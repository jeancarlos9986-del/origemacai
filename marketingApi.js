// ==================================================
// 📣 MARKETING COM IA — rota POST /marketing/plano
// ==================================================
// Uso no server.js (logo DEPOIS de app.use(bodyParser.json())):
//   require('./marketingApi')(app, admin, db, fetch);
// Variável de ambiente no Render: ANTHROPIC_API_KEY
//
// O servidor lê sozinho do Firebase: promoções (painel + cardápio), vendas dos últimos 7 dias
// e os últimos temas já usados. O navegador só manda a temperatura.

const MODELO = 'claude-haiku-4-5-20251001';
const PERFIS_PERMITIDOS = ['admin', 'marketing'];
const INTERVALO_MIN_MS = 15 * 1000;
const LIMITE_POR_DIA = 20;
const HORA_ABRE = 14;   // confira com o HORARIO_FUNCIONAMENTO do site.html
const HORA_FECHA = 22;
const STATUS_VENDIDO = ['concluido', 'finalizado', 'pronto', 'entregue'];
const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

const SISTEMA = `Você é o social media da Nova Origem Açaí, um delivery de açaí numa cidade pequena do interior de Minas Gerais (cerca de 3 mil habitantes). Os pedidos são feitos pelo site da loja.
Seu trabalho: montar o plano de conteúdo do dia para Instagram (1 post de feed e 3 momentos de stories).
Regras:
- Português do Brasil, tom próximo e acolhedor, como quem fala com vizinho. Nada de exagero nem de gíria forçada.
- Use só as informações recebidas. Nunca invente preço, desconto, produto ou horário que não estejam no contexto.
- Cada oferta tem o seu próprio preço. Cite os preços exatamente como vieram e nunca aplique o preço de um produto a outro.
- A loja é só delivery, sem salão nem balcão: não sugira fotos do interior da loja, da fachada ou de clientes sentados.
- A loja só funciona no horário informado. Não sugira conteúdo que dê a entender que ela está atendendo fora desse horário. Nomeie os momentos dos stories de acordo com o horário (por exemplo: "Antes de abrir", "Tarde", "Noite").
- Se houver oferta ativa, ela é o centro do dia. Se não houver, escolha um tema ligado ao dia da semana, ao clima ou aos produtos mais pedidos.
- Os produtos mais pedidos são só uma dica de destaque: pode chamar de "queridinho dos clientes", mas nunca cite números de vendas.
- Não repita nenhum dos temas recentes que vierem no contexto, nem o ângulo deles.
- Cidade pequena: vale incentivar indicação para amigos e vizinhos e citar a cidade, sem prometer nada.
- Legenda do feed com no máximo 4 linhas e no máximo 3 emojis, sem hashtags em excesso.
- Cada ideia de story deve ser algo que o dono consegue fotografar ou gravar com o celular em poucos minutos.
- Também crie o texto da arte (imagem) do dia: "titulo" curto e chamativo com no máximo 30 caracteres e sem emoji; "subtitulo" com no máximo 50 caracteres (pode ficar vazio); "chamada" com no máximo 24 caracteres (por exemplo "Peça pelo site"). Se houver preço de oferta, não o escreva no título nem no subtítulo, porque o selo de preço é desenhado à parte.
- "produto" deve ser o nome exato de um produto das ofertas ativas ou dos mais pedidos, ou vazio.
Responda SOMENTE com JSON válido, sem texto antes ou depois, neste formato:
{"tema":"...","legendaFeed":"...","sugestaoFoto":"...","produto":"...","arte":{"titulo":"...","subtitulo":"...","chamada":"..."},"stories":[{"momento":"Manhã","ideia":"..."},{"momento":"Tarde","ideia":"..."},{"momento":"Noite","ideia":"..."}]}`;

const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const reais = (n) => `R$ ${Number(n).toFixed(2).replace('.', ',')}`;

// Render roda em UTC: aqui o "agora" é sempre o horário de Brasília
function agoraBR() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

