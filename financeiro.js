import { db } from "./firebase.js";
import {
    collection, onSnapshot, addDoc, query, where, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, increment, orderBy, limit, runTransaction, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let totalVendas = 0, totalCustos = 0, totalGastosEmpresa = 0, totalGastosPessoal = 0, totalReceitasExtras = 0, totalTrocosPix = 0, qtdVendas = 0;
let periodo = "dia", filtroNatureza = "todos", unsubscribeGastos = null, graficoDivisao, graficoVendas;
let metaAtual = { tipo: "dia", valor: 0 };
let totalEstoqueAtual = 0;
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

const ajustarSaldo = async (valor, forma = "total") => {
    const atual = await saldoCaixa();
    const novo = { ...atual, ultimaAtualizacao: new Date() };
    valor = Number(valor.toFixed(2));

    if (forma === "dinheiro") novo.dinheiro = Number((novo.dinheiro + valor).toFixed(2));
    else if (forma === "pix") novo.pix = Number((novo.pix + valor).toFixed(2));
    else if (forma === "cartao") novo.cartao = Number((novo.cartao + valor).toFixed(2));
    else if (forma === "pessoal") return; // NÃO ALTERA O CAIXA DA EMPRESA
    else {
        novo.dinheiro = Number((novo.dinheiro + valor).toFixed(2));
        novo.pix = Number((novo.pix + valor).toFixed(2));
    }

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

let caixaCarregouPrimeiraVez = false;
function monitorarVendasCaixa() {
    onSnapshot(query(collection(db, "pedidos"), where("status", "==", "concluido")), async snap => {
        const cargaInicial = !caixaCarregouPrimeiraVez;
        caixaCarregouPrimeiraVez = true;
        const pendentes = snap.docChanges()
            .filter(c => (c.type === "added" || c.type === "modified") && !c.doc.data().caixaCreditado)
            .map(c => c.doc.id);
        if (!pendentes.length) return;

        if (cargaInicial) {
            for (let i = 0; i < pendentes.length; i += 400) {
                const lote = pendentes.slice(i, i + 400), batch = writeBatch(db);
                lote.forEach(id => batch.update(doc(db, "pedidos", id), { caixaCreditado: true }));
                await batch.commit().catch(e => console.error("Falha ao marcar vendas antigas", e));
            }
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
    if (!d || isNaN(v) || v <= 0) return alert("Preencha tudo!");
    await addDoc(collection(db, "receitas_extras"), { descricao: d, valor: v, data: new Date() });
    await ajustarSaldo(v);
    document.getElementById("descRec").value = ""; document.getElementById("valorRec").value = "";
    document.getElementById("modalReceita").classList.remove("aberto");
    carregarDados();
}

// ==============================================
// 💸 TROCO DE DINHEIRO VIA PIX
// ==============================================
async function registrarTrocoPix() {
    const d = document.getElementById("descTroco").value.trim(), v = parseFloat(document.getElementById("valorTroco").value);
    if (isNaN(v) || v <= 0) return alert("Informe o valor do troco!");
    await addDoc(collection(db, "trocos_pix"), { descricao: d || "Troco devolvido via Pix", valor: v, data: new Date() });
    document.getElementById("descTroco").value = ""; document.getElementById("valorTroco").value = "";
    document.getElementById("modalTroco").classList.remove("aberto");
    carregarDados();
}
window.excluirTroco = async (id) => { if (!confirm("Excluir este registro?")) return; await deleteDoc(doc(db, "trocos_pix", id)); carregarDados(); };

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
// 📝 CONTAS A PAGAR
// ==============================================
async function carregarContas() {
    const snap = await getDocs(query(collection(db, "contas_pagar"), orderBy("dataVenc", "asc")));
    const lista = document.getElementById("listaContas"), hoje = new Date();
    lista.innerHTML = ""; let alerta = false;
    snap.forEach(doc => {
        const c = doc.data(), venc = new Date(c.dataVenc.toDate()), dias = Math.ceil((venc - hoje) / (1000 * 60 * 60 * 24));
        let classe = ""; if (dias < 0) classe = "vencido", alerta = true; else if (dias <= 3) classe = "vencendo", alerta = true;
        lista.innerHTML += `<div class="item-conta ${classe}">
            <span>${c.descricao} - ${moeda(c.valor)}</span>
            <span>${venc.toLocaleDateString('pt-BR')} <button class="btn btn-sucesso" style="padding:4px 8px; font-size:0.75rem;" onclick="marcarPago('${doc.id}',${c.valor})">Pago</button></span>
        </div>`;
    });
    document.getElementById("caixaAlertas").className = `alertas ${alerta ? 'visivel' : ''}`;
    document.getElementById("caixaAlertas").innerHTML = alerta ? "<i class='fas fa-exclamation-triangle'></i> Atenção: contas vencidas ou próximas!" : "";
}
async function adicionarConta() {
    const n = document.getElementById("nomeConta").value.trim(), v = parseFloat(document.getElementById("valorConta").value), d = document.getElementById("dataVenc").value;
    if (!n || isNaN(v) || !d) return alert("Preencha tudo!");
    await addDoc(collection(db, "contas_pagar"), { descricao: n, valor: v, dataVenc: new Date(d), pago: false });
    document.getElementById("nomeConta").value = ""; document.getElementById("valorConta").value = ""; document.getElementById("dataVenc").value = "";
    carregarContas();
}
window.marcarPago = async (id, val) => { if (!confirm("Marcar como pago?")) return; await deleteDoc(doc(db, "contas_pagar", id)); await ajustarSaldo(-val); carregarContas(); };

// ==============================================
// 🧾 FECHAMENTO DE CAIXA
// ==============================================
async function fecharCaixa() {
    const saldoReal = parseFloat(document.getElementById("saldoReal").value) || 0;
    const saldoCalc = totalVendas - totalCustos - totalGastosEmpresa + totalReceitasExtras;
    const dinheiroEsperado = Number((ultimoPag.dinheiro + totalTrocosPix).toFixed(2));
    await addDoc(collection(db, "fechamento_caixa"), {
        data: new Date(), saldoCalculado: saldoCalc, saldoReal, diferenca: saldoReal - saldoCalc,
        dinheiroVendas: ultimoPag.dinheiro, trocosPixPeriodo: totalTrocosPix, dinheiroFisicoEsperado: dinheiroEsperado
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

    await addDoc(collection(db, "gastos"), {
        descricao: d, valor: v, tipo: t, natureza: nat, formaPagamento: forma, data: new Date()
    });

    if (nat !== "pessoal") await ajustarSaldo(-v, forma);

    document.getElementById("descricao").value = ""; document.getElementById("valor-gasto").value = "";
    carregarDados();
}

async function excluirGasto(id, valor, natureza, forma) {
    if (!confirm("Excluir este lançamento?")) return;
    await deleteDoc(doc(db, "gastos", id));
    if (natureza !== "pessoal") await ajustarSaldo(valor, forma);
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

    let delta = 0;
    if ((ant.natureza || "empresa") !== "pessoal") delta += Number(ant.valor || 0);
    if (nat !== "pessoal") delta -= v;
    if (delta !== 0) await ajustarSaldo(delta, ant.formaPagamento || "total");

    document.getElementById("modalEditar").classList.remove("aberto");
    carregarDados();
}

// ==============================================
// 📈 CARREGAMENTO GERAL DE DADOS
// ==============================================
async function carregarDados() {
    totalVendas = totalCustos = totalGastosEmpresa = totalGastosPessoal = totalReceitasExtras = totalTrocosPix = qtdVendas = 0;
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
    let htmlReceitas = ""; receitas.forEach(doc => { const r = doc.data(); totalReceitasExtras += Number(r.valor); htmlReceitas += `<tr><td>${new Date(r.data.toDate()).toLocaleDateString('pt-BR')}</td><td>Extra: ${escapeHTML(r.descricao)}</td><td class="entrada" style="text-align:right">+ ${moeda(r.valor)}</td><td style="text-align:right">-</td><td class="entrada" style="text-align:right">${moeda(r.valor)}</td><td class="acoes-col"><button class="btn btn-perigo" onclick="excluirRec('${doc.id}',${r.valor})"><i class="fas fa-trash"></i></button></td></tr>`; });
    window.excluirRec = async (id, val) => { await deleteDoc(doc(db, "receitas_extras", id)); await ajustarSaldo(-val); carregarDados(); };

    const trocos = await getDocs(query(collection(db, "trocos_pix"), where("data", ">=", inicio), where("data", "<=", fim)));
    let htmlTrocos = ""; trocos.forEach(doc => { const tr = doc.data(); totalTrocosPix += Number(tr.valor); htmlTrocos += `<tr class="linha-troco"><td>${new Date(tr.data.toDate()).toLocaleDateString('pt-BR')}</td><td>${escapeHTML(tr.descricao)} <span class="tag-troco">ajuste</span></td><td style="text-align:right">-</td><td style="text-align:right; color:var(--yellow); font-weight:700;">- ${moeda(tr.valor)} (Pix)</td><td style="text-align:right; color:var(--muted);">retido no caixa físico</td><td class="acoes-col"><button class="btn btn-perigo" onclick="excluirTroco('${doc.id}')"><i class="fas fa-trash"></i></button></td></tr>`; });

    unsubscribeGastos = onSnapshot(query(collection(db, "gastos"), where("data", ">=", inicio), where("data", "<=", fim)), snap => {
        totalGastosEmpresa = 0; totalGastosPessoal = 0;
        const linhas = [];
        snap.forEach(doc => {
            const g = doc.data(), v = Number(g.valor || 0), nat = g.natureza || "empresa", forma = g.formaPagamento || "total";
            if (nat === "pessoal") totalGastosPessoal += v; else { totalGastosEmpresa += v; categorias[g.tipo || "outros"] += v; }
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
    const dinheiroEsperado = Number((pag.dinheiro + totalTrocosPix).toFixed(2));

    const cards = document.getElementById("cards-principais");
    cards.innerHTML = `
        <div class="card-resumo"><div class="rotulo">Total Vendas</div><div class="valor">${moeda(totalVendas)}</div><div class="destaque">${qtdVendas} pedidos</div></div>
        <div class="card-resumo"><div class="rotulo">Receitas Extras</div><div class="valor" style="color:var(--green)">${moeda(totalReceitasExtras)}</div></div>
        <div class="card-resumo"><div class="rotulo">Custos Produção</div><div class="valor" style="color:var(--yellow)">${moeda(totalCustos)}</div></div>
        <div class="card-resumo"><div class="rotulo">Gastos Empresa</div><div class="valor" style="color:var(--red)">${moeda(totalGastosEmpresa)}</div></div>
        <div class="card-resumo" style="border-color:#9333ea;"><div class="rotulo">Gastos Pessoais</div><div class="valor" style="color:#d8b4fe">${moeda(totalGastosPessoal)}</div><div class="destaque">não afeta o lucro</div></div>
        <div class="card-resumo" style="border-color:var(--yellow);"><div class="rotulo">Estoque Parado</div><div class="valor" id="valorEstoqueCard" style="color:var(--yellow)">${moeda(totalEstoqueAtual)}</div><div class="destaque">dinheiro em mercadoria</div></div>
        <div class="card-resumo ${lucroLiq < 0 ? 'alerta-negativo' : ''}"><div class="rotulo">Saldo Final (empresa)</div><div class="valor" style="color:${lucroLiq < 0 ? 'var(--red)' : 'var(--green)'}">${moeda(lucroLiq)}</div><div class="destaque">Margem ${margem}% | Ticket ${moeda(ticket)}</div></div>
    `;

    document.getElementById("resumo-extra").innerHTML = `
        <div class="cards-resumo" style="margin-top:15px;">
            <div class="card-resumo"><div class="rotulo">Dinheiro (vendas)</div><div class="valor" style="color:var(--green)">${moeda(pag.dinheiro)}</div></div>
            <div class="card-resumo"><div class="rotulo">Pix</div><div class="valor" style="color:var(--green)">${moeda(pag.pix)}</div></div>
            <div class="card-resumo"><div class="rotulo">Cartão</div><div class="valor" style="color:var(--green)">${moeda(pag.cartao)}</div></div>
            <div class="card-resumo" style="border-color:var(--yellow);"><div class="rotulo">Troco Enviado via Pix</div><div class="valor" style="color:var(--yellow)">${moeda(totalTrocosPix)}</div><div class="destaque">fica retido no caixa físico</div></div>
            <div class="card-resumo" style="border-color:var(--yellow);"><div class="rotulo">Dinheiro Físico Esperado</div><div class="valor" style="color:var(--yellow)">${moeda(dinheiroEsperado)}</div><div class="destaque">dinheiro + troco Pix</div></div>
            <div class="card-resumo" style="border-color:var(--primary);"><div class="rotulo">Saldo Caixa Total</div><div class="valor" style="color:var(--primary)">${moeda(saldo.total)}</div><div class="destaque">Dinheiro: ${moeda(saldo.dinheiro)} | Pix: ${moeda(saldo.pix)} | Cartão: ${moeda(saldo.cartao)}</div></div>
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
Saldo Final: ${moeda(totalVendas + totalReceitasExtras - totalCustos - totalGastosEmpresa)}`;
    navigator.clipboard.writeText(txt); alert("✅ Resumo copiado!");
};

// ==============================================
// 🚀 INICIALIZAÇÃO GERAL
// ==============================================
document.addEventListener("DOMContentLoaded", async () => {
    await carregarMeta(); carregarContas(); iniciarListenerEstoque(); monitorarVendasCaixa();

    document.getElementById("btnAjustarCaixa").addEventListener("click", async () => {
        const saldoAtual = await saldoCaixa();
        document.getElementById("saldo-dinheiro").value = saldoAtual.dinheiro || "";
        document.getElementById("saldo-pix").value = saldoAtual.pix || "";
        document.getElementById("saldo-cartao").value = saldoAtual.cartao || "";
        document.getElementById("modalAjustarCaixa").classList.add("aberto");
    });
    document.getElementById("btnSalvarAjusteCaixa").addEventListener("click", ajustarCaixaManualmente);
    document.getElementById("filtro-periodo").addEventListener("change", e => { periodo = e.target.value; carregarDados(); });
    document.getElementById("filtro-natureza").addEventListener("change", e => { filtroNatureza = e.target.value; carregarDados(); });
    document.getElementById("btnLancar").addEventListener("click", registrarGasto);
    document.getElementById("btnExportar").addEventListener("click", exportar);
    document.getElementById("btnFecharCaixa").addEventListener("click", async () => {
        document.getElementById("saldoCalc").textContent = moeda(totalVendas - totalCustos - totalGastosEmpresa + totalReceitasExtras);
        document.getElementById("dinheiroVendasFechar").textContent = moeda(ultimoPag.dinheiro);
        document.getElementById("trocoPixFechar").textContent = moeda(totalTrocosPix);
        document.getElementById("dinheiroEsperadoFechar").textContent = moeda(ultimoPag.dinheiro + totalTrocosPix);
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

    [document.getElementById("btnCancelar"), document.getElementById("btnCancelarRec"), document.getElementById("btnCancelarFechar"), document.getElementById("btnCancelarContas"), document.getElementById("btnCancelarMeta"), document.getElementById("btnCancelarTroco"), document.getElementById("btnCancelarEstoque"), document.getElementById("btnCancelarAjusteCaixa")].forEach(b => b?.addEventListener("click", e => e.target.closest(".modal").classList.remove("aberto")));

    document.getElementById("btnSalvarEdicao").addEventListener("click", salvarEdicao);
    window.abrirEdicao = abrirEdicao; window.excluirGasto = excluirGasto;

    carregarDados();
});
