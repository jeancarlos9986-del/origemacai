import { db } from "./firebase.js";
import {
    collection, onSnapshot, addDoc, query, where, getDocs, getDoc, doc, setDoc, updateDoc, deleteDoc, increment, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let totalVendas = 0, totalCustos = 0, totalGastos = 0, totalReceitasExtras = 0, qtdVendas = 0;
let periodo = "dia", unsubscribeGastos = null, graficoDivisao, graficoVendas;
let metaAtual = { tipo: "dia", valor: 0 };

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
const saldoCaixa = async () => { try { const s = await getDoc(doc(db, "configuracoes", "caixa_empresa")); return s.exists() ? Number(s.data().saldo || 0) : 0; } catch { return 0; } };
const ajustarSaldo = async d => await setDoc(doc(db, "configuracoes", "caixa_empresa"), { saldo: increment(Math.round(d * 100) / 100), ultimaAtualizacao: new Date() }, { merge: true });

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
    document.getElementById("modalReceita").classList.remove("aberto");
    carregarDados();
}

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
    document.getElementById("caixaAlertas").innerHTML = alerta ? "<i class='fas fa-exclamation-triangle'></i> Atenção: Há contas próximas ou vencidas!" : "";
}
async function adicionarConta() {
    const n = document.getElementById("nomeConta").value.trim(), v = parseFloat(document.getElementById("valorConta").value), d = document.getElementById("dataVenc").value;
    if (!n || isNaN(v) || !d) return alert("Preencha tudo!");
    await addDoc(collection(db, "contas_pagar"), { descricao: n, valor: v, dataVenc: new Date(d), pago: false });
    document.getElementById("nomeConta").value = ""; document.getElementById("valorConta").value = ""; document.getElementById("dataVenc").value = "";
    carregarContas();
}
window.marcarPago = async (id, val) => { if (!confirm("Marcar como pago?")) return; await deleteDoc(doc(db, "contas_pagar", id)); await ajustarSaldo(-val); carregarContas(); };

async function fecharCaixa() {
    const saldoReal = parseFloat(document.getElementById("saldoReal").value) || 0;
    const saldoCalc = totalVendas - totalCustos - totalGastos + totalReceitasExtras;
    await addDoc(collection(db, "fechamento_caixa"), { data: new Date(), saldoCalculado: saldoCalc, saldoReal, diferenca: saldoReal - saldoCalc });
    alert("✅ Caixa fechado com sucesso!");
    document.getElementById("modalFechar").classList.remove("aberto");
}

async function registrarGasto() {
    const d = document.getElementById("descricao").value.trim(), v = parseFloat(document.getElementById("valor-gasto").value), t = document.getElementById("tipo-gasto").value;
    if (!d || isNaN(v) || v <= 0) return alert("Preencha tudo!");
    await addDoc(collection(db, "gastos"), { descricao: d, valor: v, tipo: t, data: new Date() });
    await ajustarSaldo(-v);
    document.getElementById("descricao").value = ""; document.getElementById("valor-gasto").value = "";
    carregarDados();
}
async function excluirGasto(id, valor) { if (!confirm("Excluir?")) return; await deleteDoc(doc(db, "gastos", id)); await ajustarSaldo(valor); carregarDados(); }
function abrirEdicao(id, d, v, t) { document.getElementById("editar-id").value = id; document.getElementById("editar-desc").value = d; document.getElementById("editar-valor").value = v; document.getElementById("editar-tipo").value = t; document.getElementById("modalEditar").classList.add("aberto"); }
async function salvarEdicao() {
    const id = document.getElementById("editar-id").value, d = document.getElementById("editar-desc").value.trim(), v = parseFloat(document.getElementById("editar-valor").value), t = document.getElementById("editar-tipo").value;
    if (!id || !d || isNaN(v) || v <= 0) return;
    const ant = (await getDoc(doc(db, "gastos", id))).data();
    await updateDoc(doc(db, "gastos", id), { descricao: d, valor: v, tipo: t });
    await ajustarSaldo(ant.valor - v);
    document.getElementById("modalEditar").classList.remove("aberto"); carregarDados();
}

async function carregarDados() {
    totalVendas = 0; totalCustos = 0; totalGastos = 0; totalReceitasExtras = 0; qtdVendas = 0;
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

    unsubscribeGastos = onSnapshot(query(collection(db, "gastos"), where("data", ">=", inicio), where("data", "<=", fim)), snap => {
        totalGastos = 0; let htmlGastos = "";
        snap.forEach(doc => {
            const g = doc.data(), v = Number(g.valor || 0); totalGastos += v; categorias[g.tipo || "outros"] += v;
            htmlGastos += `<tr><td>${g.data ? new Date(g.data.toDate()).toLocaleDateString('pt-BR') : "-"}</td><td>${escapeHTML(g.descricao)}</td><td style="text-align:right">-</td><td class="saida" style="text-align:right">- ${moeda(v)}</td><td class="saida" style="text-align:right">- ${moeda(v)}</td><td class="acoes-col"><button class="btn btn-editar" onclick="abrirEdicao('${doc.id}','${escapeHTML(g.descricao)}',${v},'${g.tipo}')"><i class="fas fa-pen"></i></button><button class="btn btn-perigo" onclick="excluirGasto('${doc.id}',${v})"><i class="fas fa-trash"></i></button></td></tr>`;
        });
        lista.innerHTML = htmlVendas + htmlReceitas + htmlGastos || `<tr><td colspan="6" style="text-align:center">Sem lançamentos.</td></tr>`;
        atualizarTela(pagamentos, categorias, dadosGraf, diasSem);
    });
}

