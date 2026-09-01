import { db } from "./firebase.js";
import {
    collection, addDoc, getDocs, getDoc, updateDoc, deleteDoc, doc, setDoc, onSnapshot, query, where, runTransaction, orderBy, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
// Baixa de estoque mora em um módulo compartilhado (estoqueBaixa.js), porque a
// cozinha (cozinha.js) também precisa chamar essa mesma lógica. Aqui ficamos
// como rede de segurança (baixa) e também importamos o estorno pra poder
// devolver estoque manualmente se precisar.
import { construirMapaEstoque, processarPedidoSeguro, estornarPedidoSeguro, calcularNecessidades } from "./estoqueBaixa.js";
// 🆕 Funções auxiliares compartilhadas com estoqueBaixa.js (evita duplicação).
import { t, n, norm, esc, pegarCampo } from "./utils.js";

// ==============================================
// Marca pedidos que JÁ existiam antes de abrirmos esta tela como processados,
// sem descontar nada — evita dar baixa retroativa em todo o histórico de vendas.
// ==============================================
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

// ==============================================
// 🆕 TAXA DE CONSUMO DIÁRIO POR INSUMO
// ==============================================
// Reusa calcularNecessidades (mesma função da baixa automática) sobre os
// pedidos dos últimos 30 dias, agregando por insumo, pra saber quanto cada
// insumo é consumido por dia em média. Usado tanto pra "Dias Restantes" na
// tabela de estoque quanto pra sugerir quantidade de compra considerando o
// prazo de entrega do fornecedor.
let mapaConsumoDiario = new Map(); // chave normalizada -> qtd média/dia

async function calcularConsumoDiario() {
    const dt = new Date(Date.now() - 2592000000); // 30 dias
    const s = await getDocs(query(
        collection(db, "pedidos"),
        where("status", "in", ["concluido", "finalizado", "pronto"]),
        where("criadoEm", ">=", dt.getTime())
    ));
    const totais = new Map();
    const diasComVenda = new Set();
    s.forEach(d => {
        const pedido = d.data();
        diasComVenda.add(new Date(pedido.criadoEm).toISOString().slice(0, 10));
        calcularNecessidades(pedido.itens || []).forEach((v, chave) => {
            totais.set(chave, (totais.get(chave) || 0) + v.qtd);
        });
    });
    const dias = Math.max(diasComVenda.size, 1);
    mapaConsumoDiario = new Map([...totais.entries()].map(([chave, total]) => [chave, total / dias]));
}

// Quantos dias o estoque atual de um insumo ainda dura, no ritmo de consumo
// recente. Retorna null quando não há dados suficientes (insumo sem venda
// nos últimos 30 dias — nesse caso a coluna mostra "—").
function diasRestantes(item) {
    const taxa = mapaConsumoDiario.get(norm(item.nome));
    if (!taxa || taxa <= 0) return null;
    const qtd = pegarCampo(item, ["quantidade", "qtd", "quant"]);
    return Math.floor(qtd / taxa);
}

// 🆕 Insumo "parado": sem nenhuma movimentação (compra/uso/ajuste) há muitos
// dias — pode ser sobra encalhada ou item cadastrado errado que nunca é
// realmente usado.
const DIAS_PARADO_LIMITE = 20;
function diasSemMovimento(item) {
    if (!item.atualizadoEm) return null;
    const data = item.atualizadoEm.toDate ? item.atualizadoEm.toDate() : new Date(item.atualizadoEm);
    if (isNaN(data.getTime())) return null;
    return Math.floor((Date.now() - data.getTime()) / 86400000);
}

// 🆕 Alerta de aumento de preço: compara as duas últimas compras registradas
// no histórico de preço do insumo — se subiu 15% ou mais, é um bom sinal pra
// renegociar ou procurar outro fornecedor.
function variacaoPrecoAlta(item) {
    const h = Array.isArray(item.historicoPrecos) ? item.historicoPrecos : [];
    if (h.length < 2) return null;
    const atual = Number(h[h.length - 1].valor);
    const anterior = Number(h[h.length - 2].valor);
    if (!anterior || !atual) return null;
    const variacao = ((atual - anterior) / anterior) * 100;
    return variacao >= 15 ? Math.round(variacao) : null;
}

let ultimosItensEstoque = [];

// 🆕 Estado da busca/ordenação da tabela de Estoque Atual (aplicados sobre
// ultimosItensEstoque toda vez que a tabela é re-renderizada).
let filtroBusca = "";
let ordenacao = { campo: null, dir: 1 };

function aplicarFiltroOrdenacao(itens) {
    let filtrados = itens;
    if (filtroBusca) {
        const termo = norm(filtroBusca);
        filtrados = filtrados.filter(i => norm(i.nome || "").includes(termo));
    }
    if (ordenacao.campo) {
        filtrados = [...filtrados].sort((a, b) => {
            let va, vb;
            if (ordenacao.campo === "nome") { va = norm(a.nome || ""); vb = norm(b.nome || ""); }
            else if (ordenacao.campo === "qtd") { va = pegarCampo(a, ["quantidade", "qtd", "quant"]); vb = pegarCampo(b, ["quantidade", "qtd", "quant"]); }
            else if (ordenacao.campo === "validade") { va = a.validade || "9999-99-99"; vb = b.validade || "9999-99-99"; }
            else if (ordenacao.campo === "dias") { va = diasRestantes(a) ?? 999999; vb = diasRestantes(b) ?? 999999; }
            else return 0;
            if (va < vb) return -1 * ordenacao.dir;
            if (va > vb) return 1 * ordenacao.dir;
            return 0;
        });
    }
    return filtrados;
}

function renderizarTabelaEstoque() {
    tabela(aplicarFiltroOrdenacao(ultimosItensEstoque));
}

document.getElementById("busca-estoque")?.addEventListener("input", e => {
    filtroBusca = e.target.value;
    renderizarTabelaEstoque();
});

document.querySelectorAll("#tab-estoque th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
        const campo = th.dataset.sort;
        if (ordenacao.campo === campo) ordenacao.dir *= -1;
        else { ordenacao.campo = campo; ordenacao.dir = 1; }
        renderizarTabelaEstoque();
    });
});

