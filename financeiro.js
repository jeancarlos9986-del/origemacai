import { db } from "./firebase.js";
import {
    collection, onSnapshot, addDoc, query, where, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, increment, orderBy, limit, runTransaction, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let totalVendas = 0, totalCustos = 0, totalGastosEmpresa = 0, totalGastosPessoal = 0, totalReceitasExtras = 0, totalTrocosPix = 0, totalGastosDinheiro = 0, qtdVendas = 0;
let periodo = "dia", filtroNatureza = "todos", unsubscribeGastos = null, graficoDivisao, graficoVendas;
let metaAtual = { tipo: "dia", valor: 0 };
let totalEstoqueAtual = 0;
let saldoEmprestimoAtual = 0;
let ultimoPag = { dinheiro: 0, pix: 0, cartao: 0 }, ultimoCat = { insumo: 0, fixo: 0, taxa: 0, outros: 0 }, ultimoGraf = [0, 0, 0, 0, 0, 0, 0], ultimoLabels = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

const CUSTOS = {
    acai: { custoPorGrama: 0.02, gramasPorCopo: 300 }, copo400: 0.58, copo500: 0.63, tampa: 0.40, colher: 0.30, guardanapo: 0.20,
    sacola1: 0.50, sacola2: 0.73, portaCopo1: 0.50, portaCopo2: 1.00,
    adicionais: { "Nutella": 2.07, "Morango": 0.64, "Granola": 0.66, "Leite em pó": 1.26, "Leite condensado": 0.26, "Paçoca": 0.85, "Disquete": 0.57, "Kit Kat": 1.89, "Ouro Branco": 1.06, "Sonho de Valsa": 1.06, "Chocoball": 1.03, "Amendoim": 0.36, "Banana": 0.12, "Ovomaltine": 1.78 }
};

const moeda = v => `R$ ${Number(v || 0).toFixed(2)}`;
const escapeHTML = t => { const d = document.createElement("div"); d.textContent = t ?? ""; return d.innerHTML; };
const calcularCustoPedido = itens => {
    let total = 0, qtd = 0; if (!itens) return 0;
    itens.forEach(i => {
        qtd++; total += CUSTOS.acai.custoPorGrama * CUSTOS.acai.gramasPorCopo;
        const n = (i.nome || "").toLowerCase(); total += n.includes("400ml") ? CUSTOS.copo400 : CUSTOS.copo500;
        total += CUSTOS.tampa + CUSTOS.colher + CUSTOS.guardanapo;
        [].concat(i.gratis || [], i.extras?.gratis || [], i.extras?.pagos || [], i.pagos || []).forEach(nome => { if (CUSTOS.adicionais[nome]) total += CUSTOS.adicionais[nome]; });
    });
    total += qtd === 1 ? CUSTOS.sacola1 + CUSTOS.portaCopo1 : CUSTOS.sacola2 + CUSTOS.portaCopo2;
    return Math.round(total * 100) / 100;
};

// ==============================================
// 🔧 SALDO SEPARADO POR FORMA DE PAGAMENTO
// ==============================================
const saldoCaixa = async () => {
    try {
        const s = await getDoc(doc(db, "configuracoes", "caixa_empresa"));
        return s.exists() ? s.data() : { dinheiro: 0, pix: 0, cartao: 0, total: 0 };
    } catch { return { dinheiro: 0, pix: 0, cartao: 0, total: 0 }; }
};

const ajustarSaldo = async (valor, forma = "dinheiro") => {
    const atual = await saldoCaixa();
    const novo = { ...atual, ultimaAtualizacao: new Date() };
    valor = Number(valor.toFixed(2));

    if (forma === "pix") novo.pix = Number((novo.pix + valor).toFixed(2));
    else if (forma === "cartao") novo.cartao = Number((novo.cartao + valor).toFixed(2));
    else if (forma === "pessoal" || forma === "aprazo") return; // NÃO ALTERA O CAIXA DA EMPRESA
    // 🐛 CORRIGIDO: antes, quando "forma" não era um dos valores acima (ex: "total"
    // ou vazio), o código somava o MESMO valor em dinheiro E em pix ao mesmo tempo —
    // dobrando o valor lançado. Agora o padrão (quando não sabemos a forma exata,
    // como em registros antigos) é tratar como dinheiro, um único lançamento.
    else novo.dinheiro = Number((novo.dinheiro + valor).toFixed(2));

    novo.total = Number((novo.dinheiro + novo.pix + novo.cartao).toFixed(2));
    await setDoc(doc(db, "configuracoes", "caixa_empresa"), novo, { merge: true });
};

// ==============================================
// 💰 CRÉDITO AUTOMÁTICO DAS VENDAS NO CAIXA
// ==============================================
async function creditarVendaNoCaixa(pedidoId) {
    await runTransaction(db, async tx => {
        const ref = doc(db, "pedidos", pedidoId);
        const snap = await tx.get(ref);
        if (!snap.exists()) return;
        const pedido = snap.data();
        if (pedido.caixaCreditado) return;
        const valor = Number(pedido.total || 0);
        tx.update(ref, { caixaCreditado: true });

        if (valor > 0) {
            const pg = (pedido.pagamento || "").toLowerCase();
            let forma = "dinheiro";
            if (pg.includes("pix")) forma = "pix";
            else if (pg.includes("cartão") || pg.includes("credito") || pg.includes("debito")) forma = "cartao";
            await ajustarSaldo(valor, forma);
        }
    });
}

// 🔧 CORREÇÃO DE BUG: a variável abaixo era resetada toda vez que a página
// carregava (`let` na memória), então TODA VEZ que você abria o financeiro,
// o sistema achava que era "a primeira vez" e marcava as vendas pendentes
// como já creditadas SEM somar o dinheiro no saldo — por isso Cartão ficou
// R$0,00 mesmo com R$95,80 vendidos no cartão: essas vendas foram descartadas
// silenciosamente em algum recarregamento da página.
// Agora esse controle fica salvo no Firestore (só acontece de verdade UMA
// VEZ, pra não creditar retroativamente vendas antigas de antes do sistema
// existir) e não reseta mais a cada vez que você abre a tela.
let caixaJaInicializadoCache = null;
async function caixaFoiInicializado() {
    if (caixaJaInicializadoCache !== null) return caixaJaInicializadoCache;
    const s = await getDoc(doc(db, "configuracoes", "caixa_empresa"));
    caixaJaInicializadoCache = s.exists() && s.data().inicializado === true;
    return caixaJaInicializadoCache;
}
async function marcarCaixaInicializado() {
    caixaJaInicializadoCache = true;
    await setDoc(doc(db, "configuracoes", "caixa_empresa"), { inicializado: true }, { merge: true });
}

function monitorarVendasCaixa() {
    onSnapshot(query(collection(db, "pedidos"), where("status", "==", "concluido")), async snap => {
        const pendentes = snap.docChanges()
            .filter(c => (c.type === "added" || c.type === "modified") && !c.doc.data().caixaCreditado)
            .map(c => c.doc.id);
        if (!pendentes.length) return;

        const jaInicializado = await caixaFoiInicializado();
        if (!jaInicializado) {
            // Só acontece uma vez na vida do sistema: marca vendas que já existiam
            // ANTES do controle de caixa existir como conferidas, sem creditar
            // (pra não inflar o saldo com vendas antigas que você já contabilizou
            // fisicamente de outro jeito).
            for (let i = 0; i < pendentes.length; i += 400) {
                const lote = pendentes.slice(i, i + 400), batch = writeBatch(db);
                lote.forEach(id => batch.update(doc(db, "pedidos", id), { caixaCreditado: true }));
                await batch.commit().catch(e => console.error("Falha ao marcar vendas antigas", e));
            }
            await marcarCaixaInicializado();
            return;
        }
        for (const id of pendentes) {
            try { await creditarVendaNoCaixa(id); } catch (e) { console.error("Erro ao creditar venda", id, e); }
        }
    });
}

// ==============================================
// ⚙️ AJUSTE MANUAL DETALHADO DO CAIXA
// ==============================================
async function ajustarCaixaManualmente() {
    const din = parseFloat(document.getElementById("saldo-dinheiro").value) || 0;
    const pix = parseFloat(document.getElementById("saldo-pix").value) || 0;
    const car = parseFloat(document.getElementById("saldo-cartao").value) || 0;

    await setDoc(doc(db, "configuracoes", "caixa_empresa"), {
        dinheiro: din, pix: pix, cartao: car,
        total: Number((din + pix + car).toFixed(2)),
        ultimaAtualizacao: new Date()
    }, { merge: true });

    document.getElementById("modalAjustarCaixa").classList.remove("aberto");
    carregarDados();
    alert("✅ Saldo atualizado com sucesso!");
}

// ==============================================
// 🔄 RECÁLCULO AUTOMÁTICO DO CAIXA
// ==============================================
// Refaz o saldo do zero, lendo TODO o histórico real salvo no sistema —
// sem precisar que você digite nenhum valor. Isso conserta o estrago
// causado pelos bugs antigos (vendas perdidas ao recarregar a página,
// receita extra dobrando o valor, troco via Pix nunca debitado, etc.)
async function recalcularCaixaAutomatico() {
    if (!confirm("Isso vai recalcular o saldo do caixa do zero, usando todo o histórico salvo (vendas, gastos, receitas, trocos e contas pagas). Quer continuar?")) return;

    let dinheiro = 0, pix = 0, cartao = 0;
    let avisoContasAntigas = false;

    // 1) Todas as vendas concluídas, de todo o histórico
    const pedidosSnap = await getDocs(query(collection(db, "pedidos"), where("status", "==", "concluido")));
    pedidosSnap.forEach(d => {
        const p = d.data(), v = Number(p.total || 0);
        if (v <= 0) return;
        const pg = (p.pagamento || "").toLowerCase();
        if (pg.includes("pix")) pix += v;
        else if (pg.includes("cartão") || pg.includes("credito") || pg.includes("debito")) cartao += v;
        else dinheiro += v;
    });

    // 2) Receitas extras (registros antigos sem forma salva contam como dinheiro)
    const receitasSnap = await getDocs(collection(db, "receitas_extras"));
    receitasSnap.forEach(d => {
        const r = d.data(), v = Number(r.valor || 0), forma = r.formaPagamento || "dinheiro";
        if (forma === "pix") pix += v; else if (forma === "cartao") cartao += v; else dinheiro += v;
    });

    // 3) Troco enviado via Pix: saiu do saldo de Pix
    const trocosSnap = await getDocs(collection(db, "trocos_pix"));
    trocosSnap.forEach(d => { pix -= Number(d.data().valor || 0); });

    // 4) Gastos de empresa pagos com dinheiro/pix/cartão (natureza "pessoal" ou
    //    forma "pessoal"/"aprazo" nunca saíram do caixa da empresa na hora)
    const gastosSnap = await getDocs(collection(db, "gastos"));
    gastosSnap.forEach(d => {
        const g = d.data(), v = Number(g.valor || 0), nat = g.natureza || "empresa", forma = g.formaPagamento || "dinheiro";
        if (nat === "pessoal" || forma === "pessoal" || forma === "aprazo") return;
        if (forma === "pix") pix -= v; else if (forma === "cartao") cartao -= v; else dinheiro -= v;
    });

    // 5) Contas a pagar já quitadas (só as que têm forma salva — a partir da
    //    correção deste bug; contas antigas marcadas como pagas ANTES dela
    //    foram apagadas pelo sistema antigo e não têm como ser recuperadas)
    const contasSnap = await getDocs(collection(db, "contas_pagar"));
    contasSnap.forEach(d => {
        const c = d.data();
        if (!c.pago) return;
        const v = Number(c.valor || 0), forma = c.formaPagamento || "dinheiro";
        if (forma === "pix") pix -= v; else if (forma === "cartao") cartao -= v; else dinheiro -= v;
    });

    // 6) Devoluções de empréstimo pessoal (dinheiro saindo da empresa de volta pro dono)
    const emprestimosSnap = await getDocs(collection(db, "emprestimos"));
    emprestimosSnap.forEach(d => {
        const e = d.data();
        if (e.tipo !== "devolucao") return;
        const v = Number(e.valor || 0), forma = e.formaPagamento || "dinheiro";
        if (forma === "pix") pix -= v; else if (forma === "cartao") cartao -= v; else dinheiro -= v;
    });

    dinheiro = Number(dinheiro.toFixed(2)); pix = Number(pix.toFixed(2)); cartao = Number(cartao.toFixed(2));
    const total = Number((dinheiro + pix + cartao).toFixed(2));

    await setDoc(doc(db, "configuracoes", "caixa_empresa"), {
        dinheiro, pix, cartao, total, inicializado: true, ultimaAtualizacao: new Date()
    }, { merge: true });
    caixaJaInicializadoCache = true;

    document.getElementById("modalAjustarCaixa").classList.remove("aberto");
    carregarDados();
    alert(`✅ Saldo recalculado a partir do histórico real!\n\nDinheiro: ${moeda(dinheiro)}\nPix: ${moeda(pix)}\nCartão: ${moeda(cartao)}\nTotal: ${moeda(total)}\n\n⚠️ Contas a pagar que foram quitadas ANTES desta atualização não entram na conta (o sistema antigo apagava esse registro). Se ainda notar diferença, é provavelmente por causa delas — a partir de agora tudo fica registrado certinho.`);
}

// ==============================================
// 📊 META E RECEITAS EXTRAS
// ==============================================
async function carregarMeta() {
    try { const m = await getDoc(doc(db, "configuracoes", "meta")); if (m.exists()) metaAtual = m.data(); } catch { }
}
async function salvarMeta() {
    metaAtual.tipo = document.getElementById("tipoMeta").value;
    metaAtual.valor = parseFloat(document.getElementById("valorMetaDef").value) || 0;
    await setDoc(doc(db, "configuracoes", "meta"), metaAtual, { merge: true });
    document.getElementById("modalMeta").classList.remove("aberto");
    carregarDados();
}

async function registrarReceitaExtra() {
    const d = document.getElementById("descRec").value.trim(), v = parseFloat(document.getElementById("valorRec").value);
    const forma = document.getElementById("formaRec").value;
    if (!d || isNaN(v) || v <= 0) return alert("Preencha tudo!");
    await addDoc(collection(db, "receitas_extras"), { descricao: d, valor: v, formaPagamento: forma, data: new Date() });
    await ajustarSaldo(v, forma);
    document.getElementById("descRec").value = ""; document.getElementById("valorRec").value = "";
    document.getElementById("modalReceita").classList.remove("aberto");
    carregarDados();
}

// ==============================================
// 💸 TROCO DE DINHEIRO VIA PIX
// ==============================================
// Cliente paga em dinheiro, você fica com a nota inteira e manda o troco de
// volta via Pix. Isso significa: o dinheiro físico fica maior que a venda
// registrada (por isso soma no "Dinheiro Físico Esperado"), e o saldo de
// Pix da empresa DIMINUI de verdade, porque saiu dinheiro daquela conta.
// 🐛 CORRIGIDO: antes esse débito no Pix nunca acontecia — o troco era só
// anotado, mas o saldo de Pix continuava cheio, sem bater com a realidade.
async function registrarTrocoPix() {
    const d = document.getElementById("descTroco").value.trim(), v = parseFloat(document.getElementById("valorTroco").value);
    if (isNaN(v) || v <= 0) return alert("Informe o valor do troco!");
    await addDoc(collection(db, "trocos_pix"), { descricao: d || "Troco devolvido via Pix", valor: v, data: new Date() });
    await ajustarSaldo(-v, "pix");
    document.getElementById("descTroco").value = ""; document.getElementById("valorTroco").value = "";
    document.getElementById("modalTroco").classList.remove("aberto");
    carregarDados();
}
window.excluirTroco = async (id, val) => { if (!confirm("Excluir este registro?")) return; await deleteDoc(doc(db, "trocos_pix", id)); if (val) await ajustarSaldo(Number(val), "pix"); carregarDados(); };

// ==============================================
// 📦 ESTOQUE
// ==============================================
function pegarCampo(item, nomes) { for (const nome of nomes) { if (item[nome] !== undefined) return item[nome]; } return 0; }
function renderListaEstoque(itens) {
    const lista = document.getElementById("listaEstoque");
    if (!lista) return;
    let html = "";
    itens.forEach(it => {
        const subtotal = it.q * it.c;
        html += `<div class="item-conta"><span>${escapeHTML(it.nome)} — ${it.q} ${it.unidade || ''} x ${moeda(it.c)}</span><span>${moeda(subtotal)}</span></div>`;
    });
    lista.innerHTML = html || `<div style="text-align:center; color:var(--muted); padding:10px;">Cadastre no Controle de Estoque.</div>`;
    document.getElementById("totalEstoqueModal").textContent = moeda(totalEstoqueAtual);
}
function atualizarCardEstoque() {
    const el = document.getElementById("valorEstoqueCard");
    if (el) el.textContent = moeda(totalEstoqueAtual);
}
function iniciarListenerEstoque() {
    onSnapshot(collection(db, "estoque"), snap => {
        let total = 0; const itens = [];
        snap.forEach(d => {
            const e = d.data(), q = Number(pegarCampo(e, ["quantidade", "qtd", "quant"])), c = Number(pegarCampo(e, ["custoUnitario", "custo", "valor"]));
            total += q * c; itens.push({ nome: e.nome, q, c, unidade: e.unidade });
        });
        totalEstoqueAtual = Math.round(total * 100) / 100;
        atualizarCardEstoque();
        renderListaEstoque(itens);
    });
}

// ==============================================
// 🤝 EMPRÉSTIMO PESSOAL (dono ↔ empresa)
// ==============================================
function atualizarCardEmprestimo() {
    const card = document.getElementById("valorEmprestimoCard");
    if (card) card.textContent = moeda(saldoEmprestimoAtual);
    const modal = document.getElementById("saldoEmprestimoModal");
    if (modal) modal.textContent = moeda(saldoEmprestimoAtual);
    // 🆕 O empréstimo é sempre dividido em 4 parcelas — mostra quanto é cada uma.
    const valorParcela = Number((saldoEmprestimoAtual / 4).toFixed(2));
    const parcela = document.getElementById("valorParcelaEmprestimo");
    if (parcela) parcela.textContent = moeda(valorParcela);
    const destaqueCard = document.getElementById("destaqueEmprestimoCard");
    if (destaqueCard) destaqueCard.textContent = `4x de ${moeda(valorParcela)}`;
}

function renderListaEmprestimos(itens) {
    const lista = document.getElementById("listaEmprestimos");
    if (!lista) return;
    if (!itens.length) {
        lista.innerHTML = `<div style="text-align:center; color:var(--muted); padding:10px;">Nenhuma movimentação ainda.</div>`;
        return;
    }
    let html = "";
    itens.forEach(it => {
        const data = it.data?.toDate ? it.data.toDate() : new Date();
        const isDevolucao = it.tipo === "devolucao";
        const tag = isDevolucao ? `<span class="tag-devolucao">Devolução</span>` : `<span class="tag-emprestimo">Empréstimo</span>`;
        const sinal = isDevolucao ? "-" : "+";
        const cor = isDevolucao ? "var(--green)" : "#d8b4fe";
        html += `<div class="item-conta linha-emprestimo">
            <span>${data.toLocaleDateString('pt-BR')} — ${escapeHTML(it.descricao)} ${tag}</span>
            <span style="color:${cor}; font-weight:700;">${sinal} ${moeda(it.valor)}
                <button class="btn btn-perigo" style="padding:2px 6px; margin-left:6px;" onclick="excluirEmprestimo('${it.id}','${it.tipo}',${it.valor},'${it.formaPagamento || ''}')"><i class="fas fa-trash"></i></button>
            </span>
        </div>`;
    });
    lista.innerHTML = html;
}

function iniciarListenerEmprestimos() {
    onSnapshot(query(collection(db, "emprestimos"), orderBy("data", "desc")), snap => {
        let total = 0; const itens = [];
        snap.forEach(d => {
            const e = d.data(), v = Number(e.valor || 0);
            total += e.tipo === "devolucao" ? -v : v;
            itens.push({ id: d.id, ...e, valor: v });
        });
        saldoEmprestimoAtual = Math.round(total * 100) / 100;
        atualizarCardEmprestimo();
        renderListaEmprestimos(itens);
    });
}

// Criado automaticamente quando um gasto de empresa é pago com "Dinheiro Pessoal"
async function criarEmprestimoAutomatico(gastoId, descricao, valor) {
    await addDoc(collection(db, "emprestimos"), {
        tipo: "emprestimo", descricao: `Gasto: ${descricao}`, valor, data: new Date(),
        origem: "gasto", gastoId
    });
}

// Remove o(s) empréstimo(s) automático(s) ligados a um gasto (ex: gasto excluído)
async function removerEmprestimoDoGasto(gastoId) {
    const snap = await getDocs(query(collection(db, "emprestimos"), where("gastoId", "==", gastoId)));
    for (const d of snap.docs) await deleteDoc(doc(db, "emprestimos", d.id));
}

// Atualiza o valor de um empréstimo automático já existente (ex: gasto editado)
async function atualizarEmprestimoDoGasto(gastoId, novoValor, novaDescricao) {
    const snap = await getDocs(query(collection(db, "emprestimos"), where("gastoId", "==", gastoId)));
    for (const d of snap.docs) await updateDoc(doc(db, "emprestimos", d.id), { valor: novoValor, descricao: `Gasto: ${novaDescricao}` });
}

async function registrarDevolucao() {
    const d = document.getElementById("descDevolucao").value.trim() || "Devolução recebida";
    const v = parseFloat(document.getElementById("valorDevolucao").value);
    const forma = document.getElementById("formaDevolucao").value;
    if (isNaN(v) || v <= 0) return alert("Informe o valor da devolução!");
    if (v > saldoEmprestimoAtual) { if (!confirm(`Esse valor é maior que o saldo devedor atual (${moeda(saldoEmprestimoAtual)}). Registrar mesmo assim?`)) return; }

    await addDoc(collection(db, "emprestimos"), { tipo: "devolucao", descricao: d, valor: v, data: new Date(), formaPagamento: forma });
    await ajustarSaldo(-v, forma); // a empresa te devolve, então sai do caixa dela

    document.getElementById("descDevolucao").value = ""; document.getElementById("valorDevolucao").value = "";
    carregarDados();
}

window.excluirEmprestimo = async (id, tipo, valor, forma) => {
    if (!confirm("Excluir este registro de empréstimo?")) return;
    if (tipo === "devolucao") await ajustarSaldo(valor, forma || "dinheiro"); // desfaz a saída do caixa
    await deleteDoc(doc(db, "emprestimos", id));
    carregarDados();
};

// ==============================================
// 📝 CONTAS A PAGAR
// ==============================================
// 🐛 CORRIGIDO: antes, ao marcar uma conta como paga, o registro era APAGADO
// (deleteDoc) e o débito no caixa não sabia com qual forma de pagamento foi
// paga — caía no bug que dobrava o valor em dinheiro+pix. Além disso, apagar
// o registro destruía o histórico, impossibilitando recalcular o caixa depois.
// Agora: guarda a forma de pagamento já na hora de cadastrar a conta, e ao
// marcar como paga, o registro é mantido (só marca pago:true) — o débito usa
// a forma certa.
async function carregarContas() {
    const snap = await getDocs(query(collection(db, "contas_pagar"), orderBy("dataVenc", "asc")));
    const lista = document.getElementById("listaContas"), hoje = new Date();
    lista.innerHTML = ""; let alerta = false;
    snap.forEach(doc => {
        const c = doc.data();
        if (c.pago) return; // já paga — não mostra mais na lista
        const venc = new Date(c.dataVenc.toDate()), dias = Math.ceil((venc - hoje) / (1000 * 60 * 60 * 24));
        const forma = c.formaPagamento || "dinheiro";
        const formaLabel = { dinheiro: "💵", pix: "⚡", cartao: "💳" }[forma] || "💵";
        let classe = ""; if (dias < 0) classe = "vencido", alerta = true; else if (dias <= 3) classe = "vencendo", alerta = true;
        lista.innerHTML += `<div class="item-conta ${classe}">
            <span>${formaLabel} ${c.descricao} - ${moeda(c.valor)}</span>
            <span>${venc.toLocaleDateString('pt-BR')} <button class="btn btn-sucesso" style="padding:4px 8px; font-size:0.75rem;" onclick="marcarPago('${doc.id}',${c.valor},'${forma}')">Pago</button></span>
        </div>`;
    });
    document.getElementById("caixaAlertas").className = `alertas ${alerta ? 'visivel' : ''}`;
    document.getElementById("caixaAlertas").innerHTML = alerta ? "<i class='fas fa-exclamation-triangle'></i> Atenção: contas vencidas ou próximas!" : "";
}
async function adicionarConta() {
    const n = document.getElementById("nomeConta").value.trim(), v = parseFloat(document.getElementById("valorConta").value), d = document.getElementById("dataVenc").value;
    const forma = document.getElementById("formaConta").value;
    if (!n || isNaN(v) || !d) return alert("Preencha tudo!");
    await addDoc(collection(db, "contas_pagar"), { descricao: n, valor: v, dataVenc: new Date(d), formaPagamento: forma, pago: false });
    document.getElementById("nomeConta").value = ""; document.getElementById("valorConta").value = ""; document.getElementById("dataVenc").value = "";
    carregarContas();
}
window.marcarPago = async (id, val, forma) => {
    if (!confirm("Marcar como pago?")) return;
    await updateDoc(doc(db, "contas_pagar", id), { pago: true, dataPagamento: new Date() });
    await ajustarSaldo(-val, forma || "dinheiro");
    carregarContas();
};

// ==============================================
// 🧾 FECHAMENTO DE CAIXA
// ==============================================
async function fecharCaixa() {
    const saldoReal = parseFloat(document.getElementById("saldoReal").value) || 0;
    const saldoCalc = totalVendas - totalCustos - totalGastosEmpresa + totalReceitasExtras;
    const dinheiroEsperado = Number((ultimoPag.dinheiro + totalTrocosPix - totalGastosDinheiro).toFixed(2));
    await addDoc(collection(db, "fechamento_caixa"), {
        data: new Date(), saldoCalculado: saldoCalc, saldoReal, diferenca: saldoReal - saldoCalc,
        dinheiroVendas: ultimoPag.dinheiro, trocosPixPeriodo: totalTrocosPix, gastosDinheiroPeriodo: totalGastosDinheiro, dinheiroFisicoEsperado: dinheiroEsperado
    });
    alert("✅ Caixa fechado com sucesso!");
    document.getElementById("modalFechar").classList.remove("aberto");
}

// ==============================================
// 📝 REGISTRO DE GASTOS (COM FORMA DE PAGAMENTO)
// ==============================================
async function registrarGasto() {
    const d = document.getElementById("descricao").value.trim();
    const v = parseFloat(document.getElementById("valor-gasto").value);
    const t = document.getElementById("tipo-gasto").value;
    const nat = document.getElementById("natureza-gasto").value;
    const forma = document.getElementById("forma-pagamento").value;

    if (!d || isNaN(v) || v <= 0) return alert("Preencha tudo!");

    const novoGasto = await addDoc(collection(db, "gastos"), {
        descricao: d, valor: v, tipo: t, natureza: nat, formaPagamento: forma, data: new Date()
    });

    // 🐛 CORRIGIDO: antes só descontava o saldo (dinheiro/pix/cartão) quando o
    // gasto era de natureza "Empresa". Só que a NATUREZA (Empresa/Pessoal) é sobre
    // quem "fica" com o custo no lucro — quem realmente sai do caixa é a FORMA DE
    // PAGAMENTO. Se você paga algo PESSOAL usando o Pix da empresa, o dinheiro
    // pix da empresa cai igual; se paga em dinheiro de papel, o dinheiro físico
    // cai igual. Por isso agora sempre chama ajustarSaldo com base na forma —
    // a própria ajustarSaldo já ignora quando forma é "pessoal" (dinheiro do seu
    // próprio bolso, não é da empresa) ou "aprazo".
    await ajustarSaldo(-v, forma);

    // Gasto pago com dinheiro do PRÓPRIO BOLSO (forma "pessoal") em nome da EMPRESA
    // = empréstimo automático (a empresa te deve). Se o gasto já é natureza pessoal
    // (ex: você tirou dinheiro do bolso pra algo seu), não é empréstimo nenhum.
    if (nat !== "pessoal" && forma === "pessoal") await criarEmprestimoAutomatico(novoGasto.id, d, v);

    document.getElementById("descricao").value = ""; document.getElementById("valor-gasto").value = "";
    carregarDados();
}

async function excluirGasto(id, valor, natureza, forma) {
    if (!confirm("Excluir este lançamento?")) return;
    await deleteDoc(doc(db, "gastos", id));
    // Mesma lógica: devolve o saldo pela forma de pagamento, independente da natureza
    // (empresa ou pessoal) — quem determina se mexeu no caixa é a forma, não a natureza.
    await ajustarSaldo(valor, forma);
    if (natureza !== "pessoal" && forma === "pessoal") await removerEmprestimoDoGasto(id);
    carregarDados();
}

function abrirEdicao(id, d, v, t, natureza, forma) {
    document.getElementById("editar-id").value = id;
    document.getElementById("editar-desc").value = d;
    document.getElementById("editar-valor").value = v;
    document.getElementById("editar-tipo").value = t;
    document.getElementById("editar-natureza").value = natureza || "empresa";
    document.getElementById("modalEditar").classList.add("aberto");
}

async function salvarEdicao() {
    const id = document.getElementById("editar-id").value;
    const d = document.getElementById("editar-desc").value.trim();
    const v = parseFloat(document.getElementById("editar-valor").value);
    const t = document.getElementById("editar-tipo").value;
    const nat = document.getElementById("editar-natureza").value;

    if (!id || !d || isNaN(v) || v <= 0) return;

    const ant = (await getDoc(doc(db, "gastos", id))).data();
    await updateDoc(doc(db, "gastos", id), { descricao: d, valor: v, tipo: t, natureza: nat });

    // A forma de pagamento não é editável neste modal — só descricao/valor/tipo/natureza.
    // Como o saldo agora reage à FORMA (não à natureza), o ajuste é sempre: desfaz o
    // valor antigo e aplica o novo valor, usando a mesma forma de pagamento original.
    let delta = Number(ant.valor || 0) - v;
    if (delta !== 0) await ajustarSaldo(delta, ant.formaPagamento || "dinheiro");

    // Mantém o empréstimo automático sincronizado (só se a forma de pagamento original era "pessoal")
    if (ant.formaPagamento === "pessoal") {
        const antEraLoan = (ant.natureza || "empresa") !== "pessoal";
        const agoraELoan = nat !== "pessoal";
        if (antEraLoan && !agoraELoan) await removerEmprestimoDoGasto(id);
        else if (!antEraLoan && agoraELoan) await criarEmprestimoAutomatico(id, d, v);
        else if (antEraLoan && agoraELoan) await atualizarEmprestimoDoGasto(id, v, d);
    }

    document.getElementById("modalEditar").classList.remove("aberto");
    carregarDados();
}

// ==============================================
// 📈 CARREGAMENTO GERAL DE DADOS
// ==============================================
async function carregarDados() {
    totalVendas = totalCustos = totalGastosEmpresa = totalGastosPessoal = totalReceitasExtras = totalTrocosPix = totalGastosDinheiro = qtdVendas = 0;
    const pagamentos = { dinheiro: 0, pix: 0, cartao: 0 }, categorias = { insumo: 0, fixo: 0, taxa: 0, outros: 0 };
    const lista = document.getElementById("lista-extrato"); lista.innerHTML = `<tr><td colspan="6" style="text-align:center; color:var(--muted)">Carregando...</td></tr>`;
    if (unsubscribeGastos) unsubscribeGastos = null;

    let inicio, fim; const hoje = new Date();
    if (periodo === "dia") { inicio = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 0, 0, 0); fim = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate(), 23, 59, 59); }
    else if (periodo === "mes") { inicio = new Date(hoje.getFullYear(), hoje.getMonth(), 1, 0, 0, 0); fim = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 0, 23, 59, 59); }
    else { inicio = new Date(2024, 0, 1); fim = new Date(2030, 11, 31); }

    let htmlVendas = "", dadosGraf = [0, 0, 0, 0, 0, 0, 0], diasSem = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
    const pedidos = await getDocs(query(collection(db, "pedidos"), where("status", "==", "concluido"), where("criadoEm", ">=", inicio.getTime()), where("criadoEm", "<=", fim.getTime())));
    pedidos.forEach(doc => {
        const p = doc.data(), val = Number(p.total || 0), custo = calcularCustoPedido(p.itens || []);
        totalVendas += val; totalCustos += custo; qtdVendas++;
        const pg = (p.pagamento || "").toLowerCase();
        if (pg.includes("dinheiro")) pagamentos.dinheiro += val; else if (pg.includes("pix")) pagamentos.pix += val; else if (pg.includes("cartão") || pg.includes("credito") || pg.includes("debito")) pagamentos.cartao += val;
        const dt = new Date(p.criadoEm); dadosGraf[dt.getDay()] += val;
        htmlVendas += `<tr><td>${dt.toLocaleDateString('pt-BR')}</td><td>Venda #${String(p.numero || "").slice(-4)} - ${escapeHTML(p.pagamento)}</td><td class="entrada" style="text-align:right">+ ${moeda(val)}</td><td style="text-align:right">-</td><td class="entrada" style="text-align:right">${moeda(val - custo)}</td><td class="acoes-col">-</td></tr>`;
    });

    const receitas = await getDocs(query(collection(db, "receitas_extras"), where("data", ">=", inicio), where("data", "<=", fim)));
    let htmlReceitas = ""; receitas.forEach(doc => { const r = doc.data(); totalReceitasExtras += Number(r.valor); htmlReceitas += `<tr><td>${new Date(r.data.toDate()).toLocaleDateString('pt-BR')}</td><td>Extra: ${escapeHTML(r.descricao)}</td><td class="entrada" style="text-align:right">+ ${moeda(r.valor)}</td><td style="text-align:right">-</td><td class="entrada" style="text-align:right">${moeda(r.valor)}</td><td class="acoes-col"><button class="btn btn-perigo" onclick="excluirRec('${doc.id}',${r.valor},'${r.formaPagamento || "dinheiro"}')"><i class="fas fa-trash"></i></button></td></tr>`; });
    window.excluirRec = async (id, val, forma) => { await deleteDoc(doc(db, "receitas_extras", id)); await ajustarSaldo(-val, forma || "dinheiro"); carregarDados(); };

    const trocos = await getDocs(query(collection(db, "trocos_pix"), where("data", ">=", inicio), where("data", "<=", fim)));
    let htmlTrocos = ""; trocos.forEach(doc => { const tr = doc.data(); totalTrocosPix += Number(tr.valor); htmlTrocos += `<tr class="linha-troco"><td>${new Date(tr.data.toDate()).toLocaleDateString('pt-BR')}</td><td>${escapeHTML(tr.descricao)} <span class="tag-troco">ajuste</span></td><td style="text-align:right">-</td><td style="text-align:right; color:var(--yellow); font-weight:700;">- ${moeda(tr.valor)} (Pix)</td><td style="text-align:right; color:var(--muted);">retido no caixa físico</td><td class="acoes-col"><button class="btn btn-perigo" onclick="excluirTroco('${doc.id}',${tr.valor})"><i class="fas fa-trash"></i></button></td></tr>`; });

    unsubscribeGastos = onSnapshot(query(collection(db, "gastos"), where("data", ">=", inicio), where("data", "<=", fim)), snap => {
        totalGastosEmpresa = 0; totalGastosPessoal = 0; totalGastosDinheiro = 0;
        const linhas = [];
        snap.forEach(doc => {
            const g = doc.data(), v = Number(g.valor || 0), nat = g.natureza || "empresa", forma = g.formaPagamento || "dinheiro";
            if (nat === "pessoal") totalGastosPessoal += v; else { totalGastosEmpresa += v; categorias[g.tipo || "outros"] += v; }
            // 🐛 CORRIGIDO: qualquer gasto pago em dinheiro de papel saiu do caixa físico de
            // verdade, seja ele Empresa ou Pessoal — por isso conta pra baixo do "Dinheiro
            // Físico Esperado" independente da natureza. Só gasto pago com forma "pessoal"
            // (dinheiro do seu próprio bolso) não mexe no caixa físico da empresa.
            if (forma === "dinheiro") totalGastosDinheiro += v;
            linhas.push({ id: doc.id, g, v, nat, forma });
        });
        const filtradas = filtroNatureza === "todos" ? linhas : linhas.filter(l => l.nat === filtroNatureza);
        let htmlGastos = "";
        filtradas.forEach(({ id, g, v, nat, forma }) => {
            const tagClasse = nat === "pessoal" ? "tag-pessoal" : "tag-empresa";
            const tagTexto = nat === "pessoal" ? "Pessoal" : "Empresa";
            const linhaClasse = nat === "pessoal" ? "linha-pessoal" : "";
            htmlGastos += `<tr class="${linhaClasse}"><td>${g.data ? new Date(g.data.toDate()).toLocaleDateString('pt-BR') : "-"}</td><td>${escapeHTML(g.descricao)} <span class="${tagClasse}">${tagTexto}</span></td><td style="text-align:right">-</td><td class="saida" style="text-align:right">- ${moeda(v)}</td><td class="saida" style="text-align:right">- ${moeda(v)}</td><td class="acoes-col"><button class="btn btn-editar" onclick="abrirEdicao('${id}','${escapeHTML(g.descricao)}',${v},'${g.tipo}','${nat}','${forma}')"><i class="fas fa-pen"></i></button><button class="btn btn-perigo" onclick="excluirGasto('${id}',${v},'${nat}','${forma}')"><i class="fas fa-trash"></i></button></td></tr>`;
        });
        lista.innerHTML = htmlVendas + htmlReceitas + htmlTrocos + htmlGastos || `<tr><td colspan="6" style="text-align:center">Sem lançamentos.</td></tr>`;
        ultimoPag = pagamentos; ultimoCat = categorias; ultimoGraf = dadosGraf; ultimoLabels = diasSem;
        atualizarTela(pagamentos, categorias, dadosGraf, diasSem);
    });
}

