import { db } from "./firebase.js";

console.log("DB:", db);
import {
    collection,
    onSnapshot,
    doc,
    updateDoc,
    getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const listaEntregas =
    document.getElementById("lista-entregas");

// ======================================
// MONITORAMENTO
// ======================================

function iniciarPainelEntregador() {

    onSnapshot(
        collection(db, "pedidos"),
        (snapshot) => {

            console.log("TOTAL PEDIDOS:", snapshot.size);

            listaEntregas.innerHTML = "";

            let temEntrega = false;

            snapshot.forEach((docSnap) => {

                const p = docSnap.data();

                const id = docSnap.id;

                const tipoEntrega =
                    String(p.entrega || "")
                        .toLowerCase();

                const statusAtual =
                    String(p.status || "")
                        .toLowerCase();

                // MOSTRA SOMENTE PEDIDOS DE ENTREGA
                // QUE JÁ FORAM FINALIZADOS PELA COZINHA
                const statusValidos = [
                    "pronto",
                    "em_rota"
                ];

                if (
                    tipoEntrega.includes("entrega")
                    &&
                    statusValidos.includes(statusAtual)
                ) {

                    temEntrega = true;

                    renderizarCard(id, p);

                }

            });

            if (!temEntrega) {

                listaEntregas.innerHTML = `
                    <p
                        style="
                            text-align:center;
                            margin-top:20px;
                            color:#fff;
                        ">
                        Nenhuma entrega pendente 🙌
                    </p>
                `;

            }

        }
    );

}

// ======================================
// CARD
// ======================================

function renderizarCard(id, p) {

    const card =
        document.createElement("div");

    card.className =
        "card-entrega";

    const jaPago =
        String(p.pagamento || "")
            .toLowerCase()
            .includes("pix");

    const corAlerta =
        jaPago
            ? "#28a745"
            : "#d32f2f";

    const textoAlerta =
        jaPago
            ? "✅ PEDIDO JÁ PAGO"
            : `💰 COBRAR R$ ${(p.total || 0).toFixed(2)}`;

    let corStatus = "#666";

    if (p.status === "pronto")
        corStatus = "#28a745";

    if (p.status === "em_rota")
        corStatus = "#4285F4";

    const endereco =
        p.endereco || "";

    const linkMaps =
        `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(endereco)}`;

    card.innerHTML = `

        <div
            style="
                background:${corAlerta};
                color:white;
                text-align:center;
                padding:12px;
                border-radius:8px 8px 0 0;
                margin:-15px -15px 15px -15px;
                font-weight:bold;
            ">
            ${textoAlerta}
        </div>

        <div
            style="
                display:flex;
                justify-content:space-between;
                align-items:flex-start;
                margin-bottom:15px;
            ">

            <div>

                <h3
                    style="
                        margin:0;
                        color:#fff;
                    ">

                    👤 ${p.nome || "Cliente"}

                </h3>

                <small
                    style="
                        color:${corStatus};
                        font-weight:bold;
                    ">

                    ${(p.status || "").toUpperCase()}

                </small>

            </div>

            <button
                onclick="abrirZap('${p.fone || ""}','${p.nome || ""}')"

                style="
                    background:#25D366;
                    border:none;
                    width:45px;
                    height:45px;
                    border-radius:50%;
                    cursor:pointer;
                ">

                💬

            </button>

        </div>

        <p style="color:#fff;">

            📍 <strong>Endereço:</strong><br>

            ${endereco || "Não informado"}

        </p>

        <div class="info-valor">

    <p>
        💰 <strong>Total:</strong>
        R$ ${(p.total || 0).toFixed(2)}
    </p>

    <p>
        💳 <strong>Pagamento:</strong>
        ${p.pagamento || "Não informado"}
    </p>

    ${p.pagamento === "Dinheiro" && p.troco
            ? `
            <p style="color:#ff9800;font-weight:bold;">
                💵 <strong>Troco para:</strong>
                R$ ${Number(p.troco).toFixed(2)}
            </p>
             <p style="color:#00c853;font-weight:bold;">
            🪙 Devolver:
            R$ ${(Number(p.troco) - Number(p.total)).toFixed(2)}
        </p>
          `
            : ""
        }

</div>

        <p
            style="
                color:#fff;
                margin-top:10px;
            ">

            📋 <strong>Itens:</strong>

            ${formatarItens(p)}

        </p>

        <div
            style="
                display:flex;
                flex-direction:column;
                gap:8px;
                margin-top:15px;
            ">

            <a
                href="${linkMaps}"
                target="_blank"
                class="btn-rota">

                🗺️ Abrir GPS

            </a>

            <div
                style="
                    display:flex;
                    gap:8px;
                ">

                ${p.status === "pronto"
            ? `
                        <button
                            onclick="atualizarStatus('${id}','em_rota')"

                            style="
                                flex:1;
                                background:#ff9800;
                                color:white;
                                border:none;
                                padding:12px;
                                border-radius:5px;
                                font-weight:bold;
                                cursor:pointer;
                            ">

                            🛵 INICIAR ENTREGA

                        </button>
                    `
            : ""
        }

                <button
                    onclick="finalizarEntrega('${id}')"

                    style="
                        flex:1;
                        background:#28a745;
                        color:white;
                        border:none;
                        padding:12px;
                        border-radius:5px;
                        font-weight:bold;
                        cursor:pointer;
                    ">

                    ✅ CONCLUIR

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

    if (!p.itens?.length)
        return "Detalhes não informados";

    return p.itens
        .map(item => item.nome)
        .join(", ");

}

// ======================================
// WHATSAPP
// ======================================

window.abrirZap = (fone, nome) => {

    if (!fone) {

        alert("Telefone não informado");

        return;

    }

    const msg =
        encodeURIComponent(
            `Olá ${nome}, aqui é o entregador da Nova Origem Açaí. 🛵`
        );

    window.open(
        `https://wa.me/55${fone}?text=${msg}`,
        "_blank"
    );

};

// ======================================
// STATUS
// ======================================

window.atualizarStatus =
    async (id, novoStatus) => {

        try {

            const docRef =
                doc(db, "pedidos", id);

            await updateDoc(
                docRef,
                {
                    status: novoStatus
                }
            );

            if (novoStatus === "em_rota") {

                const snap =
                    await getDoc(docRef);

                if (snap.exists()) {

                    const p =
                        snap.data();

                    if (p.fone) {

                        const msg =

                            `Olá ${p.nome}! Seu pedido da Nova Origem Açaí saiu para entrega. 🛵💨`;

                        window.open(
                            `https://wa.me/55${p.fone}?text=${encodeURIComponent(msg)}`,
                            "_blank"
                        );

                    }

                }

            }

        } catch (erro) {

            console.error(
                erro
            );

        }

    };

// ======================================
// CONCLUIR ENTREGA
// ======================================

window.finalizarEntrega = async (id) => {

    if (!confirm("Confirmar entrega?")) return;

    try {

        const pedidoRef = doc(db, "pedidos", id);

        const pedidoSnap = await getDoc(pedidoRef);

        if (!pedidoSnap.exists()) {
            alert("Pedido não encontrado.");
            return;
        }

        const pedido = pedidoSnap.data();

        // Atualiza status
        await window.atualizarStatus(
            id,
            "concluido"
        );

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

        if (confirm("Deseja solicitar feedback ao cliente?")) {
            window.open(
                `https://wa.me/55${telefone}?text=${mensagem}`,
                "_blank"
            );
        }

    } catch (erro) {

        console.error(erro);

        alert("Erro ao finalizar entrega.");

    }

};
// ======================================

iniciarPainelEntregador();