async function atualizarTudo() {
    const s = await getDocs(collection(db, "estoque"));
    const itens = [];
    s.forEach(d => itens.push({ id: d.id, ...d.data() }));
    ultimosItensEstoque = itens;

    await calcularConsumoDiario();

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

    alertas(itens);
    listaCompra(itens);
    renderizarTabelaEstoque();
    popularSelectGraficoInsumo();
    renderPerdasDoMes();
}

// 🆕 Agora também avisa sobre itens vencidos/vencendo em breve (campo "validade").
function diasParaVencer(validade) {
    if (!validade) return null;
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const dataVal = new Date(validade + "T00:00:00");
    if (isNaN(dataVal.getTime())) return null;
    return Math.round((dataVal - hoje) / 86400000);
}

function alertas(itens) {
    const div = document.getElementById("alertas-estoque");
    const cri = itens.filter(i => pegarCampo(i, ["quantidade", "qtd", "quant"]) <= pegarCampo(i, ["nivelMinimo", "minimo", "estoqueMinimo"]) / 2);
    const bai = itens.filter(i => {
        const q = pegarCampo(i, ["quantidade", "qtd", "quant"]);
        const m = pegarCampo(i, ["nivelMinimo", "minimo", "estoqueMinimo"]);
        return q > m / 2 && q <= m;
    });

    const vencidos = [];
    const vencendo = [];
    itens.forEach(i => {
        const dias = diasParaVencer(i.validade);
        if (dias === null) return;
        if (dias < 0) vencidos.push(i.nome);
        else if (dias <= 7) vencendo.push(`${i.nome} (${dias}d)`);
    });

    div.innerHTML = "";
    if (cri.length || bai.length || vencidos.length || vencendo.length) {
        div.innerHTML = `<div class="card alerta"><h3><i class="fas fa-exclamation-triangle"></i> Atenção!</h3>
            ${cri.length ? `<p style="color:var(--red);font-weight:bold;">URGENTE: ${cri.map(i => esc(i.nome)).join(", ")}</p>` : ""}
            ${bai.length ? `<p style="color:var(--yellow);">Fique de olho: ${bai.map(i => esc(i.nome)).join(", ")}</p>` : ""}
            ${vencidos.length ? `<p style="color:var(--red);font-weight:bold;">🗓️ VENCIDO: ${vencidos.map(esc).join(", ")}</p>` : ""}
            ${vencendo.length ? `<p style="color:var(--yellow);">🗓️ Vencendo em breve: ${vencendo.map(esc).join(", ")}</p>` : ""}
        </div>`;
    }
}

// Valores padrão usados SÓ como fallback pra itens antigos que não têm
// nivelMinimo/nivelIdeal/custoUnitario preenchidos no cadastro.
const DEFAULTS_INSUMOS = {
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
    "Disquete/Confete": { min: 0.2, ideal: 0.5, cu: 0.03 },
    "Morango": { min: 0.5, ideal: 1.5, cu: 18.00 },
    "Granola": { min: 0.5, ideal: 1.5, cu: 12.00 },
    "Leite em pó": { min: 0.3, ideal: 1, cu: 25.00 },
    "Leite condensado": { min: 0.5, ideal: 1.5, cu: 8.00 },
    "Paçoca": { min: 0.3, ideal: 1, cu: 15.00 },
    "Banana": { min: 0.5, ideal: 2, cu: 4.00 }
};

