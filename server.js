const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const cors = require('cors'); // ✅ Adicionei para liberar acesso

const app = express();

// ✅ LIBERA ACESSO PARA O SEU SITE (RESOLVE ERRO CORS)
app.use(cors({
    origin: ['https://jeancarlos9986-del.github.io', 'http://127.0.0.1:5500'], // Seus endereços
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

// ✅ CONFIGURAÇÃO DO FIREBASE
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

app.use(bodyParser.json());

// ✅ SUAS CHAVES
const MP_TOKEN = "APP_USR-2553785228948600-060911-65330e84299bb43e1f81d3902c4c1a11-293452112";
const WHATSAPP = "5534997741051"; // SEU NÚMERO PARA RECEBER OS PEDIDOS

// 🚀 NOVA ROTA: GERAR PIX (resolve o erro CORS)
app.post('/gerar-pix', async (req, res) => {
    try {
        const { total, descricao, email, nome } = req.body;

        const idempotencyKey = "pedido-" + Date.now() + "-" + Math.random().toString(36).substr(2, 5);

        // 🔹 AGORA O SERVIDOR CHAMA A API, NÃO O NAVEGADOR
        const resposta = await fetch("https://api.mercadopago.com/v1/payments", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${MP_TOKEN}`,
                "Content-Type": "application/json",
                "X-Idempotency-Key": idempotencyKey
            },
            body: JSON.stringify({
                transaction_amount: Number(total.toFixed(2)),
                description: descricao,
                payment_method_id: "pix",
                payer: {
                    email: email,
                    first_name: nome.substring(0, 15)
                },
                date_of_expiration: new Date(Date.now() + 30 * 60000).toISOString()
            })
        });

        const dados = await resposta.json();

        if (dados.id && (dados.status === "pending" || dados.status === "in_process")) {
            // Devolve os dados do Pix para o site
            res.json({
                sucesso: true,
                idPagamento: dados.id,
                codigoPix: dados.point_of_interaction.transaction_data.qr_code,
                imagemPix: dados.point_of_interaction.transaction_data.qr_code_base64
            });
        } else {
            res.json({ sucesso: false, erro: dados.message || "Erro ao gerar pagamento" });
        }

    } catch (erro) {
        console.error("❌ ERRO AO GERAR PIX:", erro);
        res.json({ sucesso: false, erro: "Falha na conexão com o servidor" });
    }
});

// 🚨 ROTA DO WEBHOOK
app.post('/webhook', async (req, res) => {
    try {
        const { action, data } = req.body;

        // Só processa se for atualização de pagamento
        if (action === 'payment.updated') {
            const paymentId = data.id;
            console.log("🔔 Recebido aviso do Mercado Pago ID:", paymentId);

            // 1. Consulta status real na API do Mercado Pago
            const resposta = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
                headers: { Authorization: `Bearer ${MP_TOKEN}` }
            });
            const dadosPagamento = await resposta.json();

            // 2. Se foi APROVADO
            if (dadosPagamento.status === 'approved') {
                console.log("✅ PAGAMENTO APROVADO!", paymentId);

                // 3. Busca o pedido no Firebase
                const pedidosRef = db.collection("pedidos");
                const consulta = pedidosRef.where("id_pagamento_mp", "==", Number(paymentId));
                const resultado = await consulta.get();

                if (resultado.empty) {
                    console.log("❌ Pedido não encontrado no banco");
                    return res.send("Pedido não encontrado");
                }

                // 4. Pegar dados e atualizar status
                let dadosPedido = null;
                let idDoDocumento = null;

                resultado.forEach((doc) => {
                    dadosPedido = doc.data();
                    idDoDocumento = doc.id;
                });

                // ✅ Atualiza para "novo" e já cai na cozinha
                await pedidosRef.doc(idDoDocumento).update({
                    status: "novo",
                    data_pagamento: new Date()
                });

                console.log("✅ Pedido atualizado para 'novo' e já aparece na cozinha!");

                // 5. 🚀 PREPARA MENSAGEM DO WHATSAPP
                const itensTexto = dadosPedido.itens.map(item => `
• ${item.nome}
${item.gratis?.length ? `Grátis: ${item.gratis.join(", ")}` : ""}
${item.extras?.length ? `Extras: ${item.extras.join(", ")}` : ""}
${item.obs ? `Obs: ${item.obs}` : ""}
                `).join("\n");

                const mensagem = encodeURIComponent(`
✅ PAGAMENTO CONFIRMADO!

🛒 NOVO PEDIDO - NOVA ORIGEM

👤 Cliente: ${dadosPedido.nome}
📞 WhatsApp: ${dadosPedido.fone}
📦 Entrega: ${dadosPedido.entrega}
📍 Endereço: ${dadosPedido.endereco || "Retirada"}

📋 ITENS:
${itensTexto}

💰 Total: R$ ${dadosPedido.total.toFixed(2)}
💳 Pagamento: PIX ✅

Já estamos preparando seu Açaí 🧡
                `);

                const linkWhatsapp = `https://wa.me/${WHATSAPP}?text=${mensagem}`;
                console.log("📱 Link para envio automático:", linkWhatsapp);
            }
        }

        // ✅ Responde 200 OBRIGATÓRIO pro Mercado Pago
        res.sendStatus(200);

    } catch (erro) {
        console.error("❌ ERRO WEBHOOK DETALHADO:", erro.message, erro.stack);
        res.sendStatus(500);
    }
});

// Servir o site
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor rodando na porta ${PORT}`));
