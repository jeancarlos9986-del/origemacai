import { db } from "./firebase.js";
import { collection, onSnapshot, query, orderBy } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

// --- TABELA DE CUSTOS REAIS (Baseado nas suas fotos) ---
const TABELA_CUSTOS = {
    "Tropical F&B Duplo": 11.24,
    "Tropical F&B Simples": 6.67,
    "Chesebacon F&B Duplo": 11.09,
    "Chesebacon F&B Simples": 5.97,
    "Big F&B Duplo": 10.93,
    "Big F&B Simples": 6.46,
    "F&B Banana Duplo": 10.94,
    "F&B Banana Simples": 7.12
};

// --- CONFIGURAÇÕES DE TAXAS ---
const TX_CREDITO = 0.0399; // 3,99%
const TX_DEBITO = 0.0199;  // 1,99%

function inicializarDashboard() {
    const q = query(collection(db, "pedidos"), orderBy("data", "desc"));

    onSnapshot(q, (snapshot) => {
        let dadosFinanceiros = {
            bruto: 0,
            custoInsumos: 0,
            taxasBancarias: 0,
            pedidos: 0,
            pix: 0,
            credito: 0,
            debito: 0,
            dinheiro: 0
        };

        const vendasPorHora = new Array(24).fill(0);

        snapshot.forEach((doc) => {
            const p = doc.data();
            const totalPedido = Number(p.total) || 0;

            dadosFinanceiros.bruto += totalPedido;
            dadosFinanceiros.pedidos++;

            // 1. CÁLCULO DO CUSTO REAL (Varre os itens do pedido)
            if (p.itens && Array.isArray(p.itens)) {
                p.itens.forEach(item => {
                    // Busca o custo na tabela, se não achar usa 35% do preço de venda como backup
                    const custoItem = TABELA_CUSTOS[item.nome] || (Number(item.preco) * 0.35);
                    dadosFinanceiros.custoInsumos += custoItem;
                });
            } else if (p.lanche_nome) {
                // Caso seu banco salve apenas um lanche por pedido (formato antigo)
                const custoLanche = TABELA_CUSTOS[p.lanche_nome] || (totalPedido * 0.35);
                dadosFinanceiros.custoInsumos += custoLanche;
            }

            // 2. DISTRIBUIÇÃO DE PAGAMENTO E TAXAS BANCÁRIAS
            if (p.pagamento === "Pix") {
                dadosFinanceiros.pix += totalPedido;
            }
            else if (p.pagamento === "Crédito") {
                dadosFinanceiros.credito += totalPedido;
                dadosFinanceiros.taxasBancarias += (totalPedido * TX_CREDITO);
            }
            else if (p.pagamento === "Débito") {
                dadosFinanceiros.debito += totalPedido;
                dadosFinanceiros.taxasBancarias += (totalPedido * TX_DEBITO);
            }
            else if (p.pagamento === "Dinheiro") {
                dadosFinanceiros.dinheiro += totalPedido;
            }

            // 3. VENDAS POR HORA
            if (p.hora) {
                const hora = parseInt(p.hora.split(":")[0]);
                if (!isNaN(hora) && hora >= 0 && hora < 24) {
                    vendasPorHora[hora] += totalPedido;
                }
            }
        });

        // Lucro Real = Bruto - Custo Real dos Lanches - Taxas da Maquininha
        const lucroLiquido = dadosFinanceiros.bruto - dadosFinanceiros.custoInsumos - dadosFinanceiros.taxasBancarias;
        const ticketMedio = dadosFinanceiros.bruto / (dadosFinanceiros.pedidos || 1);

        // ATUALIZAR INTERFACE
        document.getElementById('faturamento-bruto').innerText = formatarBRL(dadosFinanceiros.bruto);
        // O custo total exibido é a soma do que gastou com comida + o que o banco levou
        document.getElementById('custo-total').innerText = formatarBRL(dadosFinanceiros.custoInsumos + dadosFinanceiros.taxasBancarias);
        document.getElementById('lucro-liquido').innerText = formatarBRL(lucroLiquido);
        document.getElementById('ticket-medio').innerText = formatarBRL(ticketMedio);
        document.getElementById('qtd-pedidos').innerText = `${dadosFinanceiros.pedidos} pedidos realizados`;

        renderizarGraficos(vendasPorHora, dadosFinanceiros);
    });
}

function formatarBRL(valor) {
    return valor.toLocaleString('pt-br', { style: 'currency', currency: 'BRL' });
}

let horaChart, pagChart;

function renderizarGraficos(dadosHora, dadosFin) {
    const ctxHora = document.getElementById('vendasHoraChart').getContext('2d');
    const ctxPag = document.getElementById('pagamentoChart').getContext('2d');

    if (horaChart) horaChart.destroy();
    if (pagChart) pagChart.destroy();

    horaChart = new Chart(ctxHora, {
        type: 'line',
        data: {
            labels: Array.from({ length: 24 }, (_, i) => i + "h"),
            datasets: [{
                label: 'Faturamento (R$)',
                data: dadosHora,
                borderColor: '#ff9800',
                backgroundColor: 'rgba(255, 152, 0, 0.2)',
                fill: true,
                tension: 0.4
            }]
        },
        options: {
            maintainAspectRatio: false,
            scales: { y: { beginAtZero: true } }
        }
    });

    pagChart = new Chart(ctxPag, {
        type: 'doughnut',
        data: {
            labels: ['Pix', 'Crédito', 'Débito', 'Dinheiro'],
            datasets: [{
                data: [dadosFin.pix, dadosFin.credito, dadosFin.debito, dadosFin.dinheiro],
                backgroundColor: ['#00cfd5', '#1a73e8', '#5c9aff', '#4caf50'],
                borderWidth: 0
            }]
        },
        options: {
            maintainAspectRatio: false,
            plugins: {
                legend: { position: 'bottom', labels: { color: '#fff' } }
            }
        }
    });
}

inicializarDashboard();