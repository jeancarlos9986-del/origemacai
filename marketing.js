import { protegerPagina } from "./auth-guard.js";
import { db, auth } from "./firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ===== CONFIGURAÇÃO =====
const API_URL = "https://origemacai.onrender.com";
// Enquanto a rota /marketing/plano não existir no Render, deixe true (plano de exemplo).
// Quando o backend estiver pronto, troque para false.
const MODO_TESTE = false;

const DIAS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const $ = (id) => document.getElementById(id);

const contexto = { dia: DIAS[new Date().getDay()], temperatura: null, promocao: null };

function status(msg, erro = false) {
    $("status").textContent = msg;
    $("status").classList.toggle("erro", erro);
}

// ===== CONTEXTO: PROMOÇÃO ATIVA (mesma regra do site.html) =====
async function carregarPromocao() {
    try {
        const snap = await getDoc(doc(db, "configuracoes", "loja"));
        const promo = snap.exists() ? snap.data().promocao : null;
        const hoje = new Date().getDay();
        const vale = promo && promo.ativa &&
            (!promo.diasSemana || promo.diasSemana.length === 0 || promo.diasSemana.includes(hoje));

        contexto.promocao = vale ? {
            produtoNome: promo.produtoNome || "",
            tipo: promo.tipo || "",
            precoPromocional: promo.precoPromocional ?? null,
            etiqueta: promo.etiqueta || ""
        } : null;
    } catch (e) {
        console.error("Erro ao ler promoção:", e);
        contexto.promocao = null;
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
    const p = contexto.promocao;
    $("ctxPromo").textContent = p ? (p.etiqueta || p.produtoNome || "Ativa") : "Nenhuma hoje";
}

async function atualizarClima() {
    const cidade = $("cidadeInput").value.trim();
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
    const p = c.promocao;
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
async function gerarPlano() {
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
                body: JSON.stringify(contexto)
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
    $("resultado").classList.remove("hidden");
}

// ===== INÍCIO =====
protegerPagina(["marketing"]).then(async () => {
    $("app").classList.remove("hidden");
    $("cidadeInput").value = localStorage.getItem("mkt_cidade") || "";
    $("cidadeBtn").addEventListener("click", atualizarClima);
    $("gerarBtn").addEventListener("click", gerarPlano);
    document.addEventListener("click", (e) => {
        const alvo = e.target.dataset && e.target.dataset.copiar;
        if (alvo) {
            navigator.clipboard.writeText($(alvo).textContent);
            e.target.textContent = "Copiado";
            setTimeout(() => (e.target.textContent = "Copiar"), 1500);
        }
    });
    await carregarPromocao();
    pintarContexto();
    if ($("cidadeInput").value) atualizarClima();
});
