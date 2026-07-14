import { db } from "./firebase.js";
import {
    collection, onSnapshot, addDoc, query, where, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

let totalVendas = 0;
let totalCustos = 0;
let totalGastos = 0;
let periodo = "mes";

// ✅ Novo: guarda a função de "desinscrever" do listener de gastos.
// Antes, toda vez que o filtro de período mudava, um NOVO onSnapshot
// era criado sem cancelar o anterior — isso acumulava listeners e
// duplicava linhas no extrato ao longo do uso. Agora cancelamos o
// listener antigo antes de criar um novo, sem mudar os cálculos.
let unsubscribeGastos = null;

// --------------------------
// CONFIGURAÇÃO EXATA DOS SEUS CUSTOS
// --------------------------
const CUSTOS = {
    acai: { custoPorGrama: 0.02, gramasPorCopo: 300 },
    copo400: 0.58,
    copo500: 0.63,
    tampa: 0.40,
    colher: 0.30,
    guardanapo: 0.20,
    sacola1: 0.50,
    sacola2: 0.73,
    portaCopo1: 0.50,
    portaCopo2: 1.00,
    adicionais: {
        "Nutella": 2.07,
        "Morango": 0.64,
        "Granola": 0.66,
        "Leite em pó": 1.26,
        "Leite condensado": 0.26,
        "Paçoca": 0.85,
        "Disquete": 0.57,
        "Kit Kat": 1.89,
        "Ouro Branco": 1.06,
        "Sonho de Valsa": 1.06,
        "Chocoball": 1.03,
        "Amendoim": 0.36,
        "Banana": 0.12,
        "Ovomaltine": 1.78
    }
};

// --------------------------
// CÁLCULO CORRIGIDO COMPLETAMENTE
// --------------------------
function calcularCustoPedido(itensPedido) {
    let custoTotal = 0;
    let qtdCopos = 0;

    if (!itensPedido || itensPedido.length === 0) return 0;

    itensPedido.forEach(item => {
        qtdCopos++;

        // 1. Açaí
        custoTotal += CUSTOS.acai.custoPorGrama * CUSTOS.acai.gramasPorCopo;

        // 2. Tamanho do copo (identifica pelo nome)
        const nomeCopo = (item.nome || "").toLowerCase();
        if (nomeCopo.includes("400ml")) {
            custoTotal += CUSTOS.copo400;
        } else if (nomeCopo.includes("500ml") || nomeCopo.includes("super")) {
            custoTotal += CUSTOS.copo500;
        } else {
            custoTotal += CUSTOS.copo500; // Padrão
        }

        // 3. Itens individuais OBRIGATÓRIOS
        custoTotal += CUSTOS.tampa;
        custoTotal += CUSTOS.colher;
        custoTotal += CUSTOS.guardanapo;

        // 4. Adicionais dentro de extras.gratis
        const adicionais = item.extras?.gratis || [];
        adicionais.forEach(nomeAdicional => {
            const custoAdicional = CUSTOS.adicionais[nomeAdicional];
            if (custoAdicional) {
                custoTotal += custoAdicional;
            }
        });
    });

    // 5. ITENS COMPARTILHADOS — AGORA SOMADOS COM CERTEZA!
    if (qtdCopos === 1) {
        custoTotal += CUSTOS.sacola1;
        custoTotal += CUSTOS.portaCopo1;
    } else {
        custoTotal += CUSTOS.sacola2;
        custoTotal += CUSTOS.portaCopo2;
    }

    // Garante 2 casas decimais
    return Math.round(custoTotal * 100) / 100;
}

// --------------------------
// FUNÇÃO DE REGISTRAR GASTO
// --------------------------
async function registrarGasto() {
    const desc = document.getElementById("descricao")?.value.trim() || "";
    const val = parseFloat(document.getElementById("valor-gasto")?.value || "0");
    const tipo = document.getElementById("tipo-gasto")?.value || "";

    if (!desc || isNaN(val) || val <= 0) {
        alert("Preencha corretamente descrição e valor!");
        return;
    }

    try {
        await addDoc(collection(db, "gastos"), {
            descricao: desc,
            valor: val,
            tipo: tipo,
            data: new Date()
        });
        
        document.getElementById("descricao").value = "";
        document.getElementById("valor-gasto").value = "";
        alert("✅ Gasto registrado com sucesso!");
    } catch (e) {
        alert("❌ Erro ao registrar: " + e.message);
    }
}

// --------------------------
// INICIALIZAÇÃO
// --------------------------
document.addEventListener("DOMContentLoaded", () => {
    const filtroPeriodo = document.getElementById("filtro-periodo");
    if (filtroPeriodo) {
        filtroPeriodo.addEventListener("change", (e) => {
            periodo = e.target.value;
            carregarDados();
        });
    }

    const btnLancar = document.getElementById("btnLancar");
    if (btnLancar) {
        btnLancar.addEventListener("click", registrarGasto);
    }

    carregarDados();
});

// --------------------------
// CARREGAR DADOS DO FIREBASE
// --------------------------
async function carregarDados() {
    totalVendas = 0;
    totalCustos = 0;
    totalGastos = 0;
    const lista = document.getElementById("lista-extrato");
    if (!lista) return;
    lista.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--muted)">Carregando dados...</td></tr>`;

    // ✅ Cancela o listener de gastos anterior antes de criar outro
    if (unsubscribeGastos) {
        unsubscribeGastos();
        unsubscribeGastos = null;
    }

    let dataInicioTimestamp = null;
    const hoje = new Date();
    if (periodo === "dia") {
        const inicioDia = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
        dataInicioTimestamp = inicioDia.getTime();
    } else if (periodo === "mes") {
        const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
        dataInicioTimestamp = inicioMes.getTime();
    }

    // Monta o HTML das vendas concluídas (mesmo cálculo de sempre)
    let htmlVendas = "";

    try {
        const pedidosRef = collection(db, "pedidos");
        const qPedidos = query(pedidosRef, where("status", "==", "concluido"));
        const snapPedidos = await getDocs(qPedidos);

        snapPedidos.forEach(doc => {
            const p = doc.data();
            const criadoEm = p.criadoEm || 0;

            if (dataInicioTimestamp && criadoEm < dataInicioTimestamp) return;

            const valorPedido = Number(p.total || p.preco || 0);
            const custoPedido = calcularCustoPedido(p.itens || []);
            const lucroPedido = Number((valorPedido - custoPedido).toFixed(2));

            totalVendas += valorPedido;
            totalCustos += custoPedido;

            const data = new Date(criadoEm).toLocaleDateString('pt-BR');
            htmlVendas += `
                <tr>
                    <td>${data}</td>
                    <td>Venda #${String(p.numero || "").slice(-4)} - ${p.pagamento}</td>
                    <td style="text-align:right">+ R$ ${valorPedido.toFixed(2)}</td>
                    <td style="text-align:right">- R$ ${custoPedido.toFixed(2)}</td>
                    <td class="entrada" style="text-align:right">R$ ${lucroPedido.toFixed(2)}</td>
                </tr>
            `;
        });
    } catch (e) {
        console.error("Erro ao carregar pedidos concluídos:", e);
        lista.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--red)">Erro ao carregar vendas. Tente recarregar a página.</td></tr>`;
        return;
    }

    const gastosRef = collection(db, "gastos");
    const qGastos = query(gastosRef);

    // ✅ Guarda a função de cancelamento (antes era descartada, causando
    // o acúmulo de listeners mencionado acima)
    unsubscribeGastos = onSnapshot(qGastos, (snap) => {
        totalGastos = 0;
        let htmlGastos = "";

        snap.forEach(doc => {
            const g = doc.data();
            const val = Number(g.valor || 0);
            totalGastos += val;

            const data = g.data ? new Date(g.data.toDate()).toLocaleDateString('pt-BR') : "Sem data";
            htmlGastos += `
                <tr>
                    <td>${data}</td>
                    <td>${g.descricao || "Sem descrição"}</td>
                    <td class="saida" style="text-align:right">- R$ ${val.toFixed(2)}</td>
                    <td style="text-align:right">-</td>
                    <td class="saida" style="text-align:right">- R$ ${val.toFixed(2)}</td>
                </tr>
            `;
        });

        const htmlFinal = htmlVendas + htmlGastos;
        lista.innerHTML = htmlFinal || `<tr><td colspan="5" style="text-align:center; color:var(--muted)">Nenhum lançamento no período.</td></tr>`;

        atualizarTela();
    }, (erro) => {
        // ✅ Novo: trata erro do listener de gastos
        console.error("Erro no listener de gastos:", erro);
        lista.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--red)">Erro ao carregar gastos. Verifique sua conexão.</td></tr>`;
    });
}

