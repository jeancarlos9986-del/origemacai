import { db } from "./firebase.js";
import {
    collection, addDoc, getDocs, doc, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ==============================================
// BAIXA DE ESTOQUE POR PEDIDO — MÓDULO COMPARTILHADO
// ==============================================
// Antes essa lógica só existia dentro de estoque.js, então só rodava
// enquanto a tela de Estoque estava aberta no navegador. Agora fica aqui,
// num arquivo separado, pra poder ser chamada tanto pela cozinha (no
// momento em que o pedido é marcado como "pronto") quanto pelo próprio
// estoque.js (como rede de segurança, caso a chamada da cozinha falhe).
// ==============================================

function t(v, p = "") {
    return typeof v === "string" && v.trim() ? v.trim() : p;
}
function norm(nome) {
    return t(nome).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function pegarCampo(item, nomes) {
    for (const nome of nomes) {
        if (item[nome] !== undefined) return item[nome];
    }
    return 0;
}

const CONSUMO = {
    "400ml": { acai: 0.28 },
    "500ml": { acai: 0.32 },
    "Nutella": { qtd: 0.03 },
    "Morango": { qtd: 0.03 },
    "Granola": { qtd: 0.02 },
    "Leite em pó": { qtd: 0.02 },
    "Leite condensado": { qtd: 0.02 },
    "Paçoca": { qtd: 0.02 },
    "Banana": { qtd: 0.03 },
    "Disquete": { qtd: 0.01 },
    "Kit Kat": { qtd: 0.01 },
    "Ouro Branco": { qtd: 0.01 },
    "Sonho de Valsa": { qtd: 0.01 },
    "Chocoball": { qtd: 0.01 },
    "Amendoim": { qtd: 0.02 },
    "Shake Açai Tradicional 500ml": { acai: 0.30, "Leite": 0.10, "Leite em pó": 0.025 },
    "Ovomaltine": { qtd: 0.02 }
};

// Calcula tudo que um pedido consome, já agregado por item (uma entrada por insumo).
function calcularNecessidades(itens) {
    const nec = new Map(); // chave normalizada -> { nome, qtd }
    const add = (nome, qtd) => {
        if (!qtd || qtd <= 0) return;
        const chave = norm(nome);
        const atual = nec.get(chave);
        nec.set(chave, { nome, qtd: (atual?.qtd || 0) + qtd });
    };
    itens.forEach(item => {
        const copo = norm(item.nome).includes("400") ? "400ml" : "500ml";
        add("Açaí", CONSUMO[copo].acai);
        add(`Copo ${copo}`, 1);
        add("Tampa", 1);
        add("Colher", 1);
        add("Guardanapo", 1);
        let ads = [];
        ["gratis", "pagos", "adicionais"].forEach(c => { if (Array.isArray(item[c])) ads.push(...item[c]); });
        ads = [...new Set(ads.map(a => typeof a === "object" ? a.nome || "" : String(a || "")).filter(Boolean))];
        ads.forEach(ad => {
            const achou = Object.keys(CONSUMO).find(ch => norm(ch) === norm(ad));
            if (achou && CONSUMO[achou].qtd) add(achou, CONSUMO[achou].qtd);
        });
    });
    if (itens.length === 1) { add("Sacola 1 copo", 1); add("Porta-copo 1 copo", 1); }
    else if (itens.length > 1) { add("Sacola 2+ copos", 1); add("Porta-copo 2+ copos", 1); }
    return nec;
}

export async function construirMapaEstoque() {
    const snap = await getDocs(collection(db, "estoque"));
    const mapa = new Map();
    snap.forEach(d => mapa.set(norm(d.data().nome), { ref: doc(db, "estoque", d.id), nome: d.data().nome }));
    return mapa;
}

// Uma única transação: lê o pedido, lê cada insumo necessário, escreve tudo de uma vez.
// Nunca lança erro por falta de estoque — deixa o saldo ir a zero e registra o alerta,
// pra nunca travar o fechamento do pedido.
export async function processarPedidoSeguro(pedidoId, mapaEstoque) {
    let faltas = [];
    let consumos = [];

    await runTransaction(db, async tx => {
        faltas = []; consumos = [];
        const pedidoRef = doc(db, "pedidos", pedidoId);
        const pedidoSnap = await tx.get(pedidoRef);
        if (!pedidoSnap.exists()) return;
        const pedido = pedidoSnap.data();
        if (pedido.estoqueBaixado) return;

        const necessidades = [...calcularNecessidades(pedido.itens || []).entries()]
            .map(([chave, v]) => ({ chave, ...v, info: mapaEstoque.get(chave) }));

        // 1) TODAS as leituras primeiro (regra do Firestore: leitura antes de escrita)
        const leituras = [];
        for (const nec of necessidades) {
            leituras.push({ ...nec, snap: nec.info ? await tx.get(nec.info.ref) : null });
        }

        // 2) Agora as escritas
        for (const L of leituras) {
            if (!L.info || !L.snap || !L.snap.exists()) { faltas.push(L.nome); continue; }
            const atual = Number(pegarCampo(L.snap.data(), ["quantidade", "qtd", "quant"]));
            const nova = Number((atual - L.qtd).toFixed(4));
            tx.update(L.info.ref, { quantidade: Math.max(0, nova), atualizadoEm: new Date() });
            consumos.push({ nome: L.info.nome, qtd: L.qtd });
            if (nova < 0) faltas.push(L.info.nome);
        }

        tx.update(pedidoRef, faltas.length ? { estoqueBaixado: true, estoqueAlertaFalta: faltas } : { estoqueBaixado: true });
    });

    // Registro de movimentações fora da transação (é só log, não precisa ser atômico com a baixa).
    for (const c of consumos) {
        await addDoc(collection(db, "movimentacoes"), {
            nomeItem: c.nome, tipo: "saida", quantidade: c.qtd, observacao: `Pedido #${pedidoId.slice(-4)}`, data: new Date()
        }).catch(e => console.error("Falha ao registrar movimentação", e));
    }
    if (faltas.length) console.warn(`⚠️ Estoque negativo ao processar pedido #${pedidoId.slice(-4)}: ${faltas.join(", ")}`);
}
