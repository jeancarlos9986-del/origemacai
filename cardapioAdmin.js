import { db } from "./firebase.js";
import { getApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getStorage, ref as storageRef, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import {
    STATUS,
    escutarProdutos, salvarProduto, definirStatusProduto, excluirProduto, moverProdutoOrdem,
    escutarAdicionais, salvarAdicional, definirStatusAdicional, excluirAdicional, moverAdicionalOrdem,
    importarCatalogoAtualSeVazio
} from "./catalogo.js";

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ==============================================
// ABAS
// ==============================================
document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
        document.querySelectorAll(".painel").forEach(p => p.classList.remove("ativo"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.painel).classList.add("ativo");
    });
});

// ==============================================
// IMPORTAR CATÁLOGO ATUAL (uma vez só)
// ==============================================
const importarBox = document.getElementById("importar-box");
importarBox.innerHTML = `<button id="btn-importar" class="btn-secundario">📥 Importar catálogo atual do código (uma vez só)</button>`;
document.getElementById("btn-importar").addEventListener("click", async () => {
    const btn = document.getElementById("btn-importar");
    btn.disabled = true;
    btn.textContent = "Importando...";
    try {
        const r = await importarCatalogoAtualSeVazio(db);
        importarBox.innerHTML = r.importado
            ? `<p class="aviso-importar" style="color:var(--green);">✅ Catálogo importado (${r.total} itens). Pode conferir nas listas abaixo.</p>`
            : `<p class="aviso-importar">ℹ️ ${r.motivo}</p>`;
    } catch (e) {
        console.error(e);
        importarBox.innerHTML = `<p class="aviso-importar" style="color:var(--red);">Erro ao importar: ${esc(e.message)}</p>`;
    }
});

// ==============================================
// STATUS: pills reutilizáveis
// ==============================================
function pillsStatus(tipo, id, statusAtual) {
    const opcoes = [
        { valor: STATUS.DISPONIVEL, label: "Disponível" },
        { valor: STATUS.ACABANDO, label: "Acabando" },
        { valor: STATUS.ESGOTADO, label: "Esgotado hoje" }
    ];
    return `<div class="status-pills" data-tipo="${tipo}" data-id="${id}">
        ${opcoes.map(o => `<span class="pill ${o.valor} ${statusAtual === o.valor ? "on" : ""}" data-status="${o.valor}">${o.label}</span>`).join("")}
    </div>`;
}

document.addEventListener("click", async (e) => {
    const pill = e.target.closest(".pill");
    if (!pill) return;
    const box = pill.closest(".status-pills");
    const { tipo, id } = box.dataset;
    const status = pill.dataset.status;
    try {
        if (tipo === "produto") await definirStatusProduto(db, id, status);
        else await definirStatusAdicional(db, id, status);
    } catch (err) {
        console.error(err);
        alert("Não deu pra atualizar o status. Tente de novo.");
    }
});

// ==============================================
// PRODUTOS
// ==============================================
const listaProdutosEl = document.getElementById("lista-produtos");

