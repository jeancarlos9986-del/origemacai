const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();

// ==================================================
// 🔴 CORS
// ==================================================
// 🆕 Além do site em produção, libera os endereços locais mais comuns do
// Live Server / VS Code, só pra dar pra testar antes de subir o site.html
// de verdade. Quando o site já estiver publicado, pode remover as origens
// "127.0.0.1" e "localhost" daqui se quiser deixar mais restrito.
const ORIGENS_PERMITIDAS = [
    'https://jeancarlos9986-del.github.io',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://127.0.0.1:5501',
    'http://localhost:5501'
];

app.use((req, res, next) => {

    const origem = req.headers.origin;
    if (ORIGENS_PERMITIDAS.includes(origem)) {
        res.header('Access-Control-Allow-Origin', origem);
    }

    res.header(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    );

    res.header(
        'Access-Control-Allow-Headers',
        'Origin, X-Requested-With, Content-Type, Accept, Authorization'
    );

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }

    next();
});

// ==================================================
// 🧪 ROTA DE TESTE CORS
// ==================================================
app.get('/teste', (req, res) => {
    res.json({
        sucesso: true,
        mensagem: 'Servidor online e CORS funcionando!'
    });
});

// ✅ CONFIGURAÇÃO DO FIREBASE
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

app.use(bodyParser.json());

// ✅ SUAS CHAVES
const MP_TOKEN = process.env.MP_TOKEN || "APP_USR-2553785228948600-060911-65330e84299bb43e1f81d3902c4c1a11-293452112";
const WHATSAPP = "5534997741051";

