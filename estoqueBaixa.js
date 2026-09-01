import { db } from "./firebase.js";
import {
    collection, addDoc, getDocs, doc, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// 🆕 Funções auxiliares agora vêm de um arquivo compartilhado com estoque.js,
// pra evitar duplicação (veja utils.js pro motivo).
import { t, norm, pegarCampo } from "./utils.js";

// ==============================================
// BAIXA DE ESTOQUE POR PEDIDO — MÓDULO COMPARTILHADO
// ==============================================
// Antes essa lógica só existia dentro de estoque.js, então só rodava
// enquanto a tela de Estoque estava aberta no navegador. Agora fica aqui,
// num arquivo separado, pra poder ser chamada tanto pela cozinha (no
// momento em que o pedido é marcado como "pronto") quanto pelo próprio
// estoque.js (como rede de segurança, caso a chamada da cozinha falhe).
// ==============================================

// ==============================================
// RECEITA POR PRODUTO
// ==============================================
// Cada produto do cardápio (site.html) tem sua própria receita explícita.
// Produto sem receita cadastrada cai num padrão de copo 500ml E avisa no
// console — assim, se você criar um produto novo no cardápio e esquecer
// de cadastrar aqui, você fica sabendo em vez de a conta sair errada
// silenciosamente.
//
// ⚠️ Os valores marcados com ⚠️ são estimativas — ajuste as quantidades
// (em kg/un) pra bater com a receita real da loja.
const RECEITA_PRODUTO = {
    "copo 400ml tradicional": {
        copo: "Copo 400ml", acai: 0.28, tampa: 1, colher: 1, guardanapo: 1
    },
    "copo 500ml super": {
        copo: "Copo 500ml", acai: 0.32, tampa: 1, colher: 1, guardanapo: 1
    },
    "copo trufado 500ml": {
        // Copo 500ml + recheio de nutella de fábrica (não é adicional escolhido pelo cliente)
        copo: "Copo 500ml", acai: 0.32, tampa: 1, colher: 1, guardanapo: 1,
        extra: { "Nutella": 0.15 } // ⚠️ ajuste pra quantidade real de nutella do recheio
    },
    "shake acai tradicional 500ml": {
        copo: "Copo 500ml", acai: 0.30, tampa: 1, colher: 0, guardanapo: 1, // ⚠️ shake tomado com canudo — sem colher; ajuste se usar
        extra: { "Leite em pó": 0.025 } // ⚠️ ajuste se usar leite líquido/condensado também
    },
    "cone trufado": {
        // Não é copo: sem Copo 500ml/400ml nem Tampa.
        copo: null, acai: 0.15, tampa: 0, colher: 0, guardanapo: 1, // ⚠️ ajuste açaí/nutella pro cone real
        extra: { "Nutella": 0.08 }
    }
};

const RECEITA_PADRAO = { copo: "Copo 500ml", acai: 0.32, tampa: 1, colher: 1, guardanapo: 1 };

// 🆕 Lista de produtos com receita cadastrada — exportada pra outras telas
// (ex: Registrar Produção em estoqueProducao.js) montarem a lista de opções
// direto daqui, em vez de duplicar os nomes dos produtos em outro arquivo.
export const PRODUTOS_CONHECIDOS = Object.keys(RECEITA_PRODUTO);

// ==============================================
// CONSUMO DE ADICIONAIS
// ==============================================
// Os nomes abaixo são EXATAMENTE os nomes usados em PRODUCTS/GRATIS/EXTRAS
// no site.html — precisam bater com o cardápio pra a comparação funcionar.
const CONSUMO_ADICIONAL = {
    "Nutella": 0.03,
    "Morango": 0.03,
    "Granola": 0.02,
    "Leite em pó": 0.02,
    "Leite condensado": 0.02,
    "Paçoca": 0.02,
    "Banana": 0.03,
    "Disquete/Confete": 0.01,
    "Kit Kat": 0.01,
    "Ouro Branco": 0.01,
    "Sonho De Valsa": 0.01,
    "Choco Ball": 0.01,
    "Amendoim": 0.02,
    "Ovomaltine": 0.02
};

// Aplica a receita de UM produto (multiplicada por `vezes`) na função `add`.
// Compartilhada por calcularNecessidades (pedido de venda, vezes=1 sempre,
// um item por unidade) e calcularNecessidadesProducao (produção manual, onde
// `vezes` é a quantidade que você diz que fez de cada produto).
function acumularReceita(add, nomeProduto, vezes) {
    const chaveProduto = norm(nomeProduto);
    let receita = RECEITA_PRODUTO[chaveProduto];
    if (!receita) {
        console.warn(`⚠️ Produto "${nomeProduto}" sem receita cadastrada em estoqueBaixa.js (RECEITA_PRODUTO) — usando receita padrão de copo 500ml. Cadastre a receita certa pra esse produto.`);
        receita = RECEITA_PADRAO;
    }
    add("Açaí", receita.acai * vezes);
    if (receita.copo) add(receita.copo, 1 * vezes);
    add("Tampa", (receita.tampa || 0) * vezes);
    add("Colher", (receita.colher || 0) * vezes);
    add("Guardanapo", (receita.guardanapo || 0) * vezes);
    if (receita.extra) {
        Object.entries(receita.extra).forEach(([nomeExtra, qtd]) => add(nomeExtra, qtd * vezes));
    }
}

// Calcula tudo que um pedido consome, já agregado por item (uma entrada por insumo).
// 🆕 Exportada (antes era só interna) — o módulo de Conferência de Receita
// (estoqueConferencia.js) reusa exatamente essa mesma lógica pra calcular o
// "teórico" de um período, garantindo que o teste usa a receita real, e não
// uma cópia que pode ficar desatualizada.
export function calcularNecessidades(itens) {
    const nec = new Map(); // chave normalizada -> { nome, qtd }
    const add = (nome, qtd) => {
        if (!qtd || qtd <= 0) return;
        const chave = norm(nome);
        const atual = nec.get(chave);
        nec.set(chave, { nome, qtd: (atual?.qtd || 0) + qtd });
    };

    itens.forEach(item => {
        acumularReceita(add, item.nome, 1);

        // Adicionais grátis + pagos escolhidos pelo cliente
        let ads = [];
        if (Array.isArray(item.gratis)) ads.push(...item.gratis);
        if (Array.isArray(item.extras)) ads.push(...item.extras);

        ads = ads
            .map(a => (typeof a === "object" ? a.nome || "" : String(a || "")))
            // O site grava "Nome (extra)" quando o cliente passa do limite de grátis —
            // removemos o sufixo pra achar o insumo certo.
            .map(a => a.replace(/\s*\(extra\)\s*$/i, "").trim())
            .filter(Boolean);
        ads = [...new Set(ads)];

        ads.forEach(ad => {
            const achou = Object.keys(CONSUMO_ADICIONAL).find(ch => norm(ch) === norm(ad));
            if (achou) {
                add(achou, CONSUMO_ADICIONAL[achou]);
            } else {
                console.warn(`⚠️ Adicional "${ad}" sem consumo cadastrado em CONSUMO_ADICIONAL — nada foi debitado do estoque para ele.`);
            }
        });
    });

    if (itens.length === 1) { add("Sacola 1 copo", 1); add("Porta-copo 1 copo", 1); }
    else if (itens.length > 1) { add("Sacola 2+ copos", 1); add("Porta-copo 2+ copos", 1); }
    return nec;
}

// ==============================================
// 🆕 CONSUMO POR PRODUÇÃO MANUAL ("fiz X copos 400ml, Y shakes...")
// ==============================================
// Diferente de calcularNecessidades (que calcula o consumo de UM PEDIDO de
// venda, com adicionais grátis/pagos escolhidos pelo cliente e a embalagem
// — sacola/porta-copo — daquele pedido específico), esta função calcula só o
// consumo de RECEITA BASE (açaí, copo, tampa, colher, guardanapo, extra de
// receita como nutella do trufado) de uma quantidade de produtos feitos.
// NÃO soma Sacola/Porta-copo — isso é embalagem de pedido de venda, não faz
// sentido debitar isso ao simplesmente "produzir" um copo.
// NÃO tem como saber adicionais grátis/pagos aqui (isso só existe no pedido
// de venda) — se seus produtos usam muito adicional, prefira a baixa normal
// via pedido.
export function calcularNecessidadesProducao(contagens) {
    // contagens: [{ nome, quantidade }]
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

        tx.update(pedidoRef, faltas.length ? { estoqueBaixado: true, estoqueAlertaFalta: faltas } : { estoqueBaixado: true, estoqueAlertaFalta: [] });
    });

    // Registro de movimentações fora da transação (é só log, não precisa ser atômico com a baixa).
    for (const c of consumos) {
        await addDoc(collection(db, "movimentacoes"), {
            nomeItem: c.nome, tipo: "saida", quantidade: c.qtd, observacao: `Pedido #${pedidoId.slice(-4)}`, data: new Date()
        }).catch(e => console.error("Falha ao registrar movimentação", e));
    }
    if (faltas.length) console.warn(`⚠️ Estoque negativo ao processar pedido #${pedidoId.slice(-4)}: ${faltas.join(", ")}`);
}

