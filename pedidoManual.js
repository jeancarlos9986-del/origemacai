// ==============================================
// PEDIDO MANUAL (WhatsApp) — Nova Origem Açaí
// ==============================================
// Lança no sistema um pedido que o cliente fez pelo WhatsApp, SEM passar pela
// cozinha: entra no financeiro (status "concluido") e dá baixa no estoque com
// a mesma função que a cozinha usa (processarPedidoSeguro).
//
// Formas de pagamento:
//   Dinheiro / Cartão  -> status "concluido"   (entra no caixa na hora)
//   PIX já caiu        -> status "concluido"   (pagamento "Pix", SEM gerar QR Code)
//   PIX ainda não caiu -> status "pix_pendente" (NÃO entra no caixa; o estoque já
//                         é baixado, porque o produto já foi entregue). Depois você
//                         confirma ("Caiu") ou marca "Não pagou".
import { protegerPagina } from "./auth-guard.js";
import { db, auth } from "./firebase.js";
import { escutarProdutos, escutarAdicionais } from "./catalogo.js";
import { construirMapaEstoque, processarPedidoSeguro, estornarPedidoSeguro } from "./estoqueBaixa.js";
import { esc } from "./utils.js";
import {
    collection, addDoc, query, where, onSnapshot, updateDoc, doc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const $ = id => document.getElementById(id);
const moeda = v => "R$ " + Number(v || 0).toFixed(2).replace(".", ",");

const FORMAS = {
    dinheiro: { label: "💵 Dinheiro", sub: "já recebi", texto: "Dinheiro", status: "concluido" },
    cartao: { label: "💳 Cartão", sub: "já recebi", texto: "Cartão", status: "concluido" },
    pix_ok: { label: "💸 PIX já caiu", sub: "na minha chave", texto: "Pix", status: "concluido", pixPorFora: true },
    pix_pend: { label: "⏳ PIX ainda não caiu", sub: "cliente prometeu", texto: "Pix", status: "pix_pendente", pixPorFora: true, pend: true }
};

let produtos = [], adGratis = [], adExtras = [];
let itens = [];            // { uid, prod, gratis:[nomes], extras:[nomes] }
let forma = "dinheiro";
let seq = 0, salvando = false, msgTimer = null;

// ---------- utilitários ----------
function aviso(texto, tipo = "") {
    const el = $("msg");
    el.textContent = texto; el.className = tipo; el.classList.remove("hidden");
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => el.classList.add("hidden"), tipo === "erro" ? 7000 : 3500);
}
const soDigitos = s => String(s || "").replace(/\D/g, "");
function linkZap(fone, texto) {
    let d = soDigitos(fone);
    if (d.length === 10 || d.length === 11) d = "55" + d;
    if (d.length < 12) return null;
    return `https://wa.me/${d}?text=${encodeURIComponent(texto)}`;
}
function precoItem(it) {
    const extras = it.extras.filter(n => !(it.prod.extrasFixos || []).includes(n));
    return it.prod.preco + extras.reduce((s, n) => s + (adExtras.find(a => a.nome === n)?.preco || 0), 0);
}
function calcTotais() {
    const subtotal = Number(itens.reduce((s, it) => s + precoItem(it), 0).toFixed(2));
    const ajuste = parseFloat(String($("ajuste").value).replace(",", ".")) || 0;
    return { subtotal, ajuste, total: Math.max(0, Number((subtotal + ajuste).toFixed(2))) };
}

// ---------- tela: produtos, itens, pagamento ----------
function pintarProdutos() {
    const box = $("prods");
    if (!produtos.length) { box.innerHTML = `<p class="vazio">Nenhum produto encontrado no cardápio.</p>`; return; }
    box.innerHTML = produtos.map(p => `
        <button class="prod" data-id="${esc(p.id)}" ${p.esgotado ? "disabled" : ""}>
            ${esc(p.nome)}${p.esgotado ? " (esgotado)" : ""}<b>${moeda(p.preco)}</b>
        </button>`).join("");
}

