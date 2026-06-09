// auth-guard.js
import { auth } from "./firebase.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// Bloqueia o acesso imediatamente antes da página carregar totalmente
onAuthStateChanged(auth, (user) => {
    if (!user) {
        // Se não estiver logado, redireciona para a página de login
        window.location.replace("login.html");
    }
});