// --------------------------
// ATUALIZAR VALORES NA TELA
// --------------------------
function atualizarTela() {
    const lucroOperacional = Number((totalVendas - totalCustos).toFixed(2));
    const lucroLiquidoReal = Number((lucroOperacional - totalGastos).toFixed(2));

    const elTotalVendas = document.getElementById("total-vendas");
    const elTotalCustos = document.getElementById("total-custos");
    const elLucroOperacional = document.getElementById("lucro-operacional");
    const elTotalGastos = document.getElementById("total-gastos");
    const elSaldoLiquido = document.getElementById("saldo-liquido");

    if (elTotalVendas) elTotalVendas.textContent = `R$ ${totalVendas.toFixed(2)}`;
    if (elTotalCustos) elTotalCustos.textContent = `R$ ${totalCustos.toFixed(2)}`;
    if (elLucroOperacional) elLucroOperacional.textContent = `R$ ${lucroOperacional.toFixed(2)}`;
    if (elTotalGastos) elTotalGastos.textContent = `R$ ${totalGastos.toFixed(2)}`;
    if (elSaldoLiquido) elSaldoLiquido.textContent = `R$ ${lucroLiquidoReal.toFixed(2)}`;

    const elSalario = document.getElementById("salario");
    const elCaixa = document.getElementById("caixa");
    const elReserva = document.getElementById("reserva");
    if (elSalario) elSalario.textContent = `R$ ${(lucroLiquidoReal * 0.40).toFixed(2)}`;
    if (elCaixa) elCaixa.textContent = `R$ ${(lucroLiquidoReal * 0.35).toFixed(2)}`;
    if (elReserva) elReserva.textContent = `R$ ${(lucroLiquidoReal * 0.25).toFixed(2)}`;
}

window.registrarGasto = registrarGasto;