function pintarItens() {
    const box = $("itens");
    box.innerHTML = itens.map(it => {
        const lim = it.prod.limiteGratis || 0;
        const passou = it.gratis.length > lim;
        const fixos = it.prod.extrasFixos || [];
        const gratisHtml = (it.prod.customizavel && lim > 0) ? `
            <div class="rotulo ${passou ? "alerta" : ""}">Adicionais grátis (${it.gratis.length}/${lim})${passou ? " — passou do limite, use o Ajuste" : ""}</div>
            <div class="chips">${adGratis.filter(a => a.ativo).map(a => `<button class="chip ${it.gratis.includes(a.nome) ? "on" : ""}" data-acao="gratis" data-uid="${it.uid}" data-nome="${esc(a.nome)}">${esc(a.nome)}</button>`).join("")}</div>` : "";
        const extrasHtml = it.prod.customizavel ? `
            <div class="rotulo">Adicionais pagos</div>
            <div class="chips">
                ${fixos.map(n => `<span class="chip fixo">${esc(n)} (já incluso)</span>`).join("")}
                ${adExtras.filter(a => a.ativo && !fixos.includes(a.nome)).map(a => `<button class="chip ${it.extras.includes(a.nome) ? "on" : ""}" data-acao="extra" data-uid="${it.uid}" data-nome="${esc(a.nome)}">${esc(a.nome)} +${moeda(a.preco)}</button>`).join("")}
            </div>` : "";
        return `<div class="item">
            <div class="item-topo"><strong>${esc(it.prod.nome)}</strong><span class="preco">${moeda(precoItem(it))}</span>
                <button class="mini" data-acao="dup" data-uid="${it.uid}">Duplicar</button>
                <button class="mini perigo" data-acao="rem" data-uid="${it.uid}">Remover</button></div>
            ${gratisHtml}${extrasHtml}</div>`;
    }).join("");
    atualizarBarra();
}

function pintarPagamentos() {
    $("pags").innerHTML = Object.entries(FORMAS).map(([k, f]) =>
        `<button class="pag ${f.pend ? "pend" : ""} ${k === forma ? "on" : ""}" data-forma="${k}">${f.label}<small>${f.sub}</small></button>`).join("");
}

function atualizarBarra() {
    const { total } = calcTotais();
    $("barra").classList.toggle("hidden", itens.length === 0);
    $("resumo").textContent = `${itens.length} ${itens.length === 1 ? "item" : "itens"} · ${FORMAS[forma].texto}${FORMAS[forma].pend ? " (pendente)" : ""}`;
    $("totalTxt").textContent = moeda(total);
}

function novoItem(prod) {
    return { uid: ++seq, prod, gratis: [...(prod.gratisPadrao || [])].slice(0, prod.limiteGratis || 0), extras: [...(prod.extrasFixos || [])] };
}
const alternar = (lista, nome) => { const i = lista.indexOf(nome); i >= 0 ? lista.splice(i, 1) : lista.push(nome); };

// ---------- lançar ----------
function montarItemPedido(it) {
    return { id: it.prod.id, nome: it.prod.nome, preco: precoItem(it), gratis: [...it.gratis], extras: [...it.extras], obs: "" };
}

async function lancar() {
    if (salvando) return;
    if (!itens.length) return aviso("Toque em pelo menos um produto.", "erro");
    const { subtotal, ajuste, total } = calcTotais();
    if (total <= 0) return aviso("O total está zerado. Confira os itens e o ajuste.", "erro");
    if (itens.some(it => it.gratis.length > (it.prod.limiteGratis || 0)) &&
        !confirm("Algum copo passou do limite de adicionais grátis. Lançar mesmo assim?")) return;

    const f = FORMAS[forma];
    const resumo = `${itens.length} item(ns) — ${moeda(total)} — ${f.label.replace(/^\S+\s/, "")}`;
    if (!confirm(`Lançar este pedido?\n${resumo}`)) return;

    salvando = true; $("lancarBtn").disabled = true;
    const agora = Date.now();
    const pedido = {
        numero: agora,
        nome: $("nome").value.trim() || "Cliente WhatsApp",
        fone: soDigitos($("fone").value),
        entrega: "retirada", endereco: "",
        pagamento: f.texto, troco: null,
        itens: itens.map(montarItemPedido),
        subtotal, desconto: ajuste < 0 ? Math.abs(ajuste) : 0, ajuste, total,
        status: f.status,
        origem: "whatsapp", lancadoManual: true, pixPorFora: !!f.pixPorFora,
        lancadoPor: auth.currentUser?.email || auth.currentUser?.uid || null,
        criadoEm: agora,
        hora: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })
    };
    if (f.pend) pedido.pixPendenteDesde = agora;

    let ref;
    try {
        ref = await addDoc(collection(db, "pedidos"), pedido);
    } catch (e) {
        console.error("Erro ao salvar pedido manual:", e);
        aviso("Não consegui salvar o pedido. Nada foi lançado. Confira a internet e tente de novo.", "erro");
        salvando = false; $("lancarBtn").disabled = false;
        return;
    }

    // Baixa de estoque (mesma função da cozinha). Se falhar, o pedido já está salvo.
    let estoqueOk = true;
    try {
        await processarPedidoSeguro(ref.id, await construirMapaEstoque());
    } catch (e) {
        estoqueOk = false;
        console.error("Pedido salvo, mas a baixa de estoque falhou:", e);
    }

    itens = []; $("nome").value = ""; $("fone").value = ""; $("ajuste").value = "";
    pintarItens();
    aviso(estoqueOk ? "✅ Pedido lançado! Financeiro e estoque atualizados." :
        "⚠️ Pedido salvo, mas a baixa do estoque falhou. Abra a tela Estoque para ele ser conferido.", estoqueOk ? "ok" : "erro");
    salvando = false; $("lancarBtn").disabled = false;
}