async function lerOfertas(db, diaNum) {
    const ofertas = [], banners = [];
    const snap = await db.collection('configuracoes').doc('loja').get();
    const cfg = snap.exists ? snap.data() : {};
    const lista = Array.isArray(cfg.promocoes) && cfg.promocoes.length ? cfg.promocoes : (cfg.promocao ? [cfg.promocao] : []);
    lista.filter(p => p && p.ativa && (!p.diasSemana || !p.diasSemana.length || p.diasSemana.includes(diaNum))).forEach(p => {
        const nome = texto(p.produtoNome, 80);
        if (p.tipo === 'preco' && Number.isFinite(p.precoPromocional)) ofertas.push(`${nome} por ${reais(p.precoPromocional)}`);
        else if (p.tipo === 'copoFixo' && Number.isFinite(p.precoPromocional)) ofertas.push(`Copo do dia (${nome}, receita pronta) por ${reais(p.precoPromocional)}`);
        else if (p.tipo === 'limiteGratis' && Number.isFinite(p.limiteGratisPromocional)) ofertas.push(`${nome} com até ${p.limiteGratisPromocional} adicionais grátis (sem mudança de preço)`);
        else if (nome) ofertas.push(`${nome} em promoção (sem detalhe de preço)`);
        if (texto(p.etiqueta, 120)) banners.push(texto(p.etiqueta, 120));
    });
    const prods = await db.collection('cardapio_produtos').get();
    prods.forEach(d => {
        const p = d.data();
        const original = Number(p.preco), promo = Number(p.precoPromocional);
        if ((p.status || 'disponivel') !== 'esgotado' && p.nome && promo > 0 && promo < original)
            ofertas.push(`${texto(p.nome, 80)} de ${reais(original)} por ${reais(promo)}`);
    });
    return { ofertas: ofertas.slice(0, 8), banners };
}

async function lerMaisPedidos(db) {
    const desde = Date.now() - 7 * 24 * 3600 * 1000;
    const snap = await db.collection('pedidos').where('criadoEm', '>=', desde).limit(500).get();
    const cont = new Map();
    snap.forEach(d => {
        const p = d.data();
        if (!STATUS_VENDIDO.includes(p.status)) return;
        (p.itens || []).forEach(i => { if (i && i.nome) cont.set(i.nome, (cont.get(i.nome) || 0) + 1); });
    });
    return [...cont.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([nome]) => nome);
}

async function lerTemasRecentes(db) {
    const snap = await db.collection('marketing_planos').orderBy('criadoEm', 'desc').limit(7).get();
    return snap.docs.map(d => d.data().tema).filter(Boolean);
}

function extrairJson(textoIA) {
    const limpo = String(textoIA).replace(/```json|```/g, '').trim();
    const ini = limpo.indexOf('{'), fim = limpo.lastIndexOf('}');
    if (ini === -1 || fim === -1) throw new Error('Resposta da IA sem JSON');
    const plano = JSON.parse(limpo.slice(ini, fim + 1));
    if (!plano.tema || !plano.legendaFeed || !Array.isArray(plano.stories)) throw new Error('JSON da IA incompleto');
    return {
        tema: String(plano.tema),
        legendaFeed: String(plano.legendaFeed),
        sugestaoFoto: String(plano.sugestaoFoto || ''),
        produto: String(plano.produto || '').slice(0, 80),
        arte: {
            titulo: String((plano.arte && plano.arte.titulo) || plano.tema).slice(0, 40),
            subtitulo: String((plano.arte && plano.arte.subtitulo) || '').slice(0, 60),
            chamada: String((plano.arte && plano.arte.chamada) || 'Peça pelo site').slice(0, 30)
        },
        stories: plano.stories.slice(0, 5).map(s => ({ momento: String(s.momento || ''), ideia: String(s.ideia || '') }))
    };
}

