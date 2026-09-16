// =====================================================================
// 🔔 CLOUD FUNCTION — Envia notificação push quando o status do pedido muda
// =====================================================================
// Como usar:
//
// 1. Se ainda não usa Firebase Functions neste projeto:
//      npm install -g firebase-tools
//      firebase login
//      firebase init functions   (escolha o projeto "fb-pedidos", JavaScript)
//
// 2. Dentro da pasta "functions" que foi criada, instale o web-push:
//      cd functions
//      npm install web-push firebase-admin firebase-functions
//
// 3. Cole o conteúdo deste arquivo em "functions/index.js"
//    (ou adicione a função abaixo se já tiver outras funções lá).
//
// 4. Configure as chaves VAPID (as mesmas usadas no site.html) como
//    variáveis de ambiente da function. Crie um arquivo
//    "functions/.env" com:
//
//      VAPID_PUBLIC_KEY=BJsAiWuw3YU9yzJMUTqQGpq7e4YsVOMNEWlu77KkCtEqiVkd2o-w7e5m_EjpZPWfp_wo9qG_OfNrp8rJknakFNU
//      VAPID_PRIVATE_KEY=Jqa81HKvVaRKPKnscfuMwMjkk_N97TedQpYHfa_MM_0
//
//    ⚠️ A chave PRIVADA é secreta — nunca coloque ela no site.html nem
//    em nenhum lugar público. Ela fica só aqui, no servidor.
//
// 5. Deploy:
//      firebase deploy --only functions
//
// A partir daí, toda vez que o campo "status" de um documento em
// "pedidos/{id}" mudar (não importa quem mudou — painel da cozinha,
// console do Firebase, o que for), essa function dispara sozinha e
// manda a notificação pro celular do cliente.
// =====================================================================

const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { defineString } = require("firebase-functions/params");
const webpush = require("web-push");

const VAPID_PUBLIC_KEY = defineString("VAPID_PUBLIC_KEY");
const VAPID_PRIVATE_KEY = defineString("VAPID_PRIVATE_KEY");

exports.notificarStatusPedido = onDocumentUpdated("pedidos/{pedidoId}", async (event) => {
    const antes = event.data.before.data();
    const depois = event.data.after.data();

    // Só notifica quando o status realmente muda (evita notificação duplicada
    // se outro campo do pedido for atualizado por qualquer motivo)
    if (antes.status === depois.status) return;

    // Sem inscrição push salva (cliente não aceitou notificação) — nada a fazer
    if (!depois.pushSubscription) return;

    webpush.setVapidDetails(
        "mailto:contato@novaorigemacai.com.br", // 🆕 troque pelo e-mail real da loja
        VAPID_PUBLIC_KEY.value(),
        VAPID_PRIVATE_KEY.value()
    );

    const textos = {
        preparo: "🔥 Seu pedido está em preparo!",
        pronto: depois.entrega === "entrega"
            ? "✅ Seu pedido está pronto e logo sai para entrega!"
            : "✅ Seu pedido está pronto para retirada!",
        em_rota: "🛵 Saiu para entrega! Já está a caminho.",
        concluido: depois.entrega === "entrega"
            ? "🎉 Pedido entregue! Bom apetite!"
            : "🎉 Até a próxima!"
    };

    const texto = textos[depois.status];
    if (!texto) return; // status sem mensagem definida (ex: "novo", "aguardando_pagamento")

    const payload = JSON.stringify({
        titulo: "Nova Origem Açaí 🍇",
        corpo: texto,
        url: `/?pedido=${event.params.pedidoId}`
    });

    try {
        await webpush.sendNotification(depois.pushSubscription, payload);
        console.log(`✅ Push enviado para o pedido ${event.params.pedidoId} (status: ${depois.status})`);
    } catch (erro) {
        // Erros comuns aqui: a inscrição expirou ou o cliente revogou a permissão.
        // Não precisa travar nada por causa disso — só loga pra referência.
        console.error("❌ Erro ao enviar push:", erro.message);
    }
});