// ---------- listas ao vivo ----------
function escutarPendentes() {
    onSnapshot(query(collection(db, "pedidos"), where("status", "==", "pix_pendente")), snap => {
        const lista = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.criadoEm || 0) - (b.criadoEm || 0));
        const box = $("pendentes");
        if (!lista.length) { box.innerHTML = `<p class="vazio">Nenhum PIX pendente. 👍</p>`; return; }
        box.innerHTML = lista.map(p => {
            const min = Math.max(0, Math.round((Date.now() - (p.criadoEm || Date.now())) / 60000));
            const tempo = min < 60 ? `${min} min` : min < 1440 ? `${Math.floor(min / 60)} h` : `${Math.floor(min / 1440)} dia(s)`;
            const zap = linkZap(p.fone, `Oi ${p.nome && p.nome !== "Cliente WhatsApp" ? p.nome : ""}! Aqui é da Nova Origem Açaí. Ainda não vi cair o PIX de ${moeda(p.total)} do seu pedido de hoje. Pode conferir pra mim? 💜`);
            return `<div class="reg"><div class="reg-topo"><strong>${esc(p.nome)}</strong><b>${moeda(p.total)}</b></div>
                <small>há ${tempo}${p.fone ? " · " + esc(p.fone) : ""}</small>
                <div class="acoes">
                    <button class="mini" data-acao="pix-ok" data-id="${p.id}">✅ Caiu o PIX</button>
                    ${zap ? `<a class="mini" href="${zap}" target="_blank" rel="noopener">Cobrar no WhatsApp</a>` : ""}
                    <button class="mini perigo" data-acao="pix-nao" data-id="${p.id}">❌ Não pagou</button>
                </div></div>`;
        }).join("");
    }, e => { console.error(e); $("pendentes").innerHTML = `<p class="vazio">Erro ao carregar (${esc(e.code || e.message)}).</p>`; });
}

function escutarHoje() {
    const ini = new Date(); ini.setHours(0, 0, 0, 0);
    onSnapshot(query(collection(db, "pedidos"), where("criadoEm", ">=", ini.getTime())), snap => {
        const lista = snap.docs.map(d => ({ id: d.id, ...d.data() }))
            .filter(p => p.origem === "whatsapp").sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0));
        const box = $("hoje");
        if (!lista.length) { box.innerHTML = `<p class="vazio">Nenhum ainda hoje.</p>`; return; }
        box.innerHTML = lista.map(p => {
            const sel = p.status === "pix_pendente" ? `<span class="sel pend">PIX pendente</span>`
                : p.status === "cancelado" ? `<span class="sel x">desfeito</span>`
                : p.status === "nao_pago" ? `<span class="sel x">não pagou</span>`
                : `<span class="sel ok">${esc(p.pagamento)}</span>`;
            const podeDesfazer = !["cancelado", "nao_pago"].includes(p.status) && !p.caixaCreditado;
            return `<div class="reg"><div class="reg-topo"><span>${esc(p.hora || "")} · <strong>${esc(p.nome)}</strong> ${sel}</span><b>${moeda(p.total)}</b></div>
                <small>${(p.itens || []).map(i => esc(i.nome)).join(", ")}</small>
                ${podeDesfazer ? `<div class="acoes"><button class="mini perigo" data-acao="desfazer" data-id="${p.id}">Desfazer (lancei errado)</button></div>` : ""}</div>`;
        }).join("");
    }, e => console.error(e));
}