module.exports = function registrarRotaMarketing(app, admin, db, fetch) {

    async function chamarIA(contexto) {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: MODELO, max_tokens: 1000, system: SISTEMA, messages: [{ role: 'user', content: contexto }] })
        });
        if (!r.ok) { const e = new Error('IA ' + r.status); e.http = true; console.error('❌ IA respondeu', r.status, await r.text()); throw e; }
        const dados = await r.json();
        return (dados.content || []).map(c => c.text || '').join('');
    }

    app.post('/marketing/plano', async (req, res) => {
        try {
            // 1) Login e perfil
            const cab = req.headers.authorization || '';
            const idToken = cab.startsWith('Bearer ') ? cab.slice(7) : null;
            if (!idToken) return res.status(401).json({ erro: 'Faça login para gerar o plano.' });
            let uid;
            try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
            catch (e) { return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' }); }

            const perfilSnap = await db.collection('usuarios').doc(uid).get();
            const perfil = perfilSnap.exists ? perfilSnap.data() : null;
            if (!perfil || perfil.ativo === false || !PERFIS_PERMITIDOS.includes(perfil.perfil))
                return res.status(403).json({ erro: 'Sem permissão para o marketing.' });

            // 2) Limites de uso, guardados no Firebase (não zeram quando o servidor dorme)
            const agoraMs = Date.now();
            const br = agoraBR();
            const hojeChave = `${br.getFullYear()}-${br.getMonth() + 1}-${br.getDate()}`;
            const usoRef = db.collection('marketing_uso').doc(uid);
            const usoSnap = await usoRef.get();
            const u = usoSnap.exists ? usoSnap.data() : {};
            const qtd = u.dia === hojeChave ? (u.qtd || 0) : 0;
            if (agoraMs - (u.ultimo || 0) < INTERVALO_MIN_MS) return res.status(429).json({ erro: 'Aguarde alguns segundos antes de gerar de novo.' });
            if (qtd >= LIMITE_POR_DIA) return res.status(429).json({ erro: `Limite de ${LIMITE_POR_DIA} planos por dia atingido.` });
            if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ erro: 'IA ainda não configurada no servidor.' });
            await usoRef.set({ dia: hojeChave, qtd, ultimo: agoraMs }); // marca já, para dois cliques seguidos não gastarem duas vezes

            // 3) Contexto montado pelo servidor
            const corpo = req.body || {};
            const diaNum = br.getDay();
            const temp = Number.isFinite(corpo.temperatura) ? Math.round(corpo.temperatura) : null;
            const [of, top, temas] = await Promise.all([
                lerOfertas(db, diaNum),
                lerMaisPedidos(db).catch(e => { console.error('vendas:', e.message); return []; }),
                lerTemasRecentes(db).catch(e => { console.error('histórico:', e.message); return []; })
            ]);

            const linhas = [`Dia da semana: ${DIAS[diaNum]}.`, `Horário de funcionamento: das ${HORA_ABRE}h às ${HORA_FECHA}h, todos os dias.`,
                temp === null ? 'Temperatura: não informada.' : `Temperatura agora: ${temp}°C.`];
            if (of.banners.length) linhas.push(`Texto do banner do site: ${of.banners.join(' • ')}.`);
            if (of.ofertas.length) { linhas.push('Ofertas ativas hoje (cada preço vale só para o produto citado):'); of.ofertas.forEach(o => linhas.push(`- ${o}`)); }
            else linhas.push('Ofertas ativas hoje: nenhuma.');
            if (top.length) linhas.push(`Produtos mais pedidos na última semana: ${top.join(', ')}.`);
            if (temas.length) { linhas.push('Temas dos últimos posts (NÃO repetir):'); temas.forEach(t => linhas.push(`- ${texto(t, 100)}`)); }
            if (corpo.outra && texto(corpo.temaAnterior, 100)) linhas.push(`O dono pediu OUTRA VERSÃO. O tema que ele não quis foi "${texto(corpo.temaAnterior, 100)}". Use outro tema e outro ângulo.`);
            const contexto = `Contexto de hoje:\n${linhas.join('\n')}`;

            // 4) IA, com uma segunda tentativa se o JSON vier quebrado
            let plano;
            for (let tentativa = 1; tentativa <= 2; tentativa++) {
                try { plano = extrairJson(await chamarIA(contexto)); break; }
                catch (e) { if (e.http || tentativa === 2) throw e; console.warn('JSON inválido, tentando de novo'); }
            }

            await usoRef.set({ dia: hojeChave, qtd: qtd + 1, ultimo: agoraMs });
            db.collection('marketing_planos').add({ criadoEm: agoraMs, tema: plano.tema, legendaFeed: plano.legendaFeed, produto: plano.produto })
                .catch(e => console.error('histórico não salvo:', e.message));

            res.json(plano);

        } catch (erro) {
            console.error('❌ Erro em /marketing/plano:', erro.message);
            if (erro.http) return res.status(502).json({ erro: 'A IA não respondeu agora. Tente de novo em instantes.' });
            res.status(500).json({ erro: 'Não foi possível gerar o plano agora.' });
        }
    });
};
