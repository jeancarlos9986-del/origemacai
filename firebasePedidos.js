import {
    collection,
    addDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

window.salvarPedidoFirebase = async function (pedido) {
    try {
        await addDoc(collection(window.db, "pedidos"), {
            ...pedido,
            status: "Pendente",
            criadoEm: serverTimestamp()
        });

        console.log("🔥 Pedido enviado para o Firebase");
    } catch (e) {
        console.error("❌ Erro ao salvar pedido no Firebase", e);
    }
};
