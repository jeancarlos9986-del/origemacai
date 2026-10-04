import { protegerPagina } from "./auth-guard.js";
import { db, auth } from "./firebase.js";
import { TEMPLATES, desenharArte, carregarImagem } from "./arteMarketing.js";
import { doc, getDoc, collection, getDocs } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ===== CONFIGURAÇÃO =====
const API_URL = "https://origemacai.onrender.com";
// Enquanto a rota /marketing/plano não existir no Render, deixe true (plano de exemplo).
// Quando o backend estiver pronto, troque para false.
const MODO_TESTE = false;

const DIAS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const $ = (id) => document.getElementById(id);

const LOGO_URL = "./logonovonova.png.jpeg";
let catalogo = [];   // produtos com foto, usados na arte
const contexto = { dia: DIAS[new Date().getDay()], temperatura: null, promocoes: [], ofertas: [] };
let ultimoPlano = null;

function status(msg, erro = false) {
    $("status").textContent = msg;
    $("status").classList.toggle("erro", erro);
}

// ===== CONTEXTO: PROMOÇÃO ATIVA (mesma regra do site.html) =====
async function carregarPromocao() {
    try {
        const snap = await getDoc(doc(db, "configuracoes", "loja"));
        const d = snap.exists() ? snap.data() : {};
        const lista = Array.isArray(d.promocoes) && d.promocoes.length ? d.promocoes : (d.promocao ? [d.promocao] : []);
        const hoje = new Date().getDay();
        contexto.promocoes = lista
            .filter((p) => p && p.ativa && (!p.diasSemana || p.diasSemana.length === 0 || p.diasSemana.includes(hoje)))
            .map((p) => ({
                produtoNome: p.produtoNome || "", tipo: p.tipo || "",
                precoPromocional: p.precoPromocional ?? null, etiqueta: p.etiqueta || "",
                limiteGratisPromocional: p.limiteGratisPromocional ?? null
            }));
    } catch (e) {
        console.error("Erro ao ler promoções:", e);
        contexto.promocoes = [];
    }
}

// ===== CONTEXTO: OFERTAS DO CARDÁPIO (preço promocional por produto) =====
async function carregarOfertasCardapio() {
    try {
        const snap = await getDocs(collection(db, "cardapio_produtos"));
        const todos = snap.docs.map((d) => d.data());
        catalogo = todos
            .filter((p) => p.nome && Array.isArray(p.imagens) && p.imagens[0] && (p.status || "disponivel") !== "esgotado")
            .map((p) => ({ nome: p.nome, foto: String(p.imagens[0]).trim(), preco: Number(p.preco) || 0, precoPromocional: Number(p.precoPromocional) || 0 }));
        contexto.ofertas = todos
            .filter((p) => (p.status || "disponivel") !== "esgotado")
            .map((p) => ({ nome: p.nome || "", precoOriginal: Number(p.preco) || 0, precoPromocional: Number(p.precoPromocional) }))
            .filter((p) => p.nome && p.precoPromocional > 0 && p.precoPromocional < p.precoOriginal);
    } catch (e) {
        console.error("Erro ao ler ofertas do cardápio:", e);
        contexto.ofertas = [];
    }
}

// ===== CONTEXTO: CLIMA (Open-Meteo, gratuito e sem chave) =====
async function buscarClima(cidade) {
    const geo = await (await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cidade)}&count=1&language=pt&country_code=BR`
    )).json();
    if (!geo.results || !geo.results.length) throw new Error("Cidade não encontrada");
    const { latitude, longitude } = geo.results[0];
    const clima = await (await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m&timezone=auto`
    )).json();
    return Math.round(clima.current.temperature_2m);
}

function pintarContexto() {
    $("ctxDia").textContent = contexto.dia;
    $("ctxTemp").textContent = contexto.temperatura === null ? "não informada" : `${contexto.temperatura}°C`;
    const nomes = [];
    contexto.promocoes.forEach((p) => nomes.push(p.produtoNome || p.etiqueta || "Promoção do painel"));
    contexto.ofertas.forEach((o) => nomes.push(`${o.nome} (R$ ${o.precoPromocional.toFixed(2).replace(".", ",")})`));
    $("ctxPromo").textContent = nomes.length ? nomes.join(" · ") : "Nenhuma hoje";
}

