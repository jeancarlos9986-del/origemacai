import { db } from "./firebase.js";
import {
    collection, addDoc, getDocs, getDoc, updateDoc, doc, setDoc, increment, onSnapshot, query, where, runTransaction, orderBy, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// 🆕 Baixa de estoque agora mora em um módulo compartilhado (estoqueBaixa.js),
// porque a cozinha (cozinha.js) também precisa chamar essa mesma lógica no
// momento em que marca o pedido como "pronto" — sem depender da tela de
// Estoque estar aberta. Aqui ficamos apenas como rede de segurança.
import { construirMapaEstoque, processarPedidoSeguro } from "./estoqueBaixa.js";

// ==============================================
// 🆕 CAIXA POR FORMA DE PAGAMENTO (mesmo modelo do financeiro.js)
// ==============================================
// O financeiro.js guarda o saldo em configuracoes/caixa_empresa com os campos
// "dinheiro", "pix", "cartao" e "total" — NUNCA um campo genérico "saldo".
// Antes, as compras de estoque descontavam de um campo "saldo" que não existe
// nesse documento, então o financeiro nunca refletia essas compras. Esta
// função replica exatamente a lógica do financeiro.js pra manter os dois em sincronia.
async function ajustarSaldoCaixa(valor, forma) {
    const ref = doc(db, "configuracoes", "caixa_empresa");
    const snapAtual = await getDoc(ref);
    const atual = snapAtual.exists() ? snapAtual.data() : { dinheiro: 0, pix: 0, cartao: 0, total: 0 };
    const novo = { ...atual, ultimaAtualizacao: new Date() };
    valor = Number(valor.toFixed(2));

    if (forma === "dinheiro") novo.dinheiro = Number(((novo.dinheiro || 0) + valor).toFixed(2));
    else if (forma === "pix") novo.pix = Number(((novo.pix || 0) + valor).toFixed(2));
    else if (forma === "cartao") novo.cartao = Number(((novo.cartao || 0) + valor).toFixed(2));
    else return; // "aprazo" não mexe no caixa agora — vira conta a pagar

    novo.total = Number(((novo.dinheiro || 0) + (novo.pix || 0) + (novo.cartao || 0)).toFixed(2));
    await setDoc(ref, novo, { merge: true });
}

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
function pegarCampo(item, nomes) {
    for (const nome of nomes) {
        if (item[nome] !== undefined) return item[nome];
    }
    return 0;
}

// Marca pedidos que JÁ existiam antes de abrirmos esta tela como processados,
// sem descontar nada — evita dar baixa retroativa em todo o histórico de vendas.
async function marcarHistoricoSemBaixa(ids) {
    for (let i = 0; i < ids.length; i += 400) {
        const lote = ids.slice(i, i + 400);
        const batch = writeBatch(db);
        lote.forEach(id => batch.update(doc(db, "pedidos", id), { estoqueBaixado: true, estoqueIgnoradoHistorico: true }));
        await batch.commit().catch(e => console.error("Falha ao marcar histórico", e));
    }
}

let carregouPrimeiraVez = false;
function monitorar() {
    onSnapshot(query(collection(db, "pedidos"), where("status", "in", ["concluido", "finalizado", "pronto"])), async snap => {
        const ehCargaInicial = !carregouPrimeiraVez;
        carregouPrimeiraVez = true;

        const pendentes = snap.docChanges()
            .filter(c => (c.type === "added" || c.type === "modified") && !c.doc.data().estoqueBaixado)
            .map(c => c.doc.id);
        if (!pendentes.length) return;

        if (ehCargaInicial) {
            // Pedidos que já existiam quando a tela abriu: não descontam estoque retroativamente.
            await marcarHistoricoSemBaixa(pendentes);
            return;
        }

        const mapaEstoque = await construirMapaEstoque();
        for (const id of pendentes) {
            try { await processarPedidoSeguro(id, mapaEstoque); }
            catch (e) { console.error(`Erro ao processar baixa do pedido #${id.slice(-4)}`, e); }
        }
    });
}

async function mediaVendas() {
    const dt = new Date(Date.now() - 2592000000);
    const s = await getDocs(query(collection(db, "pedidos"), where("status", "in", ["concluido", "pronto"]), where("criadoEm", ">=", dt.getTime())));
    const dias = {};
    s.forEach(d => {
        const ch = new Date(d.data().criadoEm).toISOString().slice(0, 10);
        dias[ch] = (dias[ch] || 0) + (d.data().itens || []).length;
    });
    const vals = Object.values(dias).filter(v => v > 0);
    return vals.length < 5 ? 25 : Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

async function atualizarTudo() {
    const s = await getDocs(collection(db, "estoque"));
    const itens = [];
    s.forEach(d => itens.push({ id: d.id, ...d.data() }));

    const b = nome => {
        const i = itens.find(x => norm(x.nome) === norm(nome));
        return i ? pegarCampo(i, ["quantidade", "qtd", "quant"]) : 0;
    };

    const acai = b("Açaí"), c400 = b("Copo 400ml"), c500 = b("Copo 500ml"), tampa = b("Tampa");
    const med = await mediaVendas();
    const capAcai = Math.floor(acai / 0.30), capCopos = c400 + c500, capTampas = tampa;
    const total = Math.min(capAcai, capCopos, capTampas);
    const lim = capAcai <= capCopos && capAcai <= capTampas ? "Açaí" : capCopos <= capTampas ? "Copos" : "Tampas";
    const m400 = total > 0 ? Math.min(c400, Math.floor(acai / 0.28), total) : 0;
    const m500 = total > 0 ? Math.min(c500, total - m400) : 0;

    document.getElementById("max400").textContent = total > 0 ? m400 : "⚠️ Sem Açaí";
    document.getElementById("max500").textContent = total > 0 ? m500 : "⚠️ Sem Açaí";
    document.getElementById("dias").textContent = total > 0 ? `${Math.floor(total / med)} dias` : "Repor estoque";
    document.getElementById("fatmax").textContent = total > 0 ? `R$ ${(m400 * 18.90 + m500 * 22.90).toFixed(2)}` : "R$ 0.00";
    document.getElementById("lucromax").textContent = total > 0 ? `R$ ${((m400 * 18.90 + m500 * 22.90) * 0.48).toFixed(2)}` : "R$ 0.00";
    document.getElementById("limitante").textContent = lim;

    resumo(itens);
    alertas(itens);
    listaCompra(itens);
    tabela(itens);
}

function resumo(itens) {
    const total = itens.reduce((a, i) => a + (pegarCampo(i, ["quantidade", "qtd", "quant"]) * pegarCampo(i, ["custoUnitario", "custo", "valor"])), 0);
    document.getElementById("total-estoque").innerHTML = `<div class="resumo-item"><strong>Total Investido</strong>R$ ${total.toFixed(2)}</div>`;
}

function alertas(itens) {
    const div = document.getElementById("alertas-estoque");
    const cri = itens.filter(i => pegarCampo(i, ["quantidade", "qtd", "quant"]) <= pegarCampo(i, ["nivelMinimo", "minimo", "estoqueMinimo"]) / 2);
    const bai = itens.filter(i => {
        const q = pegarCampo(i, ["quantidade", "qtd", "quant"]);
        const m = pegarCampo(i, ["nivelMinimo", "minimo", "estoqueMinimo"]);
        return q > m / 2 && q <= m;
    });
    div.innerHTML = "";
    if (cri.length || bai.length) {
        div.innerHTML = `<div class="card alerta"><h3><i class="fas fa-exclamation-triangle"></i> Atenção!</h3>${cri.length ? `<p style="color:var(--red);font-weight:bold;">URGENTE: ${cri.map(i => i.nome).join(", ")}</p>` : ""}${bai.length ? `<p style="color:var(--yellow);">Fique de olho: ${bai.map(i => i.nome).join(", ")}</p>` : ""}</div>`;
    }
}

function listaCompra(itens) {
    const corpo = document.getElementById("lista-compra");
    const reg = {
        "Açaí": { min: 5, ideal: 12, cu: 16.60 },
        "Copo 400ml": { min: 15, ideal: 40, cu: 0.58 },
        "Copo 500ml": { min: 15, ideal: 40, cu: 0.63 },
        "Tampa": { min: 20, ideal: 50, cu: 0.53 },
        "Colher": { min: 20, ideal: 50, cu: 0.30 },
        "Guardanapo": { min: 30, ideal: 80, cu: 0.10 },
        "Nutella": { min: 0.5, ideal: 1.5, cu: 76.91 },
        "Porta-copo 1 copo": { min: 10, ideal: 30, cu: 0.50 },
        "Porta-copo 2+ copos": { min: 10, ideal: 30, cu: 1.00 },
        "Sacola 1 copo": { min: 15, ideal: 40, cu: 0.50 },
        "Sacola 2+ copos": { min: 10, ideal: 25, cu: 0.73 },
        "Amendoim": { min: 0.5, ideal: 1, cu: 0.24 },
        "Disquete": { min: 0.2, ideal: 0.5, cu: 0.03 },
        "Morango": { min: 0.5, ideal: 1.5, cu: 18.00 },
        "Granola": { min: 0.5, ideal: 1.5, cu: 12.00 },
        "Leite em pó": { min: 0.3, ideal: 1, cu: 25.00 },
        "Leite condensado": { min: 0.5, ideal: 1.5, cu: 8.00 },
        "Paçoca": { min: 0.3, ideal: 1, cu: 15.00 },
        "Banana": { min: 0.5, ideal: 2, cu: 4.00 }
    };

    const comp = [];
    for (const [nomeReg, dadosReg] of Object.entries(reg)) {
        const itemEncontrado = itens.find(x => norm(x.nome) === norm(nomeReg));
        if (!itemEncontrado) continue;
        const qtdAtual = pegarCampo(itemEncontrado, ["quantidade", "qtd", "quant"]);
        if (qtdAtual < dadosReg.ideal) {
            const falta = Number((dadosReg.ideal - qtdAtual).toFixed(2));
            const prioridade = qtdAtual <= dadosReg.min ? "🔴 URGENTE" : qtdAtual <= dadosReg.min * 1.5 ? "🟡 Média" : "🟢 Baixa";
            comp.push({
                p: prioridade,
                n: nomeReg,
                q: falta,
                cu: dadosReg.cu,
                t: Number((falta * dadosReg.cu).toFixed(2))
            });
        }
    }
    comp.sort((a, b) => a.p.localeCompare(b.p));
    corpo.innerHTML = comp.length
        ? comp.map(x => `<tr><td>${x.p}</td><td>${x.n}</td><td>${x.q}</td><td>R$ ${x.cu.toFixed(2)}</td><td>R$ ${x.t.toFixed(2)}</td></tr>`).join("")
        : `<tr><td colspan="5">✅ Tudo em dia!</td></tr>`;
}

window.copiarLista = () => {
    const txt = Array.from(document.querySelectorAll("#lista-compra tr")).map(r => r.textContent.trim()).join("\n");
    navigator.clipboard.writeText(txt).then(() => alert("✅ Lista copiada!"));
};

function tabela(itens) {
    document.getElementById("tab-estoque").innerHTML = itens.map(i => {
        const q = pegarCampo(i, ["quantidade", "qtd", "quant"]);
        const m = pegarCampo(i, ["nivelMinimo", "minimo", "estoqueMinimo"]);
        const cu = pegarCampo(i, ["custoUnitario", "custo", "valor"]);
        const st = q <= m / 2 ? "🚨 Crítico" : q <= m ? "⚠️ Baixo" : "✅ Normal";
        const cor = q <= m / 2 ? "var(--red)" : q <= m ? "var(--yellow)" : "var(--green)";
        return `<tr><td>${esc(i.nome)}</td><td>${q.toFixed(2)}</td><td style="color:${cor}">${st}</td><td>R$ ${cu.toFixed(2)}</td><td>R$ ${(q * cu).toFixed(2)}</td></tr>`;
    }).join("");
}

// ==============================================
// AÇÕES E INICIALIZAÇÃO
// ==============================================
document.getElementById("btn-salvar").addEventListener("click", async () => {
    const dados = {
        nome: t(document.getElementById("nome-item").value),
        unidade: t(document.getElementById("unidade-item").value),
        quantidade: n(document.getElementById("qtd-item").value),
        custoUnitario: n(document.getElementById("custo-item").value),
        nivelMinimo: n(document.getElementById("min-item").value, 0),
        nivelIdeal: n(document.getElementById("ideal-item").value, 0),
        atualizadoEm: new Date()
    };
    const lancarGasto = document.getElementById("lancar-gasto-item").checked;
    const formaPagamento = document.getElementById("forma-pagamento-item").value;
    if (!dados.nome || dados.quantidade <= 0) return alert("Preencha tudo!");
    try {
        const s = await getDocs(collection(db, "estoque"));
        if (s.docs.some(x => norm(x.data().nome) === norm(dados.nome))) return alert("Item já existe! Use Movimentação.");
        await addDoc(collection(db, "estoque"), dados);

        if (lancarGasto) {
            const valorCompra = Number((dados.quantidade * dados.custoUnitario).toFixed(2));
            if (valorCompra > 0) {
                await addDoc(collection(db, "gastos"), {
                    descricao: `Compra: ${dados.nome}`, valor: valorCompra, tipo: "insumo", natureza: "empresa",
                    formaPagamento, data: new Date()
                });

                if (formaPagamento === "aprazo") {
                    // 🆕 Não desconta o caixa agora — entra em Contas a Pagar pra ser quitada depois
                    await addDoc(collection(db, "contas_pagar"), {
                        descricao: `Compra: ${dados.nome}`, valor: valorCompra,
                        dataVenc: new Date(Date.now() + 7 * 86400000), pago: false
                    });
                } else {
                    await ajustarSaldoCaixa(-valorCompra, formaPagamento);
                }
            }
        }

        alert(lancarGasto
            ? (formaPagamento === "aprazo" ? "✅ Cadastrado! Lançado como conta a pagar (a prazo)." : "✅ Cadastrado e descontado do caixa (" + formaPagamento + ")!")
            : "✅ Cadastrado (sem lançar gasto — só a contagem do estoque).");
        atualizarTudo();
        carregarSel();
    } catch (e) {
        console.error(e);
        alert("❌ Não foi possível cadastrar o item.");
    }
});

// Movimentação manual: também atômica (baixa/compra, log e gasto/caixa na MESMA transação),
// e nunca deixa passar de zero — só avisa o usuário em vez de travar com erro no console.
document.getElementById("btn-mov").addEventListener("click", async () => {
    const id = t(document.getElementById("sel-item").value);
    const tipo = t(document.getElementById("tipo-mov").value);
    const qtd = n(document.getElementById("qtd-mov").value);
    const obs = t(document.getElementById("obs-mov").value);
    const precoDigitado = document.getElementById("preco-mov").value;
    const formaPagamento = document.getElementById("forma-mov").value;
    if (!id || qtd <= 0) return alert("Preencha tudo!");

    // 🆕 Se for compra ("entrada"), o preço vem do campo (pré-preenchido com o último,
    // mas editável) — pode ser diferente do que está salvo no cadastro do item.
    let valorCompra = 0;
    let precoUsado = null;
    try {
        await runTransaction(db, async tx => {
            const ref = doc(db, "estoque", id);
            const caixaRef = doc(db, "configuracoes", "caixa_empresa");

            // 🆕 TODAS as leituras primeiro — regra do Firestore: todo tx.get()
            // precisa acontecer antes de qualquer tx.set()/tx.update() na mesma transação.
            const s = await tx.get(ref);
            if (!s.exists()) throw new Error("Item não existe mais. Atualize a página.");
            const dadosItem = s.data();
            const qatual = Number(pegarCampo(dadosItem, ["quantidade", "qtd", "quant"]));
            const custoSalvo = Number(pegarCampo(dadosItem, ["custoUnitario", "custo", "valor"]));
            const nova = tipo === "entrada" ? qatual + qtd : qatual - qtd;
            if (nova < 0) throw new Error(`Estoque insuficiente de "${dadosItem.nome}" (disponível: ${qatual}).`);

            if (tipo === "entrada") {
                // Usa o preço digitado se o usuário informou algo; senão cai no último preço salvo.
                precoUsado = precoDigitado !== "" && !isNaN(Number(precoDigitado)) ? Number(precoDigitado) : custoSalvo;
                valorCompra = Number((qtd * precoUsado).toFixed(2));
            }

            // Só precisamos ler o caixa se formos realmente mexer nele.
            const vaiMexerNoCaixa = tipo === "entrada" && valorCompra > 0 && formaPagamento !== "aprazo";
            let novoCaixa = null;
            if (vaiMexerNoCaixa) {
                const caixaSnap = await tx.get(caixaRef);
                const caixaAtual = caixaSnap.exists() ? caixaSnap.data() : { dinheiro: 0, pix: 0, cartao: 0, total: 0 };
                novoCaixa = { ...caixaAtual, ultimaAtualizacao: new Date() };
                if (formaPagamento === "dinheiro") novoCaixa.dinheiro = Number(((novoCaixa.dinheiro || 0) - valorCompra).toFixed(2));
                else if (formaPagamento === "pix") novoCaixa.pix = Number(((novoCaixa.pix || 0) - valorCompra).toFixed(2));
                else if (formaPagamento === "cartao") novoCaixa.cartao = Number(((novoCaixa.cartao || 0) - valorCompra).toFixed(2));
                novoCaixa.total = Number(((novoCaixa.dinheiro || 0) + (novoCaixa.pix || 0) + (novoCaixa.cartao || 0)).toFixed(2));
            }

            // 🆕 A partir daqui só escritas — nenhum tx.get() depois deste ponto.
            const atualizacaoItem = { quantidade: nova, atualizadoEm: new Date() };
            if (tipo === "entrada" && precoUsado !== custoSalvo) atualizacaoItem.custoUnitario = precoUsado;

            tx.update(ref, atualizacaoItem);
            tx.set(doc(collection(db, "movimentacoes")), {
                itemId: id, nomeItem: dadosItem.nome, tipo, quantidade: qtd, observacao: obs, data: new Date()
            });

            if (tipo === "entrada" && valorCompra > 0) {
                tx.set(doc(collection(db, "gastos")), {
                    descricao: `Compra: ${dadosItem.nome}`, valor: valorCompra, tipo: "insumo", natureza: "empresa",
                    formaPagamento, data: new Date()
                });

                if (formaPagamento === "aprazo") {
                    // 🆕 A prazo: não desconta o caixa agora, vira conta a pagar
                    tx.set(doc(collection(db, "contas_pagar")), {
                        descricao: `Compra: ${dadosItem.nome}`, valor: valorCompra,
                        dataVenc: new Date(Date.now() + 7 * 86400000), pago: false
                    });
                } else {
                    tx.set(caixaRef, novoCaixa, { merge: true });
                }
            }
        });
        document.getElementById("qtd-mov").value = "";
        document.getElementById("preco-mov").value = "";
        document.getElementById("obs-mov").value = "";
        alert(tipo === "entrada" && valorCompra > 0
            ? (formaPagamento === "aprazo" ? "✅ Registrado! Lançado como conta a pagar (a prazo)." : `✅ Registrado e descontado do caixa (${formaPagamento})!`)
            : "✅ Registrado!");
        atualizarTudo();
    } catch (e) {
        console.error(e);
        alert(`❌ ${e.message || "Não foi possível registrar a movimentação."}`);
    }
});

// 🆕 Pré-preenche o preço unitário com o último valor pago quando escolhe um item,
// e mostra/esconde os campos de preço e forma de pagamento conforme o tipo escolhido.
async function atualizarCamposMovimentacao() {
    const tipo = document.getElementById("tipo-mov").value;
    const precoBox = document.getElementById("preco-mov-box");
    const formaBox = document.getElementById("forma-mov-box");
    const mostrarCompra = tipo === "entrada";
    precoBox.style.display = mostrarCompra ? "" : "none";
    formaBox.style.display = mostrarCompra ? "" : "none";
}

async function preencherUltimoPreco() {
    const id = document.getElementById("sel-item").value;
    const precoInput = document.getElementById("preco-mov");
    if (!id) { precoInput.value = ""; return; }
    try {
        const snap = await getDocs(collection(db, "estoque"));
        const itemDoc = snap.docs.find(d => d.id === id);
        if (itemDoc) {
            const custo = pegarCampo(itemDoc.data(), ["custoUnitario", "custo", "valor"]);
            precoInput.value = custo || "";
        }
    } catch (e) { console.error("Erro ao buscar último preço", e); }
}

document.getElementById("tipo-mov").addEventListener("change", atualizarCamposMovimentacao);
document.getElementById("sel-item").addEventListener("change", preencherUltimoPreco);

async function carregarSel() {
    const s = await getDocs(collection(db, "estoque"));
    document.getElementById("sel-item").innerHTML = `<option value="">Selecione...</option>` + s.docs.map(d => `<option value="${d.id}">${esc(d.data().nome)}</option>`).join("");
}

onSnapshot(query(collection(db, "movimentacoes"), orderBy("data", "desc")), s => {
    document.getElementById("tab-mov").innerHTML = s.docs.map(d => {
        const m = d.data();
        return `<tr><td>${m.data ? new Date(m.data.toDate()).toLocaleString("pt-BR") : ""}</td><td>${esc(m.nomeItem)}</td><td>${m.tipo}</td><td>${n(m.quantidade).toFixed(2)}</td></tr>`;
    }).join("") || `<tr><td colspan="4">—</td></tr>`;
});

document.addEventListener("DOMContentLoaded", () => {
    carregarSel();
    atualizarTudo();
    monitorar();
    atualizarCamposMovimentacao(); // 🆕 estado inicial certo dos campos de preço/pagamento
});
