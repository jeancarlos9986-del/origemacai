import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
    getFirestore,
    collection,
    onSnapshot,
    doc,
    updateDoc,
    deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ======================================
// CONFIGURAÇÃO FIREBASE
// ======================================
const firebaseConfig = {
    apiKey: "AIzaSyC_zNrNdstdLSa95AjYF_W8XFMwIwlq4DE",
    authDomain: "fb-pedidos.firebaseapp.com",
    projectId: "fb-pedidos",
    storageBucket: "fb-pedidos.firebasestorage.app",
    messagingSenderId: "440937401229",
    appId: "1:440937401229:web:4a27c27a69792eb25bcbc4"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ======================================
// VARIÁVEIS ELEMENTOS
// ======================================
const painelPedidos = document.getElementById("painelPedidos");
const semPedidos = document.getElementById("semPedidos");
const botoesFiltro = document.querySelectorAll(".filtro-btn");

// ======================================
// ESTADO E ÁUDIO
// ======================================
let pedidos = [];
let pedidosConhecidos = new Set();
let filtroAtivo = "todos";
let primeiraCarga = true;
let somAtivado = false;

const audioNovoPedido = new Audio("https://assets.mixkit.co/sfx/preview/mixkit-software-interface-alert-2762.mp3");
audioNovoPedido.volume = 0.8;

// ======================================
// FUNÇÕES AUXILIARES
// ======================================

function obterStatusTexto(status) {
    const statusMap = {
        novo: "🟣 NOVO",
        preparo: "🟡 EM PREPARO",
        pronto: "🟢 PRONTO",
        em_rota: "🛵 EM ROTA",
        concluido: "✅ ENTREGUE",
        aguardando_pagamento: "⏳ AGUARDANDO PGTO"
    };
    return statusMap[status] || "❓ DESCONHECIDO";
}

function formatarData(timestamp) {
    if (!timestamp) return "";
    const data = new Date(timestamp);
    return data.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ======================================
// FILTRO
// ======================================
botoesFiltro.forEach(btn => {
    btn.addEventListener("click", () => {
        botoesFiltro.forEach(b => b.classList.remove("ativo"));
        btn.classList.add("ativo");
        filtroAtivo = btn.dataset.filtro;
        renderizarPedidos();
    });
});

// ======================================
// RENDERIZAÇÃO PRINCIPAL
// ======================================
function renderizarPedidos() {
    painelPedidos.innerHTML = "";

    // Filtrar pedidos
    let pedidosFiltrados = pedidos.filter(p => {
        if (filtroAtivo === "todos") return p.status !== "concluido" && p.status !== "aguardando_pagamento";
        return p.status === filtroAtivo;
    });

    // Ordenar: Novos primeiro, depois por horário
    pedidosFiltrados.sort((a, b) => {
        if (a.status === "novo" && b.status !== "novo") return -1;
        if (a.status !== "novo" && b.status === "novo") return 1;
        return (b.criadoEm || 0) - (a.criadoEm || 0);
    });

    if (pedidosFiltrados.length === 0) {
        semPedidos.style.display = "block";
        return;
    }
    semPedidos.style.display = "none";

    // Criar Cards
    pedidosFiltrados.forEach(pedido => {
        const card = document.createElement("div");
        card.className = `pedido-card ${pedido.status}`;

        // Animação destaque para novos
        if (pedido.status === "novo" && !primeiraCarga) {
            card.classList.add("novo-pedido-animado");
        }

        const numeroExibicao = pedido.numero ? String(pedido.numero).slice(-4) : "----";
        const horaFormatada = formatarData(pedido.criadoEm);

        card.innerHTML = `
            <div class="pedido-top">
                <div>
                    <div class="pedido-numero">Pedido #${numeroExibicao}</div>
                    <div class="pedido-hora">
                        <i class="fa-solid fa-clock"></i> ${horaFormatada}
                    </div>
                </div>
                <div class="pedido-status status-${pedido.status}">
                    ${obterStatusTexto(pedido.status)}
                </div>
            </div>

            <div class="cliente-box">
                <div><strong>Nome:</strong> <span>${pedido.nome || "Não informado"}</span></div>
                <div><strong>Contato:</strong> <span>${pedido.fone || "-"}</span></div>
                <div><strong>Tipo:</strong> <span>${pedido.entrega === 'entrega' ? '🏍️ Entrega' : '🏠 Retirada'}</span></div>
                <div><strong>Pagamento:</strong> <span class="info-pagamento">${pedido.pagamento || "-"}</span></div>
                ${pedido.endereco ? `<div><strong>Endereço:</strong> <span>${pedido.endereco}</span></div>` : ""}
            </div>

            <div class="pedido-itens">
                ${pedido.itens && pedido.itens.length > 0 ? pedido.itens.map(item => `
                    <div class="pedido-item">
                        <strong>${item.nome || "Item"}</strong>
                        ${item.gratis?.length ? `<div class="item-gratis">✅ Grátis: ${item.gratis.join(", ")}</div>` : ""}
                        ${item.extras?.length ? `<div class="item-extra">➕ Adicionais: ${item.extras.join(", ")}</div>` : ""}
                        ${item.obs ? `<div class="item-obs">📝 Obs: ${item.obs}</div>` : ""}
                        <div class="valor-item">R$ ${(item.preco || 0).toFixed(2)}</div>
                    </div>
                `).join("") : "<p style='text-align:center; color:#9ca3af;'>Nenhum item encontrado</p>"}
            </div>

            <div class="pedido-footer">
                <div class="pedido-total">Total: R$ ${(pedido.total || 0).toFixed(2)}</div>
                
                <div class="acoes">
                    ${pedido.status === "novo" ? `
                        <button class="btn-preparo" data-id="${pedido.id}">
                            <i class="fa-solid fa-fire"></i> Preparar
                        </button>
                    ` : ""}

                    ${pedido.status === "preparo" ? `
                        <button class="btn-pronto" data-id="${pedido.id}">
                            <i class="fa-solid fa-check-circle"></i> Pronto
                        </button>
                    ` : ""}

                    ${pedido.status === "pronto" && pedido.entrega === "entrega" ? `
                        <button class="btn-entrega" data-id="${pedido.id}">
                            <i class="fa-solid fa-motorcycle"></i> Saiu Entrega
                        </button>
                    ` : ""}

                    ${pedido.status === "pronto" && pedido.entrega === "retirada" ? `
                        <button class="btn-concluir" data-id="${pedido.id}">
                            <i class="fa-solid fa-hand-wave"></i> Cliente Retirou
                        </button>
                    ` : ""}

                    <button class="btn-remover" data-id="${pedido.id}">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `;

        painelPedidos.appendChild(card);
    });

    adicionarEventosBotoes();
}

// ======================================
// EVENTOS DOS BOTÕES DE AÇÃO
// ======================================
function adicionarEventosBotoes() {
    // Preparar
    document.querySelectorAll(".btn-preparo").forEach(btn => {
        btn.addEventListener("click", async () => {
            await atualizarStatus(btn.dataset.id, "preparo");
        });
    });

    // Marcar como Pronto
    document.querySelectorAll(".btn-pronto").forEach(btn => {
        btn.addEventListener("click", async () => {
            await atualizarStatus(btn.dataset.id, "pronto");
        });
    });

    // Saiu para Entrega
    document.querySelectorAll(".btn-entrega").forEach(btn => {
        btn.addEventListener("click", async () => {
            await atualizarStatus(btn.dataset.id, "em_rota");
        });
    });

    // Concluir / Retirada
    document.querySelectorAll(".btn-concluir").forEach(btn => {
        btn.addEventListener("click", async () => {
            await atualizarStatus(btn.dataset.id, "concluido");
        });
    });

    // Remover/Excluir
    document.querySelectorAll(".btn-remover").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (confirm("Tem certeza que deseja remover esse pedido?")) {
                await deleteDoc(doc(db, "pedidos", btn.dataset.id));
            }
        });
    });
}