// 🆕 Antes essa lista só considerava os insumos hardcoded no objeto "reg" e
// usava preços/min/ideal fixos no código — se você mudasse o preço de compra
// do Açaí, a lista continuava mostrando o valor antigo, e um insumo novo que
// você cadastrasse (sem estar nesse objeto) nunca aparecia aqui, mesmo
// abaixo do mínimo. Agora percorremos os itens REAIS do estoque e usamos os
// valores salvos no próprio cadastro (nivelMinimo/nivelIdeal/custoUnitario),
// caindo no padrão só quando o item não tiver esses campos preenchidos.
function listaCompra(itens) {
    const corpo = document.getElementById("lista-compra");
    const comp = [];

    itens.forEach(item => {
        const chaveDefault = Object.keys(DEFAULTS_INSUMOS).find(k => norm(k) === norm(item.nome));
        const fallback = chaveDefault ? DEFAULTS_INSUMOS[chaveDefault] : { min: 0, ideal: 0, cu: 0 };

        const qtdAtual = pegarCampo(item, ["quantidade", "qtd", "quant"]);
        const min = pegarCampo(item, ["nivelMinimo", "minimo", "estoqueMinimo"]) || fallback.min;
        const ideal = pegarCampo(item, ["nivelIdeal"]) || fallback.ideal;
        const custo = pegarCampo(item, ["custoUnitario", "custo", "valor"]) || fallback.cu;

        if (!ideal || qtdAtual >= ideal) return;

        const faltaAteIdeal = Number((ideal - qtdAtual).toFixed(2));

        // 🆕 Sugestão de compra considerando o consumo real recente + o prazo de
        // entrega do fornecedor: compra o suficiente pra cobrir o tempo de
        // entrega + 3 dias de margem de segurança, ou até o ideal — o que for maior.
        const taxaDia = mapaConsumoDiario.get(norm(item.nome)) || 0;
        const leadTime = Number(pegarCampo(item, ["leadTimeDias"])) || 2;
        const coberturaAlvo = taxaDia * (leadTime + 3);
        const qtdSugerida = Math.max(faltaAteIdeal, Number((coberturaAlvo - qtdAtual).toFixed(2)));

        const prioridade = qtdAtual <= min ? "🔴 URGENTE" : qtdAtual <= min * 1.5 ? "🟡 Média" : "🟢 Baixa";
        comp.push({
            id: item.id,
            p: prioridade,
            n: item.nome,
            q: Number(qtdSugerida.toFixed(2)),
            cu: custo,
            t: Number((qtdSugerida * custo).toFixed(2)),
            pedidoFeito: !!item.pedidoFeito,
            fornecedorNome: item.fornecedorNome || "",
            fornecedorTelefone: (item.fornecedorTelefone || "").replace(/\D/g, "")
        });
    });

    // Não pedidos primeiro (por prioridade); já pedidos vão pro fim, meio apagados.
    comp.sort((a, b) => {
        if (a.pedidoFeito !== b.pedidoFeito) return a.pedidoFeito ? 1 : -1;
        return a.p.localeCompare(b.p);
    });

    corpo.innerHTML = comp.length
        ? comp.map(x => `<tr style="${x.pedidoFeito ? "opacity:.5;" : ""}">
            <td>${x.p}</td>
            <td>${esc(x.n)}</td>
            <td>${x.q}</td>
            <td>R$ ${x.cu.toFixed(2)}</td>
            <td>R$ ${x.t.toFixed(2)}</td>
            <td>${x.fornecedorNome
                ? (x.fornecedorTelefone
                    ? `<a href="https://wa.me/55${x.fornecedorTelefone}" target="_blank" rel="noopener" style="color:var(--green);">📱 ${esc(x.fornecedorNome)}</a>`
                    : esc(x.fornecedorNome))
                : "—"}</td>
            <td style="text-align:center;"><input type="checkbox" class="chk-pedido" data-id="${x.id}" ${x.pedidoFeito ? "checked" : ""}></td>
        </tr>`).join("")
        : `<tr><td colspan="7">✅ Tudo em dia!</td></tr>`;

    corpo.querySelectorAll(".chk-pedido").forEach(chk => {
        chk.addEventListener("change", async () => {
            const marcado = chk.checked;
            try {
                await updateDoc(doc(db, "estoque", chk.dataset.id), { pedidoFeito: marcado });
                const item = ultimosItensEstoque.find(i => i.id === chk.dataset.id);
                if (item) item.pedidoFeito = marcado;
            } catch (e) {
                console.error("Erro ao marcar 'já pedi'", e);
                chk.checked = !marcado;
            }
        });
    });
}

// 🆕 Manda a lista de compras (dos itens ainda NÃO marcados como "já pedi")
// pronta pro WhatsApp — pra você mesmo ou direto pro fornecedor.
window.enviarListaWhatsApp = () => {
    const linhas = Array.from(document.querySelectorAll("#lista-compra tr"))
        .filter(tr => !tr.querySelector(".chk-pedido")?.checked)
        .map(tr => {
            const tds = tr.querySelectorAll("td");
            if (tds.length < 5) return null;
            return `• ${tds[1].textContent.trim()}: ${tds[2].textContent.trim()} (R$ ${tds[4].textContent.replace("R$", "").trim()})`;
        }).filter(Boolean);
    if (!linhas.length) return alert("Nada pra comprar agora — lista vazia ou tudo já pedido!");
    const texto = `🛒 Lista de compras — Nova Origem Açaí\n\n${linhas.join("\n")}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(texto)}`, "_blank");
};

// 🆕 Modo Compra Rápida: checklist grande e simples pra usar no celular
// enquanto está fazendo a compra — mesmo checkbox "já pedi" da lista normal,
// sincronizado nos dois lugares.
window.abrirModoCompraRapida = () => {
    const container = document.getElementById("compra-rapida-lista");
    const linhas = Array.from(document.querySelectorAll("#lista-compra tr")).filter(tr => tr.querySelector(".chk-pedido"));

    container.innerHTML = linhas.length ? linhas.map(tr => {
        const tds = tr.querySelectorAll("td");
        const chkOrigem = tr.querySelector(".chk-pedido");
        const nome = tds[1].textContent.trim();
        const qtd = tds[2].textContent.trim();
        return `<label style="display:flex; align-items:center; gap:12px; padding:14px; background:var(--surface-2); border-radius:var(--radius-sm); font-size:1rem; ${chkOrigem.checked ? "opacity:.5;" : ""}">
            <input type="checkbox" class="chk-rapida" data-id="${chkOrigem.dataset.id}" ${chkOrigem.checked ? "checked" : ""} style="width:22px; height:22px;">
            <span><strong>${esc(nome)}</strong><br><span style="color:var(--muted); font-size:.85rem;">Comprar: ${qtd}</span></span>
        </label>`;
    }).join("") : `<p style="color:var(--muted);">✅ Nada pendente pra comprar agora!</p>`;

    container.querySelectorAll(".chk-rapida").forEach(chk => {
        chk.addEventListener("change", async () => {
            const marcado = chk.checked;
            try {
                await updateDoc(doc(db, "estoque", chk.dataset.id), { pedidoFeito: marcado });
                const item = ultimosItensEstoque.find(i => i.id === chk.dataset.id);
                if (item) item.pedidoFeito = marcado;
                chk.closest("label").style.opacity = marcado ? ".5" : "1";
                const original = document.querySelector(`.chk-pedido[data-id="${chk.dataset.id}"]`);
                if (original) original.checked = marcado;
            } catch (e) {
                console.error("Erro ao marcar 'já pedi'", e);
                chk.checked = !marcado;
            }
        });
    });

    document.getElementById("modal-compra-rapida").style.display = "flex";
};

document.getElementById("compra-rapida-fechar")?.addEventListener("click", () => {
    document.getElementById("modal-compra-rapida").style.display = "none";
});

window.copiarLista = () => {
    const txt = Array.from(document.querySelectorAll("#lista-compra tr")).map(r => r.textContent.trim()).join("\n");
    navigator.clipboard.writeText(txt).then(() => alert("✅ Lista copiada!"));
};

