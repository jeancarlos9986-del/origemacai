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
// FIREBASE
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

const painelPedidos =
    document.getElementById("painelPedidos");

const semPedidos =
    document.getElementById("semPedidos");

let pedidos = [];

// ======================================
// STATUS
// ======================================

function obterStatusTexto(status) {

    switch (status) {

        case "novo":
            return "🟣 NOVO";

        case "preparo":
            return "🟡 EM PREPARO";

       case "pronto":
    return "🟢 PRONTO PARA ENTREGA";

case "em_rota":
    return "🛵 EM ROTA";

case "concluido":
    return "✅ ENTREGUE";

    }

}

// ======================================
// RENDER
// ======================================

function renderizarPedidos() {

    painelPedidos.innerHTML = "";

    if (!pedidos.length) {

        semPedidos.style.display = "block";

        return;

    }

    semPedidos.style.display = "none";

    // Ordena de forma decrescente utilizando o timestamp 'criadoEm'
    pedidos
    .filter(p => p.status !== "concluido")
    .sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0))
        .forEach((pedido) => {

            const card = document.createElement("div");

            card.className =
                `pedido-card ${pedido.status}`;

            // Encurta o número gerado pelo Date.now() para exibir apenas os últimos 4 dígitos
            const numeroExibicao = pedido.numero ? String(pedido.numero).slice(-4) : "----";

            card.innerHTML = `

                <div class="pedido-top">

                    <div>

                        <div class="pedido-numero">
                            Pedido #${numeroExibicao}
                        </div>

                        <div class="pedido-hora">
                            ${pedido.hora || ""}
                        </div>

                    </div>

                    <div class="pedido-status status-${pedido.status}">
                        ${obterStatusTexto(pedido.status)}
                    </div>

                </div>

                <div class="cliente-box">

                    <div>
                        <strong>Cliente:</strong>
                        ${pedido.nome || ""}
                    </div>

                    <div>
                        <strong>Telefone:</strong>
                        ${pedido.fone || ""}
                    </div>

                    <div>
                        <strong>Entrega:</strong>
                        ${pedido.entrega || ""}
                    </div>

                    <div>
                        <strong>Pagamento:</strong>
                        ${pedido.pagamento || ""}
                    </div>

                    ${pedido.endereco ? `
                        <div>
                            <strong>Endereço:</strong>
                            ${pedido.endereco}
                        </div>
                    ` : ""}

                </div>

                <div class="pedido-itens">

                    ${pedido.itens ? pedido.itens.map(item => `

                        <div class="pedido-item">

                            <strong>
                                ${item.nome || ""}
                            </strong>

                            ${item.gratis?.length ? `
                                <div class="item-gratis">
                                    Grátis:
                                    ${item.gratis.join(", ")}
                                </div>
                            ` : ""}

                            ${item.extras?.length ? `
                                <div class="item-extra">
                                    Extras:
                                    ${item.extras.join(", ")}
                                </div>
                            ` : ""}

                            ${item.obs ? `
                                <div class="item-obs">
                                    Obs:
                                    ${item.obs}
                                </div>
                            ` : ""}

                            <div style="
                                margin-top:8px;
                                color:#00ff84;
                                font-weight:700;
                            ">

                                R$ ${(item.preco || 0).toFixed(2)}

                            </div>

                        </div>

                    `).join("") : ""}

                </div>

                <div class="pedido-footer">

                    <div class="pedido-total">

                        Total:
                        R$ ${(pedido.total || 0).toFixed(2)}

                    </div>

                    <div class="acoes">

                        ${pedido.status === "novo"
                    ? `
                            <button
                                class="btn-preparo"
                                data-id="${pedido.id}">

                                EM PREPARO

                            </button>
                        `
                    : ""}

                        ${pedido.status === "preparo"
? `
    <button
        class="btn-pronto"
                                data-id="${pedido.id}">

                                FINALIZAR

                            </button>
                        `
                    : ""}

                        <button
                            class="btn-remover"
                            data-remove="${pedido.id}">

                            REMOVER

                        </button>

                    </div>

                </div>

            `;

            painelPedidos.appendChild(card);

        });

    adicionarEventos();

}

// ======================================
// EVENTOS
// ======================================

function adicionarEventos() {

    document.querySelectorAll(".btn-preparo")
        .forEach(btn => {

            btn.addEventListener("click", async () => {

                const id = btn.dataset.id;

                await updateDoc(
                    doc(db, "pedidos", id),
                    {
                        status: "preparo"
                    }
                );

            });

        });

    document.querySelectorAll(".btn-pronto")
    .forEach(btn => {

        btn.addEventListener("click", async () => {

            const id = btn.dataset.id;

            await updateDoc(
                doc(db, "pedidos", id),
                {
                    status: "pronto"
                }
            );

        });

    });
      

    document.querySelectorAll(".btn-remover")
        .forEach(btn => {

            btn.addEventListener("click", async () => {

                const id = btn.dataset.remove;

                await deleteDoc(
                    doc(db, "pedidos", id)
                );

            });

        });

}

// ======================================
// TEMPO REAL
// ======================================

onSnapshot(
    collection(db, "pedidos"),
    (snapshot) => {

        pedidos = snapshot.docs.map(docItem => ({

            id: docItem.id,
            ...docItem.data()

        }));

        renderizarPedidos();

    }
);