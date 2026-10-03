// Monta a arte do dia em <canvas>: template + foto do produto + textos.
// Não depende de IA de imagem: a IA só escreve os textos, aqui é só desenho.

export const TEMPLATES = [
    { id: "promo", nome: "Promoção", bg: ["#f59e0b", "#ef4444"], txt: "#ffffff", sub: "rgba(255,255,255,.92)", forma: "circulo" },
    { id: "roxo",  nome: "Roxo",     bg: ["#2a0f5e", "#07070a"], txt: "#ffffff", sub: "#c4b5fd", forma: "arredondado", brilho: true },
    { id: "claro", nome: "Claro",    bg: ["#f5f3ff", "#e9d5ff"], txt: "#2e1065", sub: "#6d28d9", forma: "circulo" },
    { id: "foto",  nome: "Foto cheia", bg: null, txt: "#ffffff", sub: "#e5e7eb", forma: "cheia" }
];

export const FORMATOS = { feed: [1080, 1350], story: [1080, 1920] };
const FONTE = '"Segoe UI", Roboto, Arial, sans-serif';

const cacheImg = new Map();
export function carregarImagem(url) {
    if (!cacheImg.has(url)) {
        cacheImg.set(url, carregarSemCache(url).catch((e) => { cacheImg.delete(url); throw e; }));
    }
    return cacheImg.get(url);
}

function carregarSemCache(url) {
    const tentar = (cors) => new Promise((ok, erro) => {
        const img = new Image();
        if (cors) img.crossOrigin = "anonymous";
        img.onload = () => ok(img);
        img.onerror = () => erro(new Error("imagem não carregou"));
        img.src = url;
    });
    // 1ª tentativa permite exportar PNG; 2ª só mostra na tela (exportar pode ser bloqueado)
    return tentar(true).catch(() => tentar(false));
}