// 🆕 Tabela agora mostra validade (se cadastrada), histórico de preço (colapsável),
// dias restantes de estoque (baseado no consumo real), badges de "parado" e
// "preço subiu", e uma coluna de Ações com Editar/Excluir.
function tabela(itens) {
    document.getElementById("tab-estoque-body").innerHTML = itens.map(i => {
        const q = pegarCampo(i, ["quantidade", "qtd", "quant"]);
        const m = pegarCampo(i, ["nivelMinimo", "minimo", "estoqueMinimo"]);
        const cu = pegarCampo(i, ["custoUnitario", "custo", "valor"]);
        const st = q <= m / 2 ? "🚨 Crítico" : q <= m ? "⚠️ Baixo" : "✅ Normal";
        const cor = q <= m / 2 ? "var(--red)" : q <= m ? "var(--yellow)" : "var(--green)";

        const dias = diasParaVencer(i.validade);
        let validadeTxt = "—";
        if (dias !== null) {
            if (dias < 0) validadeTxt = `<span style="color:var(--red);">Vencido</span>`;
            else if (dias <= 7) validadeTxt = `<span style="color:var(--yellow);">${dias}d</span>`;
            else validadeTxt = new Date(i.validade + "T00:00:00").toLocaleDateString("pt-BR");
        }

        const restantes = diasRestantes(i);
        const diasRestTxt = restantes === null ? "—"
            : restantes <= 3 ? `<span style="color:var(--red); font-weight:700;">${restantes}d</span>`
            : restantes <= 7 ? `<span style="color:var(--yellow); font-weight:700;">${restantes}d</span>`
            : `${restantes}d`;

        const parado = diasSemMovimento(i);
        const badgeParado = (parado !== null && parado >= DIAS_PARADO_LIMITE && q > 0)
            ? ` <span title="Sem movimentação há ${parado} dias" style="font-size:.68rem; color:var(--muted); background:var(--surface-3); padding:2px 6px; border-radius:6px; white-space:nowrap;">🐌 parado ${parado}d</span>`
            : "";

        const altaPreco = variacaoPrecoAlta(i);
        const badgePreco = altaPreco
            ? ` <span title="Preço subiu ${altaPreco}% na última compra" style="font-size:.68rem; color:var(--yellow); background:var(--yellow-soft); padding:2px 6px; border-radius:6px; white-space:nowrap;">📈 +${altaPreco}%</span>`
            : "";

        const historico = Array.isArray(i.historicoPrecos) ? i.historicoPrecos : [];
        const historicoHtml = historico.length
            ? `<details style="margin-top:4px;"><summary style="cursor:pointer; color:var(--primary); font-size:0.75rem;">Histórico de preço (${historico.length})</summary>
                ${historico.slice(-10).reverse().map(h => `<div style="font-size:0.72rem; color:var(--muted);">${h.data ? new Date(h.data.toDate ? h.data.toDate() : h.data).toLocaleDateString("pt-BR") : "-"}: R$ ${Number(h.valor).toFixed(2)}</div>`).join("")}
               </details>`
            : "";

        return `<tr>
            <td>${esc(i.nome)}${badgeParado}${badgePreco}${historicoHtml}</td>
            <td>${q.toFixed(2)}</td>
            <td style="color:${cor}">${st}</td>
            <td>R$ ${cu.toFixed(2)}</td>
            <td>R$ ${(q * cu).toFixed(2)}</td>
            <td>${diasRestTxt}</td>
            <td>${validadeTxt}</td>
            <td style="white-space:nowrap;">
                <button data-id="${i.id}" class="btn-editar-item" style="padding:6px 10px; font-size:0.75rem;">✏️</button>
                <button data-id="${i.id}" class="btn-excluir-item" style="padding:6px 10px; font-size:0.75rem; background:var(--red);">🗑️</button>
            </td>
        </tr>`;
    }).join("");

    document.querySelectorAll(".btn-editar-item").forEach(btn => {
        btn.addEventListener("click", () => abrirModalEdicao(btn.dataset.id));
    });
    document.querySelectorAll(".btn-excluir-item").forEach(btn => {
        btn.addEventListener("click", () => excluirItem(btn.dataset.id));
    });
}

// ==============================================
// 🆕 EDITAR / EXCLUIR ITEM
// ==============================================
function abrirModalEdicao(id) {
    const item = ultimosItensEstoque.find(i => i.id === id);
    if (!item) return alert("Item não encontrado. Atualize a página.");

    document.getElementById("edit-id").value = id;
    document.getElementById("edit-nome").value = item.nome || "";
    document.getElementById("edit-unidade").value = item.unidade || "kg";
    document.getElementById("edit-custo").value = pegarCampo(item, ["custoUnitario", "custo", "valor"]) || "";
    document.getElementById("edit-min").value = pegarCampo(item, ["nivelMinimo", "minimo", "estoqueMinimo"]) || "";
    document.getElementById("edit-ideal").value = pegarCampo(item, ["nivelIdeal"]) || "";
    document.getElementById("edit-validade").value = item.validade || "";
    document.getElementById("edit-fornecedor").value = item.fornecedorNome || "";
    document.getElementById("edit-fornecedor-tel").value = item.fornecedorTelefone || "";
    document.getElementById("edit-leadtime").value = item.leadTimeDias || "";
    document.getElementById("modal-editar-item").style.display = "flex";
}

function fecharModalEdicao() {
    document.getElementById("modal-editar-item").style.display = "none";
}

