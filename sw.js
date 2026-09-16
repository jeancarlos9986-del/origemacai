const CACHE_NAME = "novaorigem-v1";
const APP_SHELL = ["./site.html", "./logonovonova.jpeg"];

self.addEventListener("install", (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .catch(() => { })
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((chaves) =>
            Promise.all(chaves.filter((c) => c !== CACHE_NAME).map((c) => caches.delete(c)))
        )
    );
    self.clients.claim();
});

// Estratégia "rede primeiro": o cardápio muda com frequência (preço, esgotado, etc.),
// então só usamos o cache guardado quando o cliente estiver sem internet.
self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;
    event.respondWith(
        fetch(event.request)
            .then((resposta) => {
                const copia = resposta.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copia)).catch(() => { });
                return resposta;
            })
            .catch(() => caches.match(event.request))
    );
});

// 🆕 NOTIFICAÇÕES PUSH: chega até com o site fechado, mas só se ALGUÉM enviar o push —
// isso exige uma Cloud Function no servidor (veja functions/index.js e o README enviados
// junto). Este service worker só cuida de EXIBIR a notificação que chegar.
self.addEventListener("push", (event) => {
    let dados = {};
    try {
        dados = event.data ? event.data.json() : {};
    } catch {
        dados = { title: "Nova Origem Açaí", body: event.data ? event.data.text() : "Atualização do seu pedido!" };
    }

    const titulo = dados.title || dados.notification?.title || "Nova Origem Açaí";
    const corpo = dados.body || dados.notification?.body || "Atualização do seu pedido!";
    const url = dados.url || dados.data?.url || "./site.html";

    event.waitUntil(
        self.registration.showNotification(titulo, {
            body: corpo,
            icon: "./logonovonova.jpeg",
            badge: "./logonovonova.jpeg",
            data: { url }
        })
    );
});

self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const url = event.notification.data?.url || "./site.html";
    event.waitUntil(
        clients.matchAll({ type: "window" }).then((lista) => {
            for (const cliente of lista) {
                if (cliente.url.includes(url) && "focus" in cliente) return cliente.focus();
            }
            if (clients.openWindow) return clients.openWindow(url);
        })
    );
});
