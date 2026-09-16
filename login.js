import { auth, db } from "./firebase.js";
import {
    signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
    doc,
    getDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Pra onde cada perfil vai depois de logar.
// Ajuste os nomes de arquivo se forem diferentes no seu projeto.
const PAGINA_POR_PERFIL = {
    admin: "./painel-nova-origem.html",
    cardapio: "./cardapio.html",
    cozinha: "./cozinha.html",
    estoque: "./estoque.html",
    financeiro: "./financeiro.html",
    entregador: "./entregador.html"
};

const form = document.getElementById("form-login");
const erroEl = document.getElementById("erro");
const btn = document.getElementById("btn-entrar");

form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const email = document.getElementById("email").value.trim();
    const senha = document.getElementById("senha").value;

    esconderErro();
    btn.disabled = true;
    btn.textContent = "Entrando...";

    try {
        const cred = await signInWithEmailAndPassword(auth, email, senha);

        const snap = await getDoc(doc(db, "usuarios", cred.user.uid));

        if (!snap.exists() || snap.data().ativo === false) {
            mostrarErro("Conta sem acesso liberado. Fale com o administrador.");
            await auth.signOut();
            return;
        }

        const perfil = snap.data().perfil;
        const destino = PAGINA_POR_PERFIL[perfil];

        if (!destino) {
            mostrarErro("Perfil sem tela associada. Fale com o administrador.");
            await auth.signOut();
            return;
        }

        window.location.href = destino;

    } catch (erro) {
        console.error(erro);
        mostrarErro("E-mail ou senha inválidos.");
    } finally {
        btn.disabled = false;
        btn.textContent = "Entrar";
    }
});

function mostrarErro(msg) {
    erroEl.textContent = msg;
    erroEl.style.display = "block";
}

function esconderErro() {
    erroEl.style.display = "none";
}
