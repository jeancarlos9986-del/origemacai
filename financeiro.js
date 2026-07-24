import { db } from "./firebase.js";
import {
  collection, addDoc, getDocs, query, where, orderBy, onSnapshot, doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ==============================================
// FUNÇÕES AUXILIARES
// ==============================================
function n(v, p = 0) {
  return isNaN(Number(v)) ? p : Number(v);
}
function t(v, p = "") {
  return typeof v === "string" && v.trim() ? v.trim() : p;
}
function norm(nome) {
  return t(nome).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function esc(texto) {
  const d = document.createElement("div");
  d.textContent = t(texto, "");
  return d.innerHTML;
}

// ==============================================
// REGISTRAR NOVO GASTO
// ==============================================
document.getElementById("btn-gasto")?.addEventListener("click", async () => {
  const descricao = t(document.getElementById("desc-gasto").value);
  const valor = n(document.getElementById("valor-gasto").value);
  const tipoGasto = t(document.getElementById("tipo-gasto").value);
  const formaPagamento = t(document.getElementById("pag-gasto").value);
  const categoria = t(document.getElementById("cat-gasto").value) || "Outros";
  const data = document.getElementById("data-gasto").value ? new Date(document.getElementById("data-gasto").value) : new Date();

  if (!descricao || valor <= 0 || !tipoGasto || !formaPagamento) {
    return alert("⚠️ Preencha descrição, valor, tipo e forma de pagamento!");
  }

  await addDoc(collection(db, "gastos"), {
    descricao, valor, tipoGasto, formaPagamento, categoria, data
  });

  alert("✅ Gasto registrado!");
  document.querySelectorAll("#desc-gasto, #valor-gasto, #data-gasto").forEach(i => i.value = "");
  document.querySelectorAll("#tipo-gasto, #pag-gasto, #cat-gasto").forEach(s => s.value = "");
  
  carregarGastos();
  atualizarResumoFinanceiro();
});

// ==============================================
// CARREGAR LISTA DE GASTOS SEPARADOS
// ==============================================
async function carregarGastos() {
  const inicioMes = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const snap = await getDocs(query(
    collection(db, "gastos"),
    where("data", ">=", inicioMes),
    orderBy("data", "desc")
  ));

  let totalEmpresa = 0, totalPessoal = 0;
  const linhas = [];

  snap.forEach(d => {
    const g = d.data();
    const valor = n(g.valor);
    const data = g.data ? new Date(g.data.toDate()).toLocaleDateString("pt-BR") : "";
    
    if (g.tipoGasto === "Empresa") totalEmpresa += valor;
    if (g.tipoGasto === "Pessoal") totalPessoal += valor;

    linhas.push(`
      <tr>
        <td>${data}</td>
        <td>${esc(g.descricao)}</td>
        <td>R$ ${valor.toFixed(2)}</td>
        <td>${g.tipoGasto === "Empresa" ? "🏢 Empresa" : "👤 Pessoal"}</td>
        <td>${g.formaPagamento}</td>
        <td>${g.categoria}</td>
      </tr>
    `);
  });

  const corpo = document.querySelector("#tab-gastos tbody");
  if (corpo) corpo.innerHTML = linhas.join("") || `<tr><td colspan="6">Nenhum gasto este mês</td></tr>`;

  document.getElementById("total-empresa")?.textContent = `R$ ${totalEmpresa.toFixed(2)}`;
  document.getElementById("total-pessoal")?.textContent = `R$ ${totalPessoal.toFixed(2)}`;
  document.getElementById("total-geral-gastos")?.textContent = `R$ ${(totalEmpresa + totalPessoal).toFixed(2)}`;
}

// ==============================================
// RESUMO FINANCEIRO COMPLETO (DIA / MÊS)
// ==============================================
async function atualizarResumoFinanceiro() {
  const hoje = new Date();
  const inicioDia = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const inicioMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1);

  // 1. BUSCAR VENDAS
  const pedidosSnap = await getDocs(query(
    collection(db, "pedidos"),
    where("status", "in", ["concluido", "pronto", "finalizado"])
  ));

  let vendasDia = 0, vendasMes = 0, qtdPedidos = 0;
  let recebDinheiro = 0, recebPix = 0, recebCartao = 0;

  pedidosSnap.forEach(d => {
    const p = d.data();
    const valor = n(p.valorTotal);
    const dataPedido = new Date(p.criadoEm);
    
    if (dataPedido >= inicioDia) vendasDia += valor;
    vendasMes += valor;
    qtdPedidos++;

    const fp = t(p.formaPagamento);
    if (fp.includes("dinheiro")) recebDinheiro += valor;
    else if (fp.includes("pix")) recebPix += valor;
    else if (fp.includes("cartão")) recebCartao += valor;
  });

  // 2. BUSCAR GASTOS SOMENTE DA EMPRESA
  const gastosSnap = await getDocs(query(
    collection(db, "gastos"),
    where("data", ">=", inicioMes),
    where("tipoGasto", "==", "Empresa")
  ));
  let totalGastosEmpresa = 0;
  gastosSnap.forEach(d => totalGastosEmpresa += n(d.data().valor));

  // 3. CALCULAR CUSTO DE INSUMOS USADOS
  const movSaida = await getDocs(query(
    collection(db, "movimentacoes"),
    where("tipo", "==", "saida"),
    where("data", ">=", inicioMes)
  ));
  const estq = await getDocs(collection(db, "estoque"));
  const mapaCusto = new Map();
  estq.forEach(d => {
    const item = d.data();
    mapaCusto.set(norm(item.nome), n(item.custoUnitario || item.custo || 0));
  });
  let custoInsumos = 0;
  movSaida.forEach(d => {
    const m = d.data();
    const cu = mapaCusto.get(norm(m.nomeItem)) || 0;
    custoInsumos += n(m.quantidade) * cu;
  });

  // 4. CÁLCULOS FINAIS
  const lucroBruto = vendasMes - custoInsumos;
  const lucroLiquido = lucroBruto - totalGastosEmpresa;
  const margemBruta = vendasMes > 0 ? (lucroBruto / vendasMes) * 100 : 0;
  const margemLiquida = vendasMes > 0 ? (lucroLiquido / vendasMes) * 100 : 0;
  const ticketMedio = qtdPedidos > 0 ? vendasMes / qtdPedidos : 0;

  // 5. ATUALIZAR NA TELA
  document.getElementById("vendas-dia")?.textContent = `R$ ${vendasDia.toFixed(2)}`;
  document.getElementById("vendas-mes")?.textContent = `R$ ${vendasMes.toFixed(2)}`;
  document.getElementById("custo-insumos")?.textContent = `R$ ${custoInsumos.toFixed(2)}`;
  document.getElementById("gastos-empresa")?.textContent = `R$ ${totalGastosEmpresa.toFixed(2)}`;
  document.getElementById("lucro-bruto")?.textContent = `R$ ${lucroBruto.toFixed(2)}`;
  document.getElementById("lucro-liquido")?.textContent = `R$ ${lucroLiquido.toFixed(2)}`;
  document.getElementById("margem-bruta")?.textContent = `${margemBruta.toFixed(1)}%`;
  document.getElementById("margem-liquida")?.textContent = `${margemLiquida.toFixed(1)}%`;
  document.getElementById("ticket-medio")?.textContent = `R$ ${ticketMedio.toFixed(2)}`;
  
  document.getElementById("rec-dinheiro")?.textContent = `R$ ${recebDinheiro.toFixed(2)}`;
  document.getElementById("rec-pix")?.textContent = `R$ ${recebPix.toFixed(2)}`;
  document.getElementById("rec-cartao")?.textContent = `R$ ${recebCartao.toFixed(2)}`;

  // DIVISÃO DO LUCRO LÍQUIDO
  const salario = lucroLiquido * 0.40;
  const caixaEmp = lucroLiquido * 0.35;
  const reserva = lucroLiquido * 0.25;
  document.getElementById("div-salario")?.textContent = `R$ ${salario.toFixed(2)}`;
  document.getElementById("div-caixa")?.textContent = `R$ ${caixaEmp.toFixed(2)}`;
  document.getElementById("div-reserva")?.textContent = `R$ ${reserva.toFixed(2)}`;
}

// ==============================================
// INICIALIZAÇÃO AUTOMÁTICA
// ==============================================
document.addEventListener("DOMContentLoaded", () => {
  carregarGastos();
  atualizarResumoFinanceiro();

  // Atualiza automaticamente se chegar novo gasto ou pedido
  onSnapshot(query(collection(db, "gastos"), orderBy("data", "desc")), () => {
    carregarGastos();
    atualizarResumoFinanceiro();
  });
});