// 🚀 ROTA PARA GERAR O PIX
app.post('/gerar-pix', async (req, res) => {
    try {

        console.log("📥 Requisição recebida em /gerar-pix");

        const { total, descricao, email, nome } = req.body;

        const idempotencyKey =
            "pedido-" +
            Date.now() +
            "-" +
            Math.random().toString(36).substr(2, 5);

        const resposta = await fetch(
            "https://api.mercadopago.com/v1/payments",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${MP_TOKEN}`,
                    "Content-Type": "application/json",
                    "X-Idempotency-Key": idempotencyKey
                },
                body: JSON.stringify({
                    transaction_amount: Number(total.toFixed(2)),
                    description: descricao,
                    payment_method_id: "pix",
                    payer: {
                        email,
                        first_name: nome.substring(0, 15)
                    },
                    // 🆕 Garante que ESTE pagamento específico sempre avise nosso /webhook,
                    // independente de como está configurado o webhook geral da conta no
                    // painel do Mercado Pago (que pode estar avisando só a criação, não a
                    // aprovação — foi o que aconteceu no teste: só chegou "payment.created").
                    notification_url: "https://origemacai.onrender.com/webhook",
                    date_of_expiration:
                        new Date(
                            Date.now() + 30 * 60000
                        ).toISOString()
                })
            }
        );

        const dados = await resposta.json();

        console.log("📤 Resposta Mercado Pago:", dados);

        if (
            dados.id &&
            (
                dados.status === "pending" ||
                dados.status === "in_process"
            )
        ) {

            return res.json({
                sucesso: true,
                idPagamento: dados.id,
                codigoPix:
                    dados.point_of_interaction
                        ?.transaction_data
                        ?.qr_code,
                imagemPix:
                    dados.point_of_interaction
                        ?.transaction_data
                        ?.qr_code_base64
            });
        }

        return res.json({
            sucesso: false,
            erro:
                dados.message ||
                dados.error ||
                "Erro ao gerar pagamento"
        });

    } catch (erro) {

        console.error(
            "❌ ERRO AO GERAR PIX:",
            erro
        );

        return res.status(500).json({
            sucesso: false,
            erro: erro.message
        });
    }
});
app.get('/verificar-pagamento/:id', async (req, res) => {
    try {
        const paymentId = req.params.id;

        const resposta = await fetch(
            `https://api.mercadopago.com/v1/payments/${paymentId}`,
            {
                headers: { Authorization: `Bearer ${MP_TOKEN}` }
            }
        );

        const dados = await resposta.json();
        res.json({
            status: dados.status,
            pago: dados.status === 'approved'
        });
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});


// ⏳ Espera alguns milissegundos (usado no retry abaixo)
function esperar(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 🔎 Procura o pedido pelo id_pagamento_mp, tentando de novo algumas vezes.
// Isso existe porque o site.html grava o pedido no Firestore SÓ DEPOIS de
// receber a resposta do /gerar-pix. Se o cliente pagar muito rápido (PIX
// aprovado quase instantaneamente), o webhook do Mercado Pago pode chegar
// AQUI antes daquele addDoc terminar. Sem retry, a busca dá "vazia" e o
// pagamento fica perdido (é o bug do "às vezes fica aguardando_pagamento").
async function buscarPedidoComRetry(paymentId, tentativas = 6, intervaloMs = 2000) {
    const pedidosRef = db.collection("pedidos");
    for (let i = 0; i < tentativas; i++) {
        const resultado = await pedidosRef
            .where("id_pagamento_mp", "==", Number(paymentId))
            .get();

        if (!resultado.empty) {
            let idDoDocumento = null;
            resultado.forEach((doc) => { idDoDocumento = doc.id; });
            return idDoDocumento;
        }

        console.log(`⏳ Pedido do pagamento ${paymentId} ainda não existe no Firestore (tentativa ${i + 1}/${tentativas}). Aguardando...`);
        await esperar(intervaloMs);
    }
    return null;
}

// 🚨 ROTA DO WEBHOOK
app.post('/webhook', async (req, res) => {
    try {

        const { action, data, type } = req.body;

        // 🆕 Aceita tanto "payment.updated" quanto "payment.created": em pagamentos
        // PIX aprovados muito rápido, o Mercado Pago às vezes só manda o evento de
        // criação já com o status "approved", sem mandar um "updated" depois.
        const ehEventoDePagamento =
            action === 'payment.updated' ||
            action === 'payment.created' ||
            type === 'payment';

        if (ehEventoDePagamento && data?.id) {

            const paymentId = data.id;

            console.log(
                "🔔 Recebido aviso do Mercado Pago ID:",
                paymentId,
                "| action:", action
            );

            const resposta = await fetch(
                `https://api.mercadopago.com/v1/payments/${paymentId}`,
                {
                    headers: {
                        Authorization: `Bearer ${MP_TOKEN}`
                    }
                }
            );

            const dadosPagamento =
                await resposta.json();

            if (
                dadosPagamento.status === 'approved'
            ) {

                const pedidosRef =
                    db.collection("pedidos");

                const idDoDocumento = await buscarPedidoComRetry(paymentId);

                if (!idDoDocumento) {
                    // 🆕 Não confirma 200 aqui: se não achamos o pedido nem depois do
                    // retry, respondemos erro de propósito. Assim o Mercado Pago
                    // reenvia esse mesmo webhook automaticamente mais tarde (ele tenta
                    // de novo por conta própria quando recebe algo diferente de 2xx),
                    // em vez de desistir para sempre do pagamento.
                    console.error(`❌ Pedido do pagamento ${paymentId} não encontrado mesmo após retry.`);
                    return res.status(404).send("Pedido não encontrado - aguardando novo retry do Mercado Pago");
                }

                // 🆕 Idempotência: se já estava confirmado, não faz nada de novo
                // (evita reprocessar fidelidade/estoque se o MP reenviar o mesmo evento)
                const docRef = pedidosRef.doc(idDoDocumento);
                const docAtual = await docRef.get();
                if (docAtual.data()?.status !== "aguardando_pagamento") {
                    console.log("ℹ️ Pedido já estava confirmado, ignorando webhook duplicado.");
                    return res.sendStatus(200);
                }

                await docRef.update({
                    status: "novo",
                    data_pagamento: new Date()
                });

                console.log(
                    "✅ Pedido atualizado:",
                    idDoDocumento
                );
            }
        }

        res.sendStatus(200);

    } catch (erro) {

        console.error(
            "❌ ERRO WEBHOOK:",
            erro
        );

        res.sendStatus(500);
    }
});

app.use(express.static('public'));

// ==================================================
// 🆕 REDE DE SEGURANÇA: reconciliação automática
// ==================================================
// Não depende do webhook chegar. A cada 1 minuto, verifica direto na API do
// Mercado Pago todos os pedidos parados em "aguardando_pagamento" e confirma
// os que já foram aprovados. Isso cobre o caso do teste de hoje: o Mercado
// Pago avisou só a CRIAÇÃO do pagamento (payment.created) e nunca avisou a
// APROVAÇÃO — então o webhook nunca teve chance de agir.
const DUAS_HORAS_MS = 2 * 60 * 60 * 1000;

async function reconciliarPagamentosPendentes() {
    try {
        const agora = Date.now();

        const snap = await db.collection("pedidos")
            .where("status", "==", "aguardando_pagamento")
            .get();

        if (snap.empty) return;

        for (const docSnap of snap.docs) {
            const pedido = docSnap.data();

            if (!pedido.id_pagamento_mp) {
                console.log(`⚠️ (reconciliação) Pedido ${docSnap.id} está "aguardando_pagamento" mas SEM id_pagamento_mp salvo — não dá pra checar esse aqui.`);
                continue;
            }

            // 🆕 Não fica checando pra sempre pedidos muito antigos (provavelmente
            // abandonados/expirados) — evita gastar chamadas de API à toa.
            if (pedido.criadoEm && (agora - pedido.criadoEm) > DUAS_HORAS_MS) continue;

            try {
                const resposta = await fetch(
                    `https://api.mercadopago.com/v1/payments/${pedido.id_pagamento_mp}`,
                    { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
                );

                const dadosPagamento = await resposta.json();

                // 🆕 Log de TODA checagem, não só quando aprova — pra sabermos o
                // que o Mercado Pago está realmente respondendo (pending, rejected,
                // erro de autenticação, etc), e não ficarmos no escuro.
                console.log(
                    `🔎 (reconciliação) Pedido ${docSnap.id} | pagamento ${pedido.id_pagamento_mp} | status MP: ${dadosPagamento.status || 'ERRO: ' + JSON.stringify(dadosPagamento)}`
                );

                if (dadosPagamento.status === 'approved') {
                    await docSnap.ref.update({
                        status: "novo",
                        data_pagamento: new Date()
                    });
                    console.log(`✅ (checagem automática) Pedido ${docSnap.id} confirmado — o webhook não tinha avisado sozinho.`);
                }
            } catch (erroIndividual) {
                console.error(`❌ Erro ao checar pagamento ${pedido.id_pagamento_mp} na reconciliação:`, erroIndividual.message);
            }
        }
    } catch (erro) {
        console.error("❌ Erro na reconciliação periódica de pagamentos:", erro);
    }
}

setInterval(reconciliarPagamentosPendentes, 60 * 1000);

// ==================================================
// 🆕 BAIXA AUTOMÁTICA DE ESTOQUE (independente do navegador)
// ==================================================
// Antes, isso só rodava enquanto alguém deixava a aba do estoque.html aberta
// no navegador — se a aba estivesse fechada, os pedidos ficavam marcados como
// "já processados" (pra não descontar retroativo) SEM nunca ter descontado de
// verdade. Rodando aqui no servidor, que fica sempre ligado, isso não depende
// de ninguém deixar tela nenhuma aberta.
//
// 🆕 A pedido do dono da loja: também processa retroativamente os pedidos que
// já estavam concluidos/prontos e nunca tiveram baixa (a flag "estoqueBaixado"
// impede reprocessar o que já foi descontado, então isso roda uma única vez
// por pedido, com segurança).

function normEstoque(nome) {
    return (nome || "").toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function pegarCampoEstoque(item, nomes) {
    for (const nome of nomes) { if (item[nome] !== undefined) return item[nome]; }
    return 0;
}

const CONSUMO_ESTOQUE = {
    "400ml": { acai: 0.28 },
    "500ml": { acai: 0.32 },
    "Nutella": { qtd: 0.03 },
    "Morango": { qtd: 0.03 },
    "Granola": { qtd: 0.02 },
    "Leite em pó": { qtd: 0.02 },
    "Leite condensado": { qtd: 0.02 },
    "Paçoca": { qtd: 0.02 },
    "Banana": { qtd: 0.03 },
    "Disquete": { qtd: 0.01 },
    "Kit Kat": { qtd: 0.01 },
    "Ouro Branco": { qtd: 0.01 },
    "Sonho de Valsa": { qtd: 0.01 },
    "Chocoball": { qtd: 0.01 },
    "Amendoim": { qtd: 0.02 },
    "Shake Açai Tradicional 500ml": { acai: 0.30, "Leite": 0.10, "Leite em pó": 0.025 },
    "Ovomaltine": { qtd: 0.02 }
};

function calcularNecessidadesEstoque(itens) {
    const nec = new Map();
    const add = (nome, qtd) => {
        if (!qtd || qtd <= 0) return;
        const chave = normEstoque(nome);
        const atual = nec.get(chave);
        nec.set(chave, { nome, qtd: (atual?.qtd || 0) + qtd });
    };
    itens.forEach(item => {
        const copo = normEstoque(item.nome).includes("400") ? "400ml" : "500ml";
        add("Açaí", CONSUMO_ESTOQUE[copo].acai);
        add(`Copo ${copo}`, 1);
        add("Tampa", 1);
        add("Colher", 1);
        add("Guardanapo", 1);
        let ads = [];
        ["gratis", "pagos", "adicionais"].forEach(c => { if (Array.isArray(item[c])) ads.push(...item[c]); });
        ads = [...new Set(ads.map(a => typeof a === "object" ? a.nome || "" : String(a || "")).filter(Boolean))];
        ads.forEach(ad => {
            const achou = Object.keys(CONSUMO_ESTOQUE).find(ch => normEstoque(ch) === normEstoque(ad));
            if (achou && CONSUMO_ESTOQUE[achou].qtd) add(achou, CONSUMO_ESTOQUE[achou].qtd);
        });
    });
    if (itens.length === 1) { add("Sacola 1 copo", 1); add("Porta-copo 1 copo", 1); }
    else if (itens.length > 1) { add("Sacola 2+ copos", 1); add("Porta-copo 2+ copos", 1); }
    return nec;
}

async function construirMapaEstoque() {
    const snap = await db.collection("estoque").get();
    const mapa = new Map();
    snap.forEach(d => mapa.set(normEstoque(d.data().nome), { ref: db.collection("estoque").doc(d.id), nome: d.data().nome }));
    return mapa;
}

async function processarPedidoEstoqueSeguro(pedidoId, mapaEstoque) {
    let faltas = [];
    let consumos = [];

    await db.runTransaction(async tx => {
        faltas = []; consumos = [];
        const pedidoRef = db.collection("pedidos").doc(pedidoId);
        const pedidoSnap = await tx.get(pedidoRef);
        if (!pedidoSnap.exists) return;
        const pedido = pedidoSnap.data();
        if (pedido.estoqueBaixado) return;

        const necessidades = [...calcularNecessidadesEstoque(pedido.itens || []).entries()]
            .map(([chave, v]) => ({ chave, ...v, info: mapaEstoque.get(chave) }));

        const leituras = [];
        for (const nec of necessidades) {
            leituras.push({ ...nec, snap: nec.info ? await tx.get(nec.info.ref) : null });
        }

        for (const L of leituras) {
            if (!L.info || !L.snap || !L.snap.exists) { faltas.push(L.nome); continue; }
            const atual = Number(pegarCampoEstoque(L.snap.data(), ["quantidade", "qtd", "quant"]));
            const nova = Number((atual - L.qtd).toFixed(4));
            tx.update(L.info.ref, { quantidade: Math.max(0, nova), atualizadoEm: new Date() });
            consumos.push({ nome: L.info.nome, qtd: L.qtd });
            if (nova < 0) faltas.push(L.info.nome);
        }

        tx.update(pedidoRef, faltas.length ? { estoqueBaixado: true, estoqueAlertaFalta: faltas } : { estoqueBaixado: true });
    });

    for (const c of consumos) {
        await db.collection("movimentacoes").add({
            nomeItem: c.nome, tipo: "saida", quantidade: c.qtd, observacao: `Pedido #${pedidoId.slice(-4)}`, data: new Date()
        }).catch(e => console.error("❌ Falha ao registrar movimentação de estoque:", e.message));
    }
    if (faltas.length) {
        console.warn(`⚠️ Estoque negativo ao processar pedido #${pedidoId.slice(-4)}: ${faltas.join(", ")}`);
    } else if (consumos.length) {
        console.log(`📦 Estoque baixado automaticamente para o pedido #${pedidoId.slice(-4)}`);
    }
}

function monitorarEstoque() {
    db.collection("pedidos")
        .where("status", "in", ["concluido", "finalizado", "pronto"])
        .onSnapshot(async snap => {
            const pendentes = snap.docChanges()
                .filter(c => (c.type === "added" || c.type === "modified") && !c.doc.data().estoqueBaixado)
                .map(c => c.doc.id);
            if (!pendentes.length) return;

            const mapaEstoque = await construirMapaEstoque();
            for (const id of pendentes) {
                try { await processarPedidoEstoqueSeguro(id, mapaEstoque); }
                catch (e) { console.error(`❌ Erro ao processar baixa de estoque do pedido #${id.slice(-4)}:`, e.message); }
            }
        }, erro => {
            console.error("❌ Erro no listener de baixa automática de estoque:", erro.message);
        });
}

monitorarEstoque();

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(
        `🚀 Servidor rodando na porta ${PORT}`
    );
});