async function atualizarTela(pag, cat, dadosGraf, labels) {
    const lucroOp = Number((totalVendas - totalCustos).toFixed(2));
    const receitaTotal = totalVendas + totalReceitasExtras;
    const lucroLiq = Number((lucroOp + totalReceitasExtras - totalGastos).toFixed(2));
    const margem = receitaTotal > 0 ? ((lucroLiq / receitaTotal) * 100).toFixed(1) : 0;
    const ticket = qtdVendas > 0 ? (totalVendas / qtdVendas).toFixed(2) : 0;
    const saldo = await saldoCaixa();

    const cards = document.getElementById("cards-principais");
    cards.innerHTML = `
        <div class="card-resumo"><div class="rotulo">Total Vendas</div><div class="valor">${moeda(totalVendas)}</div><div class="destaque">${qtdVendas} pedidos</div></div>
        <div class="card-resumo"><div class="rotulo">Receitas Extras</div><div class="valor" style="color:var(--green)">${moeda(totalReceitasExtras)}</div></div>
        <div class="card-resumo"><div class="rotulo">Custos Produção</div><div class="valor" style="color:var(--yellow)">${moeda(totalCustos)}</div></div>
        <div class="card-resumo"><div class="rotulo">Outros Gastos</div><div class="valor" style="color:var(--red)">${moeda(totalGastos)}</div></div>
        <div class="card-resumo ${lucroLiq < 0 ? 'alerta-negativo' : ''}"><div class="rotulo">Saldo Final</div><div class="valor" style="color:${lucroLiq < 0 ? 'var(--red)' : 'var(--green)'}">${moeda(lucroLiq)}</div><div class="destaque">Margem ${margem}% | Ticket ${moeda(ticket)}</div></div>
    `;

    document.getElementById("resumo-extra").innerHTML = `
        <div class="cards-resumo" style="margin-top:15px;">
            <div class="card-resumo"><div class="rotulo">Dinheiro</div><div class="valor" style="color:var(--green)">${moeda(pag.dinheiro)}</div></div>
            <div class="card-resumo"><div class="rotulo">Pix</div><div class="valor" style="color:var(--green)">${moeda(pag.pix)}</div></div>
            <div class="card-resumo"><div class="rotulo">Cartão</div><div class="valor" style="color:var(--green)">${moeda(pag.cartao)}</div></div>
            <div class="card-resumo" style="border-color:var(--primary);"><div class="rotulo">Saldo Caixa</div><div class="valor" style="color:var(--primary)">${moeda(saldo)}</div></div>
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
    const txt = `GESTÃO FINANCEIRA - NOVA ORIGEM AÇAÍ\nPeríodo: ${periodo === 'dia' ? 'Hoje' : periodo === 'mes' ? 'Este Mês' : 'Todo o Período'}\nVendas: ${moeda(totalVendas)} | Extras: ${moeda(totalReceitasExtras)} | Custos: ${moeda(totalCustos)}\nGastos: ${moeda(totalGastos)} | Saldo Final: ${moeda(totalVendas + totalReceitasExtras - totalCustos - totalGastos)}`;
    navigator.clipboard.writeText(txt); alert("✅ Resumo copiado!");
};

document.addEventListener("DOMContentLoaded", async () => {
    await carregarMeta(); carregarContas();
    document.getElementById("filtro-periodo").addEventListener("change", e => { periodo = e.target.value; carregarDados(); });
    document.getElementById("btnLancar").addEventListener("click", registrarGasto);
    document.getElementById("btnExportar").addEventListener("click", exportar);
    document.getElementById("btnFecharCaixa").addEventListener("click", async () => { document.getElementById("saldoCalc").textContent = moeda(totalVendas - totalCustos - totalGastos + totalReceitasExtras); document.getElementById("modalFechar").classList.add("aberto"); });
    document.getElementById("btnConfirmarFechar").addEventListener("click", fecharCaixa);
    document.getElementById("btnContas").addEventListener("click", () => { carregarContas(); document.getElementById("modalContas").classList.add("aberto"); });
    document.getElementById("btnAddConta").addEventListener("click", adicionarConta);
    document.getElementById("btnMeta").addEventListener("click", () => { document.getElementById("valorMetaDef").value = metaAtual.valor; document.getElementById("tipoMeta").value = metaAtual.tipo; document.getElementById("modalMeta").classList.add("aberto"); });
    document.getElementById("btnSalvarMeta").addEventListener("click", salvarMeta);
    document.getElementById("btnReceitaExtra").addEventListener("click", () => document.getElementById("modalReceita").classList.add("aberto"));
    document.getElementById("btnSalvarRec").addEventListener("click", registrarReceitaExtra);
    [document.getElementById("btnCancelar"), document.getElementById("btnCancelarRec"), document.getElementById("btnCancelarFechar"), document.getElementById("btnCancelarContas"), document.getElementById("btnCancelarMeta")].forEach(b => b?.addEventListener("click", e => e.target.closest(".modal").classList.remove("aberto")));
    document.getElementById("btnSalvarEdicao").addEventListener("click", salvarEdicao);
    window.abrirEdicao = abrirEdicao; window.excluirGasto = excluirGasto;
    carregarDados();
});