escutarProdutos(db, produtos => {
    if (produtos.length === 0) {
        listaProdutosEl.innerHTML = `<p style="color:var(--muted);">Nenhum produto cadastrado ainda. Use o botão "Importar catálogo atual" acima ou cadastre um novo.</p>`;
        return;
    }
    listaProdutosEl.innerHTML = produtos.map((p, i) => {
        const semSubir = i === 0 || !!produtos[i - 1].destaque !== !!p.destaque;
        const semDescer = i === produtos.length - 1 || !!produtos[i + 1].destaque !== !!p.destaque;
        return `
        <div class="item-linha">
            <div class="icones-ordem">
                <button class="icone-btn btn-secundario" data-mover-produto="${p.id}" data-direcao="cima" title="Mover pra cima" ${semSubir ? "disabled" : ""}><i class="fas fa-arrow-up"></i></button>
                <button class="icone-btn btn-secundario" data-mover-produto="${p.id}" data-direcao="baixo" title="Mover pra baixo" ${semDescer ? "disabled" : ""}><i class="fas fa-arrow-down"></i></button>
            </div>
            <img src="${esc(p.imagens[0])}" alt="" onerror="this.style.visibility='hidden'">
            <div class="item-info">
                <strong>${esc(p.nome)} <span class="badge-tipo">${esc(p.cat)}</span></strong>
                <span>R$ ${p.preco.toFixed(2)} ${p.limiteGratis > 0 ? `· até ${p.limiteGratis} adicionais grátis` : "· sem personalização"} ${p.destaque ? "· 🔥 destaque" : ""}</span>
            </div>
            ${pillsStatus("produto", p.id, p.status)}
            <div class="icones-acao">
                <button class="icone-btn btn-secundario" data-editar-produto="${p.id}"><i class="fas fa-pen"></i></button>
                <button class="icone-btn btn-perigo" data-excluir-produto="${p.id}"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `;
    }).join("");

    listaProdutosEl.querySelectorAll("[data-mover-produto]").forEach(btn => {
        btn.addEventListener("click", async () => {
            const { moverProduto: id, direcao } = btn.dataset;
            btn.disabled = true;
            try {
                await moverProdutoOrdem(db, produtos, id, direcao);
            } catch (err) {
                console.error(err);
                alert("Não deu pra mudar a ordem. Tente de novo.");
                btn.disabled = false;
            }
        });
    });

    listaProdutosEl.querySelectorAll("[data-editar-produto]").forEach(btn => {
        btn.addEventListener("click", () => {
            const p = produtos.find(x => x.id === btn.dataset.editarProduto);
            if (!p) return;
            document.getElementById("prod-editando-id").value = p.id;
            document.getElementById("prod-nome").value = p.nome;
            document.getElementById("prod-cat").value = p.cat;
            document.getElementById("prod-preco").value = p.preco;
            document.getElementById("prod-desc").value = p.desc;
            document.getElementById("prod-imagens").value = p.imagens.join("\n");
            document.getElementById("prod-limite").value = p.limiteGratis;
            document.getElementById("prod-destaque").checked = p.destaque;
            document.getElementById("prod-customizavel").checked = p.customizavel;
            document.getElementById("prod-cancelar-edicao").style.display = "";
            document.getElementById("prod-salvar").textContent = "Salvar Alterações";
            window.scrollTo({ top: 0, behavior: "smooth" });
        });
    });

    listaProdutosEl.querySelectorAll("[data-excluir-produto]").forEach(btn => {
        btn.addEventListener("click", async () => {
            const p = produtos.find(x => x.id === btn.dataset.excluirProduto);
            if (!p) return;
            if (!confirm(`Excluir "${p.nome}" do cardápio? Isso não pode ser desfeito.`)) return;
            try {
                await excluirProduto(db, p.id);
            } catch (err) {
                console.error(err);
                alert("Não deu pra excluir. Tente de novo.");
            }
        });
    });
});

function limparFormProduto() {
    document.getElementById("prod-editando-id").value = "";
    document.getElementById("prod-nome").value = "";
    document.getElementById("prod-cat").value = "Copos";
    document.getElementById("prod-preco").value = "";
    document.getElementById("prod-desc").value = "";
    document.getElementById("prod-imagens").value = "";
    document.getElementById("prod-limite").value = "0";
    document.getElementById("prod-destaque").checked = false;
    document.getElementById("prod-customizavel").checked = true;
    document.getElementById("prod-cancelar-edicao").style.display = "none";
    document.getElementById("prod-salvar").textContent = "Salvar Produto";
    const inputArquivo = document.getElementById("prod-imagem-arquivo");
    const aviso = document.getElementById("prod-upload-aviso");
    if (inputArquivo) inputArquivo.value = "";
    if (aviso) aviso.textContent = "";
}

document.getElementById("prod-cancelar-edicao").addEventListener("click", limparFormProduto);

// ==============================================
// UPLOAD DE IMAGEM DIRETO (Firebase Storage)
// ==============================================
// Em vez de precisar hospedar a foto em outro lugar e colar o link, dá pra
// escolher o arquivo aqui: ele sobe pro Firebase Storage e o link gerado
// entra sozinho na caixa de "Imagens" (uma URL por linha), junto com o que
// já estiver lá. Continua funcionando também colar link manualmente.
const storage = getStorage(getApp());
const inputImagemArquivo = document.getElementById("prod-imagem-arquivo");
const btnEnviarImagem = document.getElementById("prod-enviar-imagem");
const avisoUpload = document.getElementById("prod-upload-aviso");

