// ======================================
// AUTH GUARD — protege cada tela por perfil
// ======================================
// Caminho "mais fácil": o perfil de cada usuário fica salvo num documento
// Firestore em usuarios/{uid} — nada de backend/Admin SDK envolvido.
//
// Uso em qualquer painel (cozinha.js, estoque.js, financeiro.js, entregador.js, cardapioAdmin.js):
//
//   import { protegerPagina, logout } from "./auth-guard.js";
//   protegerPagina(["cozinha", "admin"]).then(() => {
//       iniciarPainelCozinha(); // sua função de início normal, só que agora depois do login confirmado
//   });
//
// Cada tela decide quais perfis podem entrar. "admin" sempre passa,
// não precisa incluir na lista.

import { auth, db } from "./firebase.js";
import {
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    doc,
    getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export function protegerPagina(perfisPermitidos = []) {
    return new Promise((resolve) => {
        onAuthStateChanged(auth, async (user) => {
            if (!user) {
                redirecionarParaLogin();
                return;
            }

            try {
                const snap = await getDoc(doc(db, "usuarios", user.uid));

                if (!snap.exists() || snap.data().ativo === false) {
                    alert("Sua conta não está liberada. Fale com o administrador.");
                    await signOut(auth);
                    redirecionarParaLogin();
                    return;
                }

                const perfil = snap.data().perfil;

                if (perfil !== "admin" && !perfisPermitidos.includes(perfil)) {
                    alert("Você não tem permissão para acessar esta tela.");
                    await signOut(auth);
                    redirecionarParaLogin();
                    return;
                }

                resolve({ user, perfil, nome: snap.data().nome || "" });

            } catch (erro) {
                console.error("Erro ao verificar permissão:", erro);
                redirecionarParaLogin();
            }
        });
    });
}

export async function logout() {
    await signOut(auth);
    redirecionarParaLogin();
}

// ======================================
// Mostra o nome de quem tá logado e liga o botão de sair.
// Chame depois que protegerPagina() resolver, em qualquer painel:
//   protegerPagina(["cozinha"]).then(({ nome }) => {
//       renderizarUsuarioLogado(nome);
//       ...resto do início do painel...
//   });
// Precisa de <span id="nome-usuario"></span> e <button id="btn-logout">Sair</button> no HTML.
// ======================================
export function renderizarUsuarioLogado(nome) {
    const elNome = document.getElementById("nome-usuario");
    if (elNome) elNome.textContent = nome || "";

    const btnLogout = document.getElementById("btn-logout");
    if (btnLogout) btnLogout.addEventListener("click", logout);
}

function redirecionarParaLogin() {
    // ./login.html funciona a partir de qualquer página na raiz do site
    window.location.href = "./login.html";
}
