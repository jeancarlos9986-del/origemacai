import { db } from "./firebase.js";
import {
    collection, query, where, getDocs, doc, updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { construirMapaEstoque, processarPedidoSeguro } from "./estoqueBaixa.js";

// ==============================================
// USO ÚNICO: debita retroativamente o estoque dos pedidos de 07/08/2026
// ==============================================
// Depois de rodar uma vez com sucesso, pode apagar este arquivo e o
// debitar-retroativo.html do servidor — eles não são usados no dia a dia.
// ==============================================

const INICIO = new Date("2026-08-07T00:00:00-03:00").getTime();
const FIM = new Date("2026-08-08T00:00:00-03:00").getTime();
const STATUS_VALIDOS = ["pronto", "concluido", "finalizado"];

export async function debitarRetroativo(log) {
    log("🔎 Buscando pedidos de 07/08/2026...");

    const snap = await getDocs(query(
        collection(db, "pedidos"),
        where("criadoEm", ">=", INICIO),
        where("criadoEm", "<", FIM)
    ));

    const alvos = snap.docs.filter(d => {
        const status = String(d.data().status || "").toLowerCase();
        return STATUS_VALIDOS.includes(status);
    });

    log(`📦 ${alvos.length} pedidos de 07/08 com status válido (pronto/concluído/finalizado).`);

    // Pedidos que JÁ tiveram baixa real (estoqueBaixado=true e não é o
    // flag "histórico ignorado") são pulados pra nunca debitar 2x.
    const jaProcessados = alvos.filter(d => d.data().estoqueBaixado && !d.data().estoqueIgnoradoHistorico);
    const pendentes = alvos.filter(d => !d.data().estoqueBaixado || d.data().estoqueIgnoradoHistorico);

    log(`✅ ${jaProcessados.length} já tinham baixa real — ignorados (sem duplicar).`);
    log(`⏳ ${pendentes.length} serão processados agora.`);

    if (!pendentes.length) {
        log("Nada a fazer. Tudo certo! ✅");
        return;
    }

    const mapaEstoque = await construirMapaEstoque();
    let ok = 0, erro = 0;

    for (const d of pendentes) {
        try {
            // Libera o pedido pra baixa real, removendo as flags que
            // bloqueariam o processamento (ex: marcado como "histórico").
            await updateDoc(doc(db, "pedidos", d.id), {
                estoqueBaixado: false,
                estoqueIgnoradoHistorico: false
            });
            await processarPedidoSeguro(d.id, mapaEstoque);
            ok++;
            log(`  ✅ Pedido #${d.id.slice(-4)} debitado.`);
        } catch (e) {
            erro++;
            log(`  ❌ Erro no pedido #${d.id.slice(-4)}: ${e.message}`);
            console.error(e);
        }
    }

    log(`🏁 Concluído! ${ok} debitados, ${erro} com erro.`);
}
