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
        return res.sendStatus(204);
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

            if (!pedido.id_pagamento_mp) continue;

            // 🆕 Não fica checando pra sempre pedidos muito antigos (provavelmente
            // abandonados/expirados) — evita gastar chamadas de API à toa.
            if (pedido.criadoEm && (agora - pedido.criadoEm) > DUAS_HORAS_MS) continue;

            try {
                const resposta = await fetch(
                    `https://api.mercadopago.com/v1/payments/${pedido.id_pagamento_mp}`,
                    { headers: { Authorization: `Bearer ${MP_TOKEN}` } }
                );

                const dadosPagamento = await resposta.json();

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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(
        `🚀 Servidor rodando na porta ${PORT}`
    );
});
