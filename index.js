/**
 * Cloud Function: dispara a notificação push quando o status de um pedido muda.
 *
 * ⚠️ ISSO PRECISA SER IMPLANTADO NO FIREBASE — o Claude não tem acesso ao seu
 * projeto Firebase pra fazer esse deploy. Passo a passo pra você (ou seu
 * desenvolvedor) rodar:
 *
 *   1) Instale o Firebase CLI, se ainda não tiver: npm install -g firebase-tools
 *   2) firebase login
 *   3) Na pasta do projeto: firebase init functions (escolha o mesmo projeto do site)
 *   4) Copie este arquivo para functions/index.js
 *   5) Dentro de functions/: npm install firebase-admin firebase-functions
 *   6) firebase deploy --only functions
 *
 * Depois disso, toda vez que o campo "status" de um documento em "pedidos" mudar,
 * essa função verifica se existe um "fcmToken" salvo nesse pedido (salvo pelo
 * botão "Avisar quando o status mudar" no site) e manda o push.
 */

const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

// Mensagens amigáveis por status (ajuste os textos como preferir)
const MENSAGENS_STATUS = {
    novo: "Recebemos seu pedido! Já estamos preparando 🍇",
    preparando: "Seu pedido está sendo preparado 👩‍🍳",
    pronto: "Seu pedido está pronto!",
    saiu_para_entrega: "Seu pedido saiu para entrega 🛵",
    concluido: "Pedido entregue! Bom apetite 😋",
    cancelado: "Seu pedido foi cancelado. Fale com a loja pelo WhatsApp se tiver dúvidas."
};

exports.notificarMudancaDeStatus = onDocumentUpdated("pedidos/{pedidoId}", async (event) => {
    const antes = event.data.before.data();
    const depois = event.data.after.data();

    // Só notifica quando o status realmente mudou e existe um token salvo
    if (antes.status === depois.status) return;
    if (!depois.fcmToken) return;

    const mensagem = MENSAGENS_STATUS[depois.status] || `Status do seu pedido: ${depois.status}`;

    try {
        await getMessaging().send({
            token: depois.fcmToken,
            notification: {
                title: `Pedido #${String(depois.numero || "").slice(-4)}`,
                body: mensagem
            },
            data: {
                url: `./site.html?pedido=${event.params.pedidoId}`
            },
            webpush: {
                fcmOptions: {
                    link: `./site.html?pedido=${event.params.pedidoId}`
                }
            }
        });
    } catch (erro) {
        // Token inválido/expirado, sem internet no aparelho do cliente, etc. — não trava nada.
        console.error("Falha ao enviar notificação push:", erro);
    }
});