// ==============================================
// 🆕 BAIXA DE ESTOQUE POR PRODUÇÃO MANUAL
// ==============================================
// Usada pela tela "Registrar Produção" (estoqueProducao.js): você diz quantos
// de cada produto fez (ex: 10 copo 400ml, 10 shake) e aqui debitamos do
// estoque a receita correspondente numa única transação — igual em espírito
// a processarPedidoSeguro, mas sem estar amarrado a um documento de "pedido"
// (essa produção pode não ter vindo de uma venda registrada no sistema).
//
// ⚠️ IMPORTANTE — evite dar baixa duas vezes do mesmo copo: pedidos que já
// passam pela cozinha/site (coleção "pedidos") já são debitados sozinhos por
// processarPedidoSeguro quando o pedido fica pronto. Use esta função só para
// produção que NÃO passou por um pedido no sistema (ex: venda de balcão sem
// pedido online), senão o mesmo copo desconta o insumo duas vezes.
//
// Nunca lança erro por falta de estoque — deixa o saldo ir a zero e retorna
// o que ficou negativo, igual ao padrão já usado em processarPedidoSeguro.
export async function processarProducaoSegura(contagens, mapaEstoque) {
    let faltas = [];
    let consumos = []; // [{ nome, qtd, disponivelApos }]

    await runTransaction(db, async tx => {
        faltas = []; consumos = [];
        const necessidades = [...calcularNecessidadesProducao(contagens).entries()]
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
            consumos.push({ nome: L.info.nome, qtd: L.qtd, disponivelApos: Math.max(0, nova) });
            if (nova < 0) faltas.push(L.info.nome);
        }
    });

    // Registro de movimentações fora da transação (é só log, não precisa ser atômico com a baixa).
    for (const c of consumos) {
        await addDoc(collection(db, "movimentacoes"), {
            nomeItem: c.nome, tipo: "saida", quantidade: c.qtd,
            observacao: "Produção registrada manualmente (tela Estoque)", data: new Date()
        }).catch(e => console.error("Falha ao registrar movimentação de produção", e));
    }
    if (faltas.length) console.warn(`⚠️ Estoque negativo ao processar produção manual: ${faltas.join(", ")}`);
    return consumos;
}

