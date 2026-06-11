const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const app = express();

// ✅ CONFIGURAÇÃO DO FIREBASE (BAIXE A CHAVE NO PAINEL DO FIREBASE)
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

app.use(bodyParser.json());

// ✅ SUAS CHAVES
const MP_TOKEN = "APP_USR-2553785228948600-060911-65330e84299bb43e1f81d3902c4c1a11-293452112"; // COLOQUE SEU TOKEN AQUI
const WHATSAPP = "5534997741051";

// 🚨 ESSE É O ENDEREÇO QUE VOCÊ VAI COLOCAR NO WEBHOOK DO MERCADO PAGO
// Ex: https://seu-site.onrender.com/webhook
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

                if (resultado.empty) return res.send("Pedido não encontrado");

                // 4. Atualiza status para "novo" (cai na cozinha)
                let dadosPedido;
                resultado.forEach(async (doc) => {
                    dadosPedido = doc.data();
                    await doc.ref.update({ status: "novo", data_pagamento: new Date() });
                });

                // 5. 🚀 ENVIA WHATSAPP AUTOMÁTICO
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

                // Abre o WhatsApp do cliente
                await fetch(`https://wa.me/${WHATSAPP}?text=${mensagem}`);

            }
        }

        res.sendStatus(200); // Responde pro Mercado Pago que deu certo
    } catch (erro) {
        console.error("❌ ERRO WEBHOOK:", erro);
        res.sendStatus(500);
    }
});

// Servir o site (se quiser, ou mantenha no GitHub Pages)
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Rodando na porta ${PORT}`));