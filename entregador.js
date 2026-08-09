import { db } from "./firebase.js";

console.log("DB:", db);
import {
    collection,
    onSnapshot,
    doc,
    updateDoc,
    getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const listaEntregas = document.getElementById("lista-entregas");
const statEntregasHoje = document.getElementById("statEntregasHoje");
const statPedidosHoje = document.getElementById("statPedidosHoje");

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

function atualizarContadorEntregas(snapshot) {
    const enderecosUnicos = new Set();
    let totalPedidos = 0;

    snapshot.forEach((docSnap) => {
        const p = docSnap.data();
        const tipoEntrega = String(p.entrega || "").toLowerCase();
        const statusAtual = String(p.status || "").toLowerCase();

        if (!tipoEntrega.includes("entrega") || statusAtual !== "concluido") return;

        // Usa concluidoEm (novo campo); pedidos antigos sem esse campo caem no atualizadoEm.
        const quando = p.concluidoEm || p.atualizadoEm;
        if (!ehHoje(quando)) return;

        totalPedidos++;
        const chave = normEndereco(p.endereco) || `sem-endereco-${docSnap.id}`;
        enderecosUnicos.add(chave);
    });

    if (statEntregasHoje) statEntregasHoje.textContent = enderecosUnicos.size;
    if (statPedidosHoje) statPedidosHoje.textContent = totalPedidos;
}

// ======================================
// MONITORAMENTO
// ======================================

function iniciarPainelEntregador() {

    onSnapshot(
        collection(db, "pedidos"),
        (snapshot) => {

            console.log("TOTAL PEDIDOS:", snapshot.size);

            atualizarContadorEntregas(snapshot);

            listaEntregas.innerHTML = "";

            let temEntrega = false;

            snapshot.forEach((docSnap) => {

                const p = docSnap.data();
                const id = docSnap.id;

                const tipoEntrega = String(p.entrega || "").toLowerCase();
                const statusAtual = String(p.status || "").toLowerCase();

                // MOSTRA SOMENTE PEDIDOS DE ENTREGA QUE JÁ FORAM FINALIZADOS PELA COZINHA
                const statusValidos = ["pronto", "em_rota"];

                if (tipoEntrega.includes("entrega") && statusValidos.includes(statusAtual)) {
                    temEntrega = true;
                    renderizarCard(id, p);
                }

            });

            if (!temEntrega) {
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
            // ✅ Novo: avisa visualmente se a conexão com o Firestore cair
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

}

// ======================================
// CARD
// ======================================

function renderizarCard(id, p) {

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

    card.innerHTML = `

        <div class="alerta-pago" style="background:${corAlerta}; color:white; text-align:center; padding:12px; font-weight:bold;">
            ${textoAlerta}
        </div>

        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:15px;">
            <div>
                <h3 style="margin:0; color:#fff; font-size:1.1rem;">
                    👤 ${p.nome || "Cliente"}
                </h3>
                <span class="status-badge" style="background:rgba(${corStatusRgb},0.15); color:${corStatus};">
                    ${(p.status || "").toUpperCase()}
                </span>
            </div>

            <button onclick="abrirZap('${p.fone || ""}','${p.nome || ""}')" class="btn-zap">
                💬
            </button>
        </div>

        <p style="color:#fff; margin-bottom:10px; line-height:1.5;">
            📍 <strong>Endereço:</strong><br>
            ${endereco || "Não informado"}
        </p>

        <div class="info-valor">
            <p>💰 <strong>Total:</strong> R$ ${(p.total || 0).toFixed(2)}</p>
            <p>💳 <strong>Pagamento:</strong> ${p.pagamento || "Não informado"}</p>

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
            📋 <strong>Itens:</strong> ${formatarItens(p)}
        </p>

        <div style="display:flex; flex-direction:column; gap:10px; margin-top:15px;">
            <a href="${linkMaps}" target="_blank" class="btn-rota">
                <i class="fa-solid fa-location-dot"></i> Abrir GPS / Rota
            </a>

            <div style="display:flex; gap:10px;">
                ${p.status === "pronto"
            ? `
                <button onclick="atualizarStatus('${id}','em_rota')" class="btn-acao btn-iniciar">
                    <i class="fa-solid fa-motorcycle"></i> Iniciar Entrega
                </button>
                ` : ""
        }

                <button onclick="finalizarEntrega('${id}')" class="btn-acao btn-concluir">
                    <i class="fa-solid fa-check-double"></i> Concluir
                </button>
            </div>
        </div>

    `;

    listaEntregas.appendChild(card);

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
    try {
        const docRef = doc(db, "pedidos", id);
        const dadosAtualizacao = { status: novoStatus, atualizadoEm: Date.now() };
        // ✅ Guarda quando a entrega foi concluída, pra separar "entregas hoje" de dias anteriores.
        if (novoStatus === "concluido") dadosAtualizacao.concluidoEm = Date.now();
        await updateDoc(docRef, dadosAtualizacao);

        if (novoStatus === "em_rota") {
            const snap = await getDoc(docRef);
            if (snap.exists()) {
                const p = snap.data();
                if (p.fone) {
                    const msg = `Olá ${p.nome}! Seu pedido da Nova Origem Açaí saiu para entrega. 🛵💨`;
                    window.open(`https://wa.me/55${p.fone}?text=${encodeURIComponent(msg)}`, "_blank");
                }
            }
        }

    } catch (erro) {
        console.error(erro);
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

        // Telefone limpo
        const telefone = pedido.fone.replace(/\D/g, "");

        const mensagem = encodeURIComponent(`
🍇 Nova Origem Açaí

Olá, ${pedido.nome}! 😍

Seu pedido foi entregue com sucesso.

Muito obrigado pela preferência. ❤️

Seu feedback é muito importante para nós.

⭐ Como estava o sabor?
⭐ Como foi a entrega?
⭐ O que podemos melhorar?

Esperamos você novamente! 🚀
`);

        if (confirm("Deseja enviar mensagem de agradecimento e pedir feedback?")) {
            window.open(`https://wa.me/55${telefone}?text=${mensagem}`, "_blank");
        }

    } catch (erro) {
        console.error(erro);
        alert("Erro ao finalizar entrega.");
    }

};

// ======================================

iniciarPainelEntregador();
