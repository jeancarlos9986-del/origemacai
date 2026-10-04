// Monta a arte do dia em <canvas>: template + foto(s) do produto + textos.
// A IA só escreve os textos; aqui é só desenho (sem custo e com a logo sempre certa).

export const TEMPLATES = [
    { id: "promo",    nome: "Promoção",     forma: "circulo",     bg: ["#f59e0b", "#ef4444"], txt: "#ffffff", sub: "rgba(255,255,255,.92)", deco: "rgba(255,255,255,.14)" },
    { id: "roxo",     nome: "Roxo",         forma: "arredondado", bg: ["#2a0f5e", "#07070a"], txt: "#ffffff", sub: "#c4b5fd", deco: "rgba(124,58,237,.28)", brilho: true },
    { id: "claro",    nome: "Claro",        forma: "circulo",     bg: ["#f5f3ff", "#e9d5ff"], txt: "#2e1065", sub: "#6d28d9", deco: "rgba(124,58,237,.14)" },
    { id: "foto",     nome: "Foto cheia",   forma: "cheia",       bg: null,                   txt: "#ffffff", sub: "#e5e7eb" },
    { id: "preco",    nome: "Preço grande", forma: "preco",       bg: ["#7c3aed", "#2a0f5e"], txt: "#ffffff", sub: "#e9d5ff", deco: "rgba(255,255,255,.12)" },
    { id: "dividido", nome: "Dividido",     forma: "dividido",    bg: ["#2a0f5e", "#07070a"], txt: "#ffffff", sub: "#c4b5fd", deco: "rgba(124,58,237,.3)" },
    { id: "minimal",  nome: "Minimal",      forma: "minimal",     bg: ["#ffffff", "#f5f3ff"], txt: "#1f1147", sub: "#6d28d9", deco: "rgba(124,58,237,.08)", centro: true },
    { id: "dupla",    nome: "Dupla",        forma: "dupla",       bg: ["#f59e0b", "#ef4444"], txt: "#ffffff", sub: "rgba(255,255,255,.92)", deco: "rgba(255,255,255,.14)", centro: true }
];

export const FORMATOS = { feed: [1080, 1350], story: [1080, 1920] };
const FONTE = '"Poppins", "Segoe UI", Roboto, Arial, sans-serif';

const cacheImg = new Map();
export function carregarImagem(url) {
    if (!cacheImg.has(url)) cacheImg.set(url, carregarSemCache(url).catch((e) => { cacheImg.delete(url); throw e; }));
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
    return tentar(true).catch(() => tentar(false)); // 2ª tentativa: só exibe (exportar pode ser bloqueado)
}

// aj = { zoom: 1..3, x: -1..1, y: -1..1 }
function cobrir(c, img, x, y, w, h, aj) {
    const z = Math.max(1, Math.min(3, (aj && aj.zoom) || 1));
    const r = Math.max(w / img.width, h / img.height) * z;
    const sw = w / r, sh = h / r, mx = (img.width - sw) / 2, my = (img.height - sh) / 2;
    c.drawImage(img, mx + ((aj && aj.x) || 0) * mx, my + ((aj && aj.y) || 0) * my, sw, sh, x, y, w, h);
}

function retArred(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
}
const trilha = (c, forma, x, y, w, h) => {
    if (forma === "circulo") { c.beginPath(); c.arc(x + w / 2, y + h / 2, Math.min(w, h) / 2, 0, Math.PI * 2); }
    else retArred(c, x, y, w, h, 48);
};

