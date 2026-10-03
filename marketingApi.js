// ==================================================
// 📣 MARKETING COM IA — rota POST /marketing/plano
// ==================================================
// Uso no server.js (logo DEPOIS de app.use(bodyParser.json())):
//   require('./marketingApi')(app, admin, db, fetch);
//
// Variável de ambiente necessária no Render: ANTHROPIC_API_KEY

const MODELO = 'claude-haiku-4-5-20251001'; // rápido e barato, suficiente para esta tarefa
const PERFIS_PERMITIDOS = ['admin', 'marketing'];
const INTERVALO_MIN_MS = 15 * 1000; // espera mínima entre dois pedidos do mesmo usuário
const LIMITE_POR_DIA = 20;          // teto de planos por usuário por dia (controla o custo)

const DIAS = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const uso = new Map(); // uid -> { ultimo, dia, qtd }  (zera quando o servidor reinicia)

const SISTEMA = `Você é o social media da Nova Origem Açaí, um delivery de açaí numa cidade pequena do interior de Minas Gerais (cerca de 3 mil habitantes). Os pedidos são feitos pelo site da loja.
Seu trabalho: montar o plano de conteúdo do dia para Instagram (1 post de feed e 3 momentos de stories).
Regras:
- Português do Brasil, tom próximo e acolhedor, como quem fala com vizinho. Nada de exagero nem de gíria forçada.
- Use só as informações recebidas. Nunca invente preço, desconto, produto ou horário que não estejam no contexto.
- Se houver promoção ativa, ela é o centro do dia. Se não houver, escolha um tema ligado ao dia da semana e ao clima.
- Cidade pequena: vale incentivar indicação para amigos e vizinhos e citar a cidade, sem prometer nada.
- Legenda do feed com no máximo 4 linhas e no máximo 3 emojis, sem hashtags em excesso.
- Cada ideia de story deve ser algo que o dono consegue fotografar ou gravar com o celular em poucos minutos.
Responda SOMENTE com JSON válido, sem texto antes ou depois, neste formato:
{"tema":"...","legendaFeed":"...","sugestaoFoto":"...","stories":[{"momento":"Manhã","ideia":"..."},{"momento":"Tarde","ideia":"..."},{"momento":"Noite","ideia":"..."}]}`;

function texto(v, max) {
    return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function montarContexto(corpo) {
    const dia = DIAS.includes(corpo.dia) ? corpo.dia : DIAS[new Date().getDay()];
    const temp = Number.isFinite(corpo.temperatura) ? Math.round(corpo.temperatura) : null;
    const p = corpo.promocao && typeof corpo.promocao === 'object' ? corpo.promocao : null;

    const linhas = [`Dia da semana: ${dia}.`];
    linhas.push(temp === null ? 'Temperatura: não informada.' : `Temperatura agora: ${temp}°C.`);
    if (p) {
        linhas.push(`Promoção ativa: ${texto(p.etiqueta, 80) || texto(p.produtoNome, 80)}.`);
        if (texto(p.produtoNome, 80)) linhas.push(`Produto da promoção: ${texto(p.produtoNome, 80)}.`);
        if (Number.isFinite(p.precoPromocional)) linhas.push(`Preço promocional: R$ ${p.precoPromocional.toFixed(2).replace('.', ',')}.`);
    } else {
        linhas.push('Promoção ativa: nenhuma hoje.');
    }
    return linhas.join('\n');
}

function extrairJson(textoIA) {
    const limpo = String(textoIA).replace(/```json|```/g, '').trim();
    const ini = limpo.indexOf('{');
    const fim = limpo.lastIndexOf('}');
    if (ini === -1 || fim === -1) throw new Error('Resposta da IA sem JSON');
    const plano = JSON.parse(limpo.slice(ini, fim + 1));
    if (!plano.tema || !plano.legendaFeed || !Array.isArray(plano.stories)) throw new Error('JSON da IA incompleto');
    return {
        tema: String(plano.tema),
        legendaFeed: String(plano.legendaFeed),
        sugestaoFoto: String(plano.sugestaoFoto || ''),
        stories: plano.stories.slice(0, 5).map(s => ({ momento: String(s.momento || ''), ideia: String(s.ideia || '') }))
    };
}

module.exports = function registrarRotaMarketing(app, admin, db, fetch) {

    app.post('/marketing/plano', async (req, res) => {
        try {
            // 1) Só entra quem está logado e tem perfil de marketing/admin
            const cab = req.headers.authorization || '';
            const idToken = cab.startsWith('Bearer ') ? cab.slice(7) : null;
            if (!idToken) return res.status(401).json({ erro: 'Faça login para gerar o plano.' });

            let uid;
            try {
                uid = (await admin.auth().verifyIdToken(idToken)).uid;
            } catch (e) {
                return res.status(401).json({ erro: 'Sessão expirada. Entre novamente.' });
            }

            const perfilSnap = await db.collection('usuarios').doc(uid).get();
            const perfil = perfilSnap.exists ? perfilSnap.data() : null;
            if (!perfil || perfil.ativo === false || !PERFIS_PERMITIDOS.includes(perfil.perfil)) {
                return res.status(403).json({ erro: 'Sem permissão para o marketing.' });
            }

            // 2) Limites de uso (protegem o custo da IA)
            const agora = Date.now();
            const hoje = new Date().toISOString().slice(0, 10);
            const u = uso.get(uid) || { ultimo: 0, dia: hoje, qtd: 0 };
            if (u.dia !== hoje) { u.dia = hoje; u.qtd = 0; }
            if (agora - u.ultimo < INTERVALO_MIN_MS) {
                return res.status(429).json({ erro: 'Aguarde alguns segundos antes de gerar de novo.' });
            }
            if (u.qtd >= LIMITE_POR_DIA) {
                return res.status(429).json({ erro: `Limite de ${LIMITE_POR_DIA} planos por dia atingido.` });
            }

            if (!process.env.ANTHROPIC_API_KEY) {
                return res.status(503).json({ erro: 'IA ainda não configurada no servidor.' });
            }

            // 3) Chama a IA
            const resposta = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': process.env.ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: MODELO,
                    max_tokens: 900,
                    system: SISTEMA,
                    messages: [{ role: 'user', content: `Contexto de hoje:\n${montarContexto(req.body || {})}` }]
                })
            });

            if (!resposta.ok) {
                console.error('❌ IA respondeu', resposta.status, await resposta.text());
                return res.status(502).json({ erro: 'A IA não respondeu agora. Tente de novo em instantes.' });
            }

            const dados = await resposta.json();
            const plano = extrairJson((dados.content || []).map(c => c.text || '').join(''));

            u.ultimo = agora;
            u.qtd += 1;
            uso.set(uid, u);

            res.json(plano);

        } catch (erro) {
            console.error('❌ Erro em /marketing/plano:', erro.message);
            res.status(500).json({ erro: 'Não foi possível gerar o plano agora.' });
        }
    });
};
