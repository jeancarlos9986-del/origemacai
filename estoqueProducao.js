import { construirMapaEstoque, processarProducaoSegura, PRODUTOS_CONHECIDOS } from "./estoqueBaixa.js";
import { esc } from "./utils.js";

// ==============================================
// 🆕 REGISTRAR PRODUÇÃO (baixa por "copos feitos")
// ==============================================
// Pra quem faz venda de balcão / não passa tudo pela tela de pedidos: aqui
// você diz quantos de cada produto FEZ (não precisa ter um "pedido" no
// sistema), o estoque desconta a receita de cada um (usando a MESMA receita
// de estoqueBaixa.js) e mostra, insumo por insumo, quanto foi usado e quanto
// sobrou no estoque logo em seguida.
//
// ⚠️ Isso é uma baixa MANUAL, separada da baixa automática de pedidos. Se o
// copo já passou por um pedido no sistema (site/cozinha), ele JÁ foi debitado
// sozinho — registrar aqui de novo vai descontar o insumo duas vezes. Use
// esta tela só pra produção/venda que não teve pedido registrado no sistema.

function tituloProduto(chave) {
    return chave.replace(/\b\w/g, c => c.toUpperCase());
}

function montarLinhas() {
    const container = document.getElementById("producao-linhas");
    if (!container) return;
    container.innerHTML = PRODUTOS_CONHECIDOS.map(chave => `
        <div>
            <label>${esc(tituloProduto(chave))}</label>
            <input type="number" min="0" step="1" class="producao-qtd" data-chave="${esc(chave)}" placeholder="0">
        </div>
    `).join("");
}

function mostrarResultado(resumoProducao, consumos) {
    const wrap = document.getElementById("producao-resultado");
    const corpo = document.getElementById("producao-resultado-body");
    const texto = document.getElementById("producao-resumo-texto");
    if (!wrap) return;

    corpo.innerHTML = consumos.length
        ? consumos.map(c => `<tr><td>${esc(c.nome)}</td><td>${c.qtd.toFixed(3)}</td><td>${c.disponivelApos.toFixed(3)}</td></tr>`).join("")
        : `<tr><td colspan="3">Nenhum insumo foi debitado (produtos sem receita cadastrada ou sem o insumo no cadastro do Estoque).</td></tr>`;

    texto.textContent = consumos.length
        ? `Produção registrada: ${resumoProducao}. Com base na receita, foi debitado o consumo listado acima — "Estoque restante" já é o saldo de cada insumo logo após essa baixa.`
        : `Produção registrada: ${resumoProducao}. Confira o console do navegador — pode ter algum produto sem receita ou insumo sem cadastro.`;
    wrap.style.display = "";
}

async function registrarProducao() {
    const inputs = document.querySelectorAll(".producao-qtd");
    const contagens = [];
    inputs.forEach(inp => {
        const qtd = Number(inp.value);
        if (qtd > 0) contagens.push({ nome: inp.dataset.chave, quantidade: qtd });
    });
    if (!contagens.length) return alert("Informe a quantidade de pelo menos um produto.");

    const resumoProducao = contagens.map(c => `${c.quantidade} ${tituloProduto(c.nome)}`).join(" + ");
    if (!confirm(`Registrar produção de: ${resumoProducao}?\n\nIsso vai debitar os insumos da receita do estoque agora.\n\n⚠️ Só use isso pra produção que NÃO veio de um pedido do sistema (senão o mesmo copo desconta o insumo duas vezes).`)) return;

    const btn = document.getElementById("producao-registrar");
    btn.disabled = true;
    try {
        const mapaEstoque = await construirMapaEstoque();
        const consumos = await processarProducaoSegura(contagens, mapaEstoque);
        mostrarResultado(resumoProducao, consumos);
        inputs.forEach(inp => inp.value = "");
        // Avisa estoque.js pra atualizar tabela/resumo/alertas sem precisar dar F5.
        window.dispatchEvent(new CustomEvent("estoque:atualizar"));
    } catch (e) {
        console.error("Erro ao registrar produção", e);
        alert(`❌ Não foi possível registrar a produção: ${e.message || ""}`);
    } finally {
        btn.disabled = false;
    }
}

function init() {
    montarLinhas();
    document.getElementById("producao-registrar")?.addEventListener("click", registrarProducao);
}

document.addEventListener("DOMContentLoaded", init);