async function confirmarPix(id) {
    if (!confirm("Confirma que o PIX já caiu na sua conta?")) return;
    try { await updateDoc(doc(db, "pedidos", id), { status: "concluido", confirmadoEm: Date.now(), atualizadoEm: new Date() }); aviso("✅ PIX confirmado. O valor entra no caixa.", "ok"); }
    catch (e) { console.error(e); aviso("Não consegui confirmar. Tente de novo.", "erro"); }
}
async function naoPagou(id) {
    if (!confirm("Marcar como NÃO PAGO?\nO valor não entra no caixa. O estoque continua baixado (o produto já foi entregue).")) return;
    try { await updateDoc(doc(db, "pedidos", id), { status: "nao_pago", naoPagoEm: Date.now(), atualizadoEm: new Date() }); aviso("Marcado como não pago.", "ok"); }
    catch (e) { console.error(e); aviso("Não consegui atualizar. Tente de novo.", "erro"); }
}
async function desfazer(id) {
    if (!confirm("Desfazer este pedido? O estoque volta e ele sai do financeiro.")) return;
    try {
        await estornarPedidoSeguro(id, await construirMapaEstoque());
        await updateDoc(doc(db, "pedidos", id), { status: "cancelado", canceladoEm: Date.now(), atualizadoEm: new Date() });
        aviso("Pedido desfeito e estoque devolvido.", "ok");
    } catch (e) { console.error(e); aviso("Não consegui desfazer. Tente de novo.", "erro"); }
}

// ---------- eventos ----------
function ligarEventos() {
    $("prods").addEventListener("click", ev => {
        const b = ev.target.closest(".prod"); if (!b) return;
        const p = produtos.find(x => x.id === b.dataset.id); if (!p) return;
        itens.push(novoItem(p)); pintarItens();
    });
    $("itens").addEventListener("click", ev => {
        const b = ev.target.closest("[data-acao]"); if (!b) return;
        const i = itens.findIndex(x => x.uid === Number(b.dataset.uid)); if (i < 0) return;
        const it = itens[i], a = b.dataset.acao;
        if (a === "gratis") alternar(it.gratis, b.dataset.nome);
        else if (a === "extra") alternar(it.extras, b.dataset.nome);
        else if (a === "rem") itens.splice(i, 1);
        else if (a === "dup") itens.splice(i + 1, 0, { ...it, uid: ++seq, gratis: [...it.gratis], extras: [...it.extras] });
        pintarItens();
    });
    $("pags").addEventListener("click", ev => {
        const b = ev.target.closest("[data-forma]"); if (!b) return;
        forma = b.dataset.forma; pintarPagamentos(); atualizarBarra();
    });
    $("ajuste").addEventListener("input", atualizarBarra);
    $("lancarBtn").addEventListener("click", lancar);
    document.body.addEventListener("click", ev => {
        const b = ev.target.closest("[data-acao]"); if (!b || !b.dataset.id) return;
        if (b.dataset.acao === "pix-ok") confirmarPix(b.dataset.id);
        else if (b.dataset.acao === "pix-nao") naoPagou(b.dataset.id);
        else if (b.dataset.acao === "desfazer") desfazer(b.dataset.id);
    });
}

protegerPagina(["financeiro", "estoque", "relatorio"]).then(({ perfil }) => {
    $("app").classList.remove("hidden");
    // Quem não é admin/financeiro não pode abrir o Financeiro (a proteção deslogaria a pessoa)
    if (!["admin", "financeiro"].includes(perfil)) document.querySelector("header a")?.classList.add("hidden");
    pintarPagamentos(); ligarEventos();
    escutarProdutos(db, lista => { produtos = lista; pintarProdutos(); pintarItens(); },
        e => { console.error(e); $("prods").innerHTML = `<p class="vazio">Erro ao carregar o cardápio (${esc(e.code || e.message)}).</p>`; });
    escutarAdicionais(db, a => { adGratis = a.gratis; adExtras = a.extras; pintarItens(); });
    escutarPendentes(); escutarHoje();
});
