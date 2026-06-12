const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();

// ==================================================
// 🔴 CORS
// ==================================================
app.use((req, res, next) => {

    res.header(
        'Access-Control-Allow-Origin',
        'https://jeancarlos9986-del.github.io'
    );

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

// 🚨 ROTA DO WEBHOOK
app.post('/webhook', async (req, res) => {
    try {

        const { action, data } = req.body;

        if (action === 'payment.updated') {

            const paymentId = data.id;

            console.log(
                "🔔 Recebido aviso do Mercado Pago ID:",
                paymentId
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

                const consulta =
                    pedidosRef.where(
                        "id_pagamento_mp",
                        "==",
                        Number(paymentId)
                    );

                const resultado =
                    await consulta.get();

                if (resultado.empty) {
                    return res.send(
                        "Pedido não encontrado"
                    );
                }

                let dadosPedido = null;
                let idDoDocumento = null;

                resultado.forEach((doc) => {
                    dadosPedido = doc.data();
                    idDoDocumento = doc.id;
                });

                await pedidosRef
                    .doc(idDoDocumento)
                    .update({
                        status: "novo",
                        data_pagamento:
                            new Date()
                    });

                console.log(
                    "✅ Pedido atualizado"
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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(
        `🚀 Servidor rodando na porta ${PORT}`
    );
});