import { db } from "./firebase.js";
import {
    collection, doc, getDocs, getDoc, writeBatch, runTransaction, increment
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { t, norm, esc } from "./utils.js";

// ==============================================
// 🆕 CADASTRO EM LOTE
// ==============================================
// Motivo: cadastrar insumo por insumo no formulário normal (um de cada vez,
// abrindo forma de pagamento etc.) é o maior ralo de tempo quando é preciso
// registrar vários itens de uma vez (ex: primeira carga de estoque, ou uma
// compra grande com vários insumos diferentes na mesma nota).
//
// Aqui você cola uma lista, um insumo por linha, no formato:
//   Nome, Quantidade, Custo Unitário, Unidade, Mínimo, Ideal
// (só Nome e Quantidade são obrigatórios — o resto pode ficar em branco).
// Aceita vírgula/ponto-e-vírgula OU Tab (colado direto do Excel/Planilha).
//
// Se o nome já existir no cadastro (comparação com norm(), igual ao resto do
// sistema), a quantidade colada é SOMADA ao que já existe, em vez de travar
// com "item já existe" — assim dá pra colar tanto insumo novo quanto reforço
// de estoque de item existente na mesma lista.

function dividirLinha(linha) {
    return linha.includes("\t") ? linha.split("\t") : linha.split(/[,;]/);
}

function paraNumero(v) {
    if (v === undefined || v === null) return null;
    const limpo = String(v).trim().replace(",", ".");
    if (limpo === "") return null;
    const x = Number(limpo);
    return isNaN(x) ? null : x;
}

function parseLinhas(texto) {
    return texto.split("\n")
        .map(l => l.trim())
        .filter(Boolean)
        .map((linha, i) => {
            const p = dividirLinha(linha).map(x => x.trim());
            return {
                linhaNum: i + 1,
                nome: t(p[0] || ""),
                quantidade: paraNumero(p[1]),
                custoUnitario: paraNumero(p[2]) || 0,
                unidade: t(p[3] || "") || "un",
                nivelMinimo: paraNumero(p[4]) || 0,
                nivelIdeal: paraNumero(p[5]) || 0
            };
        });
}

// Guarda o resultado do último preview pra usar no confirmar, sem precisar
// re-parsear (e sem depender do textarea não ter mudado entre os dois cliques).
let ultimoPreview = null;

async function gerarPreview() {
    const texto = document.getElementById("lote-texto").value;
    const corpo = document.getElementById("lote-preview-body");
    const wrap = document.getElementById("lote-preview-wrap");
    const resultado = document.getElementById("lote-resultado");
    resultado.textContent = "";

    const linhas = parseLinhas(texto);
    if (!linhas.length) return alert("Cole ao menos uma linha antes de pré-visualizar.");

    const snap = await getDocs(collection(db, "estoque"));
    const existentes = new Map();
    snap.forEach(d => existentes.set(norm(d.data().nome), { id: d.id, ...d.data() }));

    const validas = new Map(); // chave normalizada -> linha agregada
    const erros = [];

    linhas.forEach(l => {
        if (!l.nome) { erros.push({ ...l, erro: "Nome vazio" }); return; }
        if (l.quantidade === null || l.quantidade <= 0) { erros.push({ ...l, erro: "Quantidade inválida ou vazia" }); return; }

        const chave = norm(l.nome);
        const atual = validas.get(chave);
        if (atual) {
            // Mesmo nome apareceu 2x na lista colada — soma em vez de duplicar.
            atual.quantidade = Number((atual.quantidade + l.quantidade).toFixed(4));
            if (l.custoUnitario) atual.custoUnitario = l.custoUnitario;
            if (l.nivelMinimo) atual.nivelMinimo = l.nivelMinimo;
            if (l.nivelIdeal) atual.nivelIdeal = l.nivelIdeal;
        } else {
            validas.set(chave, { ...l });
        }
    });

    const linhasFinal = [...validas.entries()].map(([chave, l]) => {
        const existente = existentes.get(chave) || null;
        return { ...l, chave, existenteId: existente?.id || null, existenteQtd: existente ? Number(existente.quantidade ?? existente.qtd ?? existente.quant ?? 0) : null };
    });

    if (!linhasFinal.length) {
        corpo.innerHTML = `<tr><td colspan="8">Nenhuma linha válida — corrija os erros abaixo e pré-visualize de novo.</td></tr>`;
    } else {
        corpo.innerHTML = linhasFinal.map(l => `<tr>
            <td>${l.linhaNum}</td>
            <td>${esc(l.nome)}</td>
            <td>${l.quantidade}</td>
            <td>R$ ${l.custoUnitario.toFixed(2)}</td>
            <td>${esc(l.unidade)}</td>
            <td>${l.nivelMinimo || "—"}</td>
            <td>${l.nivelIdeal || "—"}</td>
            <td style="color:${l.existenteId ? 'var(--yellow)' : 'var(--green)'}">
                ${l.existenteId ? `Já existe (${l.existenteQtd.toFixed(2)} → +${l.quantidade.toFixed(2)})` : "✅ Novo insumo"}
            </td>
        </tr>`).join("");
    }

    if (erros.length) {
        corpo.innerHTML += erros.map(l => `<tr style="opacity:.65;">
            <td>${l.linhaNum}</td><td>${esc(l.nome || "—")}</td>
            <td colspan="5">—</td>
            <td style="color:var(--red);">❌ ${esc(l.erro)}</td>
        </tr>`).join("");
    }

    ultimoPreview = linhasFinal;
    wrap.style.display = "";
    document.getElementById("lote-confirmar").disabled = !linhasFinal.length;
    resultado.textContent = `${linhasFinal.length} linha(s) prontas • ${erros.length} com erro (ignoradas)`;
}

async function confirmarLote() {
    if (!ultimoPreview || !ultimoPreview.length) return alert("Pré-visualize antes de confirmar.");
    const linhas = ultimoPreview;
    const btn = document.getElementById("lote-confirmar");
    const resultado = document.getElementById("lote-resultado");
    const lancarGasto = document.getElementById("lote-lancar-gasto").checked;
    const formaPagamento = document.getElementById("lote-forma-pagamento").value;

    btn.disabled = true;
    resultado.textContent = "Cadastrando...";
    try {
        // 1) Cadastro dos itens + registro em Movimentações (em lotes de até 400
        //    operações, limite do writeBatch do Firestore).
        for (let i = 0; i < linhas.length; i += 400) {
            const fatia = linhas.slice(i, i + 400);
            const batch = writeBatch(db);
            fatia.forEach(l => {
                if (l.existenteId) {
                    const ref = doc(db, "estoque", l.existenteId);
                    const atualizacao = { quantidade: increment(l.quantidade), atualizadoEm: new Date() };
                    if (l.custoUnitario) atualizacao.custoUnitario = l.custoUnitario;
                    batch.update(ref, atualizacao);
                } else {
                    const ref = doc(collection(db, "estoque"));
                    batch.set(ref, {
                        nome: l.nome,
                        unidade: l.unidade,
                        quantidade: l.quantidade,
                        custoUnitario: l.custoUnitario,
                        nivelMinimo: l.nivelMinimo,
                        nivelIdeal: l.nivelIdeal,
                        validade: null,
                        atualizadoEm: new Date(),
                        historicoPrecos: l.custoUnitario > 0 ? [{ data: new Date(), valor: l.custoUnitario }] : []
                    });
                }
                batch.set(doc(collection(db, "movimentacoes")), {
                    nomeItem: l.nome, tipo: "entrada", quantidade: l.quantidade,
                    observacao: "Cadastro em lote", data: new Date()
                });
            });
            await batch.commit();
        }

        // 2) Lançamento financeiro (opcional) — um único gasto agregando o valor
        //    de todas as linhas com custo informado, seguindo o mesmo padrão de
        //    aprazo/pessoal/caixa já usado no cadastro individual.
        const totalCompra = Number(linhas.reduce((a, l) => a + l.quantidade * l.custoUnitario, 0).toFixed(2));
        if (lancarGasto && totalCompra > 0) {
            const caixaRef = doc(db, "configuracoes", "caixa_empresa");
            const precisaCaixa = !["aprazo", "pessoal"].includes(formaPagamento);
            await runTransaction(db, async tx => {
                const caixaSnap = precisaCaixa ? await tx.get(caixaRef) : null;

                const gastoRef = doc(collection(db, "gastos"));
                tx.set(gastoRef, {
                    descricao: `Compra em lote (${linhas.length} insumo(s))`, valor: totalCompra,
                    tipo: "insumo", natureza: "empresa", formaPagamento, data: new Date()
                });

                if (formaPagamento === "aprazo") {
                    tx.set(doc(collection(db, "contas_pagar")), {
                        descricao: `Compra em lote (${linhas.length} insumo(s))`, valor: totalCompra,
                        dataVenc: new Date(Date.now() + 7 * 86400000), pago: false
                    });
                } else if (formaPagamento === "pessoal") {
                    tx.set(doc(collection(db, "emprestimos")), {
                        tipo: "emprestimo", descricao: `Gasto: Compra em lote (${linhas.length} insumo(s))`,
                        valor: totalCompra, data: new Date(), origem: "gasto", gastoId: gastoRef.id
                    });
                } else {
                    const caixaAtual = caixaSnap && caixaSnap.exists() ? caixaSnap.data() : { dinheiro: 0, pix: 0, cartao: 0, total: 0 };
                    const novoCaixa = { ...caixaAtual, ultimaAtualizacao: new Date() };
                    if (formaPagamento === "dinheiro") novoCaixa.dinheiro = Number(((novoCaixa.dinheiro || 0) - totalCompra).toFixed(2));
                    else if (formaPagamento === "pix") novoCaixa.pix = Number(((novoCaixa.pix || 0) - totalCompra).toFixed(2));
                    else if (formaPagamento === "cartao") novoCaixa.cartao = Number(((novoCaixa.cartao || 0) - totalCompra).toFixed(2));
                    novoCaixa.total = Number(((novoCaixa.dinheiro || 0) + (novoCaixa.pix || 0) + (novoCaixa.cartao || 0)).toFixed(2));
                    tx.set(caixaRef, novoCaixa, { merge: true });
                }
            });
        }

        alert(`✅ ${linhas.length} insumo(s) cadastrados/atualizados!` + (lancarGasto && totalCompra > 0 ? ` Lançado R$ ${totalCompra.toFixed(2)} no financeiro (${formaPagamento}).` : ""));
        document.getElementById("lote-texto").value = "";
        document.getElementById("lote-preview-wrap").style.display = "none";
        ultimoPreview = null;
        window.dispatchEvent(new CustomEvent("estoque:atualizar"));
    } catch (e) {
        console.error("Erro no cadastro em lote", e);
        alert(`❌ Não foi possível concluir o cadastro em lote: ${e.message || ""}`);
    } finally {
        btn.disabled = false;
        resultado.textContent = "";
    }
}

function initCadastroLote() {
    const btnPrever = document.getElementById("lote-prever");
    const btnConfirmar = document.getElementById("lote-confirmar");
    const chkGasto = document.getElementById("lote-lancar-gasto");
    const formaBox = document.getElementById("lote-forma-box");
    if (!btnPrever) return; // seção não existe nessa página

    btnPrever.addEventListener("click", gerarPreview);
    btnConfirmar.addEventListener("click", confirmarLote);
    chkGasto.addEventListener("change", () => {
        formaBox.style.display = chkGasto.checked ? "" : "none";
    });
}

document.addEventListener("DOMContentLoaded", initCadastroLote);