async function salvarEdicaoItem() {
    const id = document.getElementById("edit-id").value;
    if (!id) return;
    const dados = {
        nome: t(document.getElementById("edit-nome").value),
        unidade: t(document.getElementById("edit-unidade").value),
        custoUnitario: n(document.getElementById("edit-custo").value),
        nivelMinimo: n(document.getElementById("edit-min").value, 0),
        nivelIdeal: n(document.getElementById("edit-ideal").value, 0),
        validade: t(document.getElementById("edit-validade").value) || null,
        fornecedorNome: t(document.getElementById("edit-fornecedor").value) || null,
        fornecedorTelefone: t(document.getElementById("edit-fornecedor-tel").value).replace(/\D/g, "") || null,
        leadTimeDias: n(document.getElementById("edit-leadtime").value, 2),
        atualizadoEm: new Date()
    };
    if (!dados.nome) return alert("Nome não pode ficar vazio!");
    try {
        await updateDoc(doc(db, "estoque", id), dados);
        fecharModalEdicao();
        alert("✅ Item atualizado!");
        atualizarTudo();
        carregarSel();
    } catch (e) {
        console.error(e);
        alert("❌ Não foi possível salvar as alterações.");
    }
}

async function excluirItem(id) {
    const item = ultimosItensEstoque.find(i => i.id === id);
    if (!confirm(`Excluir "${item?.nome || "este item"}" do cadastro? Isso NÃO pode ser desfeito.\n\n⚠️ Se esse insumo faz parte da receita de algum produto (estoqueBaixa.js), a baixa automática vai parar de encontrá-lo.`)) return;
    try {
        await deleteDoc(doc(db, "estoque", id));
        atualizarTudo();
        carregarSel();
    } catch (e) {
        console.error(e);
        alert("❌ Não foi possível excluir o item.");
    }
}

// ==============================================
// AÇÕES E INICIALIZAÇÃO
// ==============================================

// 🆕 Cadastro de item novo agora é atômico (item + gasto + caixa/contas a pagar
// na MESMA transação) — antes eram addDoc separados, então uma queda de
// internet no meio podia deixar o item cadastrado sem o gasto lançado (ou
// vice-versa). Segue o mesmo padrão que já era usado na Movimentação.
document.getElementById("btn-salvar").addEventListener("click", async () => {
    const dados = {
        nome: t(document.getElementById("nome-item").value),
        unidade: t(document.getElementById("unidade-item").value),
        quantidade: n(document.getElementById("qtd-item").value),
        custoUnitario: n(document.getElementById("custo-item").value),
        nivelMinimo: n(document.getElementById("min-item").value, 0),
        nivelIdeal: n(document.getElementById("ideal-item").value, 0),
        validade: t(document.getElementById("validade-item")?.value || "") || null,
        fornecedorNome: t(document.getElementById("fornecedor-item")?.value || "") || null,
        fornecedorTelefone: t(document.getElementById("fornecedor-tel-item")?.value || "").replace(/\D/g, "") || null,
        leadTimeDias: n(document.getElementById("leadtime-item")?.value, 2),
        pedidoFeito: false,
        atualizadoEm: new Date()
    };
    const lancarGasto = document.getElementById("lancar-gasto-item").checked;
    const formaPagamento = document.getElementById("forma-pagamento-item").value;
    if (!dados.nome || dados.quantidade <= 0) return alert("Preencha tudo!");

    try {
        const s = await getDocs(collection(db, "estoque"));
        if (s.docs.some(x => norm(x.data().nome) === norm(dados.nome))) return alert("Item já existe! Use Movimentação.");

        const valorCompra = lancarGasto ? Number((dados.quantidade * dados.custoUnitario).toFixed(2)) : 0;
        // 🆕 "pessoal" também não mexe no caixa da empresa — vira empréstimo, igual "aprazo" não vira caixa na hora.
        const precisaCaixa = lancarGasto && valorCompra > 0 && formaPagamento !== "aprazo" && formaPagamento !== "pessoal";

        const novoItemRef = doc(collection(db, "estoque"));
        const gastoRef = lancarGasto && valorCompra > 0 ? doc(collection(db, "gastos")) : null;
        const contaPagarRef = lancarGasto && valorCompra > 0 && formaPagamento === "aprazo" ? doc(collection(db, "contas_pagar")) : null;
        // 🆕 Comprado com dinheiro pessoal do dono → gera um empréstimo automático,
        // igual ao que já acontece em financeiro.js quando um gasto é pago como "pessoal".
        const emprestimoRef = lancarGasto && valorCompra > 0 && formaPagamento === "pessoal" ? doc(collection(db, "emprestimos")) : null;
        const caixaRef = doc(db, "configuracoes", "caixa_empresa");

        await runTransaction(db, async tx => {
            // 1) Leituras primeiro (regra do Firestore)
            const caixaSnap = precisaCaixa ? await tx.get(caixaRef) : null;

            // 2) Escritas
            tx.set(novoItemRef, {
                ...dados,
                historicoPrecos: dados.custoUnitario > 0 ? [{ data: new Date(), valor: dados.custoUnitario }] : []
            });

            if (gastoRef) {
                tx.set(gastoRef, {
                    descricao: `Compra: ${dados.nome}`, valor: valorCompra, tipo: "insumo", natureza: "empresa",
                    insumoNome: dados.nome, formaPagamento, data: new Date()
                });
            }

            if (contaPagarRef) {
                tx.set(contaPagarRef, {
                    descricao: `Compra: ${dados.nome}`, valor: valorCompra,
                    dataVenc: new Date(Date.now() + 7 * 86400000), pago: false
                });
            } else if (emprestimoRef) {
                tx.set(emprestimoRef, {
                    tipo: "emprestimo", descricao: `Gasto: Compra: ${dados.nome}`, valor: valorCompra, data: new Date(),
                    origem: "gasto", gastoId: gastoRef.id
                });
            } else if (precisaCaixa) {
                const caixaAtual = caixaSnap.exists() ? caixaSnap.data() : { dinheiro: 0, pix: 0, cartao: 0, total: 0 };
                const novoCaixa = { ...caixaAtual, ultimaAtualizacao: new Date() };
                if (formaPagamento === "dinheiro") novoCaixa.dinheiro = Number(((novoCaixa.dinheiro || 0) - valorCompra).toFixed(2));
                else if (formaPagamento === "pix") novoCaixa.pix = Number(((novoCaixa.pix || 0) - valorCompra).toFixed(2));
                else if (formaPagamento === "cartao") novoCaixa.cartao = Number(((novoCaixa.cartao || 0) - valorCompra).toFixed(2));
                novoCaixa.total = Number(((novoCaixa.dinheiro || 0) + (novoCaixa.pix || 0) + (novoCaixa.cartao || 0)).toFixed(2));
                tx.set(caixaRef, novoCaixa, { merge: true });
            }
        });

        alert(lancarGasto
            ? (formaPagamento === "aprazo" ? "✅ Cadastrado! Lançado como conta a pagar (a prazo)."
                : formaPagamento === "pessoal" ? "✅ Cadastrado! Lançado como empréstimo pessoal no financeiro (não descontou do caixa da empresa)."
                : "✅ Cadastrado e descontado do caixa (" + formaPagamento + ")!")
            : "✅ Cadastrado (sem lançar gasto — só a contagem do estoque).");
        atualizarTudo();
        carregarSel();

        // Limpa o formulário
        ["nome-item", "qtd-item", "custo-item", "min-item", "ideal-item", "fornecedor-item", "fornecedor-tel-item", "leadtime-item"].forEach(id => document.getElementById(id).value = "");
        if (document.getElementById("validade-item")) document.getElementById("validade-item").value = "";
    } catch (e) {
        console.error(e);
        alert("❌ Não foi possível cadastrar o item.");
    }
});

