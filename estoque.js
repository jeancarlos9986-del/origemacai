import { db } from "./firebase.js";
import {
    collection,
    onSnapshot,
    doc,
    setDoc,
    updateDoc,
    increment,
    getDocs
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const tabela = document.getElementById("tabela");
const saida = document.getElementById("saida");

// 🔄 ATUALIZAÇÃO EM TEMPO REAL
onSnapshot(collection(db, "estoque"), (snapshot) => {
    tabela.innerHTML = "";

    snapshot.forEach(docSnap => {
        const item = docSnap.data();
        const minimo = item.minimo || 5;

        const tr = document.createElement("tr");

        tr.innerHTML = `
            <td>${docSnap.id}</td>
            <td class="${item.quantidade <= minimo ? 'alerta' : ''}">
                ${item.quantidade}
            </td>
            <td>${minimo}</td>
            <td>
                <button onclick="window.ajustar('${docSnap.id}', 1)">+</button>
                <button onclick="window.ajustar('${docSnap.id}', -1)">-</button>
            </td>
        `;

        tabela.appendChild(tr);
    });
});

// ➕ CADASTRAR ITEM
window.cadastrar = async () => {
    const nome = document.getElementById("nome").value.trim();
    const qtd = parseInt(document.getElementById("qtd").value);
    const min = parseInt(document.getElementById("min").value) || 5;

    if (!nome || isNaN(qtd)) {
        alert("Preencha corretamente");
        return;
    }

    await setDoc(doc(db, "estoque", nome), {
        quantidade: qtd,
        minimo: min,
        precoCusto: 0,
        ultimaAtualizacao: new Date()
    });
};

// ➕➖ AJUSTAR ESTOQUE
window.ajustar = async (id, valor) => {
    await updateDoc(doc(db, "estoque", id), {
        quantidade: increment(valor),
        ultimaAtualizacao: new Date()
    });
};

// 🛒 GERAR LISTA DE COMPRA
window.gerarListaCompra = async () => {
    const snapshot = await getDocs(collection(db, "estoque"));

    let texto = "🛒 LISTA DE COMPRA\n\n";

    snapshot.forEach(docSnap => {
        const item = docSnap.data();
        const min = item.minimo || 5;

        if (item.quantidade <= min) {
            const comprar = (min * 2) - item.quantidade;
            texto += `- ${docSnap.id}: comprar ${comprar}\n`;
        }
    });

    saida.innerText = texto;
};

// 📦 VER ESTOQUE COMPLETO
window.verEstoque = async () => {
    const snapshot = await getDocs(collection(db, "estoque"));

    let texto = "📦 ESTOQUE ATUAL\n\n";

    snapshot.forEach(docSnap => {
        const item = docSnap.data();
        texto += `- ${docSnap.id}: ${item.quantidade}\n`;
    });

    saida.innerText = texto;
};

// 📲 EXPORTAR PARA WHATSAPP
window.exportarWhats = () => {
    const texto = encodeURIComponent(saida.innerText);
    window.open(`https://wa.me/?text=${texto}`, "_blank");
};

// ⚠️ ALERTA AUTOMÁTICO (a cada 1 min)
setInterval(async () => {
    const snapshot = await getDocs(collection(db, "estoque"));

    snapshot.forEach(docSnap => {
        const item = docSnap.data();
        const min = item.minimo || 5;

        if (item.quantidade <= min) {
            console.log(`⚠️ Estoque baixo: ${docSnap.id}`);
        }
    });
}, 60000);