// ==============================================
// 🆕 ESTORNO DE ESTOQUE (pedido cancelado/removido)
// ==============================================
// Antes: cancelar ou remover um pedido que já tinha passado por "pronto"
// (com o estoque já debitado) não devolvia nada — o saldo do sistema ficava
// "menor" do que o estoque físico real, e foi piorando com o tempo.
// Agora, sempre que um pedido com estoqueBaixado=true for removido/cancelado,
// chamamos esta função pra devolver exatamente o que foi debitado.
// Idempotente: se já foi estornado (estoqueEstornado=true) ou nunca teve
// baixa de verdade (ex: histórico marcado por marcarHistoricoSemBaixa),
// não faz nada.
export async function estornarPedidoSeguro(pedidoId, mapaEstoque) {
    let devolucoes = [];

    await runTransaction(db, async tx => {
        devolucoes = [];
        const pedidoRef = doc(db, "pedidos", pedidoId);
        const pedidoSnap = await tx.get(pedidoRef);
        if (!pedidoSnap.exists()) return;
        const pedido = pedidoSnap.data();

        if (!pedido.estoqueBaixado || pedido.estoqueEstornado) return;
        if (pedido.estoqueIgnoradoHistorico) return; // marcado como histórico — nunca debitou de verdade

        const necessidades = [...calcularNecessidades(pedido.itens || []).entries()]
            .map(([chave, v]) => ({ chave, ...v, info: mapaEstoque.get(chave) }));

        const leituras = [];
        for (const nec of necessidades) {
            leituras.push({ ...nec, snap: nec.info ? await tx.get(nec.info.ref) : null });
        }

        for (const L of leituras) {
            if (!L.info || !L.snap || !L.snap.exists()) continue; // item pode ter sido excluído do cadastro; nada a devolver
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
