import { db } from "./firebase.js"; // Se estiver na mesma pasta 'js', use ./
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// ==========================================
// CONFIGURAÇÃO DE CUSTOS E PREÇOS
// ==========================================
const TABELA_VALORES = {
    espetos: { custo: 4.00, venda: 10.00 },
    lanches: { custo: 8.00, venda: 18.00 },
    jantinha: { custo: 7.00, venda: 15.00 },
    refris: { custo: 3.00, venda: 6.00 }
};

// EXPORTAR a função para que o script.js ou o HTML consigam enxergar
export async function iniciarGerenciamento() {
    console.log("📊 Iniciando cálculos financeiros...");
    await carregarDadosFinanceiros();
}

async function carregarDadosFinanceiros() {
    try {
        const agora = new Date();
        const inicioDia = new Date(agora.setHours(0, 0, 0, 0));

        // Busca pedidos de hoje
        const q = query(
            collection(db, "pedidos"),
            where("criadoEm", ">=", inicioDia)
        );

        const querySnapshot = await getDocs(q);

        let totalVendas = 0;
        let totalCustos = 0;
        let lucroPorCategoria = { lanches: 0, espetos: 0, jantinhas: 0, refris: 0, acai: 0 };

        querySnapshot.forEach((doc) => {
            const p = doc.data();
            if (p.status === "Cancelado") return;

            // 1. Somar Vendas Brutas
            totalVendas += (p.total || 0);

            // 2. Lanches
            if (p.lanches) {
                Object.entries(p.lanches).forEach(([nome, qtd]) => {
                    if (qtd > 0) {
                        totalCustos += (qtd * TABELA_VALORES.lanches.custo);
                        lucroPorCategoria.lanches += (qtd * (TABELA_VALORES.lanches.venda - TABELA_VALORES.lanches.custo));
                    }
                });
            }

            // 3. Espetos
            if (p.espetos) {
                Object.entries(p.espetos).forEach(([nome, qtd]) => {
                    if (qtd > 0) {
                        totalCustos += (qtd * TABELA_VALORES.espetos.custo);
                        lucroPorCategoria.espetos += (qtd * (TABELA_VALORES.espetos.venda - TABELA_VALORES.espetos.custo));
                    }
                });
            }

            // 4. Jantinhas
            if (p.jantinhas && p.jantinhas.quantidade > 0) {
                totalCustos += (p.jantinhas.quantidade * TABELA_VALORES.jantinha.custo);
                lucroPorCategoria.jantinhas += (p.jantinhas.quantidade * (TABELA_VALORES.jantinha.venda - TABELA_VALORES.jantinha.custo));
            }
        });

        atualizarInterface(totalVendas, totalCustos, lucroPorCategoria);
    } catch (error) {
        console.error("Erro ao carregar finanças:", error);
    }
}

function atualizarInterface(vendas, custos, lucros) {
    // Verifica se os elementos existem antes de tentar escrever neles (evita erros no console)
    const setElement = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.innerText = val.toFixed(2);
    };

    setElement("lucro-hoje-lanches", lucros.lanches);
    setElement("lucro-hoje-espetos", lucros.espetos);
    setElement("lucro-hoje-jantinhas", lucros.jantinhas);

    const lucroTotalSoma = Object.values(lucros).reduce((a, b) => a + b, 0);
    setElement("lucro-hoje-total", lucroTotalSoma);

    setElement("vendas-total", vendas);
    setElement("custos-total", custos);

    const taxas = vendas * 0.05;
    setElement("taxas-total", taxas);

    const lucroReal = vendas - custos - taxas;
    setElement("lucro-real", lucroReal);
}

// Auto-execução ao carregar o módulo
iniciarGerenciamento();