// ==============================================
// UTILS COMPARTILHADOS (Nova Origem Açaí)
// ==============================================
// 🆕 Antes essas funções existiam duplicadas em estoque.js e estoqueBaixa.js.
// Foi justamente uma pequena diferença entre arquivos (nome de campo "extras"
// vs "pagos"/"adicionais") que causou o bug de adicionais nunca serem
// debitados do estoque — duplicação de lógica é terreno fértil pra isso
// acontecer de novo. Agora estoque.js e estoqueBaixa.js importam tudo daqui.

export function t(v, p = "") {
    return typeof v === "string" && v.trim() ? v.trim() : p;
}

export function n(v, p = 0) {
    return isNaN(Number(v)) ? p : Number(v);
}

export function norm(nome) {
    return t(nome).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Escapa texto pra uso seguro em innerHTML (evita injeção via nome de item, obs, etc.)
export function esc(texto) {
    const d = document.createElement("div");
    d.textContent = t(texto, "");
    return d.innerHTML;
}

// Um item de estoque pode ter sido salvo com nomes de campo diferentes
// historicamente (quantidade/qtd/quant, custoUnitario/custo/valor, etc.) —
// essa função tenta todas as variações conhecidas.
export function pegarCampo(item, nomes) {
    for (const nome of nomes) {
        if (item[nome] !== undefined) return item[nome];
    }
    return 0;
}