if (btnEnviarImagem && inputImagemArquivo) {
    btnEnviarImagem.addEventListener("click", async () => {
        const arquivos = [...inputImagemArquivo.files];
        if (arquivos.length === 0) { alert("Escolhe pelo menos uma imagem primeiro."); return; }

        btnEnviarImagem.disabled = true;
        const textareaImagens = document.getElementById("prod-imagens");
        const linksExistentes = textareaImagens.value.split("\n").map(s => s.trim()).filter(Boolean);

        for (let i = 0; i < arquivos.length; i++) {
            const arquivo = arquivos[i];
            avisoUpload.textContent = `Enviando imagem ${i + 1} de ${arquivos.length}...`;
            avisoUpload.style.color = "var(--muted)";
            try {
                const nomeArquivo = `${Date.now()}-${arquivo.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
                const ref = storageRef(storage, `cardapio/produtos/${nomeArquivo}`);
                await uploadBytes(ref, arquivo);
                const url = await getDownloadURL(ref);
                linksExistentes.push(url);
            } catch (err) {
                console.error(err);
                avisoUpload.textContent = `Erro ao enviar "${arquivo.name}". Confira se o Storage está habilitado no Firebase.`;
                avisoUpload.style.color = "var(--red)";
                btnEnviarImagem.disabled = false;
                textareaImagens.value = linksExistentes.join("\n");
                return;
            }
        }

        textareaImagens.value = linksExistentes.join("\n");
        avisoUpload.textContent = `✅ ${arquivos.length} imagem(ns) enviada(s) e adicionada(s) na lista abaixo.`;
        avisoUpload.style.color = "var(--green)";
        inputImagemArquivo.value = "";
        btnEnviarImagem.disabled = false;
    });
}

document.getElementById("prod-salvar").addEventListener("click", async () => {
    const nome = document.getElementById("prod-nome").value.trim();
    if (!nome) { alert("Dá um nome pro produto primeiro."); return; }
    const dados = {
        nome,
        cat: document.getElementById("prod-cat").value.trim() || "Copos",
        preco: document.getElementById("prod-preco").value,
        desc: document.getElementById("prod-desc").value.trim(),
        imagens: document.getElementById("prod-imagens").value.split("\n"),
        limiteGratis: document.getElementById("prod-limite").value,
        destaque: document.getElementById("prod-destaque").checked,
        customizavel: document.getElementById("prod-customizavel").checked
    };
    const idEditando = document.getElementById("prod-editando-id").value || null;
    const btn = document.getElementById("prod-salvar");
    btn.disabled = true;
    try {
        await salvarProduto(db, dados, idEditando);
        limparFormProduto();
    } catch (e) {
        console.error(e);
        alert("Não deu pra salvar o produto. Tente de novo.");
    } finally {
        btn.disabled = false;
    }
});

// ==============================================
// ADICIONAIS
// ==============================================
const listaAdicionaisEl = document.getElementById("lista-adicionais");
const adTipoSel = document.getElementById("ad-tipo");
const adPrecoBox = document.getElementById("ad-preco-box");

function atualizarVisibilidadePreco() {
    adPrecoBox.style.display = adTipoSel.value === "extra" ? "" : "none";
}
adTipoSel.addEventListener("change", atualizarVisibilidadePreco);
atualizarVisibilidadePreco();

function linhaAdicional(a, lista, i) {
    const semSubir = i === 0 || !!lista[i - 1].popular !== !!a.popular;
    const semDescer = i === lista.length - 1 || !!lista[i + 1].popular !== !!a.popular;
    return `
        <div class="item-linha">
            <div class="icones-ordem">
                <button class="icone-btn btn-secundario" data-mover-adicional="${a.id}" data-tipo="${a.tipo}" data-direcao="cima" title="Mover pra cima" ${semSubir ? "disabled" : ""}><i class="fas fa-arrow-up"></i></button>
                <button class="icone-btn btn-secundario" data-mover-adicional="${a.id}" data-tipo="${a.tipo}" data-direcao="baixo" title="Mover pra baixo" ${semDescer ? "disabled" : ""}><i class="fas fa-arrow-down"></i></button>
            </div>
            <div class="item-info">
                <strong>${esc(a.nome)} <span class="badge-tipo">${a.tipo === "extra" ? "Pago" : "Grátis"}</span> ${a.popular ? "🔥" : ""}</strong>
                <span>${a.tipo === "extra" ? `+ R$ ${a.preco.toFixed(2)}` : "Escolhido dentro do limite grátis do copo"}</span>
            </div>
            ${pillsStatus("adicional", a.id, a.status)}
            <div class="icones-acao">
                <button class="icone-btn btn-secundario" data-editar-adicional="${a.id}"><i class="fas fa-pen"></i></button>
                <button class="icone-btn btn-perigo" data-excluir-adicional="${a.id}"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `;
}

function blocoAdicionais(titulo, lista) {
    if (lista.length === 0) return "";
    return `
        <h4 style="margin:14px 0 8px; color:var(--muted); font-size:0.85rem; text-transform:uppercase; letter-spacing:.03em;">${titulo}</h4>
        ${lista.map((a, i) => linhaAdicional(a, lista, i)).join("")}
    `;
}

escutarAdicionais(db, ({ gratis, extras }) => {
    const todos = [...gratis, ...extras];
    if (todos.length === 0) {
        listaAdicionaisEl.innerHTML = `<p style="color:var(--muted);">Nenhum adicional cadastrado ainda. Use o botão "Importar catálogo atual" acima ou cadastre um novo.</p>`;
        return;
    }
    listaAdicionaisEl.innerHTML = blocoAdicionais("Adicionais grátis", gratis) + blocoAdicionais("Adicionais pagos", extras);

    listaAdicionaisEl.querySelectorAll("[data-mover-adicional]").forEach(btn => {
        btn.addEventListener("click", async () => {
            const { moverAdicional: id, tipo, direcao } = btn.dataset;
            const lista = tipo === "extra" ? extras : gratis;
            btn.disabled = true;
            try {
                await moverAdicionalOrdem(db, lista, id, direcao);
            } catch (err) {
                console.error(err);
                alert("Não deu pra mudar a ordem. Tente de novo.");
                btn.disabled = false;
            }
        });
    });

    listaAdicionaisEl.querySelectorAll("[data-editar-adicional]").forEach(btn => {
        btn.addEventListener("click", () => {
            const a = todos.find(x => x.id === btn.dataset.editarAdicional);
            if (!a) return;
            document.getElementById("ad-editando-id").value = a.id;
            document.getElementById("ad-nome").value = a.nome;
            document.getElementById("ad-tipo").value = a.tipo;
            document.getElementById("ad-preco").value = a.preco;
            document.getElementById("ad-popular").checked = a.popular;
            atualizarVisibilidadePreco();
            document.getElementById("ad-cancelar-edicao").style.display = "";
            document.getElementById("ad-salvar").textContent = "Salvar Alterações";
            window.scrollTo({ top: 0, behavior: "smooth" });
        });
    });

    listaAdicionaisEl.querySelectorAll("[data-excluir-adicional]").forEach(btn => {
        btn.addEventListener("click", async () => {
            const a = todos.find(x => x.id === btn.dataset.excluirAdicional);
            if (!a) return;
            if (!confirm(`Excluir "${a.nome}" dos adicionais? Isso não pode ser desfeito.`)) return;
            try {
                await excluirAdicional(db, a.id);
            } catch (err) {
                console.error(err);
                alert("Não deu pra excluir. Tente de novo.");
            }
        });
    });
});

function limparFormAdicional() {
    document.getElementById("ad-editando-id").value = "";
    document.getElementById("ad-nome").value = "";
    document.getElementById("ad-tipo").value = "gratis";
    document.getElementById("ad-preco").value = "0";
    document.getElementById("ad-popular").checked = false;
    atualizarVisibilidadePreco();
    document.getElementById("ad-cancelar-edicao").style.display = "none";
    document.getElementById("ad-salvar").textContent = "Salvar Adicional";
}

document.getElementById("ad-cancelar-edicao").addEventListener("click", limparFormAdicional);

document.getElementById("ad-salvar").addEventListener("click", async () => {
    const nome = document.getElementById("ad-nome").value.trim();
    if (!nome) { alert("Dá um nome pro adicional primeiro."); return; }
    const dados = {
        nome,
        tipo: document.getElementById("ad-tipo").value,
        preco: document.getElementById("ad-preco").value,
        popular: document.getElementById("ad-popular").checked
    };
    const idEditando = document.getElementById("ad-editando-id").value || null;
    const btn = document.getElementById("ad-salvar");
    btn.disabled = true;
    try {
        await salvarAdicional(db, dados, idEditando);
        limparFormAdicional();
    } catch (e) {
        console.error(e);
        alert("Não deu pra salvar o adicional. Tente de novo.");
    } finally {
        btn.disabled = false;
    }
});
