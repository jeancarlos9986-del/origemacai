// ==============================================
// MENU DE TELAS — Nova Origem Açaí
// ==============================================
// Um botão flutuante "☰" em todas as telas do sistema. Ele abre a lista de telas
// que ESSA pessoa pode abrir (o admin vê todas). Assim você entra com um login só.
//
// Para a pessoa ver o botão, ela precisa ter 2 ou mais telas liberadas (ou ser admin).
// Quem tem só uma tela (ex.: cozinha) não vê nada, fica tudo igual.
//
// Para adicionar uma tela nova: inclua uma linha em TELAS abaixo.
// Para ligar o menu numa página: <script type="module" src="./menu-telas.js"></script>
// no final do <body>.
import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// perfis: quem pode abrir (além do admin, que abre tudo). [] = só admin.
export const TELAS = [
    { grupo: "Visão geral", icone: "🏠", nome: "Início (visão do dono)", arquivo: "inicio.html", perfis: [] },
    { grupo: "Operação", icone: "🍳", nome: "Cozinha", arquivo: "cozinha.html", perfis: ["cozinha"] },
    { grupo: "Operação", icone: "🛵", nome: "Entregador", arquivo: "entregador.html", perfis: ["entregador"] },
    { grupo: "Operação", icone: "💬", nome: "Pedido de WhatsApp", arquivo: "pedido-manual.html", perfis: ["financeiro", "estoque", "relatorio"] },
    { grupo: "Estoque", icone: "📦", nome: "Estoque", arquivo: "estoque.html", perfis: ["estoque"] },
    { grupo: "Estoque", icone: "📋", nome: "Relatório do dia", arquivo: "relatorio-dia.html", perfis: ["estoque"] },
    { grupo: "Dinheiro", icone: "💰", nome: "Financeiro e caixa", arquivo: "financeiro.html", perfis: ["financeiro"] },
    { grupo: "Loja", icone: "🏪", nome: "Painel (promoção, fidelidade, clientes)", arquivo: "painel-nova-origem.html", perfis: [] },
    { grupo: "Loja", icone: "🍧", nome: "Cardápio", arquivo: "cardapio.html", perfis: ["cardapio"] },
    { grupo: "Loja", icone: "📣", nome: "Marketing", arquivo: "marketing.html", perfis: ["marketing"] },
    { grupo: "Sistema", icone: "🧹", nome: "Faxina de pedidos", arquivo: "limpeza-pedidos.html", perfis: [] }
];

const CHAVE_POS = "menuTelasPos";

function telasDoPerfil(perfil) {
    return TELAS.filter(t => perfil === "admin" || t.perfis.includes(perfil));
}

function css() {
    const s = document.createElement("style");
    s.textContent = `
    #mt-bolha{position:fixed;z-index:99998;width:46px;height:46px;border-radius:50%;border:2px solid #a855f7;background:linear-gradient(135deg,#7c1fd6,#a855f7);color:#fff;font:700 20px/1 system-ui,sans-serif;cursor:grab;box-shadow:0 4px 18px rgba(124,31,214,.55);display:flex;align-items:center;justify-content:center;touch-action:none;user-select:none;-webkit-user-select:none}
    #mt-bolha:active{cursor:grabbing}
    #mt-fundo,#mt-fundo *{box-sizing:border-box}
    #mt-fundo{position:fixed;inset:0;z-index:99999;background:rgba(5,2,10,.72);display:none;align-items:flex-end;justify-content:center}
    #mt-fundo.aberto{display:flex}
    #mt-painel{width:100%;max-width:520px;max-height:86vh;overflow:auto;background:#150a26;border:1.5px solid rgba(168,85,247,.5);border-radius:22px 22px 0 0;padding:16px 16px calc(18px + env(safe-area-inset-bottom,0px));color:#fff;font-family:"Poppins",system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
    @media(min-width:600px){#mt-fundo{align-items:center}#mt-painel{border-radius:22px}}
    #mt-topo{display:flex;align-items:center;gap:10px;margin-bottom:6px}
    #mt-topo strong{flex:1;font-size:1rem}
    #mt-topo small{display:block;color:#c4b5fd;font-weight:400;font-size:.72rem;margin-top:2px}
    #mt-fechar{background:none;border:1.5px solid #a855f7;color:#fff;border-radius:999px;width:34px;height:34px;font-size:16px;cursor:pointer}
    .mt-grupo{margin:14px 0 6px;font-size:.68rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#ffd60a}
    .mt-item{display:flex;align-items:center;gap:12px;width:100%;padding:13px 14px;margin:0 0 7px;border-radius:14px;border:1.5px solid rgba(168,85,247,.4);background:#1d0f33;color:#fff;text-decoration:none;font-size:.92rem;font-weight:600}
    .mt-item:active{transform:scale(.98)}
    .mt-item .ic{font-size:1.3rem}
    .mt-item.aqui{border-color:#ffd60a;background:#2a1a4a}
    .mt-item.aqui::after{content:"você está aqui";margin-left:auto;font-size:.66rem;color:#ffd60a;font-weight:700}
    #mt-sair{margin-top:14px;width:100%;padding:12px;border-radius:14px;border:1.5px solid #ff7a90;background:transparent;color:#ff7a90;font-weight:700;font-size:.9rem;font-family:inherit;cursor:pointer}
    @media print{#mt-bolha,#mt-fundo{display:none!important}}`;
    document.head.appendChild(s);
}

