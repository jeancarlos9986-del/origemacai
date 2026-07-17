import { db } from "./firebase.js";
import {
    collection, addDoc, getDocs, updateDoc, doc, onSnapshot, query, where, orderBy, runTransaction
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// --------------------------
// REGRAS DE CONSUMO (MANTIDAS EXATAMENTE COMO ESTAVA)
// --------------------------
const CONSUMO = {
    "400ml": { acai: 0.28 },
    "500ml": { acai: 0.32 },
    "Pequeno": { acai: 0.28 },
    "Médio": { acai: 0.32 },
    "Super": { acai: 0.32 },
    "Nutella": { quantidade: 0.03 },
    "Morango": { quantidade: 0.03 },
    "Granola": { quantidade: 0.02 },
    "Leite em pó": { quantidade: 0.02 },
    "Leite condensado": { quantidade: 0.02 },
    "Paçoca": { quantidade: 0.02 },
    "Disquete": { quantidade: 0.01 },
    "Kit Kat": { quantidade: 0.01 },
    "Ouro Branco": { quantidade: 0.01 },
    "Sonho de Valsa": { quantidade: 0.01 },
    "Chocoball": { quantidade: 0.01 },
    "Amendoim": { quantidade: 0.02 },
    "Banana": { quantidade: 0.03 },
    "Ovomaltine": { quantidade: 0.02 }
};

// --------------------------
// FUNÇÕES DE SEGURANÇA (MANTIDAS)
// --------------------------
function garantirNumero(valor, padrao = 0) {
    const convertido = Number(valor);
    return isNaN(convertido) ? padrao : convertido;
}

function garantirTexto(valor, padrao = "Não informado") {
    return typeof valor === "string" && valor.trim() !== "" ? valor.trim() : padrao;
}

function normalizarNome(nome) {
    return garantirTexto(nome).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Evita XSS: qualquer texto vindo do Firestore (nome de insumo, observação,
// descrição de gasto etc.) passa por aqui antes de entrar num innerHTML.
// Sem isso, um nome/observação contendo "<" ou caracteres de HTML poderia
// quebrar o layout ou, no pior caso, executar script na tela de quem olhar.
function escapeHTML(texto) {
    const div = document.createElement("div");
    div.textContent = garantirTexto(texto, "");
    return div.innerHTML;
}

// --------------------------
// FUNÇÃO DE ATUALIZAÇÃO DE ESTOQUE (MANTIDA)
// --------------------------
// Recebe o item JÁ localizado ({id, nome}) — quem chama é responsável por
// buscar a coleção "estoque" UMA vez por pedido (ver darBaixaPorPedido),
// em vez de rebuscar tudo a cada item baixado.
// Usa transação para ler+atualizar a quantidade de forma atômica, evitando
// que dois pedidos concorrentes derrubem o estoque para negativo.
async function atualizarQuantidadeItem(itemInfo, qtdSaida, observacao) {
    if (!itemInfo) {
        console.warn(`⚠️ ITEM NÃO CADASTRADO NO ESTOQUE — CADASTRE AGORA!`);
        return;
    }

    const itemRef = doc(db, "estoque", itemInfo.id);
    const movRef = doc(collection(db, "movimentacoes"));

    try {
        await runTransaction(db, async (transaction) => {
            const itemSnap = await transaction.get(itemRef);
            if (!itemSnap.exists()) {
                throw new Error(`Item "${itemInfo.nome}" não existe mais no estoque`);
            }

            const qtdAtual = garantirNumero(itemSnap.data().quantidade);
            const novaQtd = qtdAtual - qtdSaida;

            if (novaQtd < 0) {
                throw new Error(`Estoque insuficiente para "${itemInfo.nome}": tem ${qtdAtual}, precisa ${qtdSaida}`);
            }

            transaction.update(itemRef, {
                quantidade: novaQtd,
                atualizadoEm: new Date()
            });

            transaction.set(movRef, {
                itemId: itemInfo.id,
                nomeItem: itemInfo.nome,
                tipo: "saida",
                quantidade: qtdSaida,
                observacao: observacao,
                data: new Date()
            });
        });

        console.log(`✅ BAIXA REALIZADA: ${itemInfo.nome} -${qtdSaida}`);
    } catch (e) {
        console.warn(`⚠️ Falha na baixa de "${itemInfo.nome}": ${e.message}`);
    }
}

// --------------------------
// FUNÇÃO DE BAIXA (MANTIDA COM CORREÇÃO DO GRATIS)
// --------------------------
async function darBaixaPorPedido(pedido, idPedido) {
    const itens = pedido.itens || [];
    if (itens.length === 0) {
        console.warn(`⚠️ Pedido ${idPedido} sem itens — sem baixa`);
        return;
    }

    console.log("🚨 PEDIDO BRUTO RECEBIDO:", JSON.stringify(pedido, null, 2));

    // Busca o estoque UMA vez para o pedido inteiro (antes: era buscada a
    // coleção inteira para CADA item de baixa, gerando dezenas de leituras
    // desnecessárias por pedido).
    const snapEstoque = await getDocs(collection(db, "estoque"));
    const mapaEstoque = new Map();
    snapEstoque.forEach(d => {
        const dados = d.data();
        mapaEstoque.set(normalizarNome(dados.nome || ""), { id: d.id, nome: dados.nome });
    });

    let baixas = [];

    for (const item of itens) {
        console.log("🚨 ITEM BRUTO RECEBIDO:", JSON.stringify(item, null, 2));

        const nomeCopo = normalizarNome(item.nome || "");
        let tipoCopo = "500ml";
        if (nomeCopo.includes("400ml") || nomeCopo.includes("pequeno")) tipoCopo = "400ml";

        baixas.push({ nome: "Açaí", qtd: CONSUMO[tipoCopo].acai });
        baixas.push({ nome: tipoCopo === "400ml" ? "Copo 400ml" : "Copo 500ml", qtd: 1 });
        baixas.push({ nome: "Tampa", qtd: 1 });
        baixas.push({ nome: "Colher", qtd: 1 });
        baixas.push({ nome: "Guardanapo", qtd: 1 });

        let adicionais = [];
        if (Array.isArray(item.gratis)) adicionais.push(...item.gratis);
        if (Array.isArray(item.pagos)) adicionais.push(...item.pagos);
        if (Array.isArray(item.extras)) adicionais.push(...item.extras);
        if (Array.isArray(item.extras?.gratis)) adicionais.push(...item.extras.gratis);
        if (Array.isArray(item.extras?.pagos)) adicionais.push(...item.extras.pagos);
        if (Array.isArray(item.adicionais)) adicionais.push(...item.adicionais);

        adicionais = adicionais.map(ad => {
            if (typeof ad === "object" && ad !== null) return ad.nome || ad.titulo || "";
            return String(ad || "");
        }).filter(ad => ad.trim() !== "");

        adicionais = [...new Set(adicionais)];
        console.log("🍓 ADICIONAIS ENCONTRADOS:", adicionais);

        adicionais.forEach(nomeAdicional => {
            const nomeNorm = normalizarNome(nomeAdicional);
            let encontrado = null;
            for (const chave of Object.keys(CONSUMO)) {
                const chaveNorm = normalizarNome(chave);
                if (nomeNorm.includes(chaveNorm) || chaveNorm.includes(nomeNorm)) {
                    encontrado = chave;
                    break;
                }
            }
            if (encontrado) {
                baixas.push({ nome: encontrado, qtd: CONSUMO[encontrado].quantidade });
                console.log(`✅ ADICIONAL BAIXADO: ${encontrado}`);
            }
        });
    }

    const qtdCopos = itens.length;
    baixas.push({ nome: qtdCopos === 1 ? "Sacola 1 copo" : "Sacola 2+ copos", qtd: 1 });
    baixas.push({ nome: qtdCopos === 1 ? "Porta-copo 1 copo" : "Porta-copo 2+ copos", qtd: 1 });

    console.log("📋 LISTA FINAL PARA BAIXAR:", baixas);

    for (const baixa of baixas) {
        const itemInfo = mapaEstoque.get(normalizarNome(baixa.nome));
        if (!itemInfo) {
            console.warn(`⚠️ ITEM NÃO CADASTRADO NO ESTOQUE: "${baixa.nome}" — CADASTRE AGORA!`);
            continue;
        }
        await atualizarQuantidadeItem(itemInfo, baixa.qtd, `Baixa automática - Pedido #${pedido.numero || idPedido.slice(-4)}`);
    }
}

// --------------------------
// MONITORAMENTO (MANTIDO SEM DUPLICATAS)
// --------------------------
async function monitorarPedidosConcluidos() {
    console.log("🔍 MONITORANDO PEDIDOS...");
    const pedidosRef = collection(db, "pedidos");
    const q = query(pedidosRef, where("status", "in", ["concluido", "Concluído", "finalizado", "entregue", "pronto"]));

    onSnapshot(q, async (snap) => {
        snap.docChanges().forEach(async (change) => {
            if (change.type !== "added" && change.type !== "modified") return;
            const idPedido = change.doc.id;

            try {
                // Antes: "ler flag -> escrever flag -> dar baixa" em passos
                // separados. Se dois eventos do snapshot chegassem quase
                // juntos para o MESMO pedido, os dois liam a flag como
                // "não baixado" antes de qualquer um terminar de escrever,
                // e o estoque era baixado EM DOBRO para o mesmo pedido.
                // Agora o check-and-set roda dentro de uma transação: o
                // Firestore garante que só um dos dois "vence" a corrida.
                let podeBaixar = false;
                let pedidoAtual = null;

                await runTransaction(db, async (transaction) => {
                    const pedidoRef = doc(db, "pedidos", idPedido);
                    const pedidoSnap = await transaction.get(pedidoRef);
                    if (!pedidoSnap.exists()) return;

                    pedidoAtual = pedidoSnap.data();
                    if (pedidoAtual.estoqueBaixado === true) {
                        console.log(`✅ Pedido ${idPedido} já foi baixado — pulando!`);
                        return;
                    }

                    transaction.update(pedidoRef, { estoqueBaixado: true });
                    podeBaixar = true;
                });

                if (!podeBaixar) return;

                await darBaixaPorPedido(pedidoAtual, idPedido);
                console.log(`🎉 PEDIDO ${idPedido} FINALIZADO COM SUCESSO!`);
            } catch (erro) {
                console.error(`❌ ERRO NO PEDIDO ${idPedido}:`, erro);
                await updateDoc(doc(db, "pedidos", idPedido), { estoqueBaixado: false });
            }
        });
    });
}

// --------------------------
// NOVA FUNÇÃO: CÁLCULOS FINANCEIROS E ALERTAS
// --------------------------
function calcularIndicadoresItem(item) {
    const qtd = garantirNumero(item.quantidade);
    const custo = garantirNumero(item.custoUnitario);
    const precoVenda = garantirNumero(item.precoVenda || 0);
    const minimo = garantirNumero(item.nivelMinimo || 0);
    const ideal = garantirNumero(item.nivelIdeal || minimo * 2);

    const valorInvestido = qtd * custo;
    const retornoEsperado = qtd * precoVenda;
    const lucroEstimado = retornoEsperado - valorInvestido;
    const margem = valorInvestido > 0 ? ((lucroEstimado / valorInvestido) * 100).toFixed(1) : 0;

    let status = "✅ Normal";
    let cor = "green";
    if (qtd <= minimo && qtd > 0) { status = "⚠️ Baixo"; cor = "orange"; }
    if (qtd <= 0 || qtd <= minimo / 2) { status = "🚨 Crítico"; cor = "red"; }

    return { valorInvestido, retornoEsperado, lucroEstimado, margem, status, cor, minimo, ideal };
}

// --------------------------
// NOVA FUNÇÃO: MÉDIA REAL DE VENDAS (substitui os números fixos 25/45)
// --------------------------
// Antes a previsão usava sempre "25 copos/dia" (semana normal) ou
// "45 copos/dia" (fim de semana), fixos no código, sem nenhuma relação
// com o quanto a loja realmente vende. Agora calculamos a média real
// dos últimos 30 dias de pedidos concluídos, separando dias de semana
// normal de fim de semana (sex/sáb/dom). Se ainda não houver histórico
// suficiente (loja nova, por exemplo), caímos de volta nos valores fixos
// como estimativa inicial — e isso fica explícito na tela.
async function calcularMediaVendasReal() {
    const hoje = new Date();
    const trintaDiasAtras = new Date(hoje);
    trintaDiasAtras.setDate(trintaDiasAtras.getDate() - 30);

    try {
        const pedidosRef = collection(db, "pedidos");
        const q = query(
            pedidosRef,
            where("status", "in", ["concluido", "Concluído", "finalizado", "entregue", "pronto"]),
            where("criadoEm", ">=", trintaDiasAtras.getTime())
        );
        const snap = await getDocs(q);

        // Agrupa a quantidade de copos vendidos por dia do calendário
        const coposPorDia = {}; // ex: "2026-07-10" -> 18
        snap.forEach(d => {
            const pedido = d.data();
            const qtdCopos = (pedido.itens || []).length;
            if (qtdCopos === 0 || !pedido.criadoEm) return;
            const chave = new Date(pedido.criadoEm).toISOString().slice(0, 10);
            coposPorDia[chave] = (coposPorDia[chave] || 0) + qtdCopos;
        });

        const diasComVendas = Object.keys(coposPorDia);

        // Exige um mínimo de dias com venda pra confiar na média real —
        // com poucos dias, um único dia atípico distorceria tudo.
        if (diasComVendas.length < 5) {
            return { temDadosSuficientes: false, diasAnalisados: diasComVendas.length };
        }

        const valoresNormal = [];
        const valoresFimDeSemana = [];

        diasComVendas.forEach(chave => {
            const diaSemana = new Date(`${chave}T12:00:00`).getDay(); // meio-dia evita erro de fuso
            const ehFimDeSemana = diaSemana === 0 || diaSemana === 5 || diaSemana === 6;
            (ehFimDeSemana ? valoresFimDeSemana : valoresNormal).push(coposPorDia[chave]);
        });

        const media = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
        const mediaGeral = media(Object.values(coposPorDia));

        return {
            temDadosSuficientes: true,
            mediaGeral,
            mediaSemanaNormal: media(valoresNormal),
            mediaFimDeSemana: media(valoresFimDeSemana),
            diasAnalisados: diasComVendas.length
        };
    } catch (e) {
        console.error("Erro ao calcular média real de vendas:", e);
        return { temDadosSuficientes: false, diasAnalisados: 0 };
    }
}

// --------------------------
// NOVA FUNÇÃO: PREVISÃO DE CONSUMO E SUGESTÃO DE COMPRA
// --------------------------
async function gerarPrevisaoEstoque() {
    const previsaoDiv = document.getElementById("previsao-estoque");
    if (!previsaoDiv) return;

    previsaoDiv.innerHTML = "<p>Calculando previsão de consumo...</p>";
    const hoje = new Date();
    const diaSemana = hoje.getDay(); // 0=Dom, 6=Sáb

    // Define período de movimento alto
    const movimentoAlto = diaSemana === 5 || diaSemana === 6 || diaSemana === 0;
    const periodo = movimentoAlto ? "fim de semana" : "semana normal";

    // Tenta usar a média REAL calculada a partir do histórico de vendas.
    // Só usa os valores fixos (25/45) como estimativa de fallback quando
    // ainda não há histórico suficiente.
    const historico = await calcularMediaVendasReal();
    let mediaCopos;
    let fonteMedia;

    if (historico.temDadosSuficientes) {
        const mediaEspecifica = movimentoAlto ? historico.mediaFimDeSemana : historico.mediaSemanaNormal;
        mediaCopos = Math.round(mediaEspecifica ?? historico.mediaGeral);
        fonteMedia = `baseado nos últimos ${historico.diasAnalisados} dias com venda`;
    } else {
        mediaCopos = movimentoAlto ? 45 : 25;
        fonteMedia = `estimativa inicial — ainda faltam dados (${historico.diasAnalisados}/5 dias com venda registrados)`;
    }

    let html = `<div style="padding:15px; background:#1f2937; border-radius:8px; margin:15px 0;">
    <h4>📊 Previsão para ${periodo}</h4>
    <p>Média estimada: <strong>${mediaCopos} copos/dia</strong> <span style="color:var(--muted); font-size:0.8rem;">(${fonteMedia})</span></p><ul>`;

    // Pega estoque atual
    const snap = await getDocs(collection(db, "estoque"));
    const itens = [];
    snap.forEach(d => itens.push({ id: d.id, ...d.data() }));

    // Calcula necessidade por item
    for (const item of itens) {
        const nomeNorm = normalizarNome(item.nome);
        let consumoPorCopo = 0;

        // Verifica se tem regra de consumo
        for (const [chave, val] of Object.entries(CONSUMO)) {
            if (normalizarNome(chave) === nomeNorm) {
                consumoPorCopo = val.quantidade || 0;
                break;
            }
        }
        if (nomeNorm === "acai") consumoPorCopo = 0.30; // Média entre 400/500ml

        if (consumoPorCopo > 0) {
            const necessidade = consumoPorCopo * mediaCopos;
            const tem = garantirNumero(item.quantidade);
            const falta = Math.max(0, necessidade - tem);
            if (falta > 0) {
                html += `<li style="color:red;">🚨 <strong>${escapeHTML(item.nome)}</strong>: Precisa de ${necessidade.toFixed(2)}, tem ${tem.toFixed(2)}. Compre mais ${falta.toFixed(2)}!</li>`;
            } else {
                html += `<li style="color:green;">✅ <strong>${escapeHTML(item.nome)}</strong>: Suficiente (tem ${tem.toFixed(2)}, precisa de ${necessidade.toFixed(2)})</li>`;
            }
        }
    }
    html += `</ul></div>`;
    previsaoDiv.innerHTML = html;
}

// --------------------------
// NOVA FUNÇÃO: ALERTAS DE ESTOQUE CRÍTICO (banner na tela + notificação)
// --------------------------
// Antes, um item "crítico" só ficava vermelho na tabela — se ninguém
// abrisse a tela de estoque naquele dia, ninguém percebia. Agora:
// 1) mostra um banner bem visível no topo da página com os itens
//    críticos/baixos, e
// 2) dispara uma notificação do navegador (se o usuário permitir) quando
//    um item passa a ficar crítico, sem repetir a mesma notificação a
//    cada vez que a página recarrega no mesmo dia.

function obterChaveNotificacaoHoje() {
    return `estoque_notificados_${new Date().toISOString().slice(0, 10)}`;
}

function itensJaNotificadosHoje() {
    try {
        const salvo = localStorage.getItem(obterChaveNotificacaoHoje());
        return salvo ? new Set(JSON.parse(salvo)) : new Set();
    } catch (e) {
        return new Set(); // localStorage indisponível — segue sem deduplicar entre recarregamentos
    }
}

function marcarComoNotificado(idsNotificados) {
    try {
        localStorage.setItem(obterChaveNotificacaoHoje(), JSON.stringify([...idsNotificados]));
    } catch (e) { /* segue sem persistir */ }
}

function dispararNotificacaoNavegador(titulo, corpo) {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
        new Notification(titulo, { body: corpo, tag: "estoque-critico" });
    } catch (e) {
        console.warn("Não foi possível disparar notificação:", e);
    }
}

function renderizarPromptNotificacao() {
    if (typeof Notification === "undefined" || Notification.permission !== "default") return "";
    return `
        <div class="card" style="border-color: var(--primary); display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:15px;">
            <span><i class="fas fa-bell"></i> Ative as notificações do navegador para ser avisado assim que um item ficar crítico — mesmo com a aba fechada.</span>
            <button type="button" id="btn-ativar-notificacao" style="flex:none;">Ativar notificações</button>
        </div>`;
}

function verificarAlertasEstoque(itens) {
    const alertaDiv = document.getElementById("alertas-estoque");
    if (!alertaDiv) return;

    const promptHtml = renderizarPromptNotificacao();

    const itensComProblema = itens
        .map(item => ({ item, ind: calcularIndicadoresItem(item) }))
        .filter(({ ind }) => ind.status !== "✅ Normal");

    let alertasHtml = "";
    if (itensComProblema.length > 0) {
        const criticos = itensComProblema.filter(({ ind }) => ind.status === "🚨 Crítico");
        const baixos = itensComProblema.filter(({ ind }) => ind.status === "⚠️ Baixo");

        const listaHtml = (lista) => lista.map(({ item, ind }) =>
            `<li><strong>${escapeHTML(item.nome)}</strong> — tem ${garantirNumero(item.quantidade).toFixed(2)} ${escapeHTML(item.unidade)} (mínimo: ${ind.minimo.toFixed(2)})</li>`
        ).join("");

        alertasHtml = `
        <div class="card" style="border-color: var(--red); background: rgba(255,23,68,0.06); margin-bottom: 20px;">
            <h3 style="color: var(--red);"><i class="fas fa-triangle-exclamation"></i> Alertas de Estoque</h3>
            ${criticos.length > 0 ? `
                <p style="color: var(--red); font-weight:700; margin-bottom:5px;">🚨 Crítico — repor com urgência:</p>
                <ul style="margin:0 0 12px 20px;">${listaHtml(criticos)}</ul>` : ""}
            ${baixos.length > 0 ? `
                <p style="color: var(--yellow); font-weight:700; margin-bottom:5px;">⚠️ Baixo — fique de olho:</p>
                <ul style="margin:0 0 0 20px;">${listaHtml(baixos)}</ul>` : ""}
        </div>`;
    }

    alertaDiv.innerHTML = promptHtml + alertasHtml;

    document.getElementById("btn-ativar-notificacao")?.addEventListener("click", () => {
        Notification.requestPermission().then(() => carregarEstoque());
    });

    // Notifica só os itens críticos que ainda não foram notificados HOJE
    // (evita disparar notificação repetida toda vez que a tela recarrega)
    const criticosAgora = itensComProblema.filter(({ ind }) => ind.status === "🚨 Crítico");
    if (criticosAgora.length === 0) return;

    const jaNotificados = itensJaNotificadosHoje();
    const novos = criticosAgora.filter(({ item }) => item.id && !jaNotificados.has(item.id));

    if (novos.length > 0) {
        const nomes = novos.map(({ item }) => item.nome).join(", ");
        dispararNotificacaoNavegador("🚨 Estoque crítico", `Repor com urgência: ${nomes}`);
        novos.forEach(({ item }) => jaNotificados.add(item.id));
        marcarComoNotificado(jaNotificados);
    }
}

// --------------------------
// FUNÇÕES DE CARREGAMENTO ATUALIZADAS
// --------------------------
async function salvarItem() {
    const nome = garantirTexto(document.getElementById("nome-item").value);
    const unidade = garantirTexto(document.getElementById("unidade-item").value);
    const qtd = garantirNumero(document.getElementById("qtd-item").value);
    const custo = garantirNumero(document.getElementById("custo-item").value);
    const precoVenda = garantirNumero(document.getElementById("preco-venda-item")?.value || 0);
    const minimo = garantirNumero(document.getElementById("nivel-minimo")?.value || 0);
    const ideal = garantirNumero(document.getElementById("nivel-ideal")?.value || 0);

    if (!nome || qtd <= 0 || custo < 0) { alert("Preencha todos os campos!"); return; }
    try {
        // Evita cadastrar dois itens com o mesmo nome (ex: "Açaí" duas vezes).
        // Isso é importante porque a baixa automática de estoque localiza o
        // item PELO NOME — se existirem dois, um deles fica "invisível" para
        // as baixas de pedidos e nunca é descontado corretamente.
        const nomeNormalizadoNovo = normalizarNome(nome);
        const snapExistente = await getDocs(collection(db, "estoque"));
        const jaExiste = snapExistente.docs.some(d => normalizarNome(d.data().nome || "") === nomeNormalizadoNovo);

        if (jaExiste) {
            alert(`⚠️ Já existe um item chamado "${nome}" no estoque. Use a "Movimentação de Estoque" (Entrada/Ajuste) para atualizar a quantidade dele, em vez de cadastrar de novo.`);
            return;
        }

        await addDoc(collection(db, "estoque"), {
            nome, unidade, quantidade: qtd, custoUnitario: custo, precoVenda,
            nivelMinimo: minimo, nivelIdeal: ideal, atualizadoEm: new Date()
        });
        alert("✅ Item cadastrado!");
        limparFormularioItem(); carregarEstoque(); preencherSelectItens(); gerarPrevisaoEstoque();
    } catch (e) { alert("Erro: " + e.message); }
}

async function registrarMovimentacao() {
    const itemId = garantirTexto(document.getElementById("select-item").value);
    const tipo = garantirTexto(document.getElementById("tipo-mov").value);
    const qtd = garantirNumero(document.getElementById("qtd-mov").value);
    const obs = garantirTexto(document.getElementById("obs-mov").value);
    if (!itemId || qtd <= 0) { alert("Selecione item e quantidade!"); return; }
    try {
        const itemRef = doc(db, "estoque", itemId);
        const movRef = doc(collection(db, "movimentacoes"));
        let nomeItem = "";

        await runTransaction(db, async (transaction) => {
            const itemSnap = await transaction.get(itemRef);
            if (!itemSnap.exists()) throw new Error("Item não encontrado!");

            const itemData = itemSnap.data();
            nomeItem = itemData.nome;
            const qtdAtual = garantirNumero(itemData.quantidade);
            const novaQtd = tipo === "entrada" ? qtdAtual + qtd : qtdAtual - qtd;

            if (novaQtd < 0) throw new Error("Estoque insuficiente!");

            transaction.update(itemRef, { quantidade: novaQtd, atualizadoEm: new Date() });
            transaction.set(movRef, { itemId, nomeItem, tipo, quantidade: qtd, observacao: obs, data: new Date() });
        });

        alert("✅ Movimentação registrada!");
        limparFormularioMov(); carregarEstoque(); carregarMovimentacoes(); gerarPrevisaoEstoque();
    } catch (e) {
        alert(e.message === "Estoque insuficiente!" || e.message === "Item não encontrado!" ? "❌ " + e.message : "Erro: " + e.message);
    }
}

async function carregarEstoque() {
    const corpo = document.querySelector("#tabela-estoque tbody");
    const totalDiv = document.getElementById("total-estoque");
    if (!corpo) return;
    corpo.innerHTML = "<tr><td colspan='10' style='text-align:center'>Carregando...</td></tr>";
    try {
        const snap = await getDocs(collection(db, "estoque"));
        corpo.innerHTML = "";
        let totalInvestidoGeral = 0;
        let totalLucroGeral = 0;
        const itens = []; // usado para alimentar os insights com dados REAIS, não o DOM

        if (snap.empty) {
            corpo.innerHTML = "<tr><td colspan='10' style='text-align:center'>Nenhum item cadastrado.</td></tr>";
            atualizarInsightsEstoque([]);
            verificarAlertasEstoque([]);
            return;
        }
        snap.forEach(doc => {
            const item = doc.data();
            const id = doc.id;
            const qtd = garantirNumero(item.quantidade);
            const custo = garantirNumero(item.custoUnitario);
            const ind = calcularIndicadoresItem(item);

            itens.push({ id, ...item }); // id incluído p/ deduplicar notificações
            totalInvestidoGeral += ind.valorInvestido;
            totalLucroGeral += ind.lucroEstimado;

            corpo.innerHTML += `<tr>
                <td>${escapeHTML(item.nome)}</td>
                <td>${escapeHTML(item.unidade)}</td>
                <td>${qtd.toFixed(2)}</td>
                <td style="color:${ind.cor}">${ind.status}</td>
                <td>R$ ${custo.toFixed(2)}</td>
                <td>R$ ${garantirNumero(item.precoVenda || 0).toFixed(2)}</td>
                <td>R$ ${ind.valorInvestido.toFixed(2)}</td>
                <td>R$ ${ind.lucroEstimado.toFixed(2)}</td>
                <td>${ind.margem}%</td>
                <td><button onclick="editarItem('${id}')">Editar</button></td>
            </tr>`;
        });

        if (totalDiv) {
            totalDiv.innerHTML = `
            <div style="display:flex; gap:20px; padding:15px; background:#1f2937; border-radius:8px; margin-bottom:15px;">
                <div><strong>Total Investido:</strong> R$ ${totalInvestidoGeral.toFixed(2)}</div>
                <div><strong>Lucro Estimado Total:</strong> R$ ${totalLucroGeral.toFixed(2)}</div>
            </div>`;
        }

        atualizarInsightsEstoque(itens);
        verificarAlertasEstoque(itens);
    } catch (e) { corpo.innerHTML = `<tr><td colspan='10' style='color:red'>Erro: ${e.message}</td></tr>`; }
}

async function carregarMovimentacoes() {
    const corpo = document.querySelector("#tabela-mov tbody");
    if (!corpo) return;
    const q = query(collection(db, "movimentacoes"), orderBy("data", "desc"));
    onSnapshot(q, (snap) => {
        corpo.innerHTML = "";
        if (snap.empty) { corpo.innerHTML = "<tr><td colspan='5' style='text-align:center'>Nenhuma movimentação.</td></tr>"; return; }
        snap.forEach(doc => {
            const mov = doc.data();
            const data = mov.data ? new Date(mov.data.toDate()).toLocaleString('pt-BR') : "-";
            const tipoTexto = { entrada: "✅ Entrada", saida: "❌ Saída", ajuste: "🔧 Ajuste" }[garantirTexto(mov.tipo)] || mov.tipo;
            corpo.innerHTML += `<tr><td>${data}</td><td>${escapeHTML(mov.nomeItem)}</td><td>${tipoTexto}</td><td>${garantirNumero(mov.quantidade).toFixed(2)}</td><td>${escapeHTML(mov.observacao)}</td></tr>`;
        });
    });
}

async function preencherSelectItens() {
    const select = document.getElementById("select-item");
    if (!select) return;
    select.innerHTML = "<option value=''>Selecione...</option>";
    const snap = await getDocs(collection(db, "estoque"));
    snap.forEach(doc => {
        const item = doc.data();
        select.innerHTML += `<option value="${doc.id}">${escapeHTML(item.nome)}</option>`;
    });
}

function limparFormularioItem() {
    ["nome-item", "unidade-item", "qtd-item", "custo-item", "preco-venda-item", "nivel-minimo", "nivel-ideal"].forEach(id => {
        const campo = document.getElementById(id);
        if (campo) campo.value = "";
    });
}

function limparFormularioMov() {
    ["select-item", "tipo-mov", "qtd-mov", "obs-mov"].forEach(id => document.getElementById(id).value = "");
}

function editarItem(id) { alert("Use a movimentação para ajustar quantidades!"); }
window.editarItem = editarItem;
// Recebe os itens JÁ carregados do Firestore (vindos de carregarEstoque),
// em vez de "adivinhar" os valores lendo o texto da tabela na tela.
// Antes: se o nome do item no cadastro não fosse EXATAMENTE "Açaí",
// "Copo 400ml" etc., a função caía silenciosamente em valores fixos
// (10, 4, 5, 4) e mostrava números errados sem nenhum aviso.
function atualizarInsightsEstoque(itens) {
    // Preço de venda e margem média por copo — ainda não vêm do cadastro de
    // estoque (que guarda insumos, não os produtos finais). Se um dia você
    // cadastrar os produtos (copo 400/500ml) com preço de venda próprio,
    // dá pra puxar esses dois valores de lá em vez de fixos aqui.
    const PRECO_400 = 18.90;
    const PRECO_500 = 22.90;
    const LUCRO_MEDIO = 0.48;

    // Usa os MESMOS valores de consumo já definidos no topo do arquivo
    // (antes havia dois números diferentes de consumo de açaí no mesmo
    // arquivo: 0.28/0.32 aqui em cima e 0.30/0.35 só dentro desta função).
    const CONSUMO_400 = CONSUMO["400ml"].acai;
    const CONSUMO_500 = CONSUMO["500ml"].acai;

    const buscarQtd = (nomeAlvo) => {
        const alvoNorm = normalizarNome(nomeAlvo);
        const item = itens.find(it => {
            const nomeNorm = normalizarNome(it.nome || "");
            return nomeNorm === alvoNorm || nomeNorm.includes(alvoNorm) || alvoNorm.includes(nomeNorm);
        });
        return item ? garantirNumero(item.quantidade) : 0;
    };

    const acai = buscarQtd("Açaí");
    const copos400 = buscarQtd("Copo 400ml");
    const copos500 = buscarQtd("Copo 500ml");
    const tampas = buscarQtd("Tampa");

    // CAPACIDADE DE CADA RECURSO, DE FORMA INDEPENDENTE
    const capacidadeAcai = Math.floor(acai / ((CONSUMO_400 + CONSUMO_500) / 2)); // estimativa com consumo médio
    const capacidadeCopos = copos400 + copos500;
    const capacidadeTampas = tampas;

    // O TOTAL DE COPOS POSSÍVEIS É LIMITADO PELO MENOR DOS TRÊS RECURSOS
    const totalPossivel = Math.min(capacidadeAcai, capacidadeCopos, capacidadeTampas);

    // DISTRIBUI O TOTAL ENTRE 400ML E 500ML RESPEITANDO O ESTOQUE DE CADA COPO
    let max400 = Math.min(copos400, Math.floor(acai / CONSUMO_400), totalPossivel);
    let max500 = Math.min(copos500, totalPossivel - max400);
    // nunca deixa nenhum dos dois ficar negativo
    max400 = Math.max(0, max400);
    max500 = Math.max(0, max500);

    // ITEM LIMITANTE = o recurso com a MENOR capacidade (causa real do gargalo)
    const capacidades = { "Açaí": capacidadeAcai, "Copos": capacidadeCopos, "Tampas": capacidadeTampas };
    const limitante = Object.keys(capacidades).reduce((a, b) => capacidades[a] <= capacidades[b] ? a : b);

    // VALORES FINAIS
    const faturamento = (max400 * PRECO_400) + (max500 * PRECO_500);
    const lucro = faturamento * LUCRO_MEDIO;
    const dias = Math.floor(totalPossivel / 25);

    // ATUALIZA NA TELA
    const el = (id) => document.getElementById(id);
    if (el("max-copos-400")) el("max-copos-400").textContent = max400;
    if (el("max-copos-500")) el("max-copos-500").textContent = max500;
    if (el("dias-disponiveis")) el("dias-disponiveis").textContent = `${dias} dias`;
    if (el("faturamento-max")) el("faturamento-max").textContent = `R$ ${faturamento.toFixed(2)}`;
    if (el("lucro-real")) el("lucro-real").textContent = `R$ ${lucro.toFixed(2)}`;
    if (el("item-limitante")) el("item-limitante").textContent = limitante;
}
// --------------------------
// GERA LISTA DE COMPRA AUTOMÁTICA
// --------------------------
function gerarListaCompra() {
    const corpoLista = document.getElementById("lista-compra-corpo");
    if (!corpoLista) return;
    corpoLista.innerHTML = "";
    let totalGeral = 0;
    const itensUnicos = new Map(); // Evita repetição

    // Regras de estoque ideal para 1 semana
    const regras = {
        "Açaí": { min: 5, ideal: 10, custo: 16.60 },
        "Copo 400ml": { min: 10, ideal: 30, custo: 0.58 },
        "Copo 500ml": { min: 10, ideal: 30, custo: 0.63 },
        "Tampa": { min: 10, ideal: 30, custo: 0.53 },
        "Colher": { min: 15, ideal: 50, custo: 0.30 },
        "Porta-copo 1 copo": { min: 10, ideal: 25, custo: 0.50 },
        "Porta-copo 2+ copos": { min: 5, ideal: 15, custo: 1.00 },
        "Guardanapo": { min: 50, ideal: 150, custo: 0.10 },
        "Sacola 1 copo": { min: 15, ideal: 30, custo: 0.50 },
        "Sacola 2+ copos": { min: 15, ideal: 30, custo: 0.73 },
        "Nutella": { min: 0.5, ideal: 1.5, custo: 76.91 }
    };

    // LÊ CADA LINHA DA TABELA UMA VEZ SÓ
    document.querySelectorAll("table tr").forEach(linha => {
        const celulas = linha.querySelectorAll("td");
        if (celulas.length < 5) return;

        const nome = celulas[0].textContent.trim();
        if (!regras[nome] || itensUnicos.has(nome)) return;

        const qtdAtual = Number(celulas[2].textContent.replace(",", ".").trim() || 0);
        const { min, ideal, custo } = regras[nome];

        if (qtdAtual < ideal) {
            const falta = Math.round((ideal - qtdAtual) * 100) / 100;
            const valor = Math.round(falta * custo * 100) / 100;
            totalGeral += valor;

            let prioridade = "🟢 Baixa";
            if (qtdAtual <= min) prioridade = "🔴 URGENTE";
            else if (qtdAtual <= min * 1.5) prioridade = "🟡 Média";

            itensUnicos.set(nome, { prioridade, nome, falta, custo, valor });
        }
    });

    // Converte para lista e ordena
    const listaFinal = Array.from(itensUnicos.values());
    const ordem = { "🔴 URGENTE": 1, "🟡 Média": 2, "🟢 Baixa": 3 };
    listaFinal.sort((a, b) => ordem[a.prioridade] - ordem[b.prioridade]);

    // Monta a tela
    if (listaFinal.length === 0) {
        corpoLista.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px;">✅ Nenhum item precisa ser comprado no momento!</td></tr>`;
    } else {
        listaFinal.forEach(item => {
            corpoLista.innerHTML += `
                <tr>
                    <td>${item.prioridade}</td>
                    <td><strong>${item.nome}</strong></td>
                    <td>${item.falta}</td>
                    <td>R$ ${item.custo.toFixed(2)}</td>
                    <td>R$ ${item.valor.toFixed(2)}</td>
                </tr>
            `;
        });
        corpoLista.innerHTML += `
            <tr style="font-weight:bold; background:#1f2937;">
                <td colspan="4" style="text-align:right;">TOTAL GERAL:</td>
                <td style="color:var(--primary);">R$ ${totalGeral.toFixed(2)}</td>
            </tr>
        `;
    }
}

// Atualiza automaticamente
window.addEventListener("load", () => setTimeout(gerarListaCompra, 800));
document.addEventListener("click", e => {
    if (e.target.textContent.trim() === "Salvar Item") setTimeout(gerarListaCompra, 600);
});
// --------------------------
// INICIALIZAÇÃO
// --------------------------
document.addEventListener("DOMContentLoaded", () => {
    carregarEstoque();
    carregarMovimentacoes();
    preencherSelectItens();
    gerarPrevisaoEstoque();
    document.getElementById("btn-salvar-item")?.addEventListener("click", salvarItem);
    document.getElementById("btn-movimentar")?.addEventListener("click", registrarMovimentacao);
    monitorarPedidosConcluidos();
});
