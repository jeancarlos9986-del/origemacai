import { db } from "./firebase.js";
import {
    collection, addDoc, getDocs, updateDoc, doc, onSnapshot, query, orderBy, where
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// --------------------------
// REGRAS DE CONSUMO POR PRODUTO
// --------------------------
const CONSUMO = {
    "400ml": { acai: 0.28 },
    "500ml": { acai: 0.32 },
    "Pequeno": { acai: 0.28 },
    "Médio": { acai: 0.32 },
    "Super": { acai: 0.32 },
    "Nutella": { quantidade: 0.03 },
    "Morango": { quantidade: 0.03 },
    "Granola": { quantidade: 0.02 },
    "Leite em pó": { quantidade: 0.02 },
    "Leite condensado": { quantidade: 0.02 },
    "Paçoca": { quantidade: 0.02 },
    "Disquete": { quantidade: 0.01 },
    "Kit Kat": { quantidade: 0.01 },
    "Ouro Branco": { quantidade: 0.01 },
    "Sonho de Valsa": { quantidade: 0.01 },
    "Chocoball": { quantidade: 0.01 },
    "Amendoim": { quantidade: 0.02 },
    "Banana": { quantidade: 0.03 },
    "Ovomaltine": { quantidade: 0.02 }
};

// --------------------------
// FUNÇÕES DE SEGURANÇA
// --------------------------
function garantirNumero(valor, padrao = 0) {
    const convertido = Number(valor);
    return isNaN(convertido) ? padrao : convertido;
}

function garantirTexto(valor, padrao = "Não informado") {
    return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : padrao;
}

// --------------------------
// INICIALIZAÇÃO
// --------------------------
document.addEventListener("DOMContentLoaded", () => {
    carregarEstoque();
    carregarMovimentacoes();
    preencherSelectItens();

    document.getElementById("btn-salvar-item")?.addEventListener("click", salvarItem);
    document.getElementById("btn-movimentar")?.addEventListener("click", registrarMovimentacao);

    monitorarPedidosConcluidos();
});

// --------------------------
// BAIXA AUTOMÁTICA
// --------------------------
async function monitorarPedidosConcluidos() {
    const pedidosRef = collection(db, "pedidos");
    const q = query(pedidosRef, where("status", "==", "concluido"));

    onSnapshot(q, async (snap) => {
        snap.docChanges().forEach(async (change) => {
            if ((change.type === "modified" || change.type === "added")) {
                const pedido = change.doc.data();
                if (pedido.estoqueBaixado) return;
                await darBaixaPorPedido(pedido, change.doc.id);
            }
        });
    });
}

async function darBaixaPorPedido(pedido, idPedido) {
    try {
        const itens = pedido.itens || [];
        let baixas = [];

        for (const item of itens) {
            const nomeCopo = garantirTexto(item.nome, "").toLowerCase();
            let tipoCopo = "500ml";
            if (nomeCopo.includes("400ml") || nomeCopo.includes("pequeno")) tipoCopo = "400ml";

            baixas.push({ nome: "Açaí", qtd: CONSUMO[tipoCopo].acai });
            baixas.push({ nome: tipoCopo === "400ml" ? "Copo 400ml" : "Copo 500ml", qtd: 1 });
            baixas.push({ nome: "Tampa", qtd: 1 });
            baixas.push({ nome: "Colher", qtd: 1 });
            baixas.push({ nome: "Guardanapo", qtd: 1 });

            const adicionais = item.extras?.gratis || [];
            adicionais.forEach(nomeAdicional => {
                if (CONSUMO[nomeAdicional]) {
                    baixas.push({ nome: nomeAdicional, qtd: CONSUMO[nomeAdicional].quantidade });
                }
            });
        }

        const qtdCopos = itens.length;
        if (qtdCopos === 1) {
            baixas.push({ nome: "Sacola 1 copo", qtd: 1 });
            baixas.push({ nome: "Porta-copo 1 copo", qtd: 1 });
        } else {
            baixas.push({ nome: "Sacola 2+ copos", qtd: 1 });
            baixas.push({ nome: "Porta-copo 2+ copos", qtd: 1 });
        }

        for (const baixa of baixas) {
            await atualizarQuantidadeItem(baixa.nome, baixa.qtd, `Baixa automática - Pedido #${pedido.numero || idPedido.slice(-4)}`);
        }

        await updateDoc(doc(db, "pedidos", idPedido), { estoqueBaixado: true });
    } catch (e) {
        console.error("Erro baixa automática:", e.message);
    }
}

async function atualizarQuantidadeItem(nomeItem, qtdSaida, observacao) {
    const snap = await getDocs(query(collection(db, "estoque"), where("nome", "==", nomeItem)));
    if (snap.empty) return;

    const docItem = snap.docs[0];
    const dados = docItem.data();
    const qtdAtual = garantirNumero(dados.quantidade);
    const novaQtd = qtdAtual - qtdSaida;

    if (novaQtd < 0) return;

    await updateDoc(doc(db, "estoque", docItem.id), {
        quantidade: novaQtd,
        atualizadoEm: new Date()
    });

    await addDoc(collection(db, "movimentacoes"), {
        itemId: garantirTexto(docItem.id),
        nomeItem: garantirTexto(nomeItem),
        tipo: "saida",
        quantidade: garantirNumero(qtdSaida),
        observacao: garantirTexto(observacao),
        data: new Date()
    });
}

// --------------------------
// CADASTRAR INSUMO
// --------------------------
async function salvarItem() {
    const nome = garantirTexto(document.getElementById("nome-item").value);
    const unidade = garantirTexto(document.getElementById("unidade-item").value);
    const qtd = garantirNumero(document.getElementById("qtd-item").value);
    const custo = garantirNumero(document.getElementById("custo-item").value);

    if (!nome || qtd <= 0 || custo < 0) {
        alert("Preencha todos os campos corretamente!");
        return;
    }

    try {
        await addDoc(collection(db, "estoque"), {
            nome, unidade, quantidade: qtd, custoUnitario: custo, atualizadoEm: new Date()
        });
        alert("✅ Item cadastrado com sucesso!");
        limparFormularioItem();
        carregarEstoque();
        preencherSelectItens();
    } catch (e) {
        alert("Erro ao salvar: " + e.message);
    }
}

// --------------------------
// REGISTRAR MOVIMENTAÇÃO (CORRIGIDO)
// --------------------------
async function registrarMovimentacao() {
    const itemId = garantirTexto(document.getElementById("select-item").value);
    const tipo = garantirTexto(document.getElementById("tipo-mov").value);
    const qtd = garantirNumero(document.getElementById("qtd-mov").value);
    const obs = garantirTexto(document.getElementById("obs-mov").value);

    if (!itemId || itemId === "" || qtd <= 0) {
        alert("Selecione o item e preencha a quantidade!");
        return;
    }

    try {
        const snap = await getDocs(query(collection(db, "estoque"), where("__name__", "==", itemId)));
        if (snap.empty) {
            alert("Item não encontrado no estoque!");
            return;
        }

        const docItem = snap.docs[0];
        const itemData = docItem.data();
        const itemRef = doc(db, "estoque", itemId);
        const qtdAtual = garantirNumero(itemData.quantidade);
        const nomeItem = garantirTexto(itemData.nome);

        let novaQtd;
        if (tipo === "entrada") novaQtd = qtdAtual + qtd;
        else if (tipo === "saida") novaQtd = qtdAtual - qtd;
        else novaQtd = qtd;

        if (novaQtd < 0) {
            alert("❌ Estoque insuficiente!");
            return;
        }

        await updateDoc(itemRef, { quantidade: novaQtd, atualizadoEm: new Date() });

        // GARANTE QUE TODOS OS CAMPOS EXISTEM ANTES DE SALVAR
        await addDoc(collection(db, "movimentacoes"), {
            itemId: garantirTexto(itemId),
            nomeItem: nomeItem,
            tipo: tipo,
            quantidade: qtd,
            observacao: obs,
            data: new Date()
        });

        alert("✅ Movimentação registrada!");
        limparFormularioMov();
        carregarEstoque();
        carregarMovimentacoes();
    } catch (e) {
        console.error("Erro completo:", e);
        alert("Erro na movimentação: " + e.message);
    }
}

// --------------------------
// CARREGAR ESTOQUE
// --------------------------
async function carregarEstoque() {
    const corpo = document.querySelector("#tabela-estoque tbody");
    if (!corpo) return;
    corpo.innerHTML = "<tr><td colspan='6' style='text-align:center; color:var(--muted)'>Carregando...</td></tr>";

    try {
        const snap = await getDocs(collection(db, "estoque"));
        corpo.innerHTML = "";
        if (snap.empty) {
            corpo.innerHTML = "<tr><td colspan='6' style='text-align:center; color:var(--muted)'>Nenhum insumo cadastrado.</td></tr>";
            return;
        }

        snap.forEach(doc => {
            const item = doc.data();
            const qtd = garantirNumero(item.quantidade);
            const custo = garantirNumero(item.custoUnitario);
            const total = (qtd * custo).toFixed(2);

            corpo.innerHTML += `
                <tr>
                    <td>${garantirTexto(item.nome)}</td>
                    <td>${garantirTexto(item.unidade)}</td>
                    <td>${qtd.toFixed(2)}</td>
                    <td>R$ ${custo.toFixed(2)}</td>
                    <td>R$ ${total}</td>
                    <td><button onclick="editarItem('${doc.id}')">Editar</button></td>
                </tr>
            `;
        });
    } catch (e) {
        corpo.innerHTML = `<tr><td colspan='6' style='text-align:center; color:var(--red)'>Erro: ${e.message}</td></tr>`;
    }
}

// --------------------------
// CARREGAR MOVIMENTAÇÕES
// --------------------------
async function carregarMovimentacoes() {
    const corpo = document.querySelector("#tabela-mov tbody");
    if (!corpo) return;
    const q = query(collection(db, "movimentacoes"), orderBy("data", "desc"));

    onSnapshot(q, (snap) => {
        corpo.innerHTML = "";
        if (snap.empty) {
            corpo.innerHTML = "<tr><td colspan='5' style='text-align:center; color:var(--muted)'>Nenhuma movimentação registrada.</td></tr>";
            return;
        }

        snap.forEach(doc => {
            const mov = doc.data();
            const data = mov.data ? new Date(mov.data.toDate()).toLocaleString('pt-BR') : "-";
            const tipoTexto = { entrada: "✅ Entrada", saida: "❌ Saída", ajuste: "🔧 Ajuste" }[garantirTexto(mov.tipo)] || garantirTexto(mov.tipo);
            const qtdMov = garantirNumero(mov.quantidade);

            corpo.innerHTML += `
                <tr>
                    <td>${data}</td>
                    <td>${garantirTexto(mov.nomeItem)}</td>
                    <td>${tipoTexto}</td>
                    <td>${qtdMov.toFixed(2)}</td>
                    <td>${garantirTexto(mov.observacao)}</td>
                </tr>
            `;
        });
    });
}

// --------------------------
// PREENCHER SELECT
// --------------------------
async function preencherSelectItens() {
    const select = document.getElementById("select-item");
    if (!select) return;
    select.innerHTML = "<option value=''>Selecione um insumo...</option>";

    const snap = await getDocs(collection(db, "estoque"));
    snap.forEach(doc => {
        const item = doc.data();
        const qtd = garantirNumero(item.quantidade);
        const unidade = garantirTexto(item.unidade);
        const nome = garantirTexto(item.nome);

        select.innerHTML += `<option value="${doc.id}">${nome} (${qtd.toFixed(2)} ${unidade})</option>`;
    });
}

// --------------------------
// AUXILIARES
// --------------------------
function limparFormularioItem() {
    document.getElementById("nome-item").value = "";
    document.getElementById("qtd-item").value = "";
    document.getElementById("custo-item").value = "";
}

function limparFormularioMov() {
    document.getElementById("select-item").value = "";
    document.getElementById("qtd-mov").value = "";
    document.getElementById("obs-mov").value = "";
}

function editarItem(id) {
    alert("Por enquanto use 'Ajuste de Contagem' na movimentação!");
}

window.editarItem = editarItem;