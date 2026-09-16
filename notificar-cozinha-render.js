// ======================================
// 🆕 NOTIFICAR COZINHA (push) — TRECHO PARA ADICIONAR AO SEU SERVIDOR NO RENDER
// ======================================
// Este arquivo NÃO roda sozinho. É um trecho para você colar dentro do
// servidor Node que já existe no Render (o mesmo que gera/verifica o Pix).
//
// PASSO A PASSO:
//
// 1) No terminal do projeto do servidor (não do site), instale o Firebase Admin:
//      npm install firebase-admin
//
// 2) No Firebase Console: Configurações do projeto > Contas de serviço >
//    "Gerar nova chave privada". Isso baixa um .json.
//    NÃO suba esse arquivo pro GitHub. No Render, vá em Environment e crie
//    uma variável chamada FIREBASE_SERVICE_ACCOUNT com o CONTEÚDO desse
//    JSON colado inteiro como valor (uma linha só).
//
// 3) Cole o bloco abaixo no arquivo principal do seu servidor (ex.: index.js
//    ou server.js), perto de onde ele já usa express.json().
//
// 4) No site.html, depois de criar o pedido, ele já vai chamar:
//      POST https://origemacai.onrender.com/notificar-cozinha
//    (isso eu já deixei pronto na atualização do site.html)

const admin = require("firebase-admin");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(
            JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        )
    });
}

// Supondo que seu servidor já tenha algo como: const app = express(); app.use(express.json());
app.post("/notificar-cozinha", async (req, res) => {
    try {
        const { numero, nome, total, entrega } = req.body;

        const snap = await admin.firestore().collection("dispositivos_cozinha").get();
        const tokens = snap.docs.map((d) => d.id);

        if (tokens.length === 0) {
            return res.json({ ok: true, enviados: 0, aviso: "Nenhum dispositivo da cozinha com notificação ativada." });
        }

        const mensagem = {
            notification: {
                title: "🛒 Novo pedido!",
                body: `${nome || "Cliente"} • R$ ${Number(total || 0).toFixed(2)} • ${entrega === "entrega" ? "🛵 Entrega" : "🏠 Retirada"}`
            },
            data: {
                numero: String(numero || "")
            },
            webpush: {
                fcmOptions: {
                    link: "./cozinha.html"
                }
            },
            tokens
        };

        const resposta = await admin.messaging().sendEachForMulticast(mensagem);

        // 🧹 Remove tokens inválidos/expirados (ex.: app desinstalado, permissão revogada)
        const codigosInvalidos = [
            "messaging/invalid-registration-token",
            "messaging/registration-token-not-registered"
        ];
        const tokensParaRemover = [];
        resposta.responses.forEach((r, i) => {
            if (!r.success && codigosInvalidos.includes(r.error?.code)) {
                tokensParaRemover.push(tokens[i]);
            }
        });
        await Promise.all(
            tokensParaRemover.map((t) =>
                admin.firestore().collection("dispositivos_cozinha").doc(t).delete()
            )
        );

        res.json({ ok: true, enviados: resposta.successCount, falhas: resposta.failureCount });
    } catch (e) {
        console.error("Erro ao notificar cozinha:", e);
        res.status(500).json({ ok: false, erro: e.message });
    }
});
