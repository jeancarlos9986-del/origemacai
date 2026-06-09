import { db } from "./firebase.js";
import {
    collection,
    addDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ==========================================
// 1️⃣ CONFIGURAÇÕES E PREÇOS
// ==========================================
const PRECOS = {
    jantinha: 18.00,
    espetos: {
        "Fraldinha": 10.00, "Almôdega Com Bacon": 10.00, "Fran Bacon": 10.00,
        "Costela Bovina": 10.00, "Linguiça Cuiabana C/Queijo": 10.00,
        "Kafta C/Queijo": 10.00, "Linguiça Toscana": 10.00,
        "Tulipa": 10.00, "Cupim Laranja": 12.00, "Costela Suina": 10.00,
        "Filé Mignon": 16.00, "Pão de alho": 10.00, "Coraçãozinho": 10.00,
        "Medalhão": 10.00, "Choripan": 10.00
    },
    lanches: {
        "Cheesebacon Simples": 21.00, "Cheesebacon Duplo": 31.00,
        "Tropical Simples": 22.00, "Tropical Duplo": 32.00,
        "BIG F&B Simples": 21.00, "BIG F&B Duplo": 31.00,
        "F&B Banana Simples": 22.00, "F&B Banana Duplo": 32.00,
        "F&B Mania": 45.00, "Batata Frita M": 8.00, "Batata Frita P": 5.00,
        "Molho Verde": 3.00, "Molho da Casa": 3.00,
        "Mussarela": 0.00, "Cheedar": 0.00,
        "Bacon": 0.00, "Abacaxi": 0.00
    },
    bebidas: {
        "Coca Cola 2L": 12.00, "Fanta Laranja 2L": 12.00,
        "Coca cola Lata 310ml": 5.00, "Coca cola zero Lata 310ml": 5.00,
        "Mineiro 1,5L": 7.50, "Coca Cola 1L": 8.50, "Coca Zero 1L": 8.50,
        "Agua Mineral": 4.00, "Brahma": 5.00,
        "Skol": 5.00, "Antartica": 5.00,
        "Dell Vale": 10.00, "Heineken": 9.00
    }
};

// ==========================================
// 2️⃣ ESTADO GLOBAL
// ==========================================
let carrinho = {
    lanches: {},
    espetos: {},
    bebidas: {},
    jantinhas: { quantidade: 0 }
};

let totalPedido = 0;
let pedidoAtual = null;

// ==========================================
// 3️⃣ RENDERIZAÇÃO DOS PRODUTOS
// ==========================================
function carregarProdutos() {

    const render = (containerId, lista, categoria) => {
        const container = document.getElementById(containerId);
        if (!container) return;

        Object.keys(lista).forEach(nome => {
            const idSane = nome.replace(/\s+/g, '-');
            container.innerHTML += `
                <div class="item-row">
                    <div class="item-info">
                        <strong>${nome}</strong>
                        <small>R$ ${lista[nome].toFixed(2)}</small>
                    </div>
                    <div class="controls">
                        <button class="qty btn-minus" onclick="alterar('${categoria}', '${nome}', -1)">-</button>
                        <span class="qty-val" id="qtd-${categoria}-${idSane}">0</span>
                        <button class="qty btn-plus" onclick="alterar('${categoria}', '${nome}', 1)">+</button>
                    </div>
                </div>`;
        });
    };

    const listaJantinha = document.getElementById("lista-jantinha");
    if (listaJantinha) {
        listaJantinha.innerHTML = `
            <div class="item-row">
                <div class="item-info">
                    <strong>Jantinha Completa</strong>
                    <small>R$ ${PRECOS.jantinha.toFixed(2)}</small>
                </div>
                <div class="controls">
                    <button class="qty btn-minus" onclick="alterar('jantinhas', 'quantidade', -1)">-</button>
                    <span class="qty-val" id="qtd-jantinhas-quantidade">0</span>
                    <button class="qty btn-plus" onclick="alterar('jantinhas', 'quantidade', 1)">+</button>
                </div>
            </div>`;
    }

    render("lista-lanches", PRECOS.lanches, "lanches");
    render("lista-espetos", PRECOS.espetos, "espetos");
    render("lista-bebidas", PRECOS.bebidas, "bebidas");
}
function feedbackAcao() {
    // Vibração no celular
    if (navigator.vibrate) {
        navigator.vibrate(40);
    }

    // Som
    const som = document.getElementById("som-add");
    if (som) {
        som.currentTime = 0;
        som.play().catch(() => { });
    }
}


// ==========================================
// 4️⃣ LÓGICA DO CARRINHO
// ==========================================
window.alterar = (cat, nome, val) => {
    feedbackAcao(); // 🔥 AQUI

    const idSane = nome.replace(/\s+/g, '-');

    if (cat === 'jantinhas') {
        carrinho.jantinhas.quantidade = Math.max(
            0,
            carrinho.jantinhas.quantidade + val
        );
        document.getElementById("qtd-jantinhas-quantidade").innerText =
            carrinho.jantinhas.quantidade;
    } else {
        if (!carrinho[cat][nome]) carrinho[cat][nome] = 0;
        carrinho[cat][nome] = Math.max(0, carrinho[cat][nome] + val);
        document.getElementById(`qtd-${cat}-${idSane}`).innerText =
            carrinho[cat][nome];
    }

    calcularTotal();
};


function calcularTotal() {
    let t = 0;
    t += carrinho.jantinhas.quantidade * PRECOS.jantinha;

    Object.entries(carrinho.lanches).forEach(([n, q]) => t += q * PRECOS.lanches[n]);
    Object.entries(carrinho.espetos).forEach(([n, q]) => t += q * PRECOS.espetos[n]);
    Object.entries(carrinho.bebidas).forEach(([n, q]) => t += q * PRECOS.bebidas[n]);

    totalPedido = t;
    document.getElementById("total-valor").innerText = t.toFixed(2);
}

// ==========================================
// 5️⃣ VALIDAÇÃO
// ==========================================
function validarCliente() {
    const input = document.getElementById("cliente-nome");
    const nome = input.value.trim();

    if (!nome) {
        alert("Informe o nome do cliente ou o número da mesa.");
        input.focus();
        return false;
    }
    return true;
}

// ==========================================
// 6️⃣ FLUXO DE CONFIRMAÇÃO
// ==========================================
window.enviarPedidoFinal = () => {
    if (!validarCliente()) return;
    if (totalPedido === 0) {
        alert("🛒 O carrinho está vazio!");
        return;
    }

    montarPedidoAtual();

    const modal = document.getElementById("modal-confirmacao");
    if (modal) abrirConfirmacao();
    else enviarParaCozinha(); // fallback sem modal
};

function montarPedidoAtual() {
    const cliente = document.getElementById("cliente-nome").value.trim();
    const obs = document.getElementById("observacao-geral").value;

    const tipoRadio = document.querySelector('input[name="tipo-pedido"]:checked');
    const tipoPedido = tipoRadio ? tipoRadio.value : "🍽️ Aqui";

    pedidoAtual = {
        cliente_nome: cliente,
        tipo: tipoPedido,
        total: totalPedido,
        observacao: obs,
        lanches: carrinho.lanches,
        espetos: carrinho.espetos,
        bebidas: carrinho.bebidas,
        jantinhas: carrinho.jantinhas
    };
}

function abrirConfirmacao() {
    document.getElementById("conf-cliente").textContent =
        pedidoAtual.cliente_nome;

    const lista = document.getElementById("conf-itens");
    lista.innerHTML = "";

    const add = (obj) => {
        Object.entries(obj || {}).forEach(([n, q]) => {
            if (q > 0) {
                const div = document.createElement("div");
                div.textContent = `${q}x ${n}`;
                lista.appendChild(div);
            }
        });
    };

    if (pedidoAtual.jantinhas.quantidade > 0) {
        add({ "Jantinha": pedidoAtual.jantinhas.quantidade });
    }

    add(pedidoAtual.lanches);
    add(pedidoAtual.espetos);
    add(pedidoAtual.bebidas);

    document.getElementById("conf-total").textContent =
        `R$ ${pedidoAtual.total.toFixed(2)}`;

    document.getElementById("modal-confirmacao")
        .classList.remove("hidden");
}

function fecharModal() {
    document.getElementById("modal-confirmacao")
        .classList.add("hidden");
}

window.confirmarEnvio = async () => {
    fecharModal();
    await enviarParaCozinha();
};

// ==========================================
// 7️⃣ ENVIO PARA FIRESTORE
// ==========================================
async function enviarParaCozinha() {
    const btn = document.getElementById("btn-enviar");
    if (btn.disabled) return;

    btn.disabled = true;
    btn.innerText = "⏳ ENVIANDO...";

    try {
        await addDoc(collection(db, "pedidos"), {
            ...pedidoAtual,
            status: "Pendente",
            criadoEm: serverTimestamp(),
            id: Math.floor(1000 + Math.random() * 9000)
        });

        alert("✅ Pedido enviado!");
        location.reload();

    } catch (e) {
        console.error(e);
        alert("❌ Erro ao enviar pedido");
        btn.disabled = false;
        btn.innerText = "🚀 ENVIAR PARA COZINHA";
    }
}
function ativarBusca(inputId, containerId) {
    const input = document.getElementById(inputId);
    const container = document.getElementById(containerId);

    if (!input || !container) return;

    input.addEventListener("input", () => {
        const termo = input.value.toLowerCase();
        const itens = container.querySelectorAll(".item-row");

        itens.forEach(item => {
            const texto = item.innerText.toLowerCase();
            item.style.display = texto.includes(termo) ? "flex" : "none";
        });
    });
}

carregarProdutos();

ativarBusca("busca-lanches", "lista-lanches");
ativarBusca("busca-espetos", "lista-espetos");
ativarBusca("busca-bebidas", "lista-bebidas");

// ==========================================
// 8️⃣ INICIALIZAÇÃO
// ==========================================
window.toggleCategoria = (categoria) => {
    const mapa = {
        jantinha: "lista-jantinha",
        espetos: "lista-espetos",
        lanches: "lista-lanches",
        bebidas: "lista-bebidas"
    };

    const container = document.getElementById(mapa[categoria]);
    if (!container) return;

    const card = container.closest(".card");
    if (!card) return;

    card.style.display =
        card.style.display === "none" ? "block" : "none";

    // Atualiza botão visual
    document.querySelectorAll(".categoria-btn").forEach(btn => {
        if (btn.innerText.toLowerCase().includes(categoria)) {
            btn.classList.toggle("ativo");
        }
    });
};
