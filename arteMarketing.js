// Monta a arte do dia em <canvas> no estilo dos stories da Nova Origem Açaí:
// fundo roxo escuro com brilho, pinceladas roxa/amarela atrás do título, letra de pincel,
// foto em círculo com aro roxo, selo de preço em pincelada amarela e barra de pedido embaixo.
// A IA só escreve os textos; aqui é só desenho (sem custo e com a logo sempre certa).
//
// Fontes usadas (carregadas no marketing.html): Permanent Marker (pincel), Kaushan Script (manuscrito), Poppins.

export const TEMPLATES = [
    { id: "promo",      nome: "Promoção" },
    { id: "disponivel", nome: "Disponível" },
    { id: "destaque",   nome: "Foto cheia" },
    { id: "dupla",      nome: "Dupla" }
];

export const FORMATOS = { feed: [1080, 1350], story: [1080, 1920] };

const COR = {
    roxo: "#7c3aed", roxoClaro: "#a855f7", roxoEscuro: "#2e1065",
    amarelo: "#fde047", ambar: "#f59e0b", rosa: "#e879f9"
};
const SANS = '"Poppins", "Segoe UI", Roboto, Arial, sans-serif';
const PINCEL = '"Permanent Marker", "Poppins", Impact, sans-serif';
const SCRIPT = '"Kaushan Script", "Brush Script MT", cursive';

const LOGO_ZOOM = 1;                                  // aumente (ex.: 1.15) se a logo vier com margem sobrando
const ASSINATURA = ["Feito com carinho", "pra você!"]; // texto manuscrito da barra de baixo
const FONE_SVG = "M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z";

// ---------- imagens ----------
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

// ---------- utilidades ----------
const maiusc = (s) => String(s || "").toLocaleUpperCase("pt-BR");

