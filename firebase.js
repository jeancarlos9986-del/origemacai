import { initializeApp }
    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";

import { getFirestore }
    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { getAuth }
    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyC_zNrNdstdLSa95AjYF_W8XFMwIwlq4DE",
    authDomain: "fb-pedidos.firebaseapp.com",
    projectId: "fb-pedidos",
    storageBucket: "fb-pedidos.firebasestorage.app",
    messagingSenderId: "440937401229",
    appId: "1:440937401229:web:4a27c27a69792eb25bcbc4"
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);