// ==============================================
// 🖥️ ATUALIZAÇÃO DA TELA
// ==============================================
async function atualizarTela(pag, cat, dadosGraf, labels) {
    const lucroOp = Number((totalVendas - totalCustos).toFixed(2));
    const receitaTotal = totalVendas + totalReceitasExtras;
    const lucroLiq = Number((lucroOp + totalReceitasExtras - totalGastosEmpresa).toFixed(2));
    const margem = receitaTotal > 0 ? ((lucroLiq / receitaTotal) * 100).toFixed(1) : 0;
    const ticket = qtdVendas > 0 ? (totalVendas / qtdVendas).toFixed(2) : 0;
    const saldo = await saldoCaixa();
    const dinheiroEsperado = Number((pag.dinheiro + totalTrocosPix - totalGastosDinheiro).toFixed(2));

    const cards = document.getElementById("cards-principais");
    cards.innerHTML = `
        <div class="card-resumo"><div class="rotulo">Total Vendas</div><div class="valor">${moeda(totalVendas)}</div><div class="destaque">${qtdVendas} pedidos</div></div>
        <div class="card-resumo"><div class="rotulo">Receitas Extras</div><div class="valor" style="color:var(--green)">${moeda(totalReceitasExtras)}</div></div>
        <div class="card-resumo"><div class="rotulo">Custos Produção</div><div class="valor" style="color:var(--yellow)">${moeda(totalCustos)}</div></div>
        <div class="card-resumo"><div class="rotulo">Gastos Empresa</div><div class="valor" style="color:var(--red)">${moeda(totalGastosEmpresa)}</div></div>
        <div class="card-resumo" style="border-color:#9333ea;"><div class="rotulo">Gastos Pessoais</div><div class="valor" style="color:#d8b4fe">${moeda(totalGastosPessoal)}</div><div class="destaque">não afeta o lucro</div></div>
        <div class="card-resumo" style="border-color:#9333ea;"><div class="rotulo">Empresa te deve</div><div class="valor" id="valorEmprestimoCard" style="color:#d8b4fe">${moeda(saldoEmprestimoAtual)}</div><div class="destaque" id="destaqueEmprestimoCard">4x de ${moeda(saldoEmprestimoAtual / 4)}</div></div>
        <div class="card-resumo" style="border-color:var(--yellow);"><div class="rotulo">Estoque Parado</div><div class="valor" id="valorEstoqueCard" style="color:var(--yellow)">${moeda(totalEstoqueAtual)}</div><div class="destaque">dinheiro em mercadoria</div></div>
        <div class="card-resumo ${lucroLiq < 0 ? 'alerta-negativo' : ''}"><div class="rotulo">Saldo Final (empresa)</div><div class="valor" style="color:${lucroLiq < 0 ? 'var(--red)' : 'var(--green)'}">${moeda(lucroLiq)}</div><div class="destaque">Margem ${margem}% | Ticket ${moeda(ticket)}</div></div>
    `;

    document.getElementById("resumo-extra").innerHTML = `
        <div class="cards-resumo" style="margin-top:15px;">
            <div class="card-resumo"><div class="rotulo">Dinheiro (vendas)</div><div class="valor" style="color:var(--green)">${moeda(pag.dinheiro)}</div><div class="destaque">recebido no período</div></div>
            <div class="card-resumo"><div class="rotulo">Pix (vendas)</div><div class="valor" style="color:var(--green)">${moeda(pag.pix)}</div><div class="destaque">recebido no período</div></div>
            <div class="card-resumo"><div class="rotulo">Cartão (vendas)</div><div class="valor" style="color:var(--green)">${moeda(pag.cartao)}</div><div class="destaque">recebido no período</div></div>
            <div class="card-resumo" style="border-color:var(--yellow);"><div class="rotulo">Troco Enviado via Pix</div><div class="valor" style="color:var(--yellow)">${moeda(totalTrocosPix)}</div><div class="destaque">fica retido no caixa físico</div></div>
            <div class="card-resumo" style="border-color:var(--red);"><div class="rotulo">Gastos em Dinheiro</div><div class="valor" style="color:var(--red)">${moeda(totalGastosDinheiro)}</div><div class="destaque">saiu do caixa físico</div></div>
            <div class="card-resumo" style="border-color:var(--yellow);"><div class="rotulo">Dinheiro Físico Esperado</div><div class="valor" style="color:var(--yellow)">${moeda(dinheiroEsperado)}</div><div class="destaque">vendas + troco Pix − gastos em dinheiro</div></div>
        </div>
        <p style="font-size:0.8rem; color:var(--muted); margin:18px 0 8px;"><i class="fas fa-wallet"></i> Saldo real do caixa (atualiza sozinho a cada venda, gasto ou compra de estoque — de qualquer período)</p>
        <div class="cards-resumo">
            <div class="card-resumo" style="border-color:var(--primary);"><div class="rotulo">Saldo Dinheiro</div><div class="valor" style="color:var(--primary)">${moeda(saldo.dinheiro)}</div></div>
            <div class="card-resumo" style="border-color:#00b1ea;"><div class="rotulo"><i class="fas fa-qrcode"></i> Conta Mercado Pago</div><div class="valor" style="color:#00b1ea">${moeda(saldo.pix + saldo.cartao)}</div><div class="destaque">Pix: ${moeda(saldo.pix)} + Cartão: ${moeda(saldo.cartao)}</div></div>
            <div class="card-resumo" style="border-color:var(--primary);"><div class="rotulo">Saldo Caixa Total</div><div class="valor" style="color:var(--primary)">${moeda(saldo.total)}</div></div>
        </div>`;

    document.getElementById("salario").textContent = moeda(lucroOp * 0.40);
    document.getElementById("caixa").textContent = moeda(lucroOp * 0.35);
    document.getElementById("reserva").textContent = moeda(lucroOp * 0.25);

    document.getElementById("categoriasGastos").innerHTML = `
        <div class="cat-gasto">Insumos<br><strong>${moeda(cat.insumo)}</strong></div>
        <div class="cat-gasto">Fixos<br><strong>${moeda(cat.fixo)}</strong></div>
        <div class="cat-gasto">Taxas<br><strong>${moeda(cat.taxa)}</strong></div>
        <div class="cat-gasto">Outros<br><strong>${moeda(cat.outros)}</strong></div>`;

    const valorMeta = metaAtual.tipo === periodo ? metaAtual.valor : 0;
    const perc = valorMeta > 0 ? Math.min(100, (receitaTotal / valorMeta) * 100).toFixed(0) : 0;
    document.getElementById("textoMeta").textContent = valorMeta > 0 ? `${perc}% da meta alcançada` : "Clique em Meta para definir";
    document.getElementById("valorMeta").textContent = `${moeda(receitaTotal)} / ${moeda(valorMeta)}`;
    document.getElementById("barraMeta").style.width = `${perc}%`;

    if (graficoDivisao) graficoDivisao.destroy();
    graficoDivisao = new Chart(document.getElementById("graficoDivisao"), { type: "doughnut", data: { labels: ["Salário", "Caixa", "Reserva"], datasets: [{ data: [lucroOp * 0.4, lucroOp * 0.35, lucroOp * 0.25], borderWidth: 0, backgroundColor: ["#f59e0b", "#7c3aed", "#00c853"] }] } });
    if (graficoVendas) graficoVendas.destroy();
    graficoVendas = new Chart(document.getElementById("graficoVendas"), { type: "bar", data: { labels, datasets: [{ label: "Vendas R$", data: dadosGraf, backgroundColor: "rgba(124,58,237,0.6)" }] } });
}