function posicaoInicial() {
    try { const p = JSON.parse(localStorage.getItem(CHAVE_POS) || "null"); if (p && typeof p.x === "number") return p; } catch (e) { /* sem storage: usa padrão */ }
    return { x: 12, y: window.innerHeight - 46 - 96 };   // canto esquerdo, acima de barras fixas de baixo
}
function limitar(p) {
    return { x: Math.min(Math.max(4, p.x), window.innerWidth - 50), y: Math.min(Math.max(4, p.y), window.innerHeight - 50) };
}

function montar(perfil, nome) {
    const lista = telasDoPerfil(perfil);
    if (perfil !== "admin" && lista.length < 2) return;      // só uma tela: não precisa de menu

    css();
    const aqui = location.pathname.split("/").pop() || "";
    const grupos = [...new Set(lista.map(t => t.grupo))];
    const fundo = document.createElement("div");
    fundo.id = "mt-fundo";
    fundo.innerHTML = `<div id="mt-painel" role="dialog" aria-label="Menu de telas">
        <div id="mt-topo"><strong>Telas<small></small></strong><button id="mt-fechar" type="button" aria-label="Fechar">✕</button></div>
        ${grupos.map(g => `<div class="mt-grupo">${g}</div>${lista.filter(t => t.grupo === g).map(t =>
            `<a class="mt-item ${t.arquivo === aqui ? "aqui" : ""}" href="./${t.arquivo}"><span class="ic">${t.icone}</span>${t.nome}</a>`).join("")}`).join("")}
        <div class="mt-grupo">Outros</div>
        <a class="mt-item" href="./site.html"><span class="ic">🌐</span>Ver o site do cliente</a>
        <button id="mt-sair" type="button">Sair do sistema</button>
    </div>`;
    fundo.querySelector("small").textContent = `${nome || "Usuário"} · perfil ${perfil}`;
    document.body.appendChild(fundo);

    const bolha = document.createElement("button");
    bolha.id = "mt-bolha"; bolha.type = "button"; bolha.textContent = "☰"; bolha.setAttribute("aria-label", "Abrir menu de telas");
    let pos = limitar(posicaoInicial());
    const aplicar = () => { bolha.style.left = pos.x + "px"; bolha.style.top = pos.y + "px"; };
    aplicar(); document.body.appendChild(bolha);

    // arrastar a bolha (e distinguir de um toque)
    let arrastando = false, moveu = false, dx = 0, dy = 0;
    bolha.addEventListener("pointerdown", ev => { arrastando = true; moveu = false; dx = ev.clientX - pos.x; dy = ev.clientY - pos.y; bolha.setPointerCapture(ev.pointerId); });
    bolha.addEventListener("pointermove", ev => {
        if (!arrastando) return;
        const nx = ev.clientX - dx, ny = ev.clientY - dy;
        if (Math.abs(nx - pos.x) + Math.abs(ny - pos.y) > 4) moveu = true;
        pos = limitar({ x: nx, y: ny }); aplicar();
    });
    bolha.addEventListener("pointerup", () => {
        arrastando = false;
        if (moveu) { try { localStorage.setItem(CHAVE_POS, JSON.stringify(pos)); } catch (e) { /* ok */ } }
        else fundo.classList.add("aberto");
    });
    window.addEventListener("resize", () => { pos = limitar(pos); aplicar(); });

    const fechar = () => fundo.classList.remove("aberto");
    fundo.addEventListener("click", ev => { if (ev.target === fundo) fechar(); });
    fundo.querySelector("#mt-fechar").addEventListener("click", fechar);
    document.addEventListener("keydown", ev => { if (ev.key === "Escape") fechar(); });
    fundo.querySelector("#mt-sair").addEventListener("click", async () => {
        try { await signOut(auth); } finally { location.href = "./login.html"; }
    });
}

onAuthStateChanged(auth, async user => {
    if (!user) return;                       // sem login: sem menu
    try {
        const snap = await getDoc(doc(db, "usuarios", user.uid));
        if (!snap.exists() || snap.data().ativo === false) return;
        const perfil = String(snap.data().perfil || "").trim().toLowerCase();
        montar(perfil, snap.data().nome || "");
    } catch (e) { console.error("Menu de telas:", e); }
});