function cobrir(c, img, x, y, w, h) {
    const r = Math.max(w / img.width, h / img.height);
    const sw = w / r, sh = h / r;
    c.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

function retArred(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
}

function quebrar(c, texto, max) {
    const linhas = []; let atual = "";
    for (const p of String(texto || "").split(" ")) {
        const t = atual ? atual + " " + p : p;
        if (c.measureText(t).width > max && atual) { linhas.push(atual); atual = p; } else atual = t;
    }
    if (atual) linhas.push(atual);
    return linhas;
}

// Reduz a fonte até o título caber em no máximo 3 linhas
function ajustarTitulo(c, texto, max) {
    for (let tam = 96; tam >= 52; tam -= 6) {
        c.font = `800 ${tam}px ${FONTE}`;
        const l = quebrar(c, texto, max);
        if (l.length <= 3) return { tam, linhas: l };
    }
    c.font = `800 52px ${FONTE}`;
    return { tam: 52, linhas: quebrar(c, texto, max).slice(0, 3) };
}

const reais = (n) => "R$ " + Number(n).toFixed(2).replace(".", ",");

// o = { template, formato, titulo, subtitulo, chamada, foto, logo, preco, precoOriginal }
export function desenharArte(cv, o) {
    const [W, H] = FORMATOS[o.formato] || FORMATOS.feed;
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const t = TEMPLATES.find((x) => x.id === o.template) || TEMPLATES[0];
    const M = 70, rodape = 210;

    // ----- fundo -----
    if (t.forma === "cheia" && o.foto) {
        cobrir(c, o.foto, 0, 0, W, H);
        const g = c.createLinearGradient(0, H * 0.3, 0, H);
        g.addColorStop(0, "rgba(7,7,10,0)"); g.addColorStop(0.75, "rgba(7,7,10,.88)"); g.addColorStop(1, "rgba(7,7,10,.96)");
        c.fillStyle = g; c.fillRect(0, 0, W, H);
    } else {
        const g = c.createLinearGradient(0, 0, W, H);
        const [a, b] = t.bg || TEMPLATES[1].bg;
        g.addColorStop(0, a); g.addColorStop(1, b);
        c.fillStyle = g; c.fillRect(0, 0, W, H);
    }

    // ----- texto -----
    c.textBaseline = "top"; c.textAlign = "left";
    const tit = ajustarTitulo(c, o.titulo, W - M * 2);
    const alturaTit = tit.linhas.length * tit.tam * 1.08;
    c.font = `600 44px ${FONTE}`;
    const subLinhas = o.subtitulo ? quebrar(c, o.subtitulo, W - M * 2).slice(0, 2) : [];
    const alturaSub = subLinhas.length * 56;
    const alturaTexto = alturaTit + (alturaSub ? alturaSub + 20 : 0);

    const desenharTexto = (y0) => {
        c.fillStyle = t.txt; c.font = `800 ${tit.tam}px ${FONTE}`;
        tit.linhas.forEach((l, i) => c.fillText(l, M, y0 + i * tit.tam * 1.08));
        c.fillStyle = t.sub; c.font = `600 44px ${FONTE}`;
        subLinhas.forEach((l, i) => c.fillText(l, M, y0 + alturaTit + 20 + i * 56));
    };

    // ----- foto -----
    if (t.forma === "cheia") {
        desenharTexto(H - rodape - alturaTexto - 30);
    } else {
        const topo = M + 10;
        desenharTexto(topo);
        const livreY = topo + alturaTexto + 40;
        const livreH = H - rodape - 30 - livreY;
        const lado = Math.min(W - 160, livreH);
        const px = (W - lado) / 2, py = livreY + (livreH - lado) / 2;
        if (t.brilho) {
            const rg = c.createRadialGradient(W / 2, py + lado / 2, lado * 0.2, W / 2, py + lado / 2, lado * 0.85);
            rg.addColorStop(0, "rgba(124,58,237,.55)"); rg.addColorStop(1, "rgba(124,58,237,0)");
            c.fillStyle = rg; c.fillRect(0, py - lado * 0.4, W, lado * 1.8);
        }
        if (o.foto) {
            c.save();
            if (t.forma === "circulo") { c.beginPath(); c.arc(W / 2, py + lado / 2, lado / 2, 0, Math.PI * 2); }
            else retArred(c, px, py, lado, lado, 48);
            c.clip();
            cobrir(c, o.foto, px, py, lado, lado);
            c.restore();
            c.lineWidth = 10; c.strokeStyle = "rgba(255,255,255,.85)";
            if (t.forma === "circulo") { c.beginPath(); c.arc(W / 2, py + lado / 2, lado / 2, 0, Math.PI * 2); }
            else retArred(c, px, py, lado, lado, 48);
            c.stroke();
        }
        o._foto = { px, py, lado };
    }

    // ----- selo de preço -----
    if (o.preco) {
        const bw = 380, bh = o.precoOriginal ? 170 : 130;
        const area = o._foto || { px: W - M - bw, py: H - rodape - bh - 260, lado: bw };
        const bx = Math.min(W - M - bw, area.px + area.lado - bw * 0.75);
        const by = (t.forma === "cheia") ? H - rodape - alturaTexto - bh - 60 : area.py + area.lado - bh * 0.7;
        c.save();
        c.shadowColor = "rgba(0,0,0,.35)"; c.shadowBlur = 24; c.shadowOffsetY = 8;
        c.fillStyle = "#fde047"; retArred(c, bx, by, bw, bh, 36); c.fill();
        c.restore();
        c.textAlign = "center"; c.fillStyle = "#3b0764";
        if (o.precoOriginal) {
            c.font = `600 34px ${FONTE}`;
            const txt = "de " + reais(o.precoOriginal), tx = bx + bw / 2, ty = by + 22;
            c.fillText(txt, tx, ty);
            const w = c.measureText(txt).width;
            c.fillRect(tx - w / 2, ty + 20, w, 3);
        }
        c.font = `900 ${o.precoOriginal ? 76 : 70}px ${FONTE}`;
        c.fillText(reais(o.preco), bx + bw / 2, by + (o.precoOriginal ? 68 : 30));
        c.textAlign = "left";
    }

    // ----- rodapé: logo + chamada -----
    const ry = H - rodape + 50, tam = 120;
    if (o.logo) {
        c.save(); retArred(c, M, ry, tam, tam, 28); c.clip(); cobrir(c, o.logo, M, ry, tam, tam); c.restore();
    }
    c.fillStyle = t.txt; c.font = `800 56px ${FONTE}`; c.textBaseline = "middle";
    c.fillText(o.chamada || "Peça pelo site", M + (o.logo ? tam + 30 : 0), ry + tam / 2);
    c.textBaseline = "top";
}
