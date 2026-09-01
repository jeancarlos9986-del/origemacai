import { db } from "./firebase.js";
import {
    collection, getDocs, query, where, doc, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// Reusa a MESMA função de cálculo de receita que já roda na baixa automática
// (estoqueBaixa.js) — assim o "teórico" daqui nunca fica dessincronizado da
// receita real cadastrada.
import { calcularNecessidades } from "./estoqueBaixa.js";
import { n, norm, pegarCampo, esc } from "./utils.js";

// ==============================================
// 🆕 CONFERÊNCIA DE RECEITA — TEÓRICO x FÍSICO
// ==============================================
// Ideia: pra descobrir se a receita cadastrada (RECEITA_PRODUTO em
// estoqueBaixa.js) bate com a realidade, você escolhe um período (ex: hoje),
// o sistema soma quanto DEVERIA ter sido gasto de cada insumo segundo a
// receita, com base nos pedidos daquele período — e mostra ao lado quanto o
// sistema acha que você tem agora. Você pesa/conta fisicamente e digita o
// valor real; a diferença aparece na hora. Se quiser, um botão já corrige o
// estoque pro valor contado (fica registrado em Movimentações, igual um
// ajuste manual).
//
// Importante: o teórico é recalculado direto dos pedidos (não fica só nos
// logs de "movimentações"), pra também pegar pedidos onde a baixa automática
// tenha falhado — o objetivo aqui é testar a RECEITA contra a realidade
// física, não só conferir se a baixa automática rodou.

function inicioDoDia(str) { return new Date(str + "T00:00:00").getTime(); }
function fimDoDia(str) { return new Date(str + "T23:59:59.999").getTime(); }

async function consumoTeoricoPeriodo(inicioMs, fimMs) {
    const snap = await getDocs(query(
        collection(db, "pedidos"),
        where("status", "in", ["concluido", "finalizado", "pronto"]),
        where("criadoEm", ">=", inicioMs),
        where("criadoEm", "<=", fimMs)
    ));
    const mapa = new Map(); // chave normalizada -> { nome, qtd }
    snap.forEach(d => {
        const pedido = d.data();
        const nec = calcularNecessidades(pedido.itens || []);
        nec.forEach((v, chave) => {
            const atual = mapa.get(chave);
            mapa.set(chave, { nome: v.nome, qtd: Number(((atual?.qtd || 0) + v.qtd).toFixed(4)) });
        });
    });
    return { mapa, totalPedidos: snap.size };
}

function celulaDiferenca(sistemaQtd, valorDigitado) {
    if (valorDigitado === "" || valorDigitado === undefined || valorDigitado === null) {
        return { texto: "—", classe: "" };
    }
    const contagem = Number(valorDigitado);
    if (isNaN(contagem)) return { texto: "—", classe: "" };
    const diff = Number((contagem - sistemaQtd).toFixed(2));
    if (Math.abs(diff) < 0.01) return { texto: "✅ bate", classe: "diff-ok" };
    if (diff < 0) return { texto: `🚨 faltam ${Math.abs(diff).toFixed(2)}`, classe: "diff-falta" };
    return { texto: `⚠️ sobram ${diff.toFixed(2)}`, classe: "diff-sobra" };
}

// Aplica a contagem física como um ajuste real de estoque (mesma trilha das
// Movimentações — ajuste_add quando sobra, ajuste_sub quando falta).
async function aplicarAjuste(id, nome, sistemaQtd, inputEl, botao) {
    if (inputEl.value === "" || isNaN(Number(inputEl.value))) {
        return alert("Digite a contagem física antes de ajustar.");
    }
    const contagem = Number(inputEl.value);
    const diff = Number((contagem - sistemaQtd).toFixed(4));
    if (Math.abs(diff) < 0.001) return alert("Contagem já bate com o sistema — nada a ajustar.");

    const acao = diff > 0 ? "adicionar" : "remover";
    if (!confirm(`Ajustar "${nome}" de ${sistemaQtd.toFixed(2)} para ${contagem.toFixed(2)}?\n\nIsso vai ${acao} ${Math.abs(diff).toFixed(2)} e registrar em Movimentações.`)) return;

    botao.disabled = true;
    try {
        await runTransaction(db, async tx => {
            const ref = doc(db, "estoque", id);
            const snap = await tx.get(ref);
            if (!snap.exists()) throw new Error("Item não existe mais. Atualize a página.");
            // Reaplica a diferença sobre o valor mais atual do banco (não sobre o
            // que estava na tela), pra não sobrescrever alguma outra movimentação
            // que tenha acontecido entre a geração da conferência e o clique.
            const atual = Number(pegarCampo(snap.data(), ["quantidade", "qtd", "quant"]));
            const novo = Number((atual + diff).toFixed(4));
            tx.update(ref, { quantidade: Math.max(0, novo), atualizadoEm: new Date() });
            tx.set(doc(collection(db, "movimentacoes")), {
                itemId: id,
                nomeItem: nome,
                tipo: diff > 0 ? "ajuste_add" : "ajuste_sub",
                quantidade: Math.abs(diff),
                observacao: `Ajuste por conferência de receita (${new Date().toLocaleDateString("pt-BR")})`,
                data: new Date()
            });
        });
        alert("✅ Estoque ajustado com base na contagem física!");
        document.getElementById("conf-gerar")?.click();
    } catch (e) {
        console.error("Erro ao ajustar por conferência", e);
        alert(`❌ Não foi possível ajustar: ${e.message || ""}`);
        botao.disabled = false;
    }
}

async function gerarConferencia() {
    const corpo = document.getElementById("tab-conferencia-body");
    const resumo = document.getElementById("conf-resumo");
    const dataIni = document.getElementById("conf-data-inicio").value;
    const dataFim = document.getElementById("conf-data-fim").value;
    if (!corpo) return;
    if (!dataIni || !dataFim) return alert("Escolha as duas datas.");
    if (dataFim < dataIni) return alert("A data final não pode ser antes da data inicial.");

    corpo.innerHTML = `<tr><td colspan="6">Calculando...</td></tr>`;
    resumo.textContent = "";

    try {
        const [estoqueSnap, { mapa, totalPedidos }] = await Promise.all([
            getDocs(collection(db, "estoque")),
            consumoTeoricoPeriodo(inicioDoDia(dataIni), fimDoDia(dataFim))
        ]);

        const itens = estoqueSnap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .sort((a, b) => (a.nome || "").localeCompare(b.nome || ""));

        if (!itens.length) {
            corpo.innerHTML = `<tr><td colspan="6">Nenhum insumo cadastrado ainda.</td></tr>`;
            return;
        }

        resumo.innerHTML = totalPedidos
            ? `📦 ${totalPedidos} pedido(s) considerados no período escolhido.`
            : `⚠️ Nenhum pedido encontrado nesse período — o teórico vai ficar zerado pra tudo.`;

        corpo.innerHTML = itens.map(item => {
            const chave = norm(item.nome);
            const teorico = mapa.get(chave)?.qtd || 0;
            const sistemaQtd = Number(pegarCampo(item, ["quantidade", "qtd", "quant"]));
            return `<tr data-id="${item.id}" data-nome="${esc(item.nome)}" data-sistema="${sistemaQtd}">
                <td>${esc(item.nome)}</td>
                <td>${teorico > 0 ? teorico.toFixed(2) : "—"}</td>
                <td>${sistemaQtd.toFixed(2)}</td>
                <td><input type="number" step="0.01" class="input-conferencia" placeholder="${sistemaQtd.toFixed(2)}" data-role="contagem"></td>
                <td data-role="diferenca">—</td>
                <td><button type="button" class="btn-ajustar-conf" data-role="ajustar">Ajustar</button></td>
            </tr>`;
        }).join("");

        corpo.querySelectorAll("tr[data-id]").forEach(tr => {
            const input = tr.querySelector('[data-role="contagem"]');
            const diffCel = tr.querySelector('[data-role="diferenca"]');
            const botao = tr.querySelector('[data-role="ajustar"]');
            const sistemaQtd = Number(tr.dataset.sistema);
            if (!input) return;
            input.addEventListener("input", () => {
                const r = celulaDiferenca(sistemaQtd, input.value);
                diffCel.textContent = r.texto;
                diffCel.className = r.classe;
            });
            botao.addEventListener("click", () => aplicarAjuste(tr.dataset.id, tr.dataset.nome, sistemaQtd, input, botao));
        });
    } catch (e) {
        console.error("Erro ao gerar conferência de receita", e);
        corpo.innerHTML = `<tr><td colspan="6">❌ Erro ao calcular. Se o console do navegador mostrar um link pra "criar índice" do Firestore, clique nele e tente de novo depois de ~1 minuto.</td></tr>`;
    }
}

document.addEventListener("DOMContentLoaded", () => {
    const hoje = new Date().toISOString().slice(0, 10);
    const ini = document.getElementById("conf-data-inicio");
    const fim = document.getElementById("conf-data-fim");
    if (ini) ini.value = hoje;
    if (fim) fim.value = hoje;
    document.getElementById("conf-gerar")?.addEventListener("click", gerarConferencia);
});