async function atualizarClima() {
    const cidade = $("cidadeInput").value.trim();
    if ($("tempManual").value !== "") return;
    if (!cidade) { status("Digite a cidade da loja para buscar o clima."); return; }
    $("cidadeBtn").disabled = true;
    try {
        contexto.temperatura = await buscarClima(cidade);
        localStorage.setItem("mkt_cidade", cidade);
        status("");
    } catch (e) {
        status("Não consegui buscar o clima. Confira o nome da cidade.", true);
    }
    $("cidadeBtn").disabled = false;
    pintarContexto();
}

// ===== PLANO (exemplo local, usado só no MODO_TESTE) =====
function planoDeExemplo(c) {
    const quente = c.temperatura !== null && c.temperatura >= 28;
    const frio = c.temperatura !== null && c.temperatura <= 18;
    const p = c.promocoes[0] || (c.ofertas[0] ? { produtoNome: c.ofertas[0].nome } : null);
    const tema = p
        ? `Promoção do dia: ${p.etiqueta || p.produtoNome}`
        : quente ? "Calor pede açaí gelado" : frio ? "Dia de ficar em casa com um copo recheado" : `Boa ${c.dia} com açaí`;
    return {
        tema,
        legendaFeed: p
            ? `Hoje tem ${p.produtoNome || "promoção"} com condição especial! Peça pelo site e receba em casa. 💜`
            : `${quente ? "Esse calor merece um açaí bem gelado." : `Seu açaí de ${c.dia} está esperando.`} Peça pelo nosso site! 💜`,
        sugestaoFoto: "Foto do copo mais vendido, bem recheado, em fundo claro.",
        stories: [
            { momento: "Manhã", ideia: "Bastidor: a cozinha preparando os copos do dia." },
            { momento: "Tarde", ideia: "Print de um feedback de cliente satisfeito." },
            { momento: "Noite", ideia: "Chamada para o pedido da noite, com link do site." }
        ]
    };
}

// ===== GERAR =====
async function gerarPlano(opcoes = {}) {
    $("gerarBtn").disabled = true;
    $("resultado").classList.add("hidden");
    status("Gerando o plano de hoje…");
    const aviso = setTimeout(() => status("Acordando o servidor, isso pode levar até 50 segundos…"), 4000);

    try {
        let plano;
        if (MODO_TESTE) {
            plano = planoDeExemplo(contexto);
        } else {
            const token = await auth.currentUser.getIdToken();
            const r = await fetch(`${API_URL}/marketing/plano`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
                body: JSON.stringify({ temperatura: contexto.temperatura, ...opcoes })
            });
            const corpo = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(corpo.erro || `Servidor respondeu ${r.status}`);
            plano = corpo;
        }
        mostrar(plano);
        status("");
    } catch (e) {
        console.error(e);
        status(e.message || "Não foi possível gerar o plano agora. Tente de novo em instantes.", true);
    }
    clearTimeout(aviso);
    $("gerarBtn").disabled = false;
}

function mostrar(p) {
    ultimoPlano = p;
    $("resTema").textContent = p.tema;
    $("resFeed").textContent = p.legendaFeed;
    $("resFoto").textContent = p.sugestaoFoto ? `Foto sugerida: ${p.sugestaoFoto}` : "";
    $("resStories").innerHTML = "";
    (p.stories || []).forEach((s) => {
        const d = document.createElement("div");
        d.className = "momento";
        const t = document.createElement("b");
        t.textContent = s.momento;
        const x = document.createElement("p");
        x.className = "texto";
        x.textContent = s.ideia;
        d.append(t, x);
        $("resStories").appendChild(d);
    });
    $("avisoTeste").classList.toggle("hidden", !MODO_TESTE);
    prepararArte(p);
    $("resultado").classList.remove("hidden");
}