function rng(seed) { // aleatório repetível: a arte não "pisca" diferente a cada redesenho
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function retArred(c, x, y, w, h, r) {
    c.beginPath();
    if (c.roundRect) c.roundRect(x, y, w, h, r); else c.rect(x, y, w, h);
}

function girar(c, cx, cy, ang, fn) {
    c.save(); c.translate(cx, cy); c.rotate(ang); c.translate(-cx, -cy);
    fn();
    c.restore();
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

function ajustarLinha(c, texto, max, tam, peso = 600) {
    let t = tam;
    c.font = `${peso} ${t}px ${SANS}`;
    while (c.measureText(texto).width > max && t > 20) { t -= 2; c.font = `${peso} ${t}px ${SANS}`; }
}

// ---------- fundo e decoração ----------
function fundo(c, W, H) {
    const g = c.createLinearGradient(0, 0, W * 0.4, H);
    g.addColorStop(0, "#140630"); g.addColorStop(0.5, "#0a0416"); g.addColorStop(1, "#040109");
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    const brilho = (x, y, r, a) => {
        const rg = c.createRadialGradient(x, y, 0, x, y, r);
        rg.addColorStop(0, `rgba(124,58,237,${a})`); rg.addColorStop(1, "rgba(124,58,237,0)");
        c.fillStyle = rg; c.fillRect(x - r, y - r, r * 2, r * 2);
    };
    brilho(W * 0.5, H * 0.07, W * 0.7, 0.32);
    brilho(W * 0.95, H * 0.75, W * 0.6, 0.26);
    brilho(0, H * 0.45, W * 0.45, 0.12);
}

function folha(c, x, y, comp, ang, claro = "#237a34", escuro = "#0b3318") {
    c.save(); c.translate(x, y); c.rotate(ang);
    const g = c.createLinearGradient(0, 0, comp, 0);
    g.addColorStop(0, escuro); g.addColorStop(1, claro);
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(0, 0);
    c.bezierCurveTo(comp * 0.25, -comp * 0.32, comp * 0.75, -comp * 0.28, comp, 0);
    c.bezierCurveTo(comp * 0.75, comp * 0.28, comp * 0.25, comp * 0.32, 0, 0);
    c.fill();
    c.strokeStyle = "rgba(255,255,255,.16)"; c.lineWidth = Math.max(2, comp * 0.012);
    c.beginPath(); c.moveTo(comp * 0.05, 0); c.lineTo(comp * 0.92, 0); c.stroke();
    c.restore();
}

function fruto(c, x, y, r) {
    const g = c.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
    g.addColorStop(0, "#6b4a9c"); g.addColorStop(1, "#12051d");
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
}

function decoracao(c, W, barY) {
    c.save(); c.globalAlpha = 0.92;
    folha(c, -30, -10, 300, 0.85);
    folha(c, 20, -50, 210, 1.2, "#2c9143", "#0b3318");
    folha(c, W + 30, -20, 330, Math.PI - 0.8);
    folha(c, W - 10, -40, 220, Math.PI - 1.2, "#2c9143", "#0b3318");
    fruto(c, 34, 210, 46);
    fruto(c, 110, barY - 6, 52);
    fruto(c, 205, barY + 8, 38);
    c.restore();
}

// ---------- pincelada: a assinatura visual da marca ----------
function pincelada(c, x, y, w, h, cor, seed = 1, ang = -0.025) {
    const r = rng(seed);
    c.save();
    c.translate(x + w / 2, y + h / 2); c.rotate(ang); c.translate(-w / 2, -h / 2);
    c.fillStyle = cor;
    const n = 26, j = h * 0.07;
    c.beginPath();
    c.moveTo(0, (r() - 0.5) * j);
    for (let i = 1; i <= n; i++) c.lineTo((w * i) / n, (r() - 0.5) * j);
    c.lineTo(w, h);
    for (let i = n - 1; i >= 0; i--) c.lineTo((w * i) / n, h + (r() - 0.5) * j);
    c.closePath(); c.fill();
    // pontas desfiadas, como cerdas do pincel
    const filas = 16, fh = h / filas;
    for (let k = 0; k < filas; k++) {
        const cone = Math.sin((Math.PI * (k + 0.5)) / filas); // mais comprido no meio, curto nas bordas
        const el = r() * w * 0.05 * cone, er = r() * w * 0.06 * cone;
        const fy = k * fh + fh * 0.1, fa = fh * (0.55 + r() * 0.35);
        c.fillRect(-el, fy, el + w * 0.03, fa);
        c.fillRect(w * 0.97, fy, er + w * 0.03, fa);
    }
    // riscos de tinta seca
    c.strokeStyle = "rgba(0,0,0,.14)"; c.lineCap = "round";
    for (let k = 0; k < 8; k++) {
        const yy = r() * h, x1 = r() * w * 0.5, x2 = x1 + w * (0.2 + r() * 0.4);
        c.lineWidth = 2 + r() * 3;
        c.beginPath(); c.moveTo(x1, yy); c.lineTo(x2, yy + (r() - 0.5) * 6); c.stroke();
    }
    c.restore();
}

// ---------- título em letra de pincel ----------
function ajustarPincel(c, texto, maxL, maxTam, minTam, maxLinhas, maxAlt) {
    const alt = (n, tam) => n * tam * 1.04 + tam * 0.5;
    for (let tam = maxTam; tam >= minTam; tam -= 4) {
        c.font = `400 ${tam}px ${PINCEL}`;
        const l = quebrar(c, texto, maxL);
        if (l.length <= maxLinhas && alt(l.length, tam) <= maxAlt && l.every((x) => c.measureText(x).width <= maxL)) return { tam, linhas: l };
    }
    c.font = `400 ${minTam}px ${PINCEL}`;
    return { tam: minTam, linhas: quebrar(c, texto, maxL).slice(0, maxLinhas) };
}

// texto inclinado (efeito pincel) com sombra seca
function escreverPincel(c, linhas, x, y, tam, cor, lh = 1.04) {
    linhas.forEach((l, i) => {
        c.save();
        c.translate(x, y + i * tam * lh + tam / 2);
        c.transform(1, 0, -0.08, 1, 0, 0);
        c.textAlign = "center"; c.textBaseline = "middle";
        c.font = `400 ${tam}px ${PINCEL}`;
        c.shadowColor = "rgba(0,0,0,.45)"; c.shadowOffsetX = 4; c.shadowOffsetY = 6; c.shadowBlur = 0;
        c.fillStyle = cor;
        c.fillText(l, 0, 0);
        c.restore();
    });
}

// op = { cor, txt, maxTam, minTam?, maxLinhas?, maxAlt, seed, ang, larg, cx }
function medirFaixa(c, texto, op) {
    if (!texto) return null;
    const pad = 64;
    const t = ajustarPincel(c, maiusc(texto), op.larg - pad * 2, op.maxTam, op.minTam || 44, op.maxLinhas || 2, op.maxAlt);
    c.font = `400 ${t.tam}px ${PINCEL}`;
    const tw = Math.max(...t.linhas.map((l) => c.measureText(l).width));
    return { t, bw: Math.min(op.larg, tw + pad * 2), bh: t.linhas.length * t.tam * 1.04 + t.tam * 0.5 };
}
function pintarFaixa(c, y, p, op) {
    girar(c, op.cx, y + p.bh / 2, op.ang, () => {
        pincelada(c, op.cx - p.bw / 2, y, p.bw, p.bh, op.cor, op.seed, 0);
        escreverPincel(c, p.t.linhas, op.cx, y + p.t.tam * 0.25, p.t.tam, op.txt);
    });
}

// ---------- foto ----------
function fotoCirculo(c, img, cx, cy, d, aj, seed = 3) {
    const r = d / 2;
    const g = c.createRadialGradient(cx, cy, r * 0.7, cx, cy, r * 1.35); // brilho roxo atrás
    g.addColorStop(0, "rgba(168,85,247,.55)"); g.addColorStop(1, "rgba(168,85,247,0)");
    c.fillStyle = g; c.beginPath(); c.arc(cx, cy, r * 1.35, 0, Math.PI * 2); c.fill();
    const rn = rng(seed); // respingos de açaí em volta
    c.fillStyle = "rgba(168,85,247,.55)";
    for (let i = 0; i < 12; i++) {
        const a = rn() * Math.PI * 2, dist = r * (1.03 + rn() * 0.09), rr = 6 + rn() * 16;
        c.beginPath(); c.arc(cx + Math.cos(a) * dist, cy + Math.sin(a) * dist, rr, 0, Math.PI * 2); c.fill();
    }
    c.save(); c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.clip();
    if (img) cobrir(c, img, cx - r, cy - r, d, d, aj); else { c.fillStyle = "rgba(255,255,255,.12)"; c.fillRect(cx - r, cy - r, d, d); }
    c.restore();
    c.lineWidth = 12; c.strokeStyle = COR.roxoClaro; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 4; c.strokeStyle = "rgba(255,255,255,.9)"; c.beginPath(); c.arc(cx, cy, r - 12, 0, Math.PI * 2); c.stroke();
}

// ---------- selo de preço ----------
// s = { topo?, riscado?, grande }  (preço, "3 grátis", copo do dia...)
const seloRotulo = (s) => (s.riscado ? "POR APENAS" : s.topo ? maiusc(s.topo) : "");
function alturaSelo(s, w) {
    if (!s || !s.grande) return 0;
    const e = w / 470;
    return ((s.riscado && s.topo ? 62 : 0) + (seloRotulo(s) ? 215 : 185)) * e;
}

function precoGrande(c, texto, x, y, w, e) {
    c.textAlign = "left"; c.textBaseline = "alphabetic"; c.lineJoin = "round";
    const medir = (t, tam) => { c.font = `400 ${tam}px ${PINCEL}`; return c.measureText(t).width; };
    const pintar = (t, px, py, tam) => {
        c.font = `400 ${tam}px ${PINCEL}`;
        c.lineWidth = tam * 0.07; c.strokeStyle = COR.roxoEscuro; c.strokeText(t, px, py);
        c.fillStyle = COR.roxo; c.fillText(t, px, py);
    };
    const maxW = w - 60 * e;
    const m = /^R\$\s*(\d+)[,.](\d{2})$/.exec(String(texto).trim());
    if (m) { // "R$" pequeno, inteiro grande, centavos elevados
        const partes = (k) => [["R$", 60 * e * k], [m[1], 150 * e * k], ["," + m[2], 92 * e * k]];
        const total = (k) => partes(k).reduce((s, [t, tam]) => s + medir(t, tam), 0) + 18 * e * k;
        const k = Math.min(1, maxW / total(1));
        const [rs, inteiro, cen] = partes(k);
        const base = y + 130 * e;
        let px = x + (w - total(k)) / 2;
        pintar(rs[0], px, base, rs[1]); px += medir(rs[0], rs[1]) + 14 * e * k;
        pintar(inteiro[0], px, base, inteiro[1]); px += medir(inteiro[0], inteiro[1]) + 2 * e * k;
        pintar(cen[0], px, base - 0.72 * (inteiro[1] - cen[1]), cen[1]);
    } else {
        const t = maiusc(texto);
        let tam = 130 * e;
        while (medir(t, tam) > maxW && tam > 30) tam -= 4;
        pintar(t, x + (w - medir(t, tam)) / 2, y + 130 * e, tam);
    }
}

function desenharSelo(c, s, x, y, w) {
    if (!s || !s.grande) return 0;
    const e = w / 470, rot = seloRotulo(s);
    let yy = y;
    c.save();
    if (s.riscado && s.topo) { // preço antigo: "DE R$ 22,90" riscado
        const t = maiusc(s.topo), tx = x + 28 * e;
        c.font = `800 ${42 * e}px ${SANS}`; c.textAlign = "left"; c.textBaseline = "top"; c.fillStyle = "#fff";
        c.fillText(t, tx, yy + 4 * e);
        const tw = c.measureText(t).width;
        c.strokeStyle = COR.rosa; c.lineWidth = 6 * e; c.lineCap = "round";
        c.beginPath(); c.moveTo(tx - 10 * e, yy + 46 * e); c.lineTo(tx + tw + 10 * e, yy + 20 * e); c.stroke();
        yy += 62 * e;
    }
    const bh = (rot ? 215 : 185) * e;
    girar(c, x + w / 2, yy + bh / 2, -0.03, () => {
        pincelada(c, x, yy, w, bh, COR.amarelo, 7, 0);
        if (rot) {
            c.font = `800 ${34 * e}px ${SANS}`; c.fillStyle = "#3b0764"; c.textAlign = "left"; c.textBaseline = "top";
            c.fillText(rot, x + 36 * e, yy + 26 * e);
        }
        precoGrande(c, s.grande, x, yy + (rot ? 66 : 30) * e, w, e);
    });
    c.restore();
    return yy - y + bh;
}

// ---------- cabeçalho: logo + faíscas + frase de abertura ----------
function desenharLogo(c, img, cx, cy, d) {
    const r = d / 2;
    c.save(); c.shadowColor = "rgba(168,85,247,.7)"; c.shadowBlur = 40;
    c.fillStyle = "#12062b"; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    c.restore();
    if (img) {
        c.save(); c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.clip();
        cobrir(c, img, cx - r, cy - r, d, d, { zoom: LOGO_ZOOM });
        c.restore();
    }
    c.lineWidth = 7; c.strokeStyle = COR.roxoClaro; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
}

// k = { estilo: "marker" | "script", l1, l2 }
function frase(c, k, x, cy, larg) {
    const script = k.estilo === "script", fam = script ? SCRIPT : PINCEL;
    const l1 = script ? k.l1 : maiusc(k.l1), l2 = script ? k.l2 : maiusc(k.l2);
    let tam = script ? 88 : 66;
    const medir = () => { c.font = `400 ${tam}px ${fam}`; return Math.max(c.measureText(l1).width, c.measureText(l2).width); };
    while (medir() > larg && tam > 28) tam -= 2;
    const lw = medir();
    c.save();
    c.translate(x, cy); c.rotate(-0.1);
    c.textAlign = "left"; c.textBaseline = "middle"; c.font = `400 ${tam}px ${fam}`;
    c.shadowColor = "rgba(0,0,0,.5)"; c.shadowOffsetX = 3; c.shadowOffsetY = 4;
    c.fillStyle = "#fff"; c.fillText(l1, 0, -tam * 0.5);
    c.fillStyle = script ? COR.roxoClaro : COR.amarelo; c.fillText(l2, 0, tam * 0.55);
    if (script) {
        c.shadowColor = "transparent";
        c.strokeStyle = COR.roxoClaro; c.lineWidth = 5; c.lineCap = "round";
        c.beginPath(); c.moveTo(0, tam * 1.1); c.lineTo(lw, tam * 1.04); c.stroke();
    }
    c.restore();
}

function cabecalho(c, W, logo, topo, d, k) {
    const cx = W / 2, cy = topo + d / 2, r = d / 2;
    c.save(); c.lineCap = "round"; c.lineWidth = 8; c.strokeStyle = COR.amarelo;
    const risco = (a, comp) => {
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * (r + 34), cy + Math.sin(a) * (r + 34));
        c.lineTo(cx + Math.cos(a) * (r + 34 + comp), cy + Math.sin(a) * (r + 34 + comp));
        c.stroke();
    };
    [[-0.95, 44], [-0.6, 54], [-0.25, 40]].forEach(([a, comp]) => { risco(a, comp); risco(Math.PI - a, comp); });
    c.restore();
    desenharLogo(c, logo, cx, cy, d);
    if (k) frase(c, k, 52, cy + d * 0.12, (W - d) / 2 - 52 - 24);
}

// ---------- barra de pedido (rodapé) ----------
function iconeZap(c, x, y, s) {
    c.save();
    c.fillStyle = "#25d366"; c.beginPath(); c.arc(x + s / 2, y + s / 2, s / 2, 0, Math.PI * 2); c.fill();
    c.strokeStyle = "#fff"; c.lineWidth = s * 0.055; c.beginPath(); c.arc(x + s / 2, y + s / 2, s * 0.34, 0, Math.PI * 2); c.stroke();
    c.translate(x + s * 0.31, y + s * 0.31); c.scale((s * 0.38) / 24, (s * 0.38) / 24);
    c.fillStyle = "#fff"; c.fill(new Path2D(FONE_SVG));
    c.restore();
}

function barra(c, W, y, chamada) {
    const x = 50, w = W - 100, h = 140;
    c.save(); c.shadowColor = "rgba(168,85,247,.55)"; c.shadowBlur = 30;
    c.fillStyle = "rgba(14,5,32,.94)"; retArred(c, x, y, w, h, 46); c.fill();
    c.restore();
    c.lineWidth = 4; c.strokeStyle = COR.roxoClaro; retArred(c, x, y, w, h, 46); c.stroke();

    const ic = 92;
    iconeZap(c, x + 34, y + (h - ic) / 2, ic);

    // chamada: tudo menos a última palavra em branco; a última em amarelo, maior
    const palavras = maiusc(chamada).trim().split(/\s+/);
    const ultima = palavras.length > 1 ? palavras.pop() : "";
    const l1 = palavras.join(" ");
    const divX = x + w - 330, tx = x + 150, larg = divX - 24 - tx;
    const montar = (t) => (ultima
        ? [[l1, 800, t, "#fff"], [ultima, 900, t * 1.3, COR.amarelo]]
        : [[l1, 900, t * 1.3, "#fff"]]);
    let t1 = 34;
    const maior = (t) => Math.max(...montar(t).map(([txt, peso, tam]) => { c.font = `${peso} ${tam}px ${SANS}`; return c.measureText(txt).width; }));
    while (maior(t1) > larg && t1 > 16) t1 -= 1;
    const linhas = montar(t1);
    const altTotal = linhas.reduce((s, l) => s + l[2] * 1.12, 0);
    let yy = y + (h - altTotal) / 2;
    c.textAlign = "left"; c.textBaseline = "top";
    linhas.forEach(([txt, peso, tam, cor]) => { c.font = `${peso} ${tam}px ${SANS}`; c.fillStyle = cor; c.fillText(txt, tx, yy); yy += tam * 1.12; });

    // divisória + assinatura manuscrita
    c.strokeStyle = "rgba(168,85,247,.6)"; c.lineWidth = 3;
    c.beginPath(); c.moveTo(divX, y + 28); c.lineTo(divX, y + h - 28); c.stroke();
    const ax = divX + 28, al = x + w - ax - 24;
    let s = 36;
    const medirA = () => { c.font = `400 ${s}px ${SCRIPT}`; return Math.max(c.measureText(ASSINATURA[0]).width, c.measureText(ASSINATURA[1]).width * 1.15); };
    while (medirA() > al && s > 18) s -= 1;
    const altA = s * 1.2 + s * 1.15 * 1.2;
    const ay = y + (h - altA) / 2;
    c.font = `400 ${s}px ${SCRIPT}`; c.fillStyle = "#fff"; c.fillText(ASSINATURA[0], ax, ay);
    c.font = `400 ${s * 1.15}px ${SCRIPT}`; c.fillStyle = COR.amarelo; c.fillText(ASSINATURA[1], ax, ay + s * 1.2);
    c.textBaseline = "top";
}

// ---------- arte completa ----------
// o = { template, formato, titulo, subtitulo, chamada, foto, logo, selo, ajuste, fotos:[{foto,selo,nome,ajuste},{...}] }
export function desenharArte(cv, o) {
    const [W, H] = FORMATOS[o.formato] || FORMATOS.feed;
    const story = o.formato === "story";
    cv.width = W; cv.height = H;
    const c = cv.getContext("2d");
    let id = TEMPLATES.some((x) => x.id === o.template) ? o.template : "disponivel";
    if (id === "dupla" && !(o.fotos && o.fotos.length === 2)) id = "promo";
    const aj = o.ajuste, M = 60;
    const chamada = o.chamada || "Peça pelo site";
    const topo = story ? 260 : 56;       // story: sai da faixa coberta pelo perfil do Instagram
    const rodape = story ? 470 : 210;    // story: sai da faixa coberta pela barra de resposta
    const barY = H - rodape + 20;
    const fim = barY - 28;               // até onde o conteúdo pode descer
    const LG = story ? 230 : 200;        // diâmetro da logo
    const y0 = topo + LG + 36;           // onde começam os títulos
    const cheia = id === "destaque" && o.foto;
    c.textBaseline = "top"; c.textAlign = "left";

    // fundo
    if (cheia) {
        cobrir(c, o.foto, 0, 0, W, H, aj);
        const g = c.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, "rgba(14,5,32,.75)"); g.addColorStop(0.28, "rgba(14,5,32,.10)");
        g.addColorStop(0.55, "rgba(14,5,32,.25)"); g.addColorStop(1, "rgba(7,2,13,.96)");
        c.fillStyle = g; c.fillRect(0, 0, W, H);
    } else {
        fundo(c, W, H);
        decoracao(c, W, barY);
    }

    // cabeçalho
    const abertura = id === "promo" && o.selo ? { estilo: "marker", l1: "Temos", l2: "promoção!" }
        : id === "destaque" ? null : { estilo: "script", l1: "Vem", l2: "que tem!" };
    cabecalho(c, W, o.logo, topo, LG, abertura);

    // título (pincelada roxa) e subtítulo (pincelada amarela)
    const base = { larg: W - 100, cx: W / 2 };
    const opTit = (maxTam, maxAlt) => ({ ...base, cor: COR.roxo, txt: "#fff", maxTam, maxAlt, seed: 11, ang: -0.02 });
    const opSub = (maxTam, maxAlt) => ({ ...base, cor: id === "disponivel" ? COR.ambar : COR.amarelo, txt: COR.roxoEscuro, maxTam, maxAlt, seed: 23, ang: 0.015 });
    const titulos = (y, avail, maxTit, maxSub) => {
        const bTit = avail * 0.58, bSub = avail * 0.42 - 12;
        const pt = medirFaixa(c, o.titulo, opTit(maxTit, bTit));
        let h = 0;
        if (pt) { pintarFaixa(c, y, pt, opTit(maxTit, bTit)); h = pt.bh; }
        const ps = medirFaixa(c, o.subtitulo, opSub(maxSub, bSub));
        if (ps) { pintarFaixa(c, y + h + 12, ps, opSub(maxSub, bSub)); h += 12 + ps.bh; }
        return h;
    };

    if (id === "promo") {
        const h = titulos(y0, fim - y0 - 400, 120, 84);
        const livreY = y0 + h + 24, livreH = fim - livreY;
        if (o.selo) {
            const d = Math.min(W * 0.64, livreH), cx = W - d * 0.36, cy = livreY + livreH / 2;
            fotoCirculo(c, o.foto, cx, cy, d, aj);
            const ws = Math.min(470, cx - d / 2 - M - 14);
            desenharSelo(c, o.selo, M, livreY + (livreH - alturaSelo(o.selo, ws)) / 2, ws);
        } else {
            fotoCirculo(c, o.foto, W / 2, livreY + livreH / 2, Math.min(W - 200, livreH), aj);
        }

    } else if (id === "disponivel") {
        const h = titulos(y0, fim - y0 - 470, 150, 100);
        const livreY = y0 + h + 24, livreH = fim - livreY;
        const d = Math.min(W * 0.86, livreH + 110), cx = W - d * 0.32, cy = fim - d / 2 + 90;
        fotoCirculo(c, o.foto, cx, cy, d, aj);
        frase(c, { estilo: "script", l1: "Do nosso jeito,", l2: "pra você!" }, M, livreY + 70, 340);
        if (o.selo) {
            const ws = 320;
            desenharSelo(c, o.selo, M, fim - alturaSelo(o.selo, ws) - 10, ws);
        }

    } else if (id === "dupla") {
        const opT = { ...opTit(110, 210) };
        const pt = medirFaixa(c, o.titulo, opT);
        let y = y0;
        if (pt) { pintarFaixa(c, y, pt, opT); y += pt.bh + 14; }
        if (o.subtitulo) {
            ajustarLinha(c, o.subtitulo, W - M * 2, 42, 700);
            c.fillStyle = "#fff"; c.textAlign = "center"; c.fillText(o.subtitulo, W / 2, y); c.textAlign = "left";
            y += 58;
        }
        const livreY = y + 10, livreH = fim - livreY;
        const WS = 360;
        const hs = Math.max(alturaSelo(o.fotos[0].selo, WS), alturaSelo(o.fotos[1].selo, WS));
        const d = Math.max(220, Math.min(470, livreH - 56 - hs - 20));
        const gap = Math.max(40, (W - 2 * d) / 3), x1 = (W - 2 * d - gap) / 2;
        const py = livreY + Math.max(0, (livreH - (d + 56 + hs)) / 2);
        o.fotos.forEach((f, i) => {
            const cx = x1 + i * (d + gap) + d / 2;
            fotoCirculo(c, f.foto, cx, py + d / 2, d, f.ajuste || aj);
            c.fillStyle = "#fff"; c.textAlign = "center"; ajustarLinha(c, f.nome || "", d + gap * 0.8, 36, 800);
            c.fillText(f.nome || "", cx, py + d + 18);
            c.textAlign = "left";
            const ws = Math.min(WS, d + 60);
            desenharSelo(c, f.selo, cx - ws / 2, py + d + 68 + (hs - alturaSelo(f.selo, WS)), ws);
        });

    } else { // destaque: foto cheia no fundo, textos empilhados logo acima da barra
        const opT = opTit(120, story ? 260 : 230), opS = opSub(84, story ? 200 : 170);
        const pt = medirFaixa(c, o.titulo, opT), ps = medirFaixa(c, o.subtitulo, opS);
        const alt = (pt ? pt.bh : 0) + (ps ? (pt ? 12 : 0) + ps.bh : 0);
        const y = fim - alt;
        if (pt) pintarFaixa(c, y, pt, opT);
        if (ps) pintarFaixa(c, y + (pt ? pt.bh + 12 : 0), ps, opS);
        if (o.selo) { const ws = 340; desenharSelo(c, o.selo, M, y - alturaSelo(o.selo, ws) - 22, ws); }
    }

    barra(c, W, barY, chamada);
}
