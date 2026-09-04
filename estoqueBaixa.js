import { db } from "./firebase.js";
import {
    collection, addDoc, getDocs, doc, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { t, norm, pegarCampo } from "./utils.js";

// ==============================================
// RECEITA POR PRODUTO — NOMES IGUAIS AO ESTOQUE
// ==============================================
const RECEITA_PRODUTO = {
    "Copo 400ml Tradicional": {
        acai: 0.280,
        embalagem: {
            "Copo 400ml": 1,
            "Tampa": 1,
            "Colher": 1,
            "Adesivo": 1,
            "Guardanapo": 1
        }
    },
    "Copo 500ml Super": {
        acai: 0.450,
        embalagem: {
            "Copo 500ml": 1,
            "Tampa": 1,
            "Colher": 1,
            "Adesivo": 1,
            "Guardanapo": 1
        }
    },
    "Copo 700ml Super": {
        acai: 0.565,
        embalagem: {
            "Copo 700ml": 1,
            "Tampa 700ml": 1,
            "Colher": 1,
            "Adesivo": 1,
            "Guardanapo": 1
        }
    },
    "Copo Trufado 500ml": {
        acai: 0.450,
        embalagem: {
            "Copo 500ml": 1,
            "Tampa": 1,
            "Colher": 1,
            "Adesivo": 1,
            "Guardanapo": 1
        },
        ingredientes: {
            "Nutella": 0.100
        }
    },
    "Shake Açaí Tradicional 500ml": {
        acai: 0.300,
        embalagem: {
            "Garrafa Pet 500ml": 1,
            "Canudo": 1,
            "Adesivo": 1,
            "Guardanapo": 1
        },
        ingredientes: {
            "Leite": 0.200
        }
    },
    "Cone Trufado": {
        acai: 0.150,
        embalagem: {
            "Cone": 1,
            "Guardanapo": 1
        },
        ingredientes: {
            "Nutella": 0.080
        }
    }
};

const RECEITA_PADRAO = {
    acai: 0.400,
    embalagem: {
        "Copo 500ml": 1,
        "Tampa": 1,
        "Colher": 1,
        "Adesivo": 1,
        "Guardanapo": 1
    }
};

export const PRODUTOS_CONHECIDOS = Object.keys(RECEITA_PRODUTO);

// ==============================================
// CONSUMO DE ADICIONAIS — NOMES IGUAIS AO ESTOQUE
// ==============================================
// ⚠️ Paçoca, Ouro Branco e Sonho de valsa contam por UNIDADES
const CONSUMO_ADICIONAL = {
    "Nutella": 0.030,
    "Morango": 0.060,
    "Granola": 0.025,
    "Leite em pó": 0.035,
    "Leite condensado": 0.015,
    "Paçoca": 1,               // ✅ UNIDADE
    "Banana": 0.050,
    "Disquete/Confete": 0.010,  // ✅ Nome padronizado igual ao estoque
    "Kit Kat": 0.010,
    "Ouro Branco": 1,           // ✅ UNIDADE
    "Sonho de valsa": 1,        // ✅ UNIDADE — nome com minúsculo IGUAL ao estoque
    "Choco Ball": 0.030,
    "Amendoim": 0.020,
    "Kiwi": 0.050,
    "Ovomaltine": 0.025
};

// ==============================================
// ⚠️ ABAIXO — LÓGICA ATUALIZADA ⚠️
// ==============================================

function acumularReceita(add, nomeProduto, vezes) {
    const chaveProduto = norm(nomeProduto);
    let receita = RECEITA_PRODUTO[chaveProduto];
    if (!receita) {
        console.warn(`⚠️ Produto "${nomeProduto}" sem receita cadastrada — usando receita padrão de copo 500ml.`);
        receita = RECEITA_PADRAO;
    }

    // Açaí
    add("Açaí", receita.acai * vezes);

    // Embalagem
    if (receita.embalagem) {
        Object.entries(receita.embalagem).forEach(([nomeItem, qtd]) => {
            if (qtd > 0) add(nomeItem, qtd * vezes);
        });
    }

    // Ingredientes
    if (receita.ingredientes) {
        Object.entries(receita.ingredientes).forEach(([nomeItem, qtd]) => {
            add(nomeItem, qtd * vezes);
        });
    }
}

export function calcularNecessidades(itens) {
    const nec = new Map();
    const add = (nome, qtd) => {
        if (!qtd || qtd <= 0) return;
        const chave = norm(nome);
        const atual = nec.get(chave);
        nec.set(chave, { nome, qtd: (atual?.qtd || 0) + qtd });
    };

    itens.forEach(item => {
        acumularReceita(add, item.nome, 1);

        let ads = [];
        if (Array.isArray(item.gratis)) ads.push(...item.gratis);
        if (Array.isArray(item.extras)) ads.push(...item.extras);
        ads = ads
            .map(a => (typeof a === "object" ? a.nome || "" : String(a || "")))
            .map(a => a.replace(/\s*\(extra\)\s*$/i, "").trim())
            .filter(Boolean);
        ads = [...new Set(ads)];

        ads.forEach(ad => {
            const achou = Object.keys(CONSUMO_ADICIONAL).find(ch => norm(ch) === norm(ad));
            if (achou) {
                add(achou, CONSUMO_ADICIONAL[achou]);
            } else {
                console.warn(`⚠️ Adicional "${ad}" sem consumo cadastrado — nada foi debitado.`);
            }
        });
    });

    // Embalagem de pedido
    if (itens.length === 1) { add("Sacola 1 copo", 1); add("Porta-copo 1 copo", 1); }
    else if (itens.length > 1) { add("Sacola 2+ copos", 1); add("Porta-copo 2+ copos", 1); }

    return nec;
}

export function calcularNecessidadesProducao(contagens) {
    const nec = new Map();
    const add = (nome, qtd) => {
        if (!qtd || qtd <= 0) return;
        const chave = norm(nome);
        const atual = nec.get(chave);
        nec.set(chave, { nome, qtd: (atual?.qtd || 0) + qtd });
    };
    contagens.forEach(({ nome, quantidade }) => {
        if (!quantidade || quantidade <= 0) return;
        acumularReceita(add, nome, quantidade);
    });
    return nec;
}

export async function construirMapaEstoque() {
    const snap = await getDocs(collection(db, "estoque"));
    const mapa = new Map();
    snap.forEach(d => mapa.set(norm(d.data().nome), { ref: doc(db, "estoque", d.id), nome: d.data().nome }));
    return mapa;
}

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

        const leituras = [];
        for (const nec of necessidades) {
            leituras.push({ ...nec, snap: nec.info ? await tx.get(nec.info.ref) : null });
        }

        for (const L of leituras) {
            if (!L.info || !L.snap || !L.snap.exists()) { faltas.push(L.nome); continue; }
            const atual = Number(pegarCampo(L.snap.data(), ["quantidade", "qtd", "quant"]));
            const nova = Number((atual - L.qtd).toFixed(4));
            tx.update(L.info.ref, { quantidade: Math.max(0, nova), atualizadoEm: new Date() });
            consumos.push({ nome: L.info.nome, qtd: L.qtd });
            if (nova < 0) faltas.push(L.info.nome);
        }

        tx.update(pedidoRef, faltas.length ? { estoqueBaixado: true, estoqueAlertaFalta: faltas } : { estoqueBaixado: true, estoqueAlertaFalta: [] });
    });

    for (const c of consumos) {
        await addDoc(collection(db, "movimentacoes"), {
            nomeItem: c.nome, tipo: "saida", quantidade: c.qtd, observacao: `Pedido #${pedidoId.slice(-4)}`, data: new Date()
        }).catch(e => console.error("Falha ao registrar movimentação", e));
    }
    if (faltas.length) console.warn(`⚠️ Estoque negativo ao processar pedido #${pedidoId.slice(-4)}: ${faltas.join(", ")}`);
}