// ===== ARTE DO DIA (canvas) =====
const arte = { template: "roxo", formato: "feed", logo: null };
const norm = (t) => (t || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
const msgArte = (t) => { $("arteMsg").textContent = t || ""; $("arteMsg").classList.toggle("hidden", !t); };
const reais = (n) => "R$ " + Number(n).toFixed(2).replace(".", ",");
const fontesProntas = Promise.all(["600", "700", "800", "900"].map((w) => document.fonts.load(`${w} 40px "Poppins"`))).catch(() => {});

// Selo de destaque do produto: preço promocional, adicionais grátis ou copo do dia
function seloDoProduto(p) {
    const doPainel = (tipo) => contexto.promocoes.find((x) => x.tipo === tipo && norm(x.produtoNome) === norm(p.nome));
    const pr = doPainel("preco");
    if (pr && pr.precoPromocional > 0) return { topo: "de " + reais(p.preco), riscado: true, grande: reais(pr.precoPromocional) };
    const gr = doPainel("limiteGratis");
    if (gr && gr.limiteGratisPromocional > 0) return { topo: "Adicionais", grande: `${gr.limiteGratisPromocional} grátis` };
    const cf = doPainel("copoFixo");
    if (cf && cf.precoPromocional > 0) return { topo: "Copo do dia", grande: reais(cf.precoPromocional) };
    if (p.precoPromocional > 0 && p.precoPromocional < p.preco) return { topo: "de " + reais(p.preco), riscado: true, grande: reais(p.precoPromocional) };
    return null;
}

const ajusteAtual = () => ({ zoom: Number($("ajZoom").value) / 100, x: Number($("ajX").value) / 100, y: Number($("ajY").value) / 100 });
const zerarAjuste = () => { $("ajZoom").value = 100; $("ajX").value = 0; $("ajY").value = 0; };

function prepararArte(plano) {
    if (!catalogo.length) { $("arteBox").classList.add("hidden"); return; }
    $("arteBox").classList.remove("hidden");
    const porNome = (n) => n && catalogo.find((p) => norm(p.nome) === norm(n));
    const escolhido = porNome(plano.produto) || porNome(contexto.promocoes[0] && contexto.promocoes[0].produtoNome)
        || porNome(contexto.ofertas[0] && contexto.ofertas[0].nome) || catalogo[0];
    ["prodArte", "prodArte2"].forEach((id) => {
        $(id).innerHTML = "";
        catalogo.forEach((p, i) => { const o = document.createElement("option"); o.value = i; o.textContent = p.nome; $(id).appendChild(o); });
    });
    $("prodArte").value = catalogo.indexOf(escolhido);
    const outro = catalogo.find((p) => p !== escolhido && seloDoProduto(p)) || catalogo.find((p) => p !== escolhido) || escolhido;
    $("prodArte2").value = catalogo.indexOf(outro);
    const a = plano.arte || {};
    $("arteTitulo").value = a.titulo || plano.tema || "";
    $("arteSub").value = a.subtitulo || "";
    $("arteChamada").value = a.chamada || "Peça pelo site";
    zerarAjuste();
    arte.template = seloDoProduto(escolhido) ? "promo" : "roxo";
    pintarBotoesArte();
    renderizarArte();
}

function pintarBotoesArte() {
    $("tplBtns").innerHTML = "";
    TEMPLATES.forEach((t) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "sec" + (t.id === arte.template ? " on" : ""); b.dataset.tpl = t.id; b.textContent = t.nome;
        $("tplBtns").appendChild(b);
    });
    document.querySelectorAll("#formatoBtns button").forEach((b) => b.classList.toggle("on", b.dataset.formato === arte.formato));
    $("prod2Box").classList.toggle("hidden", arte.template !== "dupla");
}

async function montarParams(formato) {
    await fontesProntas;
    const prod = catalogo[Number($("prodArte").value)];
    if (!prod) return null;
    const carregar = async (p) => { try { return await carregarImagem(p.foto); } catch (e) { return null; } };
    const foto = await carregar(prod);
    if (!foto) msgArte("Não consegui carregar a foto deste produto. Escolha outro na lista.");
    if (!arte.logo) { try { arte.logo = await carregarImagem(LOGO_URL); } catch (e) { arte.logo = null; } }
    const aj = ajusteAtual();
    const params = {
        template: arte.template, formato, foto, logo: arte.logo, ajuste: aj, selo: seloDoProduto(prod),
        titulo: $("arteTitulo").value || "Nova Origem Açaí", subtitulo: $("arteSub").value,
        chamada: $("arteChamada").value || "Peça pelo site"
    };
    if (arte.template === "dupla") {
        const prod2 = catalogo[Number($("prodArte2").value)];
        params.fotos = [
            { foto, selo: params.selo, nome: prod.nome, ajuste: aj },
            { foto: await carregar(prod2), selo: seloDoProduto(prod2), nome: prod2.nome, ajuste: { zoom: 1, x: 0, y: 0 } }
        ];
    }
    return params;
}

let renderId = 0;
async function renderizarArte() {
    const meu = ++renderId;
    msgArte("");
    const params = await montarParams(arte.formato);
    if (!params || meu !== renderId) return;
    desenharArte($("arteCanvas"), params);
}

