import { db } from "./firebase.js";
import { protegerPagina, renderizarUsuarioLogado } from "./auth-guard.js";

protegerPagina(["entregador"]).then(({ nome }) => {
    renderizarUsuarioLogado(nome);
    iniciarPainelEntregador();
});

console.log("DB:", db);
import {
    collection,
    query,
    where,
    onSnapshot,
    doc,
    updateDoc,
    getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ======================================
// SEGURANÇA: escapar texto vindo do Firestore antes de jogar no innerHTML
// (nome/endereço/telefone são digitados pelo cliente no site.html)
// ======================================
function escapeHtml(valor) {
    return String(valor ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

const listaEntregas = document.getElementById("lista-entregas");
const statEntregasHoje = document.getElementById("statEntregasHoje");

// ======================================
// TEMPO DE ESPERA (badge "há X min" + ordenação por mais antigo primeiro)
// ======================================
// Fallback: se o pedido não tiver atualizadoEm (dado antigo/inconsistente),
// guarda a hora em que ele apareceu pela primeira vez neste painel.
const primeiroVistoEm = new Map();

function referenciaDeEspera(id, p) {
    if (p.atualizadoEm) return p.atualizadoEm;
    if (!primeiroVistoEm.has(id)) primeiroVistoEm.set(id, Date.now());
    return primeiroVistoEm.get(id);
}

function formatarTempoEspera(desde) {
    const minutos = Math.floor((Date.now() - desde) / 60000);
    if (minutos < 1) return "agora mesmo";
    if (minutos < 60) return `há ${minutos} min`;
    const horas = Math.floor(minutos / 60);
    const restoMin = minutos % 60;
    return `há ${horas}h${restoMin ? ` ${restoMin}min` : ""}`;
}

// Atualiza só o texto dos badges já renderizados, sem redesenhar os cards
// (evita perder o scroll do entregador a cada minuto).
setInterval(() => {
    document.querySelectorAll(".tempo-espera[data-desde]").forEach((el) => {
        el.textContent = formatarTempoEspera(Number(el.dataset.desde));
    });
}, 30000);

// ======================================
// AVISO SONORO DE PEDIDO NOVO
// ======================================
let idsConhecidos = null; // null = ainda não recebeu o primeiro snapshot
let audioCtx = null;

// AudioContext só pode ser criado/retomado após uma interação do usuário
// (política de autoplay dos navegadores) — destrava no primeiro toque na tela.
document.addEventListener("click", () => {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
}, { once: true });

function avisarPedidoNovo() {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

    if (!audioCtx) return; // usuário ainda não interagiu com a página nesta sessão
    const tocarBeep = (inicio) => {
        const osc = audioCtx.createOscillator();
        const ganho = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = 880;
        ganho.gain.value = 0.2;
        osc.connect(ganho).connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + inicio);
        osc.stop(audioCtx.currentTime + inicio + 0.18);
    };
    tocarBeep(0);
    tocarBeep(0.25);
}

// ======================================
// CONTADOR DE ENTREGAS (1 por endereço, não por item/pedido)
// ======================================
// Um endereço só conta como 1 entrega mesmo que o pedido tenha vários itens,
// e mesmo que haja mais de um pedido concluído pro mesmo endereço no dia
// (ex: dois pedidos separados pro mesmo prédio/escritório = 1 parada só).

function normEndereco(endereco) {
    return String(endereco || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ");
}

function ehHoje(timestamp) {
    if (!timestamp) return false;
    const d = new Date(timestamp);
    const hoje = new Date();
    return d.getFullYear() === hoje.getFullYear() &&
        d.getMonth() === hoje.getMonth() &&
        d.getDate() === hoje.getDate();
}

function atualizarContadorEntregas(snapshotConcluidos) {
    const enderecosUnicos = new Set();

    snapshotConcluidos.forEach((docSnap) => {
        const p = docSnap.data();
        const tipoEntrega = String(p.entrega || "").toLowerCase();

        if (!tipoEntrega.includes("entrega")) return;

        // Usa concluidoEm (novo campo); pedidos antigos sem esse campo caem no atualizadoEm.
        const quando = p.concluidoEm || p.atualizadoEm;
        if (!ehHoje(quando)) return;

        const chave = normEndereco(p.endereco) || `sem-endereco-${docSnap.id}`;
        enderecosUnicos.add(chave);
    });

    if (statEntregasHoje) statEntregasHoje.textContent = enderecosUnicos.size;
}

// ======================================
// MONITORAMENTO
// ======================================

function iniciarPainelEntregador() {

    // ✅ Query filtrada no servidor: só traz pedidos pendentes de entrega,
    // em vez de baixar a coleção "pedidos" inteira (incluindo histórico antigo)
    // a cada mudança em qualquer pedido do sistema.
    const queryPendentes = query(
        collection(db, "pedidos"),
        where("status", "in", ["pronto", "em_rota"])
    );

    onSnapshot(
        queryPendentes,
        (snapshot) => {

            listaEntregas.innerHTML = "";

            // Filtra só entregas (o campo "entrega" é texto livre) e já monta
            // a referência de tempo de espera de cada uma.
            const pendentes = [];
            const idsAtuais = new Set();

            snapshot.forEach((docSnap) => {
                const p = docSnap.data();
                const id = docSnap.id;
                idsAtuais.add(id);

                const tipoEntrega = String(p.entrega || "").toLowerCase();
                if (!tipoEntrega.includes("entrega")) return;

                pendentes.push({ id, p, desde: referenciaDeEspera(id, p) });
            });

            // ✅ Pedido mais antigo (esperando há mais tempo) aparece primeiro.
            pendentes.sort((a, b) => a.desde - b.desde);

            // ✅ Aviso sonoro/vibração só quando surge um pedido que não existia
            // no snapshot anterior (evita beepar de novo a cada atualização).
            if (idsConhecidos !== null) {
                const temNovo = pendentes.some((item) => !idsConhecidos.has(item.id));
                if (temNovo) avisarPedidoNovo();
            }
            idsConhecidos = idsAtuais;

            pendentes.forEach((item) => renderizarCard(item.id, item.p, item.desde));

            if (pendentes.length === 0) {
                listaEntregas.innerHTML = `
                    <div class="sem-pedidos">
                        <i class="fa-solid fa-circle-check"></i>
                        <h2>Tudo em ordem!</h2>
                        <p>Nenhuma entrega pendente no momento 🙌</p>
                    </div>
                `;
            }

        },
        (erro) => {
            // ✅ Avisa visualmente se a conexão com o Firestore cair
            console.error("Erro no listener de entregas:", erro);
            listaEntregas.innerHTML = `
                <div class="sem-pedidos">
                    <i class="fa-solid fa-triangle-exclamation"></i>
                    <h2>Conexão perdida</h2>
                    <p>Não foi possível atualizar as entregas. Verifique sua internet.</p>
                </div>
            `;
        }
    );

    // ✅ Query separada só para o contador "entregas hoje": traz apenas pedidos
    // já concluídos (ainda assim filtra por hoje no cliente, pois pedidos antigos
    // nem sempre têm o campo concluidoEm preenchido de forma indexável).
    const queryConcluidos = query(
        collection(db, "pedidos"),
        where("status", "==", "concluido")
    );

    onSnapshot(
        queryConcluidos,
        (snapshot) => atualizarContadorEntregas(snapshot),
        (erro) => console.error("Erro no listener de contador de entregas:", erro)
    );

}

// ======================================
// CARD
// ======================================

function renderizarCard(id, p, desde) {

    const card = document.createElement("div");
    card.className = "card-entrega";

    const jaPago = String(p.pagamento || "").toLowerCase().includes("pix");
    const corAlerta = jaPago ? "#00c853" : "#ff9800";
    const textoAlerta = jaPago ? "✅ PEDIDO JÁ PAGO" : `💰 COBRAR R$ ${(p.total || 0).toFixed(2)}`;

    // ✅ Correção: rgba(#hex, 0.15) é CSS inválido e nunca funcionava
    // (o fundo do badge nunca ficava colorido). Guardamos a versão
    // rgb "pura" ao lado do hex para usar nos dois formatos.
    let corStatus = "#666";
    let corStatusRgb = "102,102,102";
    if (p.status === "pronto") { corStatus = "#00c853"; corStatusRgb = "0,200,83"; }
    if (p.status === "em_rota") { corStatus = "#0284c7"; corStatusRgb = "2,132,199"; }

    const endereco = p.endereco || "";
    const linkMaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(endereco)}`;

    // ✅ Dados digitados pelo cliente (nome/endereço/pagamento) passam por escapeHtml
    // antes de entrar no innerHTML, pra não permitir injeção de HTML/script.
    card.innerHTML = `

        <div class="alerta-pago" style="background:${corAlerta}; color:white; text-align:center; padding:12px; font-weight:bold;">
            ${textoAlerta}
        </div>

        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:15px;">
            <div>
                <h3 style="margin:0; color:#fff; font-size:1.1rem;">
                    👤 ${escapeHtml(p.nome || "Cliente")}
                </h3>
                <span class="status-badge" style="background:rgba(${corStatusRgb},0.15); color:${corStatus};">
                    ${escapeHtml((p.status || "").toUpperCase())}
                </span>
                <span class="tempo-espera" data-desde="${desde}" style="display:block; margin-top:6px; font-size:0.8rem; color:var(--muted);">
                    ${formatarTempoEspera(desde)}
                </span>
            </div>

            <button class="btn-zap" data-acao="zap">
                💬
            </button>
        </div>

        <p style="color:#fff; margin-bottom:10px; line-height:1.5;">
            📍 <strong>Endereço:</strong><br>
            ${escapeHtml(endereco) || "Não informado"}
        </p>

        <div class="info-valor">
            <p>💰 <strong>Total:</strong> R$ ${(p.total || 0).toFixed(2)}</p>
            <p>💳 <strong>Pagamento:</strong> ${escapeHtml(p.pagamento || "Não informado")}</p>

            ${p.pagamento === "Dinheiro" && p.troco
            ? `
            <p style="color:#ff9800; font-weight:bold; margin-top:8px;">
                💵 <strong>Troco para:</strong> R$ ${Number(p.troco).toFixed(2)}
            </p>
            <p style="color:#00c853; font-weight:bold;">
                🪙 Devolver: R$ ${(Number(p.troco) - Number(p.total)).toFixed(2)}
            </p>
            ` : ""
        }
        </div>

        <p style="color:#fff; margin:10px 0;">
            📋 <strong>Itens:</strong> ${escapeHtml(formatarItens(p))}
        </p>

        <div style="display:flex; flex-direction:column; gap:10px; margin-top:15px;">
            <a href="${linkMaps}" target="_blank" class="btn-rota">
                <i class="fa-solid fa-location-dot"></i> Abrir GPS / Rota
            </a>

            <div style="display:flex; gap:10px;">
                ${p.status === "pronto"
            ? `
                <button class="btn-acao btn-iniciar" data-acao="iniciar">
                    <i class="fa-solid fa-motorcycle"></i> Iniciar Entrega
                </button>
                ` : ""
        }

                <button class="btn-acao btn-concluir" data-acao="concluir">
                    <i class="fa-solid fa-check-double"></i> Concluir
                </button>
            </div>
        </div>

    `;

    // ✅ Handlers via addEventListener (em vez de onclick="..." com dados do
    // cliente interpolados na string): evita quebrar o HTML quando nome/telefone
    // têm aspas, e evita reabrir brechas de injeção.
    const btnZap = card.querySelector('[data-acao="zap"]');
    if (btnZap) btnZap.addEventListener("click", () => abrirZap(p.fone || "", p.nome || ""));

    const btnIniciar = card.querySelector('[data-acao="iniciar"]');
    if (btnIniciar) btnIniciar.addEventListener("click", () => executarAcaoUnica(btnIniciar, () => atualizarStatus(id, "em_rota")));

    const btnConcluir = card.querySelector('[data-acao="concluir"]');
    if (btnConcluir) btnConcluir.addEventListener("click", () => executarAcaoUnica(btnConcluir, () => finalizarEntrega(id)));

    listaEntregas.appendChild(card);

}

// ======================================
// EVITA DUPLO CLIQUE em ações assíncronas (ex: concluir entrega 2x seguidas)
// ======================================
async function executarAcaoUnica(botao, acao) {
    if (botao.disabled) return;
    botao.disabled = true;
    botao.style.opacity = "0.6";
    try {
        await acao();
    } finally {
        // Se o botão ainda existir na tela (pedido não sumiu da lista), reabilita.
        botao.disabled = false;
        botao.style.opacity = "";
    }
}

// ======================================
// FORMATAR ITENS
// ======================================

function formatarItens(p) {
    if (!p.itens?.length) return "Detalhes não informados";
    return p.itens.map(item => item.nome).join(", ");
}

// ======================================
// WHATSAPP
// ======================================

window.abrirZap = (fone, nome) => {
    if (!fone) {
        alert("Telefone não informado");
        return;
    }
    const msg = encodeURIComponent(`Olá ${nome}, aqui é o entregador da Nova Origem Açaí. 🛵`);
    window.open(`https://wa.me/55${fone}?text=${msg}`, "_blank");
};

// ======================================
// STATUS
// ======================================

window.atualizarStatus = async (id, novoStatus) => {
    // ✅ Abre a aba em branco já no clique (síncrono), antes de qualquer await.
    // Definir a URL só depois evita que o navegador bloqueie como pop-up.
    const abaZap = novoStatus === "em_rota" ? window.open("", "_blank") : null;

    try {
        const docRef = doc(db, "pedidos", id);
        const dadosAtualizacao = { status: novoStatus, atualizadoEm: Date.now() };
        // ✅ Guarda quando a entrega foi concluída, pra separar "entregas hoje" de dias anteriores.
        if (novoStatus === "concluido") dadosAtualizacao.concluidoEm = Date.now();
        await updateDoc(docRef, dadosAtualizacao);

        if (novoStatus === "em_rota") {
            const snap = await getDoc(docRef);
            const p = snap.exists() ? snap.data() : null;
            if (p?.fone && abaZap) {
                const msg = `Olá ${p.nome}! Seu pedido da Nova Origem Açaí saiu para entrega. 🛵💨`;
                abaZap.location = `https://wa.me/55${p.fone}?text=${encodeURIComponent(msg)}`;
            } else if (abaZap) {
                abaZap.close();
            }
        }

    } catch (erro) {
        console.error(erro);
        if (abaZap) abaZap.close();
        alert("Erro ao atualizar status!");
    }
};

// ======================================
// CONCLUIR ENTREGA
// ======================================

window.finalizarEntrega = async (id) => {
    if (!confirm("Tem certeza que deseja concluir essa entrega?")) return;

    try {
        const pedidoRef = doc(db, "pedidos", id);
        const pedidoSnap = await getDoc(pedidoRef);

        if (!pedidoSnap.exists()) {
            alert("Pedido não encontrado.");
            return;
        }

        const pedido = pedidoSnap.data();

        // Atualiza status
        await window.atualizarStatus(id, "concluido");

        // ✅ Proteção: se o telefone não estiver cadastrado, evita erro
        // e só pula a etapa de mensagem de agradecimento.
        if (!pedido.fone) {
            console.warn("Pedido sem telefone cadastrado, mensagem de agradecimento não enviada.");
            return;
        }

        if (!confirm("Deseja enviar mensagem de agradecimento e pedir feedback?")) return;

        // Telefone limpo
        const telefone = pedido.fone.replace(/\D/g, "");

        const mensagem = encodeURIComponent(`
🍇 Nova Origem Açaí

Olá, ${pedido.nome}! 😍

Seu pedido foi entregue com sucesso.

Muito obrigado pela preferência, Deus abençoe! ❤️



Esperamos você novamente! 🚀
`);

        // O confirm() acima é síncrono, então esse window.open ainda está
        // "colado" ao clique original e não deve ser bloqueado como pop-up.
        window.open(`https://wa.me/55${telefone}?text=${mensagem}`, "_blank");

    } catch (erro) {
        console.error(erro);
        alert("Erro ao finalizar entrega.");
    }

};