import { db, auth } from "./firebase.js";
import { calcularNecessidades } from "./estoqueBaixa.js";
import { norm } from "./utils.js";
import {
    collection, getDocs, getDoc, doc, query, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ==============================================
// 🤖 ANÁLISE FINANCEIRA COM IA
// ==============================================
// Este arquivo faz DUAS coisas:
//  1) Calcula todos os números aqui no navegador, com a MESMA fórmula da tela
//     Financeiro (lucro = vendas + extras − CMV − gastos operacionais − taxas;
//     compra de insumo e gasto pessoal NÃO entram). Assim a IA nunca discorda
//     dos cards da tela.
//  2) Manda esse resumo para o servidor (/financeiro/analise), que pede para a
//     IA analisar. A IA só lê e sugere — não grava nada no banco.
//
// Ele não depende do filtro de período da tela: sempre analisa hoje, ontem,
// últimos 7 dias, mês atual e mês anterior.

const API_URL = "https://origemacai.onrender.com";
const $ = id => document.getElementById(id);
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const moeda = v => `R$ ${r2(v).toFixed(2).replace(".", ",")}`;
const esc = t => { const d = document.createElement("div"); d.textContent = t ?? ""; return d.innerHTML; };
const campo = (o, nomes) => { for (const n of nomes) if (o[n] !== undefined) return o[n]; return 0; };
const paraData = v => v?.toDate ? v.toDate() : (v instanceof Date ? v : (typeof v === "number" ? new Date(v) : null));
const limpar = (s, max = 60) => String(s ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, max);

const inicioDia = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
const fimDia = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
const somaDias = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function formaPedido(pagamento) {
    const pg = String(pagamento || "").toLowerCase();
    if (pg.includes("pix")) return "pix";
    if (pg.includes("débito") || pg.includes("debito")) return "debito";
    if (pg.includes("crédito") || pg.includes("credito") || pg.includes("cartão") || pg.includes("cartao")) return "credito";
    return "dinheiro";
}

// ----------------------------------------------
// Coleta e cálculo
// ----------------------------------------------
async function montarResumo() {
    const agora = new Date();
    const hoje0 = inicioDia(agora);
    const iniMes = new Date(agora.getFullYear(), agora.getMonth(), 1);
    const iniMesAnt = new Date(agora.getFullYear(), agora.getMonth() - 1, 1);
    const fimMesAnt = fimDia(new Date(agora.getFullYear(), agora.getMonth(), 0));
    const ini28 = somaDias(hoje0, -27);
    const desde = new Date(Math.min(iniMesAnt.getTime(), ini28.getTime()));

    const [pedSnap, recSnap, gasSnap, estSnap, pagSnap, recebSnap, empSnap, caixaSnap, taxasSnap, metaSnap, pixSnap] = await Promise.all([
        getDocs(query(collection(db, "pedidos"), where("status", "==", "concluido"), where("criadoEm", ">=", desde.getTime()), where("criadoEm", "<=", agora.getTime()))),
        getDocs(query(collection(db, "receitas_extras"), where("data", ">=", desde), where("data", "<=", agora))),
        getDocs(query(collection(db, "gastos"), where("data", ">=", desde), where("data", "<=", agora))),
        getDocs(collection(db, "estoque")),
        getDocs(collection(db, "contas_pagar")),
        getDocs(collection(db, "contas_receber")),
        getDocs(collection(db, "emprestimos")),
        getDoc(doc(db, "configuracoes", "caixa_empresa")),
        getDoc(doc(db, "configuracoes", "taxas")),
        getDoc(doc(db, "configuracoes", "meta")),
        getDocs(query(collection(db, "pedidos"), where("status", "==", "pix_pendente")))
    ]);

    // ----- Estoque: custos (para o CMV) e capital parado -----
    const custos = new Map(), semCustoEstoque = [], suspeitos = [], abaixoMinimo = [];
    let valorEstoque = 0;
    estSnap.forEach(d => {
        const e = d.data();
        const q = Number(campo(e, ["quantidade", "qtd", "quant"])) || 0;
        const c = Number(campo(e, ["custoUnitario", "custo", "valor"])) || 0;
        custos.set(norm(e.nome), c);
        valorEstoque += q * c;
        if (c > 0 && c <= 0.05) suspeitos.push(limpar(e.nome));
        const min = Number(e.nivelMinimo) || 0;
        if (min > 0 && q <= min) abaixoMinimo.push(`${limpar(e.nome)} (${r2(q)} de mínimo ${min})`);
    });
    const insumosSemCusto = new Set();
    const custoDe = itens => {
        let total = 0;
        calcularNecessidades(itens).forEach((v, chave) => {
            const c = custos.get(chave);
            if (!c) { insumosSemCusto.add(v.nome); return; }
            total += v.qtd * c;
        });
        return r2(total);
    };

    // ----- Linhas normalizadas -----
    const pedidos = [];
    pedSnap.forEach(d => {
        const p = d.data();
        const t = Number(p.criadoEm);
        if (!t) return;
        pedidos.push({ t, total: Number(p.total || 0), forma: formaPedido(p.pagamento), itens: p.itens || [], cmv: custoDe(p.itens || []) });
    });
    const receitas = [];
    recSnap.forEach(d => { const r = d.data(), dt = paraData(r.data); if (dt) receitas.push({ t: dt.getTime(), valor: Number(r.valor || 0), forma: r.formaPagamento || "dinheiro" }); });
    const gastos = [];
    gasSnap.forEach(d => {
        const g = d.data(), dt = paraData(g.data);
        if (dt) gastos.push({ t: dt.getTime(), valor: Number(g.valor || 0), tipo: g.tipo || "outros", natureza: g.natureza || "empresa", forma: g.formaPagamento || "dinheiro", desc: limpar(g.descricao) });
    });

    const taxas = { pix: 0.49, debito: 1.18, credito: 2.82, ...(taxasSnap.exists() ? taxasSnap.data() : {}) };

    // ----- Agregação por janela (mesma conta da tela) -----
    function agregar(ini, fim) {
        const a = { vendas: 0, pedidos: 0, cmv: 0, receitasExtras: 0, gastosOperacionais: 0, gastosInsumos: 0, gastosTaxasLancadas: 0, gastosPessoais: 0, pagamento: { dinheiro: 0, pix: 0, debito: 0, credito: 0 } };
        const base = { pix: 0, debito: 0, credito: 0 };
        pedidos.filter(p => p.t >= ini && p.t <= fim).forEach(p => {
            a.vendas += p.total; a.pedidos++; a.cmv += p.cmv; a.pagamento[p.forma] += p.total;
            if (p.forma !== "dinheiro") base[p.forma] += p.total;
        });
        receitas.filter(r => r.t >= ini && r.t <= fim).forEach(r => {
            a.receitasExtras += r.valor;
            if (r.forma === "pix") base.pix += r.valor;
            else if (r.forma === "cartao_debito") base.debito += r.valor;
            else if (r.forma === "cartao_credito" || r.forma === "cartao") base.credito += r.valor;
        });
        gastos.filter(g => g.t >= ini && g.t <= fim).forEach(g => {
            if (g.natureza === "pessoal") a.gastosPessoais += g.valor;
            else if (g.tipo === "insumo") a.gastosInsumos += g.valor;
            else if (g.tipo === "taxa") a.gastosTaxasLancadas += g.valor;
            else a.gastosOperacionais += g.valor;
        });
        const taxaEstimada = base.pix * taxas.pix / 100 + base.debito * taxas.debito / 100 + base.credito * taxas.credito / 100;
        const taxasNoLucro = Math.max(taxaEstimada, a.gastosTaxasLancadas);
        const receitaTotal = a.vendas + a.receitasExtras;
        const lucro = a.vendas - a.cmv + a.receitasExtras - a.gastosOperacionais - taxasNoLucro;
        return {
            vendas: r2(a.vendas), pedidos: a.pedidos, ticketMedio: a.pedidos ? r2(a.vendas / a.pedidos) : 0,
            cmv: r2(a.cmv), cmvPctDasVendas: a.vendas > 0 ? r2(a.cmv / a.vendas * 100) : null,
            receitasExtras: r2(a.receitasExtras), gastosOperacionais: r2(a.gastosOperacionais),
            comprasDeInsumo: r2(a.gastosInsumos), taxasPagas: r2(taxasNoLucro), gastosPessoais: r2(a.gastosPessoais),
            lucro: r2(lucro), margemPct: receitaTotal > 0 ? r2(lucro / receitaTotal * 100) : null,
            vendasPorPagamento: Object.fromEntries(Object.entries(a.pagamento).map(([k, v]) => [k, r2(v)]))
        };
    }

    const periodos = {
        hoje: agregar(hoje0.getTime(), agora.getTime()),
        ontem: agregar(somaDias(hoje0, -1).getTime(), fimDia(somaDias(hoje0, -1)).getTime()),
        ultimos7dias: agregar(somaDias(hoje0, -6).getTime(), agora.getTime()),
        mesAtual: agregar(iniMes.getTime(), agora.getTime()),
        mesAnterior: agregar(iniMesAnt.getTime(), fimMesAnt.getTime())
    };

    // ----- Projeção do mês e meta -----
    const diasNoMes = new Date(agora.getFullYear(), agora.getMonth() + 1, 0).getDate();
    const diaAtual = agora.getDate();
    const receitaMes = periodos.mesAtual.vendas + periodos.mesAtual.receitasExtras;
    const meta = metaSnap.exists() ? metaSnap.data() : null;
    const projecaoMes = {
        diaDoMes: diaAtual, diasNoMes,
        vendasProjetadas: diaAtual >= 3 ? r2(periodos.mesAtual.vendas / diaAtual * diasNoMes) : null,
        lucroProjetado: diaAtual >= 3 ? r2(periodos.mesAtual.lucro / diaAtual * diasNoMes) : null,
        aviso: diaAtual < 3 ? "poucos dias de dados, projeção não confiável" : "projeção simples pelo ritmo médio diário",
        meta: meta && Number(meta.valor) > 0 ? { tipo: meta.tipo, valor: Number(meta.valor), receitaDoPeriodoAtual: r2(meta.tipo === "mes" ? receitaMes : periodos.hoje.vendas) } : null
    };

    // ----- Série diária (14 dias) e média por dia da semana (28 dias) -----
    const serieDiaria = [];
    for (let i = 13; i >= 0; i--) {
        const dia = somaDias(hoje0, -i);
        const total = pedidos.filter(p => p.t >= dia.getTime() && p.t <= fimDia(dia).getTime()).reduce((s, p) => s + p.total, 0);
        serieDiaria.push({ dia: `${String(dia.getDate()).padStart(2, "0")}/${String(dia.getMonth() + 1).padStart(2, "0")} ${DIAS[dia.getDay()]}`, vendas: r2(total) });
    }
    const porSemana = Array(7).fill(0);
    pedidos.filter(p => p.t >= ini28.getTime()).forEach(p => { porSemana[new Date(p.t).getDay()] += p.total; });
    const mediaPorDiaDaSemana = Object.fromEntries(DIAS.map((n, i) => [n, r2(porSemana[i] / 4)]));

    // ----- Produtos do mês: unidades e custo de insumos por unidade -----
    const prod = new Map();
    pedidos.filter(p => p.t >= iniMes.getTime()).forEach(p => {
        p.itens.forEach(item => {
            const nome = limpar(item && item.nome, 60) || "(sem nome)";
            const x = prod.get(nome) || { nome, unidades: 0, cmv: 0, preco: 0, comPreco: 0 };
            x.unidades++;
            x.cmv += custoDe([item]);
            const preco = Number(item.preco ?? item.valor ?? item.precoFinal ?? 0);
            if (preco > 0) { x.preco += preco; x.comPreco++; }
            prod.set(nome, x);
        });
    });
    const porProduto = [...prod.values()].sort((a, b) => b.unidades - a.unidades).slice(0, 10).map(x => ({
        produto: x.nome, unidadesNoMes: x.unidades,
        custoInsumosPorUnidade: r2(x.cmv / x.unidades),
        precoMedio: x.comPreco ? r2(x.preco / x.comPreco) : null
    }));

    // ----- Gastos do mês: categorias e maiores lançamentos -----
    const gastosMes = gastos.filter(g => g.t >= iniMes.getTime());
    const porCategoria = {};
    gastosMes.filter(g => g.natureza !== "pessoal").forEach(g => { porCategoria[g.tipo] = r2((porCategoria[g.tipo] || 0) + g.valor); });
    const maioresGastos = gastosMes.filter(g => g.natureza !== "pessoal").sort((a, b) => b.valor - a.valor).slice(0, 6)
        .map(g => ({ descricao: g.desc, valor: r2(g.valor), tipo: g.tipo }));

    // ----- Caixa e contas -----
    const caixa = caixaSnap.exists() ? caixaSnap.data() : {};
    const saldo = { dinheiro: r2(caixa.dinheiro), pix: r2(caixa.pix), cartao: r2(caixa.cartao), total: r2(caixa.total) };

    const aPagar = [];
    pagSnap.forEach(d => { const c = d.data(); if (c.pago) return; const v = paraData(c.dataVenc); aPagar.push({ descricao: limpar(c.descricao), valor: Number(c.valor || 0), venc: v }); });
    const diasAte = v => v ? Math.ceil((v.getTime() - agora.getTime()) / 86400000) : null;
    const vencidas = aPagar.filter(c => diasAte(c.venc) !== null && diasAte(c.venc) < 0);
    const prox7 = aPagar.filter(c => diasAte(c.venc) !== null && diasAte(c.venc) >= 0 && diasAte(c.venc) <= 7);
    const somaC = l => r2(l.reduce((s, c) => s + c.valor, 0));
    const fmtConta = c => ({ descricao: c.descricao, valor: r2(c.valor), venceEmDias: diasAte(c.venc) });
    const contasPagar = {
        totalPendente: somaC(aPagar), qtdPendente: aPagar.length,
        vencidas: { qtd: vencidas.length, total: somaC(vencidas), itens: vencidas.slice(0, 8).map(fmtConta) },
        proximos7dias: { qtd: prox7.length, total: somaC(prox7), itens: prox7.slice(0, 8).map(fmtConta) },
        caixaCobreProximos7dias: r2(saldo.total - somaC(vencidas) - somaC(prox7))
    };

    const aReceber = [];
    recebSnap.forEach(d => { const c = d.data(); if (c.recebido) return; const dt = paraData(c.data); aReceber.push({ cliente: limpar(c.cliente, 40), valor: Number(c.valor || 0), diasEmAberto: dt ? Math.floor((agora.getTime() - dt.getTime()) / 86400000) : null }); });
    const contasReceber = {
        totalPendente: somaC(aReceber), qtdPendente: aReceber.length,
        maisAntigas: aReceber.sort((a, b) => (b.diasEmAberto ?? 0) - (a.diasEmAberto ?? 0)).slice(0, 6).map(c => ({ cliente: c.cliente, valor: r2(c.valor), diasEmAberto: c.diasEmAberto }))
    };

    let emprestado = 0;
    empSnap.forEach(d => { const e = d.data(); emprestado += e.tipo === "devolucao" ? -Number(e.valor || 0) : Number(e.valor || 0); });

    // ----- Confiabilidade (o que pode tornar os números errados) -----
    let pixSoma = 0; pixSnap.forEach(d => { pixSoma += Number(d.data().total || 0); });
    const confiabilidade = {
        insumosSemCustoNoEstoque: [...insumosSemCusto].slice(0, 10),
        insumosComCustoQuaseZero: suspeitos.slice(0, 10),
        pixPendentes: pixSnap.size ? { qtd: pixSnap.size, total: r2(pixSoma) } : null,
        nenhumaCompraDeInsumoNoMes: periodos.mesAtual.vendas > 500 && periodos.mesAtual.comprasDeInsumo <= 0
    };

    return {
        geradoEm: agora.toLocaleString("pt-BR"),
        diaDaSemanaHoje: DIAS[agora.getDay()],
        periodos, projecaoMes, serieDiariaVendas14dias: serieDiaria, mediaVendasPorDiaDaSemana28dias: mediaPorDiaDaSemana,
        porProduto, gastosDoMesPorCategoria: porCategoria, maioresGastosDoMes: maioresGastos,
        taxasConfiguradasPct: { pix: taxas.pix, debito: taxas.debito, credito: taxas.credito },
        caixaAtual: saldo, contasPagar, contasReceber,
        dinheiroPessoalEmprestado: r2(emprestado),
        estoque: { valorParado: r2(valorEstoque), itensAbaixoDoMinimo: abaixoMinimo.slice(0, 8) },
        confiabilidade
    };
}

// ----------------------------------------------
// Chamada ao servidor
// ----------------------------------------------
let resumoAtual = null;

async function chamarServidor(corpo) {
    const token = await auth.currentUser.getIdToken();
    const r = await fetch(`${API_URL}/financeiro/analise`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify(corpo)
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dados.erro || `Servidor respondeu ${r.status}`);
    return dados;
}

function status(msg, erro = false) {
    const el = $("iaStatus");
    el.textContent = msg || "";
    el.className = "ia-status" + (erro ? " erro" : "");
}

// ----------------------------------------------
// Tela
// ----------------------------------------------
const ROTULO_SAUDE = { boa: "🟢 Saúde financeira: boa", atencao: "🟡 Saúde financeira: atenção", critica: "🔴 Saúde financeira: crítica" };

function bloco(titulo, txt) {
    return txt ? `<div class="ia-bloco"><h5>${esc(titulo)}</h5><p>${esc(txt)}</p></div>` : "";
}

function renderizar(a, r) {
    const m = r.periodos.mesAtual;
    const cor = v => v < 0 ? "var(--red)" : "var(--green)";
    const numeros = `<div class="ia-numeros">
        <div><span>Lucro do mês</span><b style="color:${cor(m.lucro)}">${moeda(m.lucro)}</b></div>
        <div><span>Vendas do mês</span><b>${moeda(m.vendas)}</b></div>
        <div><span>Margem</span><b>${m.margemPct === null ? "—" : m.margemPct + "%"}</b></div>
        <div><span>Caixa total</span><b>${moeda(r.caixaAtual.total)}</b></div>
    </div>`;
    const alertas = a.alertas.map(x => `<div class="ia-alerta ${esc(x.gravidade)}"><b>${esc(x.titulo)}</b><p>${esc(x.detalhe)}</p>${x.acao ? `<p class="ia-acao">👉 ${esc(x.acao)}</p>` : ""}</div>`).join("");
    const destaques = a.destaques.map(x => `<div class="ia-dest ${esc(x.tipo)}"><b>${esc(x.titulo)}</b> — ${esc(x.detalhe)}</div>`).join("");
    const acoes = a.acoes.map((x, i) => `<li><b>${esc(x.acao)}</b><br><span>${esc(x.motivo)}</span></li>`).join("");
    $("iaResultado").innerHTML = `
        <div class="ia-saude ${esc(a.saude)}">${ROTULO_SAUDE[a.saude] || ""}</div>
        <p class="ia-resumo">${esc(a.resumo)}</p>
        ${numeros}
        ${alertas ? `<h5 class="ia-titulo">⚠️ Alertas</h5>${alertas}` : ""}
        ${destaques ? `<h5 class="ia-titulo">✨ Destaques</h5>${destaques}` : ""}
        ${bloco("💵 Caixa", a.caixa)}${bloco("📊 Margem e produtos", a.margemProdutos)}${bloco("🧾 Contas a pagar e a receber", a.contas)}${bloco("📈 Projeção do mês", a.projecao)}
        ${acoes ? `<h5 class="ia-titulo">✅ O que fazer agora</h5><ol class="ia-lista">${acoes}</ol>` : ""}
        <p class="ia-rodape">Gerado em ${esc(r.geradoEm)}. A IA analisa os números da tela e pode errar: confira antes de decidir.</p>`;
    $("iaPerguntaBox").style.display = "";
}

async function analisar() {
    const btn = $("iaAnalisarBtn");
    btn.disabled = true;
    $("iaResultado").innerHTML = "";
    $("iaResposta").innerHTML = "";
    status("Calculando seus números…");
    try {
        resumoAtual = await montarResumo();
        status("Analisando com IA… (se o servidor estava dormindo, pode levar até 50 segundos)");
        const analise = await chamarServidor({ resumo: resumoAtual });
        renderizar(analise, resumoAtual);
        status("");
    } catch (e) {
        console.error("Análise financeira IA:", e);
        const indice = e && e.code === "failed-precondition" ? " O Firestore pede um índice: abra o console do navegador e clique no link dele." : "";
        status((e.message || "Não foi possível analisar agora.") + indice, true);
    }
    btn.disabled = false;
}

async function perguntar() {
    const campoP = $("iaPergunta");
    const pergunta = campoP.value.trim();
    if (!pergunta || !resumoAtual) return;
    const btn = $("iaPerguntarBtn");
    btn.disabled = true;
    $("iaResposta").innerHTML = `<p class="ia-status">Pensando…</p>`;
    try {
        const { resposta } = await chamarServidor({ resumo: resumoAtual, pergunta });
        $("iaResposta").innerHTML = `<div class="ia-bloco"><h5>🗨️ ${esc(pergunta)}</h5><p>${esc(resposta)}</p></div>`;
        campoP.value = "";
    } catch (e) {
        $("iaResposta").innerHTML = `<p class="ia-status erro">${esc(e.message || "Não foi possível responder agora.")}</p>`;
    }
    btn.disabled = false;
}

document.addEventListener("DOMContentLoaded", () => {
    if (!$("modalIA")) return;
    $("btnAnaliseIA")?.addEventListener("click", () => { $("modalIA").classList.add("aberto"); if (!resumoAtual) analisar(); });
    $("iaAnalisarBtn").addEventListener("click", analisar);
    $("iaFecharBtn").addEventListener("click", () => $("modalIA").classList.remove("aberto"));
    $("iaPerguntarBtn").addEventListener("click", perguntar);
    $("iaPergunta").addEventListener("keydown", e => { if (e.key === "Enter") perguntar(); });
});