const nomeArquivo = (f) => `nova-origem-${contexto.dia}-${arte.template}-${f}.png`;
const paraBlob = (cv) => new Promise((ok, erro) => {
    try { cv.toBlob((b) => (b ? ok(b) : erro(new Error("vazio"))), "image/png"); } catch (e) { erro(e); }
});
function salvarBlob(blob, nome) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = nome; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const SEM_EXPORTAR = "Esta foto não permite baixar a arte. Escolha outro produto na lista.";

async function baixarArte() {
    try { salvarBlob(await paraBlob($("arteCanvas")), nomeArquivo(arte.formato)); } catch (e) { msgArte(SEM_EXPORTAR); }
}

async function baixarAmbos() {
    try {
        for (const f of ["feed", "story"]) {
            const params = await montarParams(f);
            if (!params) return;
            const cv = document.createElement("canvas");
            desenharArte(cv, params);
            salvarBlob(await paraBlob(cv), nomeArquivo(f));
            await new Promise((r) => setTimeout(r, 500));
        }
    } catch (e) { msgArte(SEM_EXPORTAR); }
}

async function compartilharArte() {
    try {
        const blob = await paraBlob($("arteCanvas"));
        const dados = { files: [new File([blob], nomeArquivo(arte.formato), { type: "image/png" })], text: $("resFeed").textContent };
        if (navigator.canShare && navigator.canShare(dados)) await navigator.share(dados);
        else salvarBlob(blob, nomeArquivo(arte.formato));
    } catch (e) {
        if (e.name !== "AbortError") msgArte("Não foi possível compartilhar. Use Baixar imagem.");
    }
}

// ===== INÍCIO =====
protegerPagina(["marketing"]).then(async () => {
    $("app").classList.remove("hidden");
    $("cidadeInput").value = localStorage.getItem("mkt_cidade") || "";
    $("cidadeBtn").addEventListener("click", atualizarClima);
    $("gerarBtn").addEventListener("click", () => gerarPlano());
    document.addEventListener("click", (e) => {
        const alvo = e.target.dataset && e.target.dataset.copiar;
        if (alvo) {
            navigator.clipboard.writeText($(alvo).textContent);
            e.target.textContent = "Copiado";
            setTimeout(() => (e.target.textContent = "Copiar"), 1500);
        }
    });
    $("tplBtns").addEventListener("click", (e) => { const t = e.target.dataset.tpl; if (t) { arte.template = t; pintarBotoesArte(); renderizarArte(); } });
    $("formatoBtns").addEventListener("click", (e) => { const f = e.target.dataset.formato; if (f) { arte.formato = f; pintarBotoesArte(); renderizarArte(); } });
    let espera;
    const redesenhar = () => { clearTimeout(espera); espera = setTimeout(renderizarArte, 250); };
    ["prodArte", "prodArte2", "arteTitulo", "arteSub", "arteChamada", "ajZoom", "ajX", "ajY"].forEach((id) => $(id).addEventListener("input", redesenhar));
    $("prodArte").addEventListener("change", zerarAjuste);
    $("ajReset").addEventListener("click", () => { zerarAjuste(); renderizarArte(); });
    $("baixarAmbosBtn").addEventListener("click", baixarAmbos);
    $("compartilharBtn").addEventListener("click", compartilharArte);
    if (navigator.share) $("compartilharBtn").classList.remove("hidden");
    $("tempManual").addEventListener("input", (e) => { contexto.temperatura = e.target.value === "" ? null : Number(e.target.value); pintarContexto(); });
    $("outraBtn").addEventListener("click", () => gerarPlano({ outra: true, temaAnterior: ultimoPlano ? ultimoPlano.tema : "" }));
    $("copiarTudoBtn").addEventListener("click", (e) => {
        const stories = [...document.querySelectorAll("#resStories .momento")].map((m) => `${m.children[0].textContent}: ${m.children[1].textContent}`).join("\n");
        navigator.clipboard.writeText(`${$("resTema").textContent}\n\n${$("resFeed").textContent}\n\nStories:\n${stories}`);
        e.target.textContent = "Copiado"; setTimeout(() => (e.target.textContent = "Copiar tudo"), 1500);
    });
    $("baixarBtn").addEventListener("click", baixarArte);
    await Promise.all([carregarPromocao(), carregarOfertasCardapio()]);
    pintarContexto();
    if ($("cidadeInput").value) atualizarClima();
});