const exportar = () => {
    const txt = `GESTÃO FINANCEIRA - NOVA ORIGEM AÇAÍ
Período: ${periodo === 'dia' ? 'Hoje' : periodo === 'mes' ? 'Este Mês' : 'Todo o Período'}
Vendas: ${moeda(totalVendas)} | Extras: ${moeda(totalReceitasExtras)} | Custos: ${moeda(totalCustos)}
Gastos Empresa: ${moeda(totalGastosEmpresa)} | Gastos Pessoais: ${moeda(totalGastosPessoal)}
Troco enviado via Pix: ${moeda(totalTrocosPix)} | Estoque Parado: ${moeda(totalEstoqueAtual)}
Empresa te deve (empréstimo pessoal): ${moeda(saldoEmprestimoAtual)} — 4x de ${moeda(saldoEmprestimoAtual / 4)}
Saldo Final: ${moeda(totalVendas + totalReceitasExtras - totalCustos - totalGastosEmpresa)}`;
    navigator.clipboard.writeText(txt); alert("✅ Resumo copiado!");
};

// ==============================================
// 🚀 INICIALIZAÇÃO GERAL
// ==============================================
document.addEventListener("DOMContentLoaded", async () => {
    await carregarMeta(); carregarContas(); iniciarListenerEstoque(); iniciarListenerEmprestimos(); monitorarVendasCaixa();

    document.getElementById("btnAjustarCaixa").addEventListener("click", async () => {
        const saldoAtual = await saldoCaixa();
        document.getElementById("saldo-dinheiro").value = saldoAtual.dinheiro || "";
        document.getElementById("saldo-pix").value = saldoAtual.pix || "";
        document.getElementById("saldo-cartao").value = saldoAtual.cartao || "";
        document.getElementById("modalAjustarCaixa").classList.add("aberto");
    });
    document.getElementById("btnSalvarAjusteCaixa").addEventListener("click", ajustarCaixaManualmente);
    document.getElementById("btnRecalcularCaixa").addEventListener("click", recalcularCaixaAutomatico);
    document.getElementById("filtro-periodo").addEventListener("change", e => { periodo = e.target.value; carregarDados(); });
    document.getElementById("filtro-natureza").addEventListener("change", e => { filtroNatureza = e.target.value; carregarDados(); });
    document.getElementById("btnLancar").addEventListener("click", registrarGasto);
    document.getElementById("btnExportar").addEventListener("click", exportar);
    document.getElementById("btnFecharCaixa").addEventListener("click", async () => {
        document.getElementById("saldoCalc").textContent = moeda(totalVendas - totalCustos - totalGastosEmpresa + totalReceitasExtras);
        document.getElementById("dinheiroVendasFechar").textContent = moeda(ultimoPag.dinheiro);
        document.getElementById("trocoPixFechar").textContent = moeda(totalTrocosPix);
        document.getElementById("gastosDinheiroFechar").textContent = moeda(totalGastosDinheiro);
        document.getElementById("dinheiroEsperadoFechar").textContent = moeda(ultimoPag.dinheiro + totalTrocosPix - totalGastosDinheiro);
        document.getElementById("modalFechar").classList.add("aberto");
    });
    document.getElementById("btnConfirmarFechar").addEventListener("click", fecharCaixa);
    document.getElementById("btnContas").addEventListener("click", () => { carregarContas(); document.getElementById("modalContas").classList.add("aberto"); });
    document.getElementById("btnAddConta").addEventListener("click", adicionarConta);
    document.getElementById("btnMeta").addEventListener("click", () => { document.getElementById("valorMetaDef").value = metaAtual.valor; document.getElementById("tipoMeta").value = metaAtual.tipo; document.getElementById("modalMeta").classList.add("aberto"); });
    document.getElementById("btnSalvarMeta").addEventListener("click", salvarMeta);
    document.getElementById("btnReceitaExtra").addEventListener("click", () => document.getElementById("modalReceita").classList.add("aberto"));
    document.getElementById("btnSalvarRec").addEventListener("click", registrarReceitaExtra);
    document.getElementById("btnTrocoPix").addEventListener("click", () => document.getElementById("modalTroco").classList.add("aberto"));
    document.getElementById("btnSalvarTroco").addEventListener("click", registrarTrocoPix);
    document.getElementById("btnEstoque").addEventListener("click", () => document.getElementById("modalEstoque").classList.add("aberto"));
    document.getElementById("btnGerenciarEstoque").addEventListener("click", () => window.location.href = "estoque.html");
    document.getElementById("btnEmprestimos").addEventListener("click", () => document.getElementById("modalEmprestimos").classList.add("aberto"));
    document.getElementById("btnSalvarDevolucao").addEventListener("click", registrarDevolucao);

    [document.getElementById("btnCancelar"), document.getElementById("btnCancelarRec"), document.getElementById("btnCancelarFechar"), document.getElementById("btnCancelarContas"), document.getElementById("btnCancelarMeta"), document.getElementById("btnCancelarTroco"), document.getElementById("btnCancelarEstoque"), document.getElementById("btnCancelarAjusteCaixa"), document.getElementById("btnCancelarEmprestimos")].forEach(b => b?.addEventListener("click", e => e.target.closest(".modal").classList.remove("aberto")));

    document.getElementById("btnSalvarEdicao").addEventListener("click", salvarEdicao);
    window.abrirEdicao = abrirEdicao; window.excluirGasto = excluirGasto;

    carregarDados();
});