async function atualizarStatus(id, novoStatus) {
    try {
        await updateDoc(doc(db, "pedidos", id), {
            status: novoStatus,
            atualizadoEm: new Date()
        });
    } catch (e) {
        console.error("Erro ao atualizar:", e);
        alert("Erro ao atualizar status!");
    }
}

// ======================================
// REALTIME LISTENER FIREBASE
// ======================================
onSnapshot(collection(db, "pedidos"), (snapshot) => {
    pedidos = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
    }));

    // Verifica novos pedidos para tocar som
    if (!primeiraCarga && somAtivado) {
        const idsAtuais = new Set(pedidos.map(p => p.id));
        const novos = [...idsAtuais].filter(id => !pedidosConhecidos.has(id));

        if (novos.length > 0) {
            novos.forEach(id => {
                const pedido = pedidos.find(p => p.id === id);
                if (pedido?.status === "novo") {
                    audioNovoPedido.currentTime = 0;
                    audioNovoPedido.play().catch(e => console.log("Áudio bloqueado:", e));
                }
            });
        }
    }

    // Atualiza lista de conhecidos
    pedidosConhecidos = new Set(pedidos.map(p => p.id));
    primeiraCarga = false;

    renderizarPedidos();
});

// ======================================
// CONTROLE DE SOM
// ======================================
document.getElementById("ativarSom").addEventListener("click", () => {
    somAtivado = !somAtivado;
    const btn = document.getElementById("ativarSom");
    if (somAtivado) {
        btn.innerText = "🔕 Desativar Som";
        btn.style.background = "rgba(0, 200, 83, 0.2)";
        btn.style.color = "#00ff84";
        audioNovoPedido.play().catch(() => { });
    } else {
        btn.innerText = "🔔 Ativar Som";
        btn.style.background = "rgba(124, 58, 237, 0.2)";
        btn.style.color = "#c084fc";
    }
});

document.body.addEventListener("click", () => {
    audioNovoPedido.load();
});
