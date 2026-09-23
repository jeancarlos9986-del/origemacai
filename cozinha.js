import {
    collection,
    onSnapshot,
    doc,
    updateDoc,
    deleteDoc,
    query,
    orderBy,
    limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// 🆕 Baixa de estoque: antes só acontecia se a tela de Estoque estivesse
// aberta em algum navegador. Agora disparamos direto daqui, no momento em
// que a cozinha marca o pedido como "pronto" — funciona sempre, mesmo com
// a tela de Estoque fechada.
// 🆕 estornarPedidoSeguro: devolve o estoque debitado quando um pedido que já
// tinha ficado "pronto" é removido/cancelado — antes isso não acontecia e o
// saldo do sistema ficava menor do que o estoque físico real com o tempo.
import { construirMapaEstoque, processarPedidoSeguro, estornarPedidoSeguro } from "./estoqueBaixa.js";

// ======================================
// 🔒 LOGIN — usa a MESMA instância do Firebase do resto do site
// (antes esse arquivo criava seu próprio initializeApp/getFirestore
// separado, duplicando a config e impedindo o uso do auth-guard,
// que depende do db/auth exportados por firebase.js)
// ======================================
import { db } from "./firebase.js";
import { protegerPagina, renderizarUsuarioLogado } from "./auth-guard.js";
protegerPagina(["cozinha"]).then(({ nome }) => {
    renderizarUsuarioLogado(nome);
    iniciarListenerPedidos();
});

// ======================================
// 🆕 LINK DE ACOMPANHAMENTO DO PEDIDO
// ======================================
// ⚠️ TROQUE PELA URL REAL ONDE O site.html ESTÁ PUBLICADO
const SITE_URL = "https://jeancarlos9986-del.github.io/origemacai/site";

function gerarLinkAcompanhamento(pedidoId) {
    return `${SITE_URL}?pedido=${pedidoId}`;
}

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

const audioNovoPedido = new Audio("./alerta.mp3");
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

// 🔧 Escapa texto vindo do cliente (nome, endereço, observação do item etc.)
// antes de colocar no innerHTML. Antes esses campos iam direto pro HTML —
// um texto digitado no site (ex: campo de observação) podia quebrar o
// layout do card ou, no limite, injetar HTML/script na tela da cozinha.
function escaparHtml(texto) {
    if (texto === null || texto === undefined) return "";
    return String(texto)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// 🔧 Guarda uma "assinatura" do que foi renderizado da última vez, pra
// evitar reconstruir o painel inteiro (innerHTML = "") quando nada que
// aparece na tela realmente mudou — ex: uma escrita no Firestore que não
// afeta nenhum campo exibido, ou snapshots repetidos chegando em sequência.
// Isso evita a "piscada" visual e preserva o scroll dentro da lista de
// itens de um pedido que estava sendo lido no momento.
let ultimaAssinaturaRenderizada = null;

// 🆕 Mostra quantos pedidos existem em cada status direto no botão do
// filtro (ex: "Novos (3)") — dá pra saber o volume sem clicar em cada aba.
function atualizarContadoresFiltro() {
    const contagens = {
        todos: pedidos.filter(p => p.status !== "concluido" && p.status !== "aguardando_pagamento").length,
        novo: pedidos.filter(p => p.status === "novo").length,
        preparo: pedidos.filter(p => p.status === "preparo").length,
        pronto: pedidos.filter(p => p.status === "pronto").length
    };
    botoesFiltro.forEach(btn => {
        const chave = btn.dataset.filtro;
        // Guarda o texto original (sem contador) na primeira passada, pra
        // não ir empilhando "(3) (5) (2)..." nas próximas atualizações.
        if (!btn.dataset.rotuloBase) {
            btn.dataset.rotuloBase = btn.textContent.trim();
        }
        const total = contagens[chave] ?? 0;
        btn.textContent = total > 0 ? `${btn.dataset.rotuloBase} (${total})` : btn.dataset.rotuloBase;
    });
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

    // 🔧 Se o que precisa aparecer na tela é idêntico ao último render, não
    // reconstrói nada — só os campos usados no card entram na assinatura.
    const assinaturaAtual = JSON.stringify(pedidosFiltrados.map(p => ([
        p.id, p.status, p.numero, p.criadoEm, p.nome, p.fone,
        p.entrega, p.pagamento, p.endereco, p.total, p.itens
    ])));
    if (assinaturaAtual === ultimaAssinaturaRenderizada) {
        return;
    }
    ultimaAssinaturaRenderizada = assinaturaAtual;

    painelPedidos.innerHTML = "";

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
                <div><strong>Nome:</strong> <span>${escaparHtml(pedido.nome) || "Não informado"}</span></div>
                <div><strong>Contato:</strong> <span>${escaparHtml(pedido.fone) || "-"}</span></div>
                <div><strong>Tipo:</strong> <span>${pedido.entrega === 'entrega' ? '🏍️ Entrega' : '🏠 Retirada'}</span></div>
                <div><strong>Pagamento:</strong> <span class="info-pagamento">${escaparHtml(pedido.pagamento) || "-"}</span></div>
                ${pedido.endereco ? `<div><strong>Endereço:</strong> <span>${escaparHtml(pedido.endereco)}</span></div>` : ""}
            </div>

            <div class="link-acompanhamento">
                <button class="btn-copiar-link" data-id="${pedido.id}">
                    <i class="fa-solid fa-link"></i> Copiar Link
                </button>
                <button class="btn-whatsapp-link" data-id="${pedido.id}" data-fone="${escaparHtml(pedido.fone)}" data-nome="${escaparHtml(pedido.nome)}">
                    <i class="fa-brands fa-whatsapp"></i> Enviar por WhatsApp
                </button>
            </div>

            <div class="pedido-itens">
                ${pedido.itens && pedido.itens.length > 0 ? pedido.itens.map(item => `
                    <div class="pedido-item">
                        <strong>${escaparHtml(item.nome) || "Item"}</strong>
                        ${item.gratis?.length ? `<div class="item-gratis">✅ Grátis: ${escaparHtml(item.gratis.join(", "))}</div>` : ""}
                        ${item.extras?.length ? `<div class="item-extra">➕ Adicionais: ${escaparHtml(item.extras.join(", "))}</div>` : ""}
                        ${item.obs ? `<div class="item-obs">📝 Obs: ${escaparHtml(item.obs)}</div>` : ""}
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
    // 🆕 Copiar link de acompanhamento
    document.querySelectorAll(".btn-copiar-link").forEach(btn => {
        btn.addEventListener("click", async () => {
            const link = gerarLinkAcompanhamento(btn.dataset.id);
            try {
                await navigator.clipboard.writeText(link);
                const original = btn.innerHTML;
                btn.innerHTML = `<i class="fa-solid fa-check"></i> Copiado!`;
                setTimeout(() => btn.innerHTML = original, 1500);
            } catch (e) {
                prompt("Copie o link manualmente:", link);
            }
        });
    });

    // 🆕 Enviar link direto pelo WhatsApp
    document.querySelectorAll(".btn-whatsapp-link").forEach(btn => {
        btn.addEventListener("click", () => {
            const fone = (btn.dataset.fone || "").replace(/\D/g, "");
            if (!fone) {
                alert("Este pedido não tem telefone cadastrado.");
                return;
            }
            const link = gerarLinkAcompanhamento(btn.dataset.id);
            const msg = encodeURIComponent(
                `Olá ${btn.dataset.nome || ""}! Aqui está o link para acompanhar seu pedido em tempo real 👇\n${link}`
            );
            window.open(`https://wa.me/55${fone}?text=${msg}`, "_blank");
        });
    });

    // Preparar
    document.querySelectorAll(".btn-preparo").forEach(btn => {
        btn.addEventListener("click", async () => {
            // 🔧 Trava o botão enquanto a atualização está em andamento pra
            // evitar dois cliques rápidos (ex: internet lenta) disparando
            // duas atualizações/baixas de estoque pro mesmo pedido.
            if (btn.disabled) return;
            btn.disabled = true;
            try {
                await atualizarStatus(btn.dataset.id, "preparo");
            } finally {
                btn.disabled = false;
            }
        });
    });

    // Marcar como Pronto
    document.querySelectorAll(".btn-pronto").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (btn.disabled) return;
            btn.disabled = true;
            try {
                await atualizarStatus(btn.dataset.id, "pronto");
            } finally {
                btn.disabled = false;
            }
        });
    });

    // Saiu para Entrega
    document.querySelectorAll(".btn-entrega").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (btn.disabled) return;
            btn.disabled = true;
            try {
                await atualizarStatus(btn.dataset.id, "em_rota");
            } finally {
                btn.disabled = false;
            }
        });
    });

    // Concluir / Retirada
    document.querySelectorAll(".btn-concluir").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (btn.disabled) return;
            btn.disabled = true;
            try {
                await atualizarStatus(btn.dataset.id, "concluido");
            } finally {
                btn.disabled = false;
            }
        });
    });

    // Remover/Excluir
    document.querySelectorAll(".btn-remover").forEach(btn => {
        btn.addEventListener("click", async () => {
            if (btn.disabled) return;
            if (confirm("Tem certeza que deseja remover esse pedido?")) {
                btn.disabled = true;
                const pedidoId = btn.dataset.id;
                try {
                    // 🆕 Se o estoque já tinha sido debitado pra esse pedido (passou por
                    // "pronto"), devolve os insumos ANTES de excluir — evita que o saldo
                    // do sistema fique menor do que o estoque físico real. Não trava a
                    // exclusão se o estorno falhar (ex: sem internet) — só avisa no console,
                    // a tela de Estoque continua servindo de rede de segurança.
                    const pedido = pedidos.find(p => p.id === pedidoId);
                    if (pedido?.estoqueBaixado && !pedido?.estoqueEstornado) {
                        try {
                            const mapaEstoque = await construirMapaEstoque();
                            await estornarPedidoSeguro(pedidoId, mapaEstoque);
                        } catch (e) {
                            console.error(`Erro ao estornar estoque do pedido #${pedidoId.slice(-4)} antes de remover:`, e);
                        }
                    }
                    await deleteDoc(doc(db, "pedidos", pedidoId));
                } catch (e) {
                    console.error("Erro ao remover pedido:", e);
                    alert("Erro ao remover pedido! Tente novamente.");
                } finally {
                    btn.disabled = false;
                }
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
        return;
    }

    // 🆕 Dá baixa no estoque assim que o pedido fica "pronto" — não trava
    // nem avisa o cliente/cozinha se algo der errado aqui, só loga no
    // console (a tela de Estoque continua servindo de rede de segurança
    // caso essa chamada falhe por qualquer motivo, ex: sem internet).
    if (novoStatus === "pronto") {
        try {
            const mapaEstoque = await construirMapaEstoque();
            await processarPedidoSeguro(id, mapaEstoque);
        } catch (e) {
            console.error(`Erro ao dar baixa no estoque do pedido #${id.slice(-4)}:`, e);
        }
    }
}

// ======================================
// REALTIME LISTENER FIREBASE
// ======================================
const avisoConexao = document.getElementById("avisoConexao");

// 🔧 Removida a segunda chamada de protegerPagina(["cozinha"]).then(...) que
// existia aqui — ela chamava iniciarListenerPedidos() de novo, registrando
// um segundo onSnapshot na mesma coleção "pedidos" (já registrado lá no
// topo do arquivo). Isso fazia cada mudança no Firestore renderizar o
// painel duas vezes e tocar som/notificação em dobro para o mesmo pedido.
// A chamada do topo do arquivo já é suficiente.

function iniciarListenerPedidos() {
    // 🆕 Antes buscava a coleção "pedidos" inteira, sem limite — conforme o
    // histórico cresce isso aumenta leituras/custo no Firestore e deixa o
    // carregamento mais pesado. Agora traz só os 200 pedidos mais recentes
    // (ordenados por criadoEm). Não muda nenhum campo/documento, só reduz
    // o volume trazido — 100% compatível com o resto do sistema.
    const consultaPedidos = query(
        collection(db, "pedidos"),
        orderBy("criadoEm", "desc"),
        limit(200)
    );

    onSnapshot(consultaPedidos, (snapshot) => {
        // Conexão ok — esconde aviso caso estivesse visível
        if (avisoConexao) avisoConexao.style.display = "none";

        pedidos = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));

        // Verifica novos pedidos para tocar som e notificar
        if (!primeiraCarga) {
            const idsAtuais = new Set(pedidos.map(p => p.id));
            const novos = [...idsAtuais].filter(id => !pedidosConhecidos.has(id));

            if (novos.length > 0) {
                novos.forEach(id => {
                    const pedido = pedidos.find(p => p.id === id);
                    if (pedido?.status === "novo") {
                        if (somAtivado) {
                            audioNovoPedido.currentTime = 0;
                            audioNovoPedido.play().catch(e => console.log("Áudio bloqueado:", e));
                        }
                        if (notificacoesAtivas && Notification.permission === "granted") {
                            const numeroExibicao = pedido.numero ? String(pedido.numero).slice(-4) : "----";
                            const notif = new Notification("🛒 Novo pedido!", {
                                body: `${pedido.nome || "Cliente"} • R$ ${(pedido.total || 0).toFixed(2)} • Pedido #${numeroExibicao}`,
                                icon: "./logonovonova.png.jpeg",
                                tag: "novo-pedido-" + id,
                                requireInteraction: true
                            });
                            notif.onclick = () => {
                                window.focus();
                                notif.close();
                            };
                        }
                    }
                });
            }
        }

        // Atualiza lista de conhecidos
        pedidosConhecidos = new Set(pedidos.map(p => p.id));
        primeiraCarga = false;

        atualizarContadoresFiltro();
        renderizarPedidos();
    }, (erro) => {
        // ✅ Novo: se a conexão com o Firestore cair, avisa visualmente
        // em vez de deixar o painel travado sem explicação.
        console.error("Erro no listener de pedidos:", erro);
        if (avisoConexao) avisoConexao.style.display = "block";
    });
}

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

// 🔧 Antes recarregava o áudio (audioNovoPedido.load()) a CADA clique na
// página, inclusive nos botões de ação dos pedidos. O objetivo real aqui é
// só "destravar" o áudio pra funcionar depois (política dos navegadores
// exige uma interação do usuário) — então basta fazer isso uma vez.
document.body.addEventListener("click", () => {
    audioNovoPedido.load();
}, { once: true });

// ======================================
// 🆕 NOTIFICAÇÕES (sem servidor — só permissão do navegador)
// ======================================
// Funciona: aba em segundo plano, outra aba/janela aberta, tela ligada.
// NÃO funciona: celular com a tela bloqueada/app fechado — isso exige
// notificação push de verdade, que precisa de um servidor por trás.
const btnPush = document.getElementById("ativarPush");
let notificacoesAtivas = false;

async function ativarNotificacoesLocais() {
    if (!("Notification" in window)) {
        alert("Este navegador não suporta notificações.");
        return;
    }

    if (Notification.permission === "denied") {
        alert("As notificações estão bloqueadas para este site. Vá nas configurações do navegador (ícone de cadeado ao lado do endereço) e permita notificações.");
        return;
    }

    const permissao = await Notification.requestPermission();
    if (permissao !== "granted") {
        alert("Você precisa permitir as notificações para receber os alertas.");
        return;
    }

    notificacoesAtivas = true;
    btnPush.textContent = "✅ Notificações Ativas";
    btnPush.classList.add("push-ativo");

    new Notification("🔔 Notificações ativadas!", {
        body: "Você vai ser avisado quando chegar um novo pedido.",
        icon: "./logonovonova.png.jpeg"
    });
}

btnPush.addEventListener("click", ativarNotificacoesLocais);