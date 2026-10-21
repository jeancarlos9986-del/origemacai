// ==============================================
// CONFERÊNCIA DE CAIXA — Abrir / Fechar (Nova Origem Açaí)
// ==============================================
// Compara o que o SISTEMA diz que existe (saldo por forma de pagamento) com o
// que você CONTOU de verdade. Dinheiro é contado nota por nota e moeda por
// moeda. Qualquer diferença exige um motivo e (opcionalmente) acerta o saldo do
// sistema, para o dia seguinte começar certo. Tudo fica registrado em
// "fechamento_caixa" (coleção que já existia).
import {
    collection, addDoc, getDocs, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const NOTAS = [200, 100, 50, 20, 10, 5, 2];     // em reais
const MOEDAS = [100, 50, 25, 10, 5];            // em centavos
const FORMAS = { dinheiro: "💵 Dinheiro", pix: "⚡ Pix (conta)", cartao: "💳 Cartão" };
const MOTIVOS = [
    ["troco", "Erro de troco / moedas"],
    ["gasto_nao_lancado", "Paguei um gasto e não lancei"],
    ["retirada", "Retirei dinheiro (pessoal / sangria)"],
    ["whatsapp", "Pedido de WhatsApp que não lancei"],
    ["forma_errada", "Venda lançada com forma de pagamento errada"],
    ["coloquei", "Coloquei dinheiro no caixa (troco / meu)"],
    ["recontar", "Vou recontar depois (não acertar o saldo)"],
    ["nao_sei", "Não sei explicar"]
];

let C = null;      // contexto vindo do financeiro.js
let S = null;      // estado da conferência aberta
const $ = id => document.getElementById(id);
const cents = v => Math.round((Number(v) || 0) * 100);
const r2 = v => Math.round(v * 100) / 100;
const nomeNota = v => `n${v}`;
const nomeMoeda = c => `m${c}`;

// ---------- abrir ----------
export async function abrirConferenciaCaixa(ctx) {
    C = ctx;
    S = { modo: "fechamento", esperado: { dinheiro: 0, pix: 0, cartao: 0 }, historico: [] };
    $("modalFechar").classList.add("aberto");
    $("cxCorpo").innerHTML = `<p class="cx-vazio">Carregando saldo do sistema…</p>`;
    await carregarSistema();
    const hoje = new Date().toDateString();
    const jaHoje = S.historico.some(h => h.tipo && h.quando && h.quando.toDateString() === hoje);
    S.modo = jaHoje ? "fechamento" : "abertura";
    desenhar();
}

async function carregarSistema() {
    const saldo = await C.saldoCaixa();
    S.esperado = { dinheiro: r2(Number(saldo.dinheiro) || 0), pix: r2(Number(saldo.pix) || 0), cartao: r2(Number(saldo.cartao) || 0) };
    try {
        const snap = await getDocs(query(collection(C.db, "fechamento_caixa"), orderBy("data", "desc"), limit(8)));
        S.historico = snap.docs.map(d => {
            const x = d.data();
            return { ...x, quando: x.data?.toDate ? x.data.toDate() : (x.data ? new Date(x.data) : null) };
        });
    } catch (e) { console.error("Histórico do caixa:", e); S.historico = []; }
}

// ---------- leitura da contagem ----------
function lerContagem() {
    const contagem = {}; let notasC = 0, moedasC = 0;
    NOTAS.forEach(v => { const q = Math.max(0, parseInt($(`cx-in-${nomeNota(v)}`)?.value, 10) || 0); contagem[nomeNota(v)] = q; notasC += q * v * 100; });
    MOEDAS.forEach(c => { const q = Math.max(0, parseInt($(`cx-in-${nomeMoeda(c)}`)?.value, 10) || 0); contagem[nomeMoeda(c)] = q; moedasC += q * c; });
    return { contagem, notasC, moedasC, totalC: notasC + moedasC };
}
function lerContado() {
    const { totalC } = lerContagem();
    const contado = { dinheiro: totalC / 100 };
    if (S.modo === "fechamento") ["pix", "cartao"].forEach(f => {
        const v = $(`cx-in-${f}`)?.value;
        if (v !== undefined && String(v).trim() !== "") contado[f] = r2(parseFloat(String(v).replace(",", ".")) || 0);
    });
    return contado;
}

// ---------- tela ----------
function blocoDif(f) {
    return `<div class="cx-dif" id="cx-dif-${f}" style="display:none">
        <div class="cx-dif-txt" id="cx-dif-txt-${f}"></div>
        <select id="cx-mot-${f}"><option value="">Para onde foi / de onde veio? (obrigatório)</option>${MOTIVOS.map(([k, t]) => `<option value="${k}">${C.esc(t)}</option>`).join("")}</select>
        <input type="text" id="cx-obs-${f}" placeholder="Observação (opcional)" maxlength="160">
        <label class="cx-chk"><input type="checkbox" id="cx-aj-${f}" checked> Acertar o saldo do sistema para o valor contado</label>
    </div>`;
}

function desenhar() {
    const e = S.esperado;
    const ult = S.historico.find(h => typeof h.totalMoedas === "number");
    const hist = S.historico.slice(0, 6).map(h => {
        const dt = h.quando ? h.quando.toLocaleDateString("pt-BR") + " " + h.quando.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—";
        const tipo = h.tipo === "abertura" ? "☀️ Abertura" : h.tipo === "fechamento" ? "🌙 Fechamento" : "🌙 Fechamento (antigo)";
        const d = h.diferencas?.dinheiro;
        const dtxt = typeof d !== "number" ? "" : Math.abs(d) < 0.005 ? `<b class="cx-ok">bateu</b>` : `<b class="${d < 0 ? "cx-falta" : "cx-sobra"}">${d < 0 ? "faltou" : "sobrou"} ${C.moeda(Math.abs(d))}</b>`;
        const mot = h.motivos?.dinheiro ? ` · ${C.esc(h.motivos.dinheiro.texto || "")}` : "";
        return `<div class="cx-hist-linha"><span>${dt} · ${tipo}</span><span>${dtxt}${mot}</span></div>`;
    }).join("");

    $("cxCorpo").innerHTML = `
        <div class="cx-abas">
            <button type="button" data-modo="abertura">☀️ Abrir caixa</button>
            <button type="button" data-modo="fechamento">🌙 Fechar caixa</button>
        </div>
        <p class="cx-ajuda" id="cxAjuda"></p>
        <div class="cx-sistema">
            <div>Dinheiro (sistema)<strong>${C.moeda(e.dinheiro)}</strong></div>
            <div>Pix (sistema)<strong>${C.moeda(e.pix)}</strong></div>
            <div>Cartão (sistema)<strong>${C.moeda(e.cartao)}</strong></div>
        </div>
        <button type="button" class="cx-link" id="cxAtualizar">↻ Atualizar valores do sistema</button>

        <div class="cx-sec">💵 Conte o dinheiro da gaveta</div>
        <div class="cx-sub">Notas</div>
        <div class="cx-grid">${NOTAS.map(v => `<label><span>R$ ${v}</span><input type="number" min="0" step="1" inputmode="numeric" id="cx-in-${nomeNota(v)}" placeholder="0"><em id="cx-sub-${nomeNota(v)}"></em></label>`).join("")}</div>
        <div class="cx-sub">Moedas</div>
        <div class="cx-grid">${MOEDAS.map(c => `<label><span>${c >= 100 ? "R$ 1,00" : "R$ 0," + String(c).padStart(2, "0")}</span><input type="number" min="0" step="1" inputmode="numeric" id="cx-in-${nomeMoeda(c)}" placeholder="0"><em id="cx-sub-${nomeMoeda(c)}"></em></label>`).join("")}</div>
        <div class="cx-totais">
            <span>Notas: <b id="cx-notas">R$ 0,00</b></span>
            <span>Moedas: <b id="cx-moedas">R$ 0,00</b></span>
            <span class="cx-total">Contado: <b id="cx-total">R$ 0,00</b></span>
        </div>
        ${ult ? `<p class="cx-ajuda">Moedas na última contagem: <b>${C.moeda(ult.totalMoedas)}</b> (${ult.quando ? ult.quando.toLocaleDateString("pt-BR") : "—"})</p>` : ""}
        ${blocoDif("dinheiro")}

        <div id="cxOutros">
            <div class="cx-sec">⚡ Pix e 💳 Cartão <small>(opcional — deixe vazio para não conferir)</small></div>
            <label class="cx-linha-in"><span>Saldo real do Pix na conta (R$)</span><input type="number" step="0.01" inputmode="decimal" id="cx-in-pix" placeholder="vazio = não conferir"></label>
            ${blocoDif("pix")}
            <label class="cx-linha-in"><span>Cartão: valor real a receber (R$)</span><input type="number" step="0.01" inputmode="decimal" id="cx-in-cartao" placeholder="vazio = não conferir"></label>
            ${blocoDif("cartao")}
        </div>
        ${hist ? `<div class="cx-sec">Últimas conferências</div><div class="cx-hist">${hist}</div>` : ""}`;

    const corpo = $("cxCorpo");
    corpo.oninput = ev => { if (ev.target.closest("[id^=cx-in-],[id^=cx-mot-],[id^=cx-aj-]")) atualizar(); };
    corpo.onchange = corpo.oninput;
    corpo.onclick = async ev => {
        const aba = ev.target.closest("[data-modo]");
        if (aba) { S.modo = aba.dataset.modo; atualizar(); return; }
        if (ev.target.closest("#cxAtualizar")) {
            const guard = lerContagemBruta();
            await carregarSistema(); desenhar(); restaurar(guard);
        }
    };
    atualizar();
}
// preserva o que já foi digitado ao atualizar os valores do sistema
function lerContagemBruta() { const o = {}; document.querySelectorAll("#cxCorpo input[id^=cx-in-]").forEach(i => { o[i.id] = i.value; }); return o; }
function restaurar(o) { Object.entries(o).forEach(([id, v]) => { const i = $(id); if (i) i.value = v; }); atualizar(); }

function atualizar() {
    const { notasC, moedasC, totalC, contagem } = lerContagem();
    $("cx-notas").textContent = C.moeda(notasC / 100);
    $("cx-moedas").textContent = C.moeda(moedasC / 100);
    $("cx-total").textContent = C.moeda(totalC / 100);
    NOTAS.forEach(v => { const q = contagem[nomeNota(v)]; $(`cx-sub-${nomeNota(v)}`).textContent = q ? C.moeda(q * v) : ""; });
    MOEDAS.forEach(c => { const q = contagem[nomeMoeda(c)]; $(`cx-sub-${nomeMoeda(c)}`).textContent = q ? C.moeda(q * c / 100) : ""; });

    const abertura = S.modo === "abertura";
    document.querySelectorAll("#cxCorpo [data-modo]").forEach(b => b.classList.toggle("on", b.dataset.modo === S.modo));
    $("cxTitulo").textContent = abertura ? "Abrir Caixa" : "Fechar Caixa";
    $("btnConfirmarFechar").textContent = abertura ? "Abrir caixa" : "Fechar caixa";
    $("cxAjuda").textContent = abertura
        ? "Conte o dinheiro que está na gaveta ANTES de começar a vender. Se não bater com o sistema, o motivo fica registrado."
        : "Conte tudo no fim do dia. O sistema mostra a diferença e pergunta para onde foi (ou de onde veio).";
    $("cxOutros").style.display = abertura ? "none" : "";

    const contado = lerContado();
    ["dinheiro", "pix", "cartao"].forEach(f => {
        const bloco = $(`cx-dif-${f}`);
        if (!bloco) return;
        const tem = contado[f] !== undefined && !(abertura && f !== "dinheiro");
        const dif = tem ? r2(contado[f] - S.esperado[f]) : 0;
        const mostrar = tem && Math.abs(dif) >= 0.01;
        bloco.style.display = mostrar ? "" : "none";
        if (mostrar) {
            $(`cx-dif-txt-${f}`).innerHTML = `${FORMAS[f]}: sistema ${C.moeda(S.esperado[f])} · contado ${C.moeda(contado[f])} → <b class="${dif < 0 ? "cx-falta" : "cx-sobra"}">${dif < 0 ? "FALTOU" : "SOBROU"} ${C.moeda(Math.abs(dif))}</b>`;
            const mot = $(`cx-mot-${f}`).value, aj = $(`cx-aj-${f}`);
            if (mot === "recontar") { aj.checked = false; aj.disabled = true; } else aj.disabled = false;
        }
    });
    // aviso de "bateu" para o dinheiro (só depois de começar a contar)
    const ok = $("cx-ok-dinheiro") || (() => { const p = document.createElement("p"); p.id = "cx-ok-dinheiro"; p.className = "cx-bateu"; $("cx-dif-dinheiro").before(p); return p; })();
    const dd = r2(contado.dinheiro - S.esperado.dinheiro);
    ok.textContent = (totalC > 0 && Math.abs(dd) < 0.01) ? "✅ Dinheiro bateu certinho com o sistema!" : "";
}

// ---------- confirmar ----------
export async function confirmarConferencia() {
    if (!S || !C) return false;
    const abertura = S.modo === "abertura";
    const { contagem, notasC, moedasC, totalC } = lerContagem();
    const contado = lerContado();
    if (totalC === 0 && S.esperado.dinheiro > 0 &&
        !confirm(`Você contou R$ 0,00 de dinheiro, mas o sistema espera ${C.moeda(S.esperado.dinheiro)}. Confirma mesmo?`)) return false;

    const diferencas = {}, motivos = {}, ajuste = {};
    for (const f of Object.keys(contado)) {
        const dif = r2(contado[f] - S.esperado[f]);
        diferencas[f] = dif;
        if (Math.abs(dif) < 0.01) continue;
        const mot = $(`cx-mot-${f}`).value;
        if (!mot) { alert(`${FORMAS[f]}: ${dif < 0 ? "faltou" : "sobrou"} ${C.moeda(Math.abs(dif))}. Escolha para onde foi (ou de onde veio) antes de continuar.`); $(`cx-mot-${f}`).focus(); return false; }
        motivos[f] = { motivo: mot, texto: (MOTIVOS.find(m => m[0] === mot) || [])[1] || mot, obs: ($(`cx-obs-${f}`).value || "").trim() };
        if ($(`cx-aj-${f}`).checked && mot !== "recontar") ajuste[f] = dif;
    }
    const linhas = Object.keys(contado).map(f => `${FORMAS[f]}: sistema ${C.moeda(S.esperado[f])} | contado ${C.moeda(contado[f])} | ${Math.abs(diferencas[f]) < 0.01 ? "bateu" : (diferencas[f] < 0 ? "faltou " : "sobrou ") + C.moeda(Math.abs(diferencas[f]))}`);
    const ajTxt = Object.keys(ajuste).length ? `\n\nO saldo do sistema será acertado: ${Object.entries(ajuste).map(([f, v]) => `${FORMAS[f]} ${v > 0 ? "+" : "-"}${C.moeda(Math.abs(v))}`).join(", ")}.` : "";
    if (!confirm(`${abertura ? "ABRIR" : "FECHAR"} o caixa?\n\n${linhas.join("\n")}${ajTxt}`)) return false;

    const registro = {
        tipo: abertura ? "abertura" : "fechamento", data: new Date(),
        esperado: { ...S.esperado }, contado, diferencas, motivos,
        contagemDinheiro: contagem, totalNotas: notasC / 100, totalMoedas: moedasC / 100,
        ajusteAplicado: Object.keys(ajuste).length ? ajuste : null,
        por: C.usuario ? (C.usuario() || null) : null,
        // campos do formato antigo, para não quebrar nada que leia esta coleção
        saldoReal: contado.dinheiro, dinheiroFisicoEsperado: S.esperado.dinheiro
    };
    try { await addDoc(collection(C.db, "fechamento_caixa"), registro); }
    catch (e) { console.error(e); alert("Não consegui salvar a conferência. Nada foi alterado. Confira a internet e tente de novo."); return false; }

    try { for (const [f, v] of Object.entries(ajuste)) await C.ajustarSaldo(v, f); }
    catch (e) { console.error(e); alert("A conferência foi salva, mas não consegui acertar o saldo do sistema. Use 'Ajustar caixa' manualmente."); return true; }
    alert(abertura ? "☀️ Caixa aberto! Bom movimento!" : "🌙 Caixa fechado e conferido!");
    return true;
}