function desenharFoto(c, img, x, y, w, h, forma, aj, { anel = true, sombra = false } = {}) {
    if (sombra) {
        c.save(); c.shadowColor = "rgba(31,17,71,.30)"; c.shadowBlur = 44; c.shadowOffsetY = 18;
        c.fillStyle = "#fff"; trilha(c, forma, x, y, w, h); c.fill(); c.restore();
    }
    c.save(); trilha(c, forma, x, y, w, h); c.clip();
    if (img) cobrir(c, img, x, y, w, h, aj); else { c.fillStyle = "rgba(255,255,255,.15)"; c.fillRect(x, y, w, h); }
    c.restore();
    if (anel) { c.lineWidth = 10; c.strokeStyle = "rgba(255,255,255,.85)"; trilha(c, forma, x, y, w, h); c.stroke(); }
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

function ajustarTitulo(c, texto, max, maxTam = 96, minTam = 52, maxLinhas = 3) {
    for (let tam = maxTam; tam >= minTam; tam -= 4) {
        c.font = `800 ${tam}px ${FONTE}`;
        const l = quebrar(c, texto, max);
        if (l.length <= maxLinhas && l.every((x) => c.measureText(x).width <= max)) return { tam, linhas: l };
    }
    c.font = `800 ${minTam}px ${FONTE}`;
    return { tam: minTam, linhas: quebrar(c, texto, max).slice(0, maxLinhas) };
}

// s = { topo?, riscado?, grande }  (preço, "3 grátis", copo do dia...)
function desenharSelo(c, s, bx, by, esc = 1) {
    if (!s || !s.grande) return;
    const bw = 380 * esc, bh = (s.topo ? 170 : 130) * esc, cx = bx + bw / 2;
    c.save(); c.shadowColor = "rgba(0,0,0,.35)"; c.shadowBlur = 24; c.shadowOffsetY = 8;
    c.fillStyle = "#fde047"; retArred(c, bx, by, bw, bh, 36 * esc); c.fill(); c.restore();
    c.textAlign = "center"; c.fillStyle = "#3b0764";
    if (s.topo) {
        c.font = `600 ${34 * esc}px ${FONTE}`;
        const ty = by + 22 * esc;
        c.fillText(s.topo, cx, ty);
        if (s.riscado) { const w = c.measureText(s.topo).width; c.fillRect(cx - w / 2, ty + 20 * esc, w, 3 * esc); }
    }
    let tam = (s.topo ? 76 : 70) * esc;
    c.font = `900 ${tam}px ${FONTE}`;
    while (c.measureText(s.grande).width > bw - 30 * esc && tam > 28) { tam -= 4; c.font = `900 ${tam}px ${FONTE}`; }
    c.fillText(s.grande, cx, by + (s.topo ? 68 : 30) * esc);
    c.textAlign = "left";
}

function ajustarLinha(c, texto, max, tam, peso = 600) {
    let t = tam;
    c.font = `${peso} ${t}px ${FONTE}`;
    while (c.measureText(texto).width > max && t > 20) { t -= 2; c.font = `${peso} ${t}px ${FONTE}`; }
}

// o = { template, formato, titulo, subtitulo, chamada, foto, logo, selo, ajuste, fotos:[{foto,selo,nome},{...}] }
export function desenharArte(cv, o) {
    const [W, H] = FORMATOS[o.formato] || FORMATOS.feed;
    const story = o.formato === "story";
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    const t = TEMPLATES.find((x) => x.id === o.template) || TEMPLATES[0];
    const M = 70;
    const topo = story ? 260 : M + 10;     // story: sai da faixa coberta pelo perfil do Instagram
    const rodape = story ? 470 : 210;      // story: sai da faixa coberta pela barra de resposta
    const aj = o.ajuste;
    const chamada = o.chamada || "Peça pelo site";
    c.textBaseline = "top"; c.textAlign = "left";

    // ----- fundo -----
    if (t.forma === "cheia" && o.foto) {
        cobrir(c, o.foto, 0, 0, W, H, aj);
        const g = c.createLinearGradient(0, H * 0.3, 0, H);
        g.addColorStop(0, "rgba(7,7,10,0)"); g.addColorStop(0.75, "rgba(7,7,10,.88)"); g.addColorStop(1, "rgba(7,7,10,.96)");
        c.fillStyle = g; c.fillRect(0, 0, W, H);
    } else {
        const g = c.createLinearGradient(0, 0, W, H);
        const [a, b] = t.bg || TEMPLATES[1].bg;
        g.addColorStop(0, a); g.addColorStop(1, b);
        c.fillStyle = g; c.fillRect(0, 0, W, H);
        if (t.deco) { // formas da marca no fundo
            c.fillStyle = t.deco;
            c.beginPath(); c.arc(W * 0.98, H * 0.1, W * 0.34, 0, Math.PI * 2); c.fill();
            c.beginPath(); c.arc(W * 0.02, H * 0.9, W * 0.28, 0, Math.PI * 2); c.fill();
        }
    }

    const logoTam = 120;
    const desenharLogo = (x, y) => {
        if (!o.logo) return;
        c.save(); retArred(c, x, y, logoTam, logoTam, 28); c.clip(); cobrir(c, o.logo, x, y, logoTam, logoTam); c.restore();
    };

    // ===== DIVIDIDO: foto na metade esquerda, texto na direita =====
    if (t.forma === "dividido") {
        const metade = W / 2, xr = metade + 50, wr = metade - 100;
        if (o.foto) cobrir(c, o.foto, 0, 0, metade, H, aj);
        const tit = ajustarTitulo(c, o.titulo, wr, 80, 40, 4);
        c.font = `600 38px ${FONTE}`;
        const sub = o.subtitulo ? quebrar(c, o.subtitulo, wr).slice(0, 3) : [];
        const altTit = tit.linhas.length * tit.tam * 1.08;
        const alt = altTit + (sub.length ? sub.length * 50 + 18 : 0);
        const y = Math.max(topo + logoTam + 40, (H - rodape) * 0.34);
        desenharLogo(xr, topo);
        c.fillStyle = t.txt; c.font = `800 ${tit.tam}px ${FONTE}`;
        tit.linhas.forEach((l, i) => c.fillText(l, xr, y + i * tit.tam * 1.08));
        c.fillStyle = t.sub; c.font = `600 38px ${FONTE}`;
        sub.forEach((l, i) => c.fillText(l, xr, y + altTit + 18 + i * 50));
        desenharSelo(c, o.selo, xr, y + alt + 40, Math.min(1, wr / 380));
        c.fillStyle = t.txt; ajustarLinha(c, chamada, wr, 44, 800);
        c.fillText(chamada, xr, H - rodape + 90);
        return;
    }

    // ----- título e subtítulo -----
    const centro = !!t.centro;
    const tit = ajustarTitulo(c, o.titulo, W - M * 2);
    c.font = `600 44px ${FONTE}`;
    const sub = o.subtitulo ? quebrar(c, o.subtitulo, W - M * 2).slice(0, 2) : [];
    const altTit = tit.linhas.length * tit.tam * 1.08;
    const altTexto = altTit + (sub.length ? sub.length * 56 + 20 : 0);
    const escrever = (y0) => {
        c.textAlign = centro ? "center" : "left";
        const x = centro ? W / 2 : M;
        c.fillStyle = t.txt; c.font = `800 ${tit.tam}px ${FONTE}`;
        tit.linhas.forEach((l, i) => c.fillText(l, x, y0 + i * tit.tam * 1.08));
        c.fillStyle = t.sub; c.font = `600 44px ${FONTE}`;
        sub.forEach((l, i) => c.fillText(l, x, y0 + altTit + 20 + i * 56));
        c.textAlign = "left";
    };

    if (t.forma === "cheia") {
        const yTxt = H - rodape - altTexto - 30;
        escrever(yTxt);
        desenharSelo(c, o.selo, W - M - 380, yTxt - 170 - 40, 1);
    } else {
        escrever(topo);
        const livreY = topo + altTexto + 40;
        const livreH = H - rodape - 30 - livreY;

        if (t.forma === "dupla" && o.fotos && o.fotos.length === 2) {
            const lado = Math.min((W - M * 3) / 2, livreH - 190);
            const y = livreY + Math.max(0, (livreH - (lado + 190)) / 2);
            o.fotos.forEach((f, i) => {
                const x = M + i * (lado + M);
                desenharFoto(c, f.foto, x, y, lado, lado, "arredondado", f.ajuste || aj);
                c.fillStyle = t.txt; c.textAlign = "center"; ajustarLinha(c, f.nome || "", lado, 34, 700);
                c.fillText(f.nome || "", x + lado / 2, y + lado + 16);
                c.textAlign = "left";
                desenharSelo(c, f.selo, x + (lado - 380 * 0.78) / 2, y + lado + 62, 0.78);
            });
        } else if (t.forma === "preco") {
            const lado = Math.max(300, Math.min(W - 300, livreH - 290));
            const py = livreY + Math.max(0, (livreH - lado - 290) / 2);
            desenharFoto(c, o.foto, (W - lado) / 2, py, lado, lado, "circulo", aj);
            desenharSelo(c, o.selo, (W - 380 * 1.45) / 2, py + lado + 36, 1.45);
        } else {
            const lado = Math.min(W - 160, livreH);
            const px = (W - lado) / 2, py = livreY + (livreH - lado) / 2;
            if (t.brilho) {
                const rg = c.createRadialGradient(W / 2, py + lado / 2, lado * 0.2, W / 2, py + lado / 2, lado * 0.85);
                rg.addColorStop(0, "rgba(124,58,237,.55)"); rg.addColorStop(1, "rgba(124,58,237,0)");
                c.fillStyle = rg; c.fillRect(0, py - lado * 0.4, W, lado * 1.8);
            }
            const mini = t.forma === "minimal";
            desenharFoto(c, o.foto, px, py, lado, lado, mini ? "arredondado" : t.forma, aj, { anel: !mini, sombra: mini });
            if (o.selo) {
                const bw = 380, bh = o.selo.topo ? 170 : 130;
                desenharSelo(c, o.selo, Math.min(W - M - bw, px + lado - bw * 0.75), py + lado - bh * 0.7, 1);
            }
        }
    }

    // ----- rodapé: logo + chamada -----
    const ry = H - rodape + 50;
    ajustarLinha(c, chamada, W - M * 2 - logoTam - 30, 56, 800);
    const larguraTxt = c.measureText(chamada).width;
    const bloco = (o.logo ? logoTam + 30 : 0) + larguraTxt;
    const x0 = centro ? (W - bloco) / 2 : M;
    desenharLogo(x0, ry);
    c.fillStyle = t.txt; c.textBaseline = "middle";
    c.fillText(chamada, x0 + (o.logo ? logoTam + 30 : 0), ry + logoTam / 2);
    c.textBaseline = "top";
}
