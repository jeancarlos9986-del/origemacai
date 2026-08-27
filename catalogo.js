// ==============================================
// CATÁLOGO EM TEMPO REAL — PRODUTOS E ADICIONAIS
// ==============================================
// Antes, os produtos (PRODUCTS), adicionais grátis (GRATIS) e adicionais
// pagos (EXTRAS) do cardápio ficavam escritos direto no código do site.html.
// Pra mudar qualquer coisa — inclusive só marcar que algo acabou — era
// preciso editar o código e publicar de novo.
//
// Agora o catálogo mora no Firestore, em duas coleções:
//   - "cardapio_produtos": cada doc é um produto (copo, shake, cone...)
//   - "cardapio_adicionais": cada doc é um adicional, grátis ou pago
//     (o campo "tipo" distingue: "gratis" ou "extra")
//
// Esse arquivo é importado tanto pelo site.html (só leitura, tempo real)
// quanto pelo cardapio.html (o painel de administração, leitura + escrita).
// Nenhum dos dois cria sua própria ligação com o Firestore aqui dentro —
// cada chamada recebe o "db" já pronto de quem importou, pra evitar
// inicializar o Firebase duas vezes.
// ==============================================

import {
    collection, doc, addDoc, setDoc, updateDoc, deleteDoc,
    onSnapshot, query, orderBy, getDocs, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const STATUS = {
    DISPONIVEL: "disponivel",
    ACABANDO: "acabando",
    ESGOTADO: "esgotado"
};

// ==============================================
// PRODUTOS
// ==============================================

// Escuta a coleção de produtos em tempo real. O callback recebe um array
// já no formato que o site.html espera (compatível com o antigo PRODUCTS),
// com "esgotado"/"acabando" derivados do campo "status".
//
// Ordem de exibição (painel e site), nessa prioridade:
//   1) produtos com "destaque" (🔥 mais pedido) sempre vêm primeiro
//   2) dentro de cada grupo (destaque / sem destaque), pelo campo "ordem"
//      — controlado pelas setinhas ▲▼ do painel
// Produtos antigos que ainda não têm "ordem" caem pro final do seu grupo
// (ORDEM_PADRAO), até serem reordenados pela primeira vez no painel — depois
// disso a lista inteira passa a ter valores sequenciais (0, 1, 2...).
// Importante: por causa disso, a ordenação é feita aqui no cliente, e não
// com orderBy("ordem") no Firestore — um orderBy("ordem") excluiria da
// consulta qualquer produto que ainda não tivesse esse campo.
const ORDEM_PADRAO = 9999;

export function escutarProdutos(db, callback, onErro) {
    return onSnapshot(
        query(collection(db, "cardapio_produtos"), orderBy("nome")),
        snap => {
            const produtos = snap.docs.map(d => mapearProduto(d.id, d.data()));
            produtos.sort((a, b) =>
                (b.destaque ? 1 : 0) - (a.destaque ? 1 : 0) ||
                (a.ordem - b.ordem) ||
                a.nome.localeCompare(b.nome, "pt-BR")
            );
            callback(produtos);
        },
        onErro || (e => console.error("Erro ao escutar cardapio_produtos:", e))
    );
}

function mapearProduto(id, data) {
    const status = data.status || STATUS.DISPONIVEL;
    const ordemNum = Number(data.ordem);
    return {
        id,
        cat: data.cat || "Copos",
        nome: data.nome || "",
        preco: Number(data.preco) || 0,
        desc: data.desc || "",
        imagens: Array.isArray(data.imagens) && data.imagens.length ? data.imagens : ["./sem-foto.png"],
        limiteGratis: Number(data.limiteGratis) || 0,
        destaque: !!data.destaque,
        customizavel: data.customizavel !== false,
        ordem: Number.isFinite(ordemNum) ? ordemNum : ORDEM_PADRAO,
        status,
        esgotado: status === STATUS.ESGOTADO,
        acabando: status === STATUS.ACABANDO
    };
}

export async function salvarProduto(db, dados, id = null) {
    const payload = {
        nome: (dados.nome || "").trim(),
        cat: dados.cat || "Copos",
        preco: Number(dados.preco) || 0,
        desc: dados.desc || "",
        imagens: (dados.imagens || []).map(s => s.trim()).filter(Boolean),
        limiteGratis: Number(dados.limiteGratis) || 0,
        destaque: !!dados.destaque,
        customizavel: dados.customizavel !== false,
        status: dados.status || STATUS.DISPONIVEL,
        atualizadoEm: new Date()
    };
    // A "ordem" nunca é sobrescrita aqui numa edição — ela só muda pelos
    // botões ▲▼ do painel (moverProdutoOrdem). Um produto novo entra no
    // final da lista (ORDEM_PADRAO) até ser reordenado manualmente.
    if (id) {
        await updateDoc(doc(db, "cardapio_produtos", id), payload);
        return id;
    }
    payload.ordem = ORDEM_PADRAO;
    payload.criadoEm = new Date();
    const ref = await addDoc(collection(db, "cardapio_produtos"), payload);
    return ref.id;
}

export async function definirStatusProduto(db, id, status) {
    await updateDoc(doc(db, "cardapio_produtos", id), { status, atualizadoEm: new Date() });
}

export async function excluirProduto(db, id) {
    await deleteDoc(doc(db, "cardapio_produtos", id));
}

// Move um produto pra cima ou pra baixo na lista, reorganizando a ordem de
// exibição. Recebe a lista já ordenada como está sendo mostrada no painel
// (mesma lista que vem do escutarProdutos) e grava valores sequenciais de
// "ordem" (0, 1, 2...) pra toda a lista de uma vez — isso "conserta" de
// quebra produtos antigos que ainda estivessem com ORDEM_PADRAO.
//
// Como produtos com "destaque" sempre aparecem antes dos sem destaque
// (ver escutarProdutos), não deixamos mover um produto pra dentro do outro
// grupo — o clique não teria efeito visual nenhum, só confundiria.
export async function moverProdutoOrdem(db, produtosOrdenados, id, direcao) {
    const idx = produtosOrdenados.findIndex(p => p.id === id);
    if (idx === -1) return;
    const alvo = idx + (direcao === "cima" ? -1 : 1);
    if (alvo < 0 || alvo >= produtosOrdenados.length) return;
    if (!!produtosOrdenados[idx].destaque !== !!produtosOrdenados[alvo].destaque) return;

    const nova = [...produtosOrdenados];
    [nova[idx], nova[alvo]] = [nova[alvo], nova[idx]];

    const batch = writeBatch(db);
    nova.forEach((p, i) => {
        batch.update(doc(db, "cardapio_produtos", p.id), { ordem: i, atualizadoEm: new Date() });
    });
    await batch.commit();
}

// ==============================================
// ADICIONAIS (grátis e pagos)
// ==============================================

// A ordem de exibição dos adicionais segue a mesma lógica dos produtos:
// populares (🔥) sempre primeiro, e dentro de cada grupo (popular / normal)
// pelo campo "ordem" — controlado pelas setinhas ▲▼ do painel. "gratis" e
// "extra" são ordenados de forma independente, já que aparecem em blocos
// separados no site (adicionais grátis x adicionais pagos).
export function escutarAdicionais(db, callback, onErro) {
    return onSnapshot(
        query(collection(db, "cardapio_adicionais"), orderBy("nome")),
        snap => {
            const todos = snap.docs.map(d => mapearAdicional(d.id, d.data()));
            const porOrdem = (a, b) =>
                (b.popular ? 1 : 0) - (a.popular ? 1 : 0) ||
                (a.ordem - b.ordem) ||
                a.nome.localeCompare(b.nome, "pt-BR");
            callback({
                gratis: todos.filter(a => a.tipo === "gratis").sort(porOrdem),
                extras: todos.filter(a => a.tipo === "extra").sort(porOrdem)
            });
        },
        onErro || (e => console.error("Erro ao escutar cardapio_adicionais:", e))
    );
}

function mapearAdicional(id, data) {
    const status = data.status || STATUS.DISPONIVEL;
    const ordemNum = Number(data.ordem);
    return {
        id,
        tipo: data.tipo === "extra" ? "extra" : "gratis",
        nome: data.nome || "",
        preco: Number(data.preco) || 0,
        popular: !!data.popular,
        ordem: Number.isFinite(ordemNum) ? ordemNum : ORDEM_PADRAO,
        status,
        ativo: status !== STATUS.ESGOTADO,
        acabando: status === STATUS.ACABANDO
    };
}

export async function salvarAdicional(db, dados, id = null) {
    const payload = {
        nome: (dados.nome || "").trim(),
        tipo: dados.tipo === "extra" ? "extra" : "gratis",
        preco: dados.tipo === "extra" ? (Number(dados.preco) || 0) : 0,
        popular: !!dados.popular,
        status: dados.status || STATUS.DISPONIVEL,
        atualizadoEm: new Date()
    };
    // Assim como em salvarProduto: "ordem" não é sobrescrita numa edição,
    // só muda pelos botões ▲▼ (moverAdicionalOrdem).
    if (id) {
        await updateDoc(doc(db, "cardapio_adicionais", id), payload);
        return id;
    }
    payload.ordem = ORDEM_PADRAO;
    payload.criadoEm = new Date();
    const ref = await addDoc(collection(db, "cardapio_adicionais"), payload);
    return ref.id;
}

export async function definirStatusAdicional(db, id, status) {
    await updateDoc(doc(db, "cardapio_adicionais", id), { status, atualizadoEm: new Date() });
}

export async function excluirAdicional(db, id) {
    await deleteDoc(doc(db, "cardapio_adicionais", id));
}

// Move um adicional pra cima/baixo dentro do MESMO grupo (grátis ou pago) —
// recebe a lista já filtrada por tipo e ordenada (gratis[] ou extras[] que
// vêm do escutarAdicionais). Mesma regra dos produtos: não deixa cruzar a
// fronteira popular/normal, pra não dar um clique sem efeito visível.
export async function moverAdicionalOrdem(db, listaMesmoTipo, id, direcao) {
    const idx = listaMesmoTipo.findIndex(a => a.id === id);
    if (idx === -1) return;
    const alvo = idx + (direcao === "cima" ? -1 : 1);
    if (alvo < 0 || alvo >= listaMesmoTipo.length) return;
    if (!!listaMesmoTipo[idx].popular !== !!listaMesmoTipo[alvo].popular) return;

    const nova = [...listaMesmoTipo];
    [nova[idx], nova[alvo]] = [nova[alvo], nova[idx]];

    const batch = writeBatch(db);
    nova.forEach((a, i) => {
        batch.update(doc(db, "cardapio_adicionais", a.id), { ordem: i, atualizadoEm: new Date() });
    });
    await batch.commit();
}

// ==============================================
// MIGRAÇÃO ÚNICA — importa o catálogo que hoje está fixo no código
// ==============================================
// Roda uma vez (pelo botão "Importar catálogo atual" no painel). Só escreve
// se as coleções ainda estiverem vazias, pra nunca duplicar em cliques repetidos.
const PRODUTOS_ATUAIS = [
    { nome: "Copo 400ml Tradicional", cat: "Copos", preco: 18.90, desc: "Escolha até 2 adicionais grátis.", imagens: ["./unnamed.jpg", "./copo401.jpeg"], limiteGratis: 2 },
    { nome: "Copo 500ml Super", cat: "Copos", preco: 22.90, desc: "Escolha até 3 adicionais grátis.", imagens: ["./copo506.jpeg", "./copo507.jpeg", "./copo508.jpeg", "./copo501.jpeg"], limiteGratis: 3, destaque: true },
    { nome: "Copo 700ml Mega", cat: "Copos", preco: 29.90, desc: "Escolha até 4 adicionais grátis.", imagens: ["./copo 700ml.jpeg", "./copo 701ml.jpeg"], limiteGratis: 4, destaque: false },
    { nome: "Copo Trufado 500ml", cat: "Copos", preco: 34.90, desc: "Copo recheado de nutella, sinta nutella em cada colherada", imagens: ["./copotrufado3.jpeg", "./copotrufado2.jpeg", "./Copo Trufado.jpeg"], limiteGratis: 2 },
    { nome: "Shake Açai Tradicional 500ml", cat: "Copos", preco: 16.00, desc: "Açai batido com leite, leite pó e leite condensado.", imagens: ["./Shake02.jpeg", "./Shake01.jpeg"], limiteGratis: 2 },
    { nome: "Cone Trufado", cat: "Copos", preco: 13.00, desc: "Cone com açai e muitaaaaaaaa Nutella", imagens: ["./cone02.jpeg", "./cone.jpeg"], limiteGratis: 0, customizavel: false }
];

const GRATIS_ATUAIS = [
    { nome: "Banana", popular: false },
    { nome: "Granola", popular: true },
    { nome: "Leite condensado", popular: true },
    { nome: "Leite em pó", popular: false },
    { nome: "Morango", popular: false }
];

const EXTRAS_ATUAIS = [
    { nome: "Kiwi", preco: 2, popular: false },
    { nome: "Paçoca", preco: 2, popular: false },
    { nome: "Nutella", preco: 5, popular: true },
    { nome: "Kit Kat", preco: 4, popular: true },
    { nome: "Ovomaltine", preco: 4, popular: true },
    { nome: "Sonho De Valsa", preco: 3, popular: false },
    { nome: "Ouro Branco", preco: 3, popular: false },
    { nome: "Choco Ball", preco: 3, popular: false },
    { nome: "Disquete/Confete", preco: 3, popular: false },
    { nome: "Amendoim", preco: 2, popular: false }
];

export async function importarCatalogoAtualSeVazio(db) {
    const [snapProdutos, snapAdicionais] = await Promise.all([
        getDocs(collection(db, "cardapio_produtos")),
        getDocs(collection(db, "cardapio_adicionais"))
    ]);
    if (!snapProdutos.empty || !snapAdicionais.empty) {
        return { importado: false, motivo: "Já existem itens cadastrados — nada foi importado, pra não duplicar." };
    }

    const batch = writeBatch(db);
    PRODUTOS_ATUAIS.forEach((p, i) => {
        const ref = doc(collection(db, "cardapio_produtos"));
        batch.set(ref, { ...p, destaque: !!p.destaque, customizavel: p.customizavel !== false, ordem: i, status: STATUS.DISPONIVEL, criadoEm: new Date() });
    });
    GRATIS_ATUAIS.forEach((g, i) => {
        const ref = doc(collection(db, "cardapio_adicionais"));
        batch.set(ref, { nome: g.nome, tipo: "gratis", preco: 0, popular: !!g.popular, ordem: i, status: STATUS.DISPONIVEL, criadoEm: new Date() });
    });
    EXTRAS_ATUAIS.forEach((e, i) => {
        const ref = doc(collection(db, "cardapio_adicionais"));
        batch.set(ref, { nome: e.nome, tipo: "extra", preco: e.preco, popular: !!e.popular, ordem: i, status: STATUS.DISPONIVEL, criadoEm: new Date() });
    });
    await batch.commit();
    return { importado: true, total: PRODUTOS_ATUAIS.length + GRATIS_ATUAIS.length + EXTRAS_ATUAIS.length };
}
