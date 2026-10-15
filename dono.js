import { db } from "./firebase.js";
import { protegerPagina, renderizarUsuarioLogado } from "./auth-guard.js";
import {
    collection, doc, onSnapshot, query, where, orderBy, limit, getDocs, getAggregateFromServer, sum, count
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { calcularNecessidades } from "./estoqueBaixa.js";
import { TELAS } from "./menu-telas.js";
import { esc, norm, pegarCampo } from "./utils.js";

// ==============================================
// PAINEL DO DONO — tudo numa tela só
// ==============================================
// Só o perfil "admin" entra (protegerPagina([]) deixa passar apenas admin).
// Tudo atualiza ao vivo (onSnapshot); os totais do mês e "desde o início" usam
// agregação do Firestore (soma no servidor, sem baixar todos os pedidos).
//
// Regra de faturamento = a MESMA do financeiro.js: pedido com status "concluido",
// somando o campo "total". Pedido cancelado / Pix pendente / não pago não conta.

const ABERTOS = ["novo", "preparo", "pronto", "em_rota", "pix_pendente", "aguardando_pagamento"];
const NAO_CONTA = ["cancelado", "nao_pago", "pix_pendente", "aguardando_pagamento"];
const MIN_NOVO_PARADO = 10;      // pedido novo sem ser aceito há X min => alerta vermelho
const MIN_PRONTO_ESPERANDO = 15; // pronto esperando entregador há X min => alerta amarelo
const HORA_COBRAR_MARKETING = 10; // depois dessa hora, avisa se o plano de hoje não foi gerado

const moeda = v => `R$ ${Number(v || 0).toFixed(2).replace(".", ",")}`;
const num = v => Number(v) || 0;
const inicioDoDia = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const minutosDesde = ms => Math.max(0, Math.floor((Date.now() - num(ms)) / 60000));
const textoTempo = min => min < 1 ? "agora" : min < 60 ? `há ${min} min` : `há ${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
const hora = ms => new Date(ms).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const ehEntrega = p => String(p.entrega || "").toLowerCase().includes("entrega");
const qtdDe = i => num(pegarCampo(i, ["quantidade", "qtd", "quant"]));
const minDe = i => num(pegarCampo(i, ["nivelMinimo", "minimo", "estoqueMinimo"]));
const custoDe = i => num(pegarCampo(i, ["custoUnitario", "custo", "valor"]));
const $ = id => document.getElementById(id);
const set = (id, html) => { const el = $(id); if (el) el.innerHTML = html; };
const setTxt = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };

function formaPagamento(pg) {
    const s = String(pg || "").toLowerCase();
    if (s.includes("pix")) return "pix";
    if (s.includes("débito") || s.includes("debito") || s.includes("crédito") || s.includes("credito") || s.includes("cartão") || s.includes("cartao")) return "cartao";
    return "dinheiro";
}

// ---------- estado ----------
let pedidosHoje = [], abertos = [], estoque = [], caixa = null, contas = [];
let plano;            // undefined = carregando | null = nenhum plano | objeto
let agreg = { mes: null, total: null };
const falhas = new Set();
let diaCarregado = new Date().toDateString();

const pedidosUnidos = () => {
    const m = new Map();
    abertos.forEach(p => m.set(p.id, p));
    pedidosHoje.forEach(p => m.set(p.id, p));
    return [...m.values()];
};

// ---------- início ----------
protegerPagina([]).then(r => {
    renderizarUsuarioLogado(r?.nome);
    if (r?.nome) setTxt("nome-usuario", r.nome.split(" ")[0]);
    setTxt("data-hoje", new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" }));
    montarTelas();
    iniciarListeners();
    carregarAgregados();
    setInterval(() => {
        if (new Date().toDateString() !== diaCarregado) return location.reload(); // virou o dia: recomeça do zero
        render();
    }, 30 * 1000);
    setInterval(carregarAgregados, 5 * 60 * 1000);
});

function marcarVivo(ok) {
    const live = $("live");
    if (!live) return;
    const ruim = !ok || falhas.size > 0;
    live.classList.toggle("off", ruim);
    setTxt("live-txt", ruim ? "alguma parte não carregou" : `ao vivo • ${new Date().toLocaleTimeString("pt-BR")}`);
}

function escutar(nome, alvo, aoReceber) {
    onSnapshot(alvo, snap => {
        falhas.delete(nome);
        aoReceber(snap);
        marcarVivo(true);
        render();
    }, err => {
        console.error(`Painel do dono — erro em "${nome}":`, err);
        falhas.add(nome);
        marcarVivo(false);
        render();
    });
}

function iniciarListeners() {
    const lista = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));
    escutar("pedidos de hoje", query(collection(db, "pedidos"), where("criadoEm", ">=", inicioDoDia())), s => { pedidosHoje = lista(s); });
    // Pedidos ainda em andamento, de qualquer dia (um pedido de ontem à noite ainda "em rota" não some daqui).
    escutar("pedidos em andamento", query(collection(db, "pedidos"), where("status", "in", ABERTOS)), s => { abertos = lista(s); });
    escutar("estoque", collection(db, "estoque"), s => { estoque = lista(s); });
    escutar("caixa", doc(db, "configuracoes", "caixa_empresa"), s => { caixa = s.exists() ? s.data() : null; });
    escutar("contas a pagar", query(collection(db, "contas_pagar"), where("pago", "==", false)), s => { contas = lista(s); });
    escutar("marketing", query(collection(db, "marketing_planos"), orderBy("criadoEm", "desc"), limit(1)), s => { plano = s.empty ? null : s.docs[0].data(); });
}

// Soma no servidor (barato). Se o índice composto da soma ainda não existe, lê os
// pedidos direto (usa os mesmos índices que o financeiro já tem) pra não ficar sem número.
let somaViaLeitura = false;
async function somar(q) {
    try {
        return (await getAggregateFromServer(q, { total: sum("total"), qtd: count() })).data();
    } catch (e) {
        somaViaLeitura = true;
        console.warn("Painel do dono: índice da soma ainda não existe — usando leitura direta. Crie o índice pelo link do erro (dá menos leituras).", e.message);
        const snap = await getDocs(q);
        let total = 0; snap.forEach(d => { total += num(d.data().total); });
        return { total, qtd: snap.size };
    }
}

let ultimoTotalGeralMs = 0;
async function carregarAgregados() {
    try {
        const ini = new Date(); ini.setDate(1); ini.setHours(0, 0, 0, 0);
        const concl = query(collection(db, "pedidos"), where("status", "==", "concluido"));
        const mes = await somar(query(concl, where("criadoEm", ">=", ini.getTime())));
        // Lendo o histórico inteiro (sem índice), só atualiza o total geral a cada 30 min.
        const podeAtualizarTotal = !somaViaLeitura || Date.now() - ultimoTotalGeralMs > 30 * 60 * 1000;
        const total = podeAtualizarTotal ? await somar(concl) : agreg.total;
        if (podeAtualizarTotal) ultimoTotalGeralMs = Date.now();
        agreg = { mes, total };
        falhas.delete("totais");
    } catch (e) {
        console.error("Painel do dono — totais do mês/geral:", e);
        falhas.add("totais");
    }
    marcarVivo(true);
    render();
}

// ---------- render ----------
function render() {
    renderKPIs();
    renderFila();
    renderFormas();
    renderUltimos();
    renderEstoque();
    renderMarketing();
    renderAtencao();
    setTxt("rodape", falhas.size ? `⚠️ Não carregou: ${[...falhas].join(", ")} (veja o console do navegador).` : "Os números se atualizam sozinhos.");
}

function resumoHoje() {
    const concl = pedidosHoje.filter(p => p.status === "concluido");
    const fat = concl.reduce((a, p) => a + num(p.total), 0);
    const contam = pedidosHoje.filter(p => !NAO_CONTA.includes(p.status));
    const andamento = pedidosHoje.filter(p => ["novo", "preparo", "pronto", "em_rota"].includes(p.status));
    const cancelados = pedidosHoje.filter(p => p.status === "cancelado").length;

    // Custo dos insumos dos pedidos concluídos (mesma receita da baixa do estoque).
    const custos = new Map(estoque.map(i => [norm(i.nome), custoDe(i)]));
    let cmv = 0; const semCusto = new Set();
    concl.forEach(p => calcularNecessidades(p.itens || []).forEach((v, chave) => {
        const c = custos.get(chave);
        if (!c) semCusto.add(v.nome); else cmv += v.qtd * c;
    }));
    return { concl, fat, contam, andamento, cancelados, cmv, semCusto, valorAndamento: andamento.reduce((a, p) => a + num(p.total), 0) };
}

function renderKPIs() {
    const r = resumoHoje();
    setTxt("k-fat", moeda(r.fat));
    setTxt("k-fat-sub", r.valorAndamento > 0 ? `+ ${moeda(r.valorAndamento)} em andamento` : `${r.concl.length} pedido(s) concluído(s)`);
    setTxt("k-ped", r.contam.length);
    setTxt("k-ped-sub", `${r.andamento.length} em andamento${r.cancelados ? ` • ${r.cancelados} cancelado(s)` : ""}`);
    setTxt("k-tkt", r.concl.length ? moeda(r.fat / r.concl.length) : "—");
    setTxt("k-luc", r.concl.length ? moeda(r.fat - r.cmv) : "—");
    setTxt("k-luc-sub", r.semCusto.size ? `⚠️ ${r.semCusto.size} insumo(s) sem custo` : "vendas − custo dos insumos");

    setTxt("k-mes", agreg.mes ? moeda(agreg.mes.total) : "—");
    setTxt("k-mes-sub", agreg.mes ? `${agreg.mes.qtd} pedido(s) concluído(s)` : "");
    setTxt("k-total", agreg.total ? moeda(agreg.total.total) : "—");
    setTxt("k-total-sub", agreg.total ? `${agreg.total.qtd} pedido(s) desde o início` : "desde o início");

    if (caixa) {
        const tot = caixa.total ?? (num(caixa.dinheiro) + num(caixa.pix) + num(caixa.cartao));
        setTxt("k-caixa", moeda(tot));
        setTxt("k-caixa-sub", `💵 ${moeda(caixa.dinheiro)} • ⚡ ${moeda(caixa.pix)} • 💳 ${moeda(caixa.cartao)}`);
    } else { setTxt("k-caixa", "—"); setTxt("k-caixa-sub", ""); }

    const totalContas = contas.reduce((a, c) => a + num(c.valor), 0);
    const venc = contas.filter(c => c.dataVenc?.toDate && c.dataVenc.toDate() < new Date(inicioDoDia())).length;
    setTxt("k-contas", moeda(totalContas));
    setTxt("k-contas-sub", contas.length ? `${contas.length} em aberto${venc ? ` • ${venc} vencida(s)` : ""}` : "nenhuma em aberto ✅");
}

function renderFila() {
    const todos = pedidosUnidos();
    const c = {
        novo: todos.filter(p => p.status === "novo"),
        preparo: todos.filter(p => p.status === "preparo"),
        aguarda: todos.filter(p => p.status === "pronto" && ehEntrega(p)),
        retirada: todos.filter(p => p.status === "pronto" && !ehEntrega(p)),
        rota: todos.filter(p => p.status === "em_rota"),
        ok: pedidosHoje.filter(p => p.status === "concluido")
    };
    const ids = { novo: "f-novo", preparo: "f-preparo", aguarda: "f-aguarda", retirada: "f-retirada", rota: "f-rota", ok: "f-ok" };
    Object.entries(ids).forEach(([k, id]) => { const el = $(id); if (el) el.querySelector(".n").textContent = c[k].length; });
    $("f-novo")?.classList.toggle("quente", c.novo.some(p => minutosDesde(p.criadoEm) >= MIN_NOVO_PARADO));
    $("f-aguarda")?.classList.toggle("morno", c.aguarda.some(p => minutosDesde(p.atualizadoEm || p.criadoEm) >= MIN_PRONTO_ESPERANDO));
    const ent = c.ok.filter(ehEntrega).length;
    if ($("f-ok")) $("f-ok").title = `${ent} entrega(s) • ${c.ok.length - ent} retirada(s)`;
}

function renderFormas() {
    const r = resumoHoje();
    const f = { dinheiro: 0, pix: 0, cartao: 0 };
    r.concl.forEach(p => { f[formaPagamento(p.pagamento)] += num(p.total); });
    if (!r.concl.length) return set("formas", `<p class="vazio">Sem vendas concluídas ainda.</p>`);
    const rot = { dinheiro: ["💵 Dinheiro", "var(--green)"], pix: ["⚡ Pix", "var(--blue)"], cartao: ["💳 Cartão", "var(--primary)"] };
    set("formas", Object.entries(f).map(([k, v]) => `
        <div style="padding:8px 0;"><div class="linha" style="border:none;padding:0;"><span>${rot[k][0]}</span><span class="v">${moeda(v)}</span></div>
        <div class="barra"><i style="width:${r.fat ? (v / r.fat * 100) : 0}%; background:${rot[k][1]};"></i></div></div>`).join(""));
}

const ROTULO = { novo: "Novo", preparo: "Preparo", pronto: "Pronto", em_rota: "Em rota", concluido: "Entregue", cancelado: "Cancelado", pix_pendente: "Pix pendente", aguardando_pagamento: "Aguard. pgto", nao_pago: "Não pago" };

function renderUltimos() {
    const lista = [...pedidosHoje].sort((a, b) => num(b.criadoEm) - num(a.criadoEm)).slice(0, 8);
    if (!lista.length) return set("ultimos", `<p class="vazio">Nenhum pedido hoje.</p>`);
    set("ultimos", lista.map(p => `
        <div class="linha"><span style="font-family:var(--mono);color:var(--muted);">#${esc(String(p.numero || p.id).slice(-4))}</span>
        <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.nome || "—")}</span>
        <span class="pill p-${ROTULO[p.status] ? esc(p.status) : "outro"}">${esc(ROTULO[p.status] || p.status || "?")}</span>
        <span class="v">${moeda(p.total)}</span><span style="color:var(--muted);font-size:.72rem;">${hora(num(p.criadoEm))}</span></div>`).join(""));
}

function itensBaixos() {
    return estoque.map(i => ({ i, q: qtdDe(i), m: minDe(i) }))
        .filter(x => x.m > 0 || x.q <= 0)
        .map(x => ({ ...x, r: x.m > 0 ? x.q / x.m : 0 }))
        .sort((a, b) => a.r - b.r);
}

function renderEstoque() {
    if (!estoque.length) return set("estoque", `<p class="vazio">${falhas.has("estoque") ? "Não consegui ler o estoque." : "Carregando..."}</p>`);
    const baixos = itensBaixos().slice(0, 5);
    if (!baixos.length) return set("estoque", `<p class="vazio">✅ Nenhum item com mínimo definido ou zerado.</p>`);
    const cor = r => r <= 0.5 ? "var(--red)" : r <= 1 ? "var(--yellow)" : "var(--green)";
    const pior = baixos[0];
    set("estoque", `<p class="vazio" style="padding-top:0;">🔻 Mais baixo agora: <b style="color:var(--text)">${esc(pior.i.nome)}</b></p>` +
        baixos.map(x => `<div style="padding:7px 0;"><div class="linha" style="border:none;padding:0;"><span>${esc(x.i.nome)}</span>
        <span class="v" style="color:${cor(x.r)}">${x.q.toFixed(2)} ${esc(x.i.unidade || "")}</span></div>
        <div class="barra"><i style="width:${Math.min(100, x.r / 2 * 100)}%; background:${cor(x.r)};"></i></div>
        <div style="font-size:.7rem;color:var(--muted);margin-top:3px;">mínimo ${x.m || "—"}</div></div>`).join(""));
}

function renderMarketing() {
    if (falhas.has("marketing")) return set("marketing", `<p class="vazio">⚠️ Sem permissão pra ler os planos. Publique as regras novas do Firestore (coleção <b>marketing_planos</b>).</p>`);
    if (plano === undefined) return set("marketing", `<p class="vazio">Carregando...</p>`);
    const deHoje = plano && num(plano.criadoEm) >= inicioDoDia();
    if (!plano) return set("marketing", `<p class="vazio">Nenhum plano gerado ainda.</p><a class="ver" style="color:var(--primary);font-weight:800;font-size:.8rem;" href="./marketing.html">Gerar o plano de hoje →</a>`);
    if (!deHoje) return set("marketing", `<p class="vazio">⚠️ O plano de hoje ainda não foi gerado.</p><p class="vazio">Último: <b>${esc(plano.tema)}</b> (${new Date(num(plano.criadoEm)).toLocaleDateString("pt-BR")})</p>
        <a style="color:var(--primary);font-weight:800;font-size:.8rem;" href="./marketing.html">Gerar o plano de hoje →</a>`);
    set("marketing", `<div class="mkt-tema">${esc(plano.tema)}</div>
        ${plano.produto ? `<span class="pill p-pronto">🍧 ${esc(plano.produto)}</span>` : ""}
        <div class="mkt-leg">${esc(plano.legendaFeed)}</div>
        <p class="vazio" style="margin-top:8px;">Gerado às ${hora(num(plano.criadoEm))}</p>`);
}

function renderAtencao() {
    const av = [];
    const todos = pedidosUnidos();
    const add = (cor, icone, txt, link) => av.push({ cor, icone, txt, link });

    const novos = todos.filter(p => p.status === "novo" && minutosDesde(p.criadoEm) >= MIN_NOVO_PARADO);
    if (novos.length) add("red", "🟣", `${novos.length} pedido(s) novo(s) sem ser aceito(s) — o mais antigo ${textoTempo(Math.max(...novos.map(p => minutosDesde(p.criadoEm))))}`, "./cozinha.html");

    const esperando = todos.filter(p => p.status === "pronto" && ehEntrega(p) && minutosDesde(p.atualizadoEm || p.criadoEm) >= MIN_PRONTO_ESPERANDO);
    if (esperando.length) add("yellow", "🛵", `${esperando.length} pedido(s) pronto(s) esperando o entregador há mais de ${MIN_PRONTO_ESPERANDO} min`, "./entregador.html");

    const pix = todos.filter(p => p.status === "pix_pendente").length;
    if (pix) add("yellow", "⚡", `${pix} Pix aguardando confirmação de pagamento`, "./financeiro.html");

    const crit = itensBaixos().filter(x => x.q <= 0 || x.r <= 0.5);
    if (crit.length) add("red", "📦", `Estoque crítico: ${crit.slice(0, 4).map(x => esc(x.i.nome)).join(", ")}${crit.length > 4 ? ` e mais ${crit.length - 4}` : ""}`, "./estoque.html");

    const hojeIni = inicioDoDia();
    const vencidas = contas.filter(c => c.dataVenc?.toDate && c.dataVenc.toDate().getTime() < hojeIni);
    if (vencidas.length) add("red", "💸", `${vencidas.length} conta(s) a pagar vencida(s): ${moeda(vencidas.reduce((a, c) => a + num(c.valor), 0))}`, "./financeiro.html");
    const prox = contas.filter(c => { const t = c.dataVenc?.toDate?.().getTime(); return t >= hojeIni && t < hojeIni + 3 * 86400000; });
    if (prox.length) add("yellow", "🗓️", `${prox.length} conta(s) vencendo nos próximos 3 dias: ${moeda(prox.reduce((a, c) => a + num(c.valor), 0))}`, "./financeiro.html");

    const venc = estoque.filter(i => i.validade && new Date(i.validade + "T00:00:00").getTime() < hojeIni + 3 * 86400000);
    if (venc.length) add("yellow", "🗓️", `Validade perto do fim no estoque: ${venc.slice(0, 3).map(i => esc(i.nome)).join(", ")}`, "./estoque.html");

    const semPlano = plano !== undefined && !falhas.has("marketing") && !(plano && num(plano.criadoEm) >= hojeIni);
    if (semPlano && new Date().getHours() >= HORA_COBRAR_MARKETING) add("yellow", "📣", "O plano de marketing de hoje ainda não foi gerado", "./marketing.html");

    if (!av.length) return set("atencao", `<div class="aviso green">✅ Tudo em ordem agora — nenhum pedido parado, estoque e contas sob controle.</div>`);
    // Os textos acima já passam por esc() onde entram nomes; o resto é texto fixo do sistema.
    set("atencao", av.map(a => `<div class="aviso ${a.cor}"><span>${a.icone}</span><span>${a.txt}</span><a href="${a.link}">abrir →</a></div>`).join(""));
}

function montarTelas() {
    const grupos = [...new Set(TELAS.map(t => t.grupo))];
    const html = grupos.map(g => {
        const itens = TELAS.filter(t => t.grupo === g && t.arquivo !== "dono.html");
        if (!itens.length) return "";
        return `<div class="telas-grupo">${esc(g)}</div><div class="telas">${itens.map(t =>
            `<a class="tela" href="./${esc(t.arquivo)}"><span class="ic">${t.icone}</span>${esc(t.nome)}</a>`).join("")}</div>`;
    }).join("");
    set("telas", html + `<div class="telas-grupo">Outros</div><div class="telas"><a class="tela" href="./site.html"><span class="ic">🌐</span>Ver o site do cliente</a></div>`);
}
