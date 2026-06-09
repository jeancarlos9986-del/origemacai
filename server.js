const express = require("express");
const cors = require("cors");
const { MercadoPagoConfig, Payment } = require("mercadopago");
const admin = require("firebase-admin");

const app = express();

/* =========================
   CORS (Ajustado para produção)
========================= */
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

/* =========================
   FIREBASE (Inicialização Segura)
========================= */
if (!admin.apps.length) {
    try {
        admin.initializeApp({
            // Se estiver usando o Render, as credenciais devem estar nas variáveis de ambiente
            credential: admin.credential.applicationDefault()
        });
        console.log("🔥 Firebase conectado com sucesso");
    } catch (e) {
        console.error("❌ Erro ao inicializar Firebase:", e);
    }
}

const db = admin.firestore();

/* =========================
   CONFIG MERCADO PAGO
========================= */
const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

if (!ACCESS_TOKEN) {
    console.error("❌ CRÍTICO: MP_ACCESS_TOKEN não encontrado nas variáveis de ambiente!");
}

const client = new MercadoPagoConfig({
    accessToken: ACCESS_TOKEN,
    options: { timeout: 7000 } // Aumentado levemente para evitar timeouts em conexões lentas
});

const payment = new Payment(client);

/* =========================
   URL WEBHOOK (Render)
========================= */
const WEBHOOK_URL = "https://f-burguer.onrender.com/webhook";

/* =========================
   ROTAS
========================= */

app.get("/", (req, res) => {
    res.send("🚀 Servidor PIX F&B Burguer operacional");
});

// CRIAR PAGAMENTO PIX
app.post("/pix", async (req, res) => {
    const { valor, descricao, pedidoId } = req.body;

    if (!valor || !pedidoId) {
        return res.status(400).json({ erro: "Valor e ID do pedido são obrigatórios" });
    }

    try {
        const paymentData = {
            body: {
                transaction_amount: Number(valor),
                description: descricao || "Pedido F&B Burguer",
                payment_method_id: "pix",
                payer: {
                    email: "cliente@fbburguer.com", // Email genérico obrigatório pelo MP
                    first_name: "Cliente",
                    last_name: "F&B"
                },
                metadata: { pedido_id: pedidoId },
                notification_url: WEBHOOK_URL
            }
        };

        const result = await payment.create(paymentData);
        const qr = result.point_of_interaction?.transaction_data;

        console.log(`✅ PIX Gerado - Pedido: ${pedidoId} | Pagamento: ${result.id}`);

        res.json({
            pagamento_id: result.id,
            status: result.status,
            qr_code: qr.qr_code,
            qr_base64: qr.qr_code_base64
        });

    } catch (error) {
        console.error("❌ ERRO AO GERAR PIX:", error.message);
        res.status(500).json({ erro: "Erro ao processar pagamento", detalhe: error.message });
    }
});

// CONSULTAR STATUS (Polling do Front-end)
app.get("/status/:id", async (req, res) => {
    try {
        const pagamentoId = req.params.id;
        const result = await payment.get({ id: pagamentoId });

        res.json({
            id: result.id,
            status: result.status
        });
    } catch (error) {
        console.error("❌ ERRO AO CONSULTAR STATUS:", error.message);
        res.status(500).json({ erro: "Erro ao consultar pagamento" });
    }
});

// WEBHOOK (Notificação do Mercado Pago)
app.post("/webhook", async (req, res) => {
    try {
        const { type, data } = req.body;

        // O Mercado Pago envia notificações de vários tipos, filtramos apenas 'payment'
        if (type !== "payment" || !data?.id) {
            return res.status(200).send("OK");
        }

        const paymentId = data.id;
        const result = await payment.get({ id: paymentId });

        const status = result.status;
        const pedidoId = result.metadata?.pedido_id;

        console.log(`📩 Webhook: Pagamento ${paymentId} está ${status} (Pedido: ${pedidoId})`);

        // Verificamos se foi aprovado ou creditado
        if (status === "approved" || status === "accredited") {

            if (!pedidoId || pedidoId === "sem_pedido") {
                console.log("⚠️ Webhook ignorado: ID do pedido ausente no metadata");
                return res.sendStatus(200);
            }

            const pedidoRef = db.collection("pedidos").doc(pedidoId);
            const pedidoSnap = await pedidoRef.get();

            if (!pedidoSnap.exists) {
                console.log(`❌ Pedido ${pedidoId} não encontrado no banco de dados.`);
                return res.sendStatus(200);
            }

            const pedidoData = pedidoSnap.data();

            // Só atualiza se o pedido ainda não estiver marcado como pago
            if (pedidoData.pago !== true) {
                await pedidoRef.update({
                    status: "Pendente", // STATUS EXATO PARA APARECER NA COZINHA
                    pago: true,
                    pagoEm: admin.firestore.FieldValue.serverTimestamp(), // Data oficial do servidor Firebase
                    mercadopago_id: paymentId
                });
                console.log(`🚀 Pedido ${pedidoId} ENVIADO PARA COZINHA (Status: Pendente)`);
            } else {
                console.log(`ℹ️ Pedido ${pedidoId} já estava processado.`);
            }
        }

        res.status(200).send("OK");

    } catch (error) {
        console.error("❌ ERRO NO WEBHOOK:", error.message);
        // Retornamos 500 para o Mercado Pago tentar enviar a notificação novamente mais tarde
        res.sendStatus(500);
    }
});

/* =========================
   START SERVIDOR
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
    console.log("====================================");
    console.log("🔥 SERVIDOR F&B BURGUER ATIVO");
    console.log(`PORTA: ${PORT}`);
    console.log(`WEBHOOK CONFIGURADO: ${WEBHOOK_URL}`);
    console.log("====================================");
});