export async function processarProducaoSegura(contagens, mapaEstoque) {
    let faltas = [];
    let consumos = [];
    await runTransaction(db, async tx => {
        faltas = []; consumos = [];
        const necessidades = [...calcularNecessidadesProducao(contagens).entries()]
            .map(([chave, v]) => ({ chave, ...v, info: mapaEstoque.get(chave) }));

        const leituras = [];
        for (const nec of necessidades) {
            leituras.push({ ...nec, snap: nec.info ? await tx.get(nec.info.ref) : null });
        }

        for (const L of leituras) {
            if (!L.info || !L.snap || !L.snap.exists()) { faltas.push(L.nome); continue; }
            const atual = Number(pegarCampo(L.snap.data(), ["quantidade", "qtd", "quant"]));
            const nova = Number((atual - L.qtd).toFixed(4));
            tx.update(L.info.ref, { quantidade: Math.max(0, nova), atualizadoEm: new Date() });
            consumos.push({ nome: L.info.nome, qtd: L.qtd, disponivelApos: Math.max(0, nova) });
            if (nova < 0) faltas.push(L.info.nome);
        }
    });

    for (const c of consumos) {
        await addDoc(collection(db, "movimentacoes"), {
            nomeItem: c.nome, tipo: "saida", quantidade: c.qtd,
            observacao: "Produção registrada manualmente (tela Estoque)", data: new Date()
        }).catch(e => console.error("Falha ao registrar movimentação de produção", e));
    }
    if (faltas.length) console.warn(`⚠️ Estoque negativo ao processar produção manual: ${faltas.join(", ")}`);
    return consumos;
}

export async function estornarPedidoSeguro(pedidoId, mapaEstoque) {
    let devolucoes = [];
    await runTransaction(db, async tx => {
        devolucoes = [];
        const pedidoRef = doc(db, "pedidos", pedidoId);
        const pedidoSnap = await tx.get(pedidoRef);
        if (!pedidoSnap.exists()) return;
        const pedido = pedidoSnap.data();
        if (!pedido.estoqueBaixado || pedido.estoqueEstornado) return;
        if (pedido.estoqueIgnoradoHistorico) return;

        const necessidades = [...calcularNecessidades(pedido.itens || []).entries()]
            .map(([chave, v]) => ({ chave, ...v, info: mapaEstoque.get(chave) }));

        const leituras = [];
        for (const nec of necessidades) {
            leituras.push({ ...nec, snap: nec.info ? await tx.get(nec.info.ref) : null });
        }

        for (const L of leituras) {
            if (!L.info || !L.snap || !L.snap.exists()) continue;
            const atual = Number(pegarCampo(L.snap.data(), ["quantidade", "qtd", "quant"]));
            const nova = Number((atual + L.qtd).toFixed(4));
            tx.update(L.info.ref, { quantidade: nova, atualizadoEm: new Date() });
            devolucoes.push({ nome: L.info.nome, qtd: L.qtd });
        }

        tx.update(pedidoRef, { estoqueEstornado: true });
    });

    for (const d of devolucoes) {
        await addDoc(collection(db, "movimentacoes"), {
            nomeItem: d.nome, tipo: "entrada", quantidade: d.qtd,
            observacao: `Estorno — pedido #${pedidoId.slice(-4)} cancelado/removido`, data: new Date()
        }).catch(e => console.error("Falha ao registrar estorno", e));
    }
    return devolucoes;
}
