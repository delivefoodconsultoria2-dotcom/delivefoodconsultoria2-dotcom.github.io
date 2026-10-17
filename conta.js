/* DeliveRota — base da Área do cliente e do Painel master (login Firebase + servidor) */
(function () {
  const $ = s => document.querySelector(s);
  const API = (() => { const a = (window.DELIVEROTA_API || "").trim(); return a ? (a.endsWith("/") ? a : a + "/") : ""; })();
  const FB = window.DELIVEROTA_FIREBASE || null;
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ERR = { "auth/invalid-email": "E-mail inválido.", "auth/invalid-credential": "E-mail ou senha incorretos.", "auth/invalid-login-credentials": "E-mail ou senha incorretos.",
    "auth/wrong-password": "E-mail ou senha incorretos.", "auth/user-not-found": "E-mail ou senha incorretos.", "auth/too-many-requests": "Muitas tentativas. Espere alguns minutos.", "auth/network-request-failed": "Sem internet." };
  let auth = null;
  function aparelho() { try { let id = localStorage.getItem("deliverota-aparelho"); if (!id) { id = "ap-" + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join(""); localStorage.setItem("deliverota-aparelho", id); } return id; } catch (e) { return ""; } }
  function load(src) { return new Promise((ok, no) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
  async function api(arq, corpo) {
    const tk = await auth.currentUser.getIdToken();
    const r = await fetch(API + arq, { method: corpo ? "POST" : "GET", headers: { Authorization: "Bearer " + tk, "X-Aparelho": aparelho(), ...(corpo ? { "Content-Type": "application/json" } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || "Não consegui falar com o servidor. Tente de novo.");
    return j;
  }
  function telaLogin(box, done) {
    box.innerHTML = `<form class="card" id="cLogin" novalidate><h2>Entrar</h2><p class="sub">Use o mesmo e-mail e senha do app DeliveRota.</p>
      <label>E-mail<input id="cEmail" type="email" autocomplete="email" required></label>
      <label>Senha<input id="cPass" type="password" autocomplete="current-password" required></label>
      <p class="err" id="cErr" hidden></p><button class="btn primary" type="submit">Entrar</button>
      <button class="link" type="button" id="cForgot">Esqueci minha senha</button></form>`;
    $("#cLogin").addEventListener("submit", async e => {
      e.preventDefault(); const er = $("#cErr"); er.hidden = true;
      try { await auth.signInWithEmailAndPassword($("#cEmail").value.trim(), $("#cPass").value); done(); }
      catch (x) { er.hidden = false; er.textContent = ERR[x.code] || x.message; }
    });
    $("#cForgot").addEventListener("click", async () => {
      const em = $("#cEmail").value.trim(), er = $("#cErr"); er.hidden = false;
      if (!em) { er.textContent = "Digite seu e-mail acima e toque de novo."; return; }
      try { await auth.sendPasswordResetEmail(em); er.textContent = "Se existir conta com esse e-mail, enviamos o link para criar uma senha nova."; } catch (x) { er.textContent = ERR[x.code] || x.message; }
    });
  }
  async function iniciar(box, quandoLogado) {
    if (!FB || !API) { box.innerHTML = `<div class="card"><h2>Ainda não configurado</h2><p class="sub">O login de verdade (Firebase) e o servidor de pagamento precisam estar ligados no arquivo firebase-config.js.</p><a class="btn ghost" href="./">Voltar ao app</a></div>`; return; }
    box.innerHTML = `<div class="card"><p class="sub">Carregando…</p></div>`;
    try {
      await load("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
      await load("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js");
    } catch (e) { box.innerHTML = `<div class="card"><h2>Sem internet</h2><p class="sub">Conecte e recarregue a página.</p></div>`; return; }
    if (!firebase.apps.length) firebase.initializeApp(FB);
    auth = firebase.auth(); auth.languageCode = "pt";
    const u = await new Promise(ok => { const off = auth.onAuthStateChanged(x => { off(); ok(x); }); });
    const go = () => quandoLogado(auth.currentUser);
    if (u) go(); else telaLogin(box, go);
  }
  async function sair() { if (auth) await auth.signOut(); location.reload(); }
  window.Conta = { iniciar, api, esc, sair, fmtData: iso => iso ? new Date(iso).toLocaleDateString("pt-BR") : "—",
    fmtReal: v => Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }) };
})();
