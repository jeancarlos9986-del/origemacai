import { db } from "./firebase.js";
import { collection, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const PRECOS = {
    jantinha: 18.00,
    espetos: {
        "Fraldinha": 10.00, "Almôdega Com Bacon": 10.00, "Fran Bacon": 10.00,
        "Costela Bovina": 10.00, "Linguiça Apimentada": 10.00,
        "Kafta com Queijo": 10.00, "Linguiça Toscana": 10.00,
        "Tulipa": 10.00, "Cupim Laranja": 12.00, "Costela Suina": 10.00,
        "Filé Mignon": 16.00, "Pão de alho": 10.00, "Coraçãozinho": 10.00,
        "Medalhão": 10.00, "Choripan": 10.00
    },
    lanches: {
        "Cheesebacon Simples": 21.00, "Cheesebacon Duplo": 31.00,
        "Tropical Simples": 22.00, "Tropical Duplo": 32.00,
        "BIG F&B Simples": 21.00, "BIG F&B Duplo": 31.00, "Pão Queijo/Cheeder Hamburguer": 15.00,
        "F&B Banana Simples": 22.00, "F&B Banana Duplo": 32.00,
        "F&B Mania": 45.00, "Batata Frita M": 8.00, "Batata Frita P": 5.00, "Molho Verde": 3.00, "Molho da Casa": 3.00, "Mussarela": 0.00, "Cheedar": 0.00, "Bacon": 3.00, "Abacaxi": 0.00
    },
    refrigerantes: {
        "Coca Cola 2L": 12.00, "Coca Cola Zero 2L": 12.00, "Fanta Laranja 2L": 12.00,
        "Coca cola Lata 310ml": 5.00, "Coca cola zero Lata 310ml": 5.00,
        "Mineiro 1,5L": 7.50, "Mineiro Lata": 5.00, "Amstel": 6.00, "Coca Cola 1L": 8.50, "Coca Zero 1L": 8.50,
        "Agua Mineral": 4.00, "Brahma": 5.00, "Skol": 5.00, "Antartica": 5.00, "Dell Vale Maracuja": 10,
        "Dell Vale Pessego": 10, "Dell Vale Abacaxi": 10, "Dell Vale Manga": 10, "Heineken": 9.00
    },
    acai: { "Açaí 400ml": 17.00 },
    acaiAdicionais: {
        "Paçoca": 2.00, "Ouro Branco": 3.00, "Sonho de Valsa": 3.00,
        "Nutella": 4.00, "Kit Kat": 3.00, "Disquetes": 2.00
    }
};

let carrinho = {};

// --- FUNÇÃO PARA GERAR O HTML DOS ITENS ---
function carregarCardapio() {
    const container = document.getElementById('lista-itens');
    if (!container) return;
    container.innerHTML = "";

    renderizarItem(container, "Jantinha Completa", PRECOS.jantinha, "jantinha_Jantinha");

    const categorias = [
        { nome: "🍢 Espetos", dados: PRECOS.espetos, chave: "espetos" },
        { nome: "🍔 Lanches e Porções", dados: PRECOS.lanches, chave: "lanches" },
        { nome: "🥤 Bebidas", dados: PRECOS.refrigerantes, chave: "refrigerantes" },
        { nome: "💜 Açaí", dados: PRECOS.acai, chave: "acai" },
        { nome: "🍫 Adicionais Açaí", dados: PRECOS.acaiAdicionais, chave: "acaiAdicionais" }
    ];

    categorias.forEach(cat => {
        const titulo = document.createElement('h2');
        titulo.innerText = cat.nome;
        titulo.className = "categoria-titulo";
        container.appendChild(titulo);

        Object.entries(cat.dados).forEach(([nome, preco]) => {
            renderizarItem(container, nome, preco, `${cat.chave}_${nome}`);
        });
    });
}

function renderizarItem(container, nome, preco, idUnico) {
    const div = document.createElement('div');
    div.className = 'item-card';
    div.innerHTML = `
        <div class="item-info">
            <strong>${nome}</strong><br>
            <small>R$ ${preco.toFixed(2)}</small>
        </div>
        <div class="controles">
            <button class="btn-qtd" onclick="mudarQtd('${idUnico}', -1, ${preco}, '${nome}')">-</button>
            <span class="qtd-valor" id="qtd-${idUnico}">0</span>
            <button class="btn-qtd" onclick="mudarQtd('${idUnico}', 1, ${preco}, '${nome}')">+</button>
        </div>
    `;
    container.appendChild(div);
}

// --- LÓGICA DE QUANTIDADE ---
window.mudarQtd = (id, delta, preco, nome) => {
    if (!carrinho[id]) carrinho[id] = { qtd: 0, preco: preco, nome: nome };

    carrinho[id].qtd += delta;
    if (carrinho[id].qtd < 0) carrinho[id].qtd = 0;

    document.getElementById(`qtd-${id}`).innerText = carrinho[id].qtd;
    atualizarTotal();
};

function atualizarTotal() {
    let total = 0;
    Object.values(carrinho).forEach(item => {
        total += item.qtd * item.preco;
    });
    const totalElement = document.getElementById('valor-total');
    if (totalElement) totalElement.innerText = total.toFixed(2);
}

// --- FUNÇÃO PARA ENVIAR O PEDIDO (CYBERTECH FLOW) ---
window.enviarPedido = async () => {
    const nomeCli = document.getElementById('cliente-nome').value;
    const foneCli = document.getElementById('cliente-fone').value;
    const totalVal = parseFloat(document.getElementById('valor-total').innerText);

    if (!nomeCli || !foneCli || totalVal <= 0) {
        alert("Preencha seu nome, telefone e adicione itens ao pedido!");
        return;
    }

    const pedido = {
        cliente: nomeCli,
        whatsapp: foneCli,
        total: totalVal,
        status: "Pendente",
        data: new Date().toLocaleString(),
        churrasqueira: [],
        cozinha: [],
        bebidas: []
    };

    Object.entries(carrinho).forEach(([id, dados]) => {
        if (dados.qtd > 0) {
            const itemFinal = { nome: dados.nome, qtd: dados.qtd, preco: dados.preco };

            if (id.includes("espetos")) {
                pedido.churrasqueira.push(itemFinal);
            } else if (id.includes("lanches") || id.includes("jantinha")) {
                pedido.cozinha.push(itemFinal);
            } else {
                pedido.bebidas.push(itemFinal);
            }
        }
    });

    try {
        console.log("Enviando para o Firebase...", pedido);
        await addDoc(collection(db, "pedidos"), pedido);
        alert("Pedido enviado com sucesso para a F&B Burguer!");
        window.location.reload();
    } catch (error) {
        console.error("Erro Firebase:", error);
        alert("Erro ao conectar com o servidor. Verifique sua internet.");
    }
};

carregarCardapio();