// Movimentação manual: também atômica (baixa/compra/ajuste, log e gasto/caixa
// na MESMA transação), e nunca deixa passar de zero — só avisa o usuário em
// vez de travar com erro no console.
// 🆕 "Ajuste" agora tem direção: ajuste_add soma, ajuste_sub subtrai. Antes
// existia um único "ajuste" que sempre subtraía — não dava pra corrigir o
// estoque pra CIMA (ex: contagem física maior que o sistema) sem lançar como
// compra, o que geraria um gasto financeiro falso.
document.getElementById("btn-mov").addEventListener("click", async () => {
    const id = t(document.getElementById("sel-item").value);
    const tipo = t(document.getElementById("tipo-mov").value);
    const qtd = n(document.getElementById("qtd-mov").value);
    const obs = t(document.getElementById("obs-mov").value);
    const precoDigitado = document.getElementById("preco-mov").value;
    const formaPagamento = document.getElementById("forma-mov").value;
    if (!id || qtd <= 0) return alert("Preencha tudo!");

    const tiposQueSomam = ["entrada", "ajuste_add"];

    let valorCompra = 0;
    let precoUsado = null;
    try {
        // 🆕 Se a compra vai mexer no caixa (dinheiro/pix/cartão), precisamos ler o
        // documento do caixa AGORA, antes de qualquer escrita — o Firestore exige que
        // todas as leituras de uma transação aconteçam antes de todas as escritas.
        const vaiMexerNoCaixa = tipo === "entrada" && !["aprazo", "pessoal"].includes(formaPagamento);
        const caixaRef = vaiMexerNoCaixa ? doc(db, "configuracoes", "caixa_empresa") : null;

        await runTransaction(db, async tx => {
            const ref = doc(db, "estoque", id);
            const s = await tx.get(ref);
            // 1) TODAS as leituras primeiro
            const caixaSnap = caixaRef ? await tx.get(caixaRef) : null;

            if (!s.exists()) throw new Error("Item não existe mais. Atualize a página.");
            const dadosItem = s.data();
            const qatual = Number(pegarCampo(dadosItem, ["quantidade", "qtd", "quant"]));
            const custoSalvo = Number(pegarCampo(dadosItem, ["custoUnitario", "custo", "valor"]));
            const nova = tiposQueSomam.includes(tipo) ? qatual + qtd : qatual - qtd;
            if (nova < 0) throw new Error(`Estoque insuficiente de "${dadosItem.nome}" (disponível: ${qatual}).`);

            const atualizacaoItem = { quantidade: nova, atualizadoEm: new Date() };
            // 2) A partir daqui só escritas

            if (tipo === "entrada") {
                // Usa o preço digitado se o usuário informou algo; senão cai no último preço salvo.
                precoUsado = precoDigitado !== "" && !isNaN(Number(precoDigitado)) ? Number(precoDigitado) : custoSalvo;
                valorCompra = Number((qtd * precoUsado).toFixed(2));
                if (precoUsado !== custoSalvo) {
                    atualizacaoItem.custoUnitario = precoUsado;
                    // 🆕 Guarda histórico de preço (últimos 20) pra acompanhar variação com o fornecedor.
                    const historico = Array.isArray(dadosItem.historicoPrecos) ? dadosItem.historicoPrecos : [];
                    atualizacaoItem.historicoPrecos = [...historico, { data: new Date(), valor: precoUsado }].slice(-20);
                }
            }

            tx.update(ref, atualizacaoItem);
            tx.set(doc(collection(db, "movimentacoes")), {
                itemId: id, nomeItem: dadosItem.nome, tipo, quantidade: qtd, observacao: obs, data: new Date()
            });

            if (tipo === "entrada" && valorCompra > 0) {
                const gastoRef = doc(collection(db, "gastos"));
                tx.set(gastoRef, {
                    descricao: `Compra: ${dadosItem.nome}`, valor: valorCompra, tipo: "insumo", natureza: "empresa",
                    insumoNome: dadosItem.nome, formaPagamento, data: new Date()
                });

                if (formaPagamento === "aprazo") {
                    tx.set(doc(collection(db, "contas_pagar")), {
                        descricao: `Compra: ${dadosItem.nome}`, valor: valorCompra,
                        dataVenc: new Date(Date.now() + 7 * 86400000), pago: false
                    });
                } else if (formaPagamento === "pessoal") {
                    // 🆕 Pago com dinheiro pessoal do dono → não mexe no caixa da empresa,
                    // vira empréstimo automático (mesmo padrão do financeiro.js).
                    tx.set(doc(collection(db, "emprestimos")), {
                        tipo: "emprestimo", descricao: `Gasto: Compra: ${dadosItem.nome}`, valor: valorCompra, data: new Date(),
                        origem: "gasto", gastoId: gastoRef.id
                    });
                } else {
                    // caixaRef/caixaSnap já foram lidos no início da transação (regra de leitura antes de escrita)
                    const caixaAtual = caixaSnap && caixaSnap.exists() ? caixaSnap.data() : { dinheiro: 0, pix: 0, cartao: 0, total: 0 };
                    const novoCaixa = { ...caixaAtual, ultimaAtualizacao: new Date() };
                    if (formaPagamento === "dinheiro") novoCaixa.dinheiro = Number(((novoCaixa.dinheiro || 0) - valorCompra).toFixed(2));
                    else if (formaPagamento === "pix") novoCaixa.pix = Number(((novoCaixa.pix || 0) - valorCompra).toFixed(2));
                    else if (formaPagamento === "cartao") novoCaixa.cartao = Number(((novoCaixa.cartao || 0) - valorCompra).toFixed(2));
                    novoCaixa.total = Number(((novoCaixa.dinheiro || 0) + (novoCaixa.pix || 0) + (novoCaixa.cartao || 0)).toFixed(2));
                    tx.set(caixaRef, novoCaixa, { merge: true });
                }
            }
        });
        document.getElementById("qtd-mov").value = "";
        document.getElementById("preco-mov").value = "";
        document.getElementById("obs-mov").value = "";
        alert(tipo === "entrada" && valorCompra > 0
            ? (formaPagamento === "aprazo" ? "✅ Registrado! Lançado como conta a pagar (a prazo)."
                : formaPagamento === "pessoal" ? "✅ Registrado! Lançado como empréstimo pessoal no financeiro (não descontou do caixa da empresa)."
                : `✅ Registrado e descontado do caixa (${formaPagamento})!`)
            : "✅ Registrado!");
        atualizarTudo();
    } catch (e) {
        console.error(e);
        alert(`❌ ${e.message || "Não foi possível registrar a movimentação."}`);
    }
});

// Pré-preenche o preço unitário com o último valor pago quando escolhe um item,
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

const LABEL_TIPO_MOV = { entrada: "Compra", saida: "Uso", ajuste_add: "Ajuste ➕", ajuste_sub: "Ajuste ➖", ajuste: "Ajuste (antigo)", perda: "Perda/Quebra" };

let ultimasMovimentacoes = [];
onSnapshot(query(collection(db, "movimentacoes"), orderBy("data", "desc")), s => {
    ultimasMovimentacoes = s.docs.map(d => d.data());
    document.getElementById("tab-mov-body").innerHTML = s.docs.map(d => {
        const m = d.data();
        return `<tr><td>${m.data ? new Date(m.data.toDate()).toLocaleString("pt-BR") : ""}</td><td>${esc(m.nomeItem)}</td><td>${LABEL_TIPO_MOV[m.tipo] || esc(m.tipo)}</td><td>${n(m.quantidade).toFixed(2)}</td></tr>`;
    }).join("") || `<tr><td colspan="4">—</td></tr>`;
});

// ==============================================
// 🆕 EXPORTAR MOVIMENTAÇÕES EM CSV
// ==============================================
window.exportarMovimentacoesCSV = () => {
    if (!ultimasMovimentacoes.length) return alert("Nenhuma movimentação pra exportar ainda.");
    const linhas = [["Data", "Insumo", "Tipo", "Quantidade", "Observação"]];
    ultimasMovimentacoes.forEach(m => {
        linhas.push([
            m.data ? new Date(m.data.toDate()).toLocaleString("pt-BR") : "",
            m.nomeItem || "",
            LABEL_TIPO_MOV[m.tipo] || m.tipo || "",
            n(m.quantidade).toFixed(2),
            m.observacao || ""
        ]);
    });
    const csv = linhas.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `movimentacoes_estoque_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
};

// ==============================================
// 🆕 PERDAS / QUEBRAS DO MÊS
// ==============================================
// Soma as movimentações tipo "perda" do mês corrente, agrupadas por insumo,
// pra você enxergar rápido onde está desperdiçando (vencimento, quebra no
// transporte, erro de preparo etc.) separado do consumo normal de venda.
function renderPerdasDoMes() {
    const corpo = document.getElementById("tab-perdas-body");
    if (!corpo) return;
    const agora = new Date();
    const inicioMes = new Date(agora.getFullYear(), agora.getMonth(), 1).getTime();

    const porInsumo = new Map(); // nome -> { qtd, ocorrencias }
    ultimasMovimentacoes.forEach(m => {
        if (m.tipo !== "perda") return;
        const dataMs = m.data?.toDate ? m.data.toDate().getTime() : (m.data ? new Date(m.data).getTime() : 0);
        if (dataMs < inicioMes) return;
        const atual = porInsumo.get(m.nomeItem) || { qtd: 0, ocorrencias: 0 };
        atual.qtd += Number(m.quantidade) || 0;
        atual.ocorrencias += 1;
        porInsumo.set(m.nomeItem, atual);
    });

    const linhas = [...porInsumo.entries()].sort((a, b) => b[1].qtd - a[1].qtd);
    corpo.innerHTML = linhas.length
        ? linhas.map(([nome, v]) => {
            const item = ultimosItensEstoque.find(i => norm(i.nome) === norm(nome));
            const custo = item ? pegarCampo(item, ["custoUnitario", "custo", "valor"]) : 0;
            return `<tr><td>${esc(nome)}</td><td>${v.qtd.toFixed(2)}</td><td>R$ ${(v.qtd * custo).toFixed(2)}</td><td>${v.ocorrencias}</td></tr>`;
        }).join("")
        : `<tr><td colspan="4">✅ Nenhuma perda registrada esse mês.</td></tr>`;
}

// ==============================================
// 🆕 GRÁFICO DE CONSUMO POR INSUMO (30 dias)
// ==============================================
let chartConsumo = null;

function popularSelectGraficoInsumo() {
    const sel = document.getElementById("chart-insumo-select");
    if (!sel) return;
    const selecionadoAntes = sel.value;
    sel.innerHTML = ultimosItensEstoque
        .slice()
        .sort((a, b) => norm(a.nome || "").localeCompare(norm(b.nome || "")))
        .map(i => `<option value="${esc(i.nome)}">${esc(i.nome)}</option>`).join("");
    if (selecionadoAntes && [...sel.options].some(o => o.value === selecionadoAntes)) {
        sel.value = selecionadoAntes;
    }
    renderGraficoConsumo(sel.value);
}

function renderGraficoConsumo(nomeInsumo) {
    const canvas = document.getElementById("chart-consumo");
    if (!canvas || !nomeInsumo || typeof Chart === "undefined") return;

    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const dias = [];
    for (let i = 29; i >= 0; i--) dias.push(new Date(hoje.getTime() - i * 86400000).toISOString().slice(0, 10));

    const porDia = Object.fromEntries(dias.map(d => [d, 0]));
    ultimasMovimentacoes.forEach(m => {
        if (norm(m.nomeItem) !== norm(nomeInsumo)) return;
        if (m.tipo !== "saida" && m.tipo !== "perda") return;
        const dataObj = m.data?.toDate ? m.data.toDate() : (m.data ? new Date(m.data) : null);
        if (!dataObj) return;
        const chave = dataObj.toISOString().slice(0, 10);
        if (chave in porDia) porDia[chave] += Number(m.quantidade) || 0;
    });

    if (chartConsumo) chartConsumo.destroy();
    chartConsumo = new Chart(canvas.getContext("2d"), {
        type: "bar",
        data: {
            labels: dias.map(d => d.slice(8, 10) + "/" + d.slice(5, 7)),
            datasets: [{
                label: `Consumo diário — ${nomeInsumo}`,
                data: dias.map(d => Number(porDia[d].toFixed(2))),
                backgroundColor: "rgba(139, 92, 246, .55)",
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { labels: { color: "#f5f5f7" } } },
            scales: {
                x: { ticks: { color: "#9697a6", maxRotation: 0 }, grid: { display: false } },
                y: { ticks: { color: "#9697a6" }, grid: { color: "rgba(255,255,255,.06)" } }
            }
        }
    });
}

document.getElementById("chart-insumo-select")?.addEventListener("change", e => {
    renderGraficoConsumo(e.target.value);
});

// ==============================================
// 🆕 RELATÓRIO MENSAL EXPORTÁVEL POR INSUMO
// ==============================================
// Junta, pro mês escolhido, quanto foi comprado (entrada), usado (saída) e
// perdido (perda) de cada insumo — útil pra prestação de contas ou pra ver
// rápido o mês inteiro sem ficar rolando a lista de movimentações.
window.exportarRelatorioMensal = () => {
    const mesInput = document.getElementById("relatorio-mes")?.value; // formato "YYYY-MM"
    if (!mesInput) return alert("Escolha um mês antes de exportar.");
    const [ano, mes] = mesInput.split("-").map(Number);
    const inicio = new Date(ano, mes - 1, 1).getTime();
    const fim = new Date(ano, mes, 1).getTime();

    const porInsumo = new Map(); // nome -> { comprasQtd, comprasValor, usoQtd, perdaQtd, perdaValor }
    ultimasMovimentacoes.forEach(m => {
        const dataMs = m.data?.toDate ? m.data.toDate().getTime() : (m.data ? new Date(m.data).getTime() : 0);
        if (dataMs < inicio || dataMs >= fim) return;
        const atual = porInsumo.get(m.nomeItem) || { comprasQtd: 0, comprasValor: 0, usoQtd: 0, perdaQtd: 0, perdaValor: 0 };
        const qtd = Number(m.quantidade) || 0;
        const item = ultimosItensEstoque.find(i => norm(i.nome) === norm(m.nomeItem));
        const custo = item ? pegarCampo(item, ["custoUnitario", "custo", "valor"]) : 0;

        if (m.tipo === "entrada") { atual.comprasQtd += qtd; atual.comprasValor += qtd * custo; }
        else if (m.tipo === "saida") { atual.usoQtd += qtd; }
        else if (m.tipo === "perda") { atual.perdaQtd += qtd; atual.perdaValor += qtd * custo; }

        porInsumo.set(m.nomeItem, atual);
    });

    if (!porInsumo.size) return alert("Nenhuma movimentação encontrada nesse mês.");

    const linhas = [["Insumo", "Comprado (qtd)", "Comprado (R$)", "Usado (qtd)", "Perdido (qtd)", "Perdido (R$)"]];
    [...porInsumo.entries()].sort((a, b) => a[0].localeCompare(b[0])).forEach(([nome, v]) => {
        linhas.push([nome, v.comprasQtd.toFixed(2), v.comprasValor.toFixed(2), v.usoQtd.toFixed(2), v.perdaQtd.toFixed(2), v.perdaValor.toFixed(2)]);
    });

    const csv = linhas.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `relatorio_estoque_${mesInput}.csv`;
    link.click();
    URL.revokeObjectURL(url);
};

// ==============================================
// MODAL DE EDIÇÃO — listeners
// ==============================================
document.getElementById("edit-salvar")?.addEventListener("click", salvarEdicaoItem);
document.getElementById("edit-cancelar")?.addEventListener("click", fecharModalEdicao);

document.addEventListener("DOMContentLoaded", () => {
    carregarSel();
    atualizarTudo();
    monitorar();
    atualizarCamposMovimentacao(); // estado inicial certo dos campos de preço/pagamento
});

