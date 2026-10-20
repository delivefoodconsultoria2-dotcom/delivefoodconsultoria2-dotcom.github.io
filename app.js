/* DeliveRota — app de roteirização para entregadores (PWA: Android/Play Store e Windows) */
(function () {
"use strict";

/* ===================== utilidades ===================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = t => String(t ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = n => (n || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const km1 = n => (n || 0).toFixed(1).replace(".", ",");
const uid = () => Math.random().toString(36).slice(2, 9);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const digits = s => String(s || "").replace(/\D/g, "");

const LIBS = {
  xlsx: "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
  pdf: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
  pdfWorker: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  ocr: "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
  zxing: "https://unpkg.com/@zxing/library@0.20.0/umd/index.min.js"
};
const loaded = {};
function loadScript(url) {
  if (!loaded[url]) loaded[url] = new Promise((ok, fail) => {
    const s = document.createElement("script");
    s.src = url; s.async = true;
    s.onload = ok; s.onerror = () => { delete loaded[url]; fail(new Error("Não consegui baixar um componente. Verifique a internet.")); };
    document.head.appendChild(s);
  });
  return loaded[url];
}

/* ===================== armazenamento (IndexedDB) ===================== */
let dbp;
function idb() {
  if (!dbp) dbp = new Promise((ok, fail) => {
    const r = indexedDB.open("deliverota", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("kv"); r.result.createObjectStore("photos"); };
    r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
  });
  return dbp;
}
async function dbGet(store, key) { try { const d = await idb(); return await new Promise((ok, fail) => { const q = d.transaction(store).objectStore(store).get(key); q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); }); } catch (e) { return undefined; } }
async function dbSet(store, key, val) { try { const d = await idb(); await new Promise((ok, fail) => { const t = d.transaction(store, "readwrite"); t.objectStore(store).put(val, key); t.oncomplete = ok; t.onerror = () => fail(t.error); }); } catch (e) {} }
async function dbDel(store, key) { try { const d = await idb(); await new Promise(ok => { const t = d.transaction(store, "readwrite"); t.objectStore(store).delete(key); t.oncomplete = ok; t.onerror = ok; }); } catch (e) {} }

/* ===================== estado ===================== */
const DEFAULTS = {
  gastos: [], agenda: [], planejadas: [], rotaNome: "", rotaData: "",
  stops: [], start: null, history: [], filter: "all",
  settings: { city: "Belo Horizonte - MG", rate: 3.5, vehicle: "moto", stopMin: 3, nav: "google", roundTrip: false, theme: "system",
    speak: true, kml: 0, fuelPrice: 6.19, autoRep: "none", repWa: "", repMail: "", msg: "Olá {nome}! Sou o entregador do seu pedido e chego em cerca de {min} minutos." }
};
let st = JSON.parse(JSON.stringify(DEFAULTS));
let saveT;
function save() { clearTimeout(saveT); saveT = setTimeout(() => { if (user) dbSet("kv", "state:" + user.uid, st); }, 60); }
window.addEventListener("pagehide", () => { if (user) dbSet("kv", "state:" + user.uid, st); });
document.addEventListener("visibilitychange", () => { if (document.hidden && user) dbSet("kv", "state:" + user.uid, st); });
/* região padrão: Belo Horizonte e Grande BH */
const REGION = { center: [-19.9191, -43.9386], zoom: 11, viewbox: "-44.36,-19.50,-43.66,-20.22" };
const RMBH = ["Belo Horizonte", "Contagem", "Betim", "Nova Lima", "Santa Luzia", "Ribeirão das Neves", "Ibirité", "Sabará", "Vespasiano", "Lagoa Santa", "Sarzedo", "Pedro Leopoldo", "Brumadinho", "Igarapé", "São José da Lapa", "Confins", "Mário Campos", "Raposos", "Caeté", "Esmeraldas", "Juatuba", "Mateus Leme", "São Joaquim de Bicas"];
const SPEED = { moto: 24, carro: 20, bike: 13, pe: 4.5 };
const VEHICLE_LABEL = { moto: "Moto", carro: "Carro / van", bike: "Bicicleta", pe: "A pé" };

/* ===================== distância e rota ===================== */
function hav(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return 0;
  const R = 6371, t = x => x * Math.PI / 180, dl = t(b.lat - a.lat), dg = t(b.lng - a.lng);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h)) * 1.3; // 1,3 = fator médio de ruas
}
const hasGeo = s => s && s.lat != null && s.lng != null;
const pending = () => st.stops.filter(s => s.status === "pending");
/* ponto final da rota: outro endereço (ex.: casa) ou voltar ao início */
function fimPt() { return (st.end && st.end.lat != null) ? st.end : (st.settings.roundTrip && st.start ? st.start : null); }
const hhmm = t => new Date(t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
/* previsão de horário de cada parada e do término (inclui a volta ao ponto final) */
function previsao(list) {
  list = (list || pending()).filter(hasGeo);
  const v = SPEED[st.settings.vehicle] || 22, para = (st.settings.stopMin || 3) * 60000;
  const reta = routeKm(list, lastPoint());
  let fator = 1.35; if (osrmKm && reta > 0.3) fator = Math.min(2.2, Math.max(1.05, osrmKm / reta));
  let p = (NV.on && NV.eu) ? NV.eu : (ondeEstou && Date.now() - ondeEstou.t < 20 * 60000 ? ondeEstou : lastPoint());
  let t = Date.now(), km = 0; const itens = [];
  list.forEach(s => { const d = p ? hav(p, s) * fator : 0; km += d; t += d / v * 3600000; itens.push({ s, t, km }); t += para; p = s; });
  const fp = fimPt(); let kmFim = 0; if (fp && p) { kmFim = hav(p, fp) * fator; km += kmFim; t += kmFim / v * 3600000; }
  return { itens, fim: t, km, volta: !!fp };
}
function nomePonto(x, vazio) { return x ? (x.label || "Endereço escolhido") : vazio; }
function inicioFimSheet() {
  const fimTxt = st.end ? nomePonto(st.end) : (st.settings.roundTrip && st.start ? "Voltar ao início" : "Termina na última entrega");
  sheet(`<h3>Início e fim da rota</h3><p class="sub">O app organiza a ordem e calcula o horário de término contando a volta.</p>
    <h4 class="cfg-h">Começo da rota</h4><div class="sub" style="margin-bottom:6px"><b>${esc(nomePonto(st.start, "Onde você estiver"))}</b></div>
    <div class="row wrap"><button class="btn ghost sm" id="ifIniGps">Minha localização</button><button class="btn ghost sm" id="ifIniMapa">Escolher no mapa</button></div>
    <div class="row" style="margin-top:6px"><input class="busca" id="ifIniTxt" placeholder="Ou digite o endereço de saída" style="margin:0;flex:1"><button class="btn primary sm" id="ifIniOk">OK</button></div>
    <h4 class="cfg-h">Fim da rota</h4><div class="sub" style="margin-bottom:6px"><b>${esc(fimTxt)}</b></div>
    <div class="row wrap"><button class="btn ghost sm" id="ifFimNao">Termina na última entrega</button><button class="btn ghost sm" id="ifFimIni">Voltar ao início</button><button class="btn ghost sm" id="ifFimGps">Minha localização</button><button class="btn ghost sm" id="ifFimMapa">Escolher no mapa</button></div>
    <div class="row" style="margin-top:6px"><input class="busca" id="ifFimTxt" placeholder="Ou digite o endereço final (ex.: sua casa)" style="margin:0;flex:1"><button class="btn primary sm" id="ifFimOk">OK</button></div>
    <button class="btn ghost" id="ifFecha" style="width:100%;margin-top:14px">Pronto</button>`, bg => {
    const q = id => bg.querySelector(id);
    const aplica = msg => { save(); if (pending().filter(hasGeo).length >= 2) optimize({ quieto: true }); else renderAll(true); toast(msg); inicioFimSheet(); };
    const gps = cb => { if (!navigator.geolocation) return toast("Este aparelho não informa a localização"); toast("Buscando sua localização..."); navigator.geolocation.getCurrentPosition(p2 => { ondeEstou = { lat: p2.coords.latitude, lng: p2.coords.longitude, t: Date.now() }; cb({ lat: p2.coords.latitude, lng: p2.coords.longitude, label: "Minha localização" }); }, () => toast("Libere a permissão de localização."), { enableHighAccuracy: true, timeout: 15000 }); };
    const busca = async (txt, cb) => { txt = (txt || "").trim(); if (!txt) return toast("Digite o endereço"); toast("Procurando o endereço..."); const a = parseAddressLine(txt) || {}; const g = await photon({ street: a.street || txt, num: a.num || "", bairro: a.bairro || "", city: st.settings.city }) || await nominatim({ q: txt + ", " + (st.settings.city || "").split(" - ")[0] }); if (!g) return toast("Não achei esse endereço. Tente com o número e o bairro."); cb({ lat: g.lat, lng: g.lng, label: txt }); };
    q("#ifIniGps").addEventListener("click", () => gps(x => { st.start = x; aplica("Início: sua localização"); }));
    q("#ifIniMapa").addEventListener("click", () => { closeSheet(); go("rota"); setPinMode("start"); });
    q("#ifIniOk").addEventListener("click", () => busca(q("#ifIniTxt").value, x => { st.start = x; aplica("Início definido"); }));
    q("#ifFimNao").addEventListener("click", () => { st.end = null; st.settings.roundTrip = false; aplica("A rota termina na última entrega"); });
    q("#ifFimIni").addEventListener("click", () => { st.end = null; st.settings.roundTrip = true; if (st.start) aplica("No fim, volta ao início"); else gps(x => { st.start = x; aplica("No fim, volta para onde você está agora"); }); });
    q("#ifFimGps").addEventListener("click", () => gps(x => { st.end = x; aplica("Fim: este local"); }));
    q("#ifFimMapa").addEventListener("click", () => { closeSheet(); go("rota"); setPinMode("end"); });
    q("#ifFimOk").addEventListener("click", () => busca(q("#ifFimTxt").value, x => { st.end = x; aplica("Fim definido"); }));
    q("#ifFecha").addEventListener("click", closeSheet);
  });
}
function routeKm(list, from) { let k = 0, p = from || st.start; list.filter(hasGeo).forEach(s => { if (p) k += hav(p, s); p = s; }); return k; }
function lastPoint() { const d = st.stops.filter(s => s.status !== "pending" && hasGeo(s)); return d.length ? d[d.length - 1] : st.start; }

/* ordena as paradas: prioridade/horário primeiro, depois vizinho mais próximo + 2-opt/or-opt.
   d(a,b) = custo entre dois pontos (linha reta ou tempo real pelas ruas) */
function ordenar(geo, anchor, d) {
  const rank = s => s.prio ? 0 : s.win === "Até 12:00" ? 1 : s.win === "Depois das 15:00" ? 3 : 2;
  let out = [];
  [0, 1, 2, 3].forEach(r => {
    let group = geo.filter(s => rank(s) === r); if (!group.length) return;
    let cur = out.length ? out[out.length - 1] : anchor, seq = [];
    while (group.length) { group.sort((x, y) => d(cur, x) - d(cur, y)); cur = group.shift(); seq.push(cur); }
    const startPt = out.length ? out[out.length - 1] : anchor;
    const endPt = (r === 3 || !geo.some(s => rank(s) > r)) ? fimPt() : null;
    seq = twoOpt(seq, startPt, endPt, d);
    out = out.concat(seq);
  });
  return out;
}
const dReta = (a, b) => (a && b) ? hav(a, b) : 0;
function optimize(opts = {}) {
  const done = st.stops.filter(s => s.status !== "pending");
  const pend = pending();
  const geo = pend.filter(hasGeo), noGeo = pend.filter(s => !hasGeo(s));
  if (geo.length < 2) { toast(noGeo.length ? "Algumas paradas ainda estão sem localização" : "Adicione pelo menos 2 paradas"); return; }
  const before = routeKm(geo, lastPoint());
  const anchor = lastPoint() || geo[0];
  const out = ordenar(geo, anchor, dReta);
  const after = routeKm(out, lastPoint());
  st.stops = done.concat(out, noGeo); markStart();
  save(); renderAll(true);
  const saved = before - after;
  if (!opts.quieto) toast(saved > 0.05 ? `Rota otimizada: ${km1(saved)} km a menos` : "Rota organizada na melhor ordem");
  refinarPelasRuas();
}
/* ajuste fino: usa o tempo real de percurso pelas ruas (mão única, retornos) */
let refinoN = 0; const matrizCache = new Map();
async function refinarPelasRuas() {
  const meu = ++refinoN;
  if (!navigator.onLine) return "offline";
  const geo = pending().filter(hasGeo); if (geo.length < 3) return "poucas";
  const anchor = lastPoint() || geo[0];
  const pts = anchor === geo[0] ? geo.slice() : [anchor, ...geo];
  const fp = fimPt(); if (fp && !pts.includes(fp)) pts.push(fp);
  if (pts.length > 100) return "muitas"; // serviço gratuito aceita até 100 pontos por vez
  const chave = pts.map(p => p.lat.toFixed(5) + "," + p.lng.toFixed(5)).join(";");
  let dur = matrizCache.get(chave);
  if (!dur) {
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 9000);
    try {
      const coords = pts.map(p => p.lng.toFixed(6) + "," + p.lat.toFixed(6)).join(";");
      const r = await fetch(`https://router.project-osrm.org/table/v1/driving/${coords}?annotations=duration`, { signal: ctl.signal });
      const j = await r.json(); if (j.code !== "Ok" || !j.durations) return "erro";
      dur = j.durations; matrizCache.set(chave, dur);
    } catch (e) { return "falhou"; } finally { clearTimeout(to); }
  }
  if (meu !== refinoN) return "mudou"; // a rota mudou enquanto esperava
  const idx = new Map(pts.map((p, i) => [p, i]));
  const d = (a, b) => { if (!a || !b) return 0; const i = idx.get(a), k = idx.get(b); if (i == null || k == null) return hav(a, b) * 120; const v = dur[i][k]; return v == null ? hav(a, b) * 120 : v; };
  const custo = seq => { let t = 0, c = anchor; seq.forEach(s => { t += d(c, s); c = s; }); return t; };
  const atual = pending().filter(hasGeo);
  if (atual.length !== geo.length || atual.some(s => !idx.has(s))) return "diferente";
  const antes = custo(atual);
  const melhor = ordenar(atual.slice(), anchor, d);
  const depois = custo(melhor);
  if (depois < antes - 30) { // só troca se ganhar pelo menos meio minuto
    const done = st.stops.filter(s => s.status !== "pending"), noGeo = pending().filter(s => !hasGeo(s));
    st.stops = done.concat(melhor, noGeo); markStart(); save(); renderAll(false);
    toast(`Ajustada pelas ruas: ~${Math.max(1, Math.round((antes - depois) / 60))} min a menos`, 3500);
  }
  st.ruas = true; save(); return { antes, depois };
}
function twoOpt(seq, startPt, endPt, d = dReta) {
  // 2-opt + or-opt: aguenta rotas de 100+ paradas em menos de 1 segundo
  const n = seq.length; if (n < 3) return seq;
  const P = i => i < 0 ? startPt : i >= n ? endPt : seq[i];
  let improved = true, passes = 0;
  const t0 = Date.now();
  while (improved && passes++ < 400 && Date.now() - t0 < 2500) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = P(i - 1), b = seq[i], c = seq[j], e = P(j + 1);
        const delta = d(a, c) + d(b, e) - d(a, b) - d(c, e);
        if (delta < -1e-7) { let x = i, y = j; while (x < y) { const t = seq[x]; seq[x] = seq[y]; seq[y] = t; x++; y--; } improved = true; }
      }
    }
    // or-opt: move blocos de 1 a 3 paradas para outro ponto da rota
    for (let len = 1; len <= 3; len++) {
      for (let i = 0; i + len <= n; i++) {
        const a = P(i - 1), b = seq[i], c = seq[i + len - 1], e = P(i + len);
        const gain = d(a, b) + d(c, e) - d(a, e);
        if (gain < 1e-7) continue;
        let best = null, bestCost = gain - 1e-7;
        for (let k = -1; k < n; k++) {
          if (k >= i - 1 && k <= i + len - 1) continue;
          const u = P(k), v = P(k + 1);
          if (v === b) continue;
          const add1 = d(u, b) + d(c, v) - d(u, v), add2 = d(u, c) + d(b, v) - d(u, v);
          if (add1 < bestCost) { bestCost = add1; best = { k, rev: false }; }
          if (add2 < bestCost) { bestCost = add2; best = { k, rev: true }; }
        }
        if (best) {
          let block = seq.splice(i, len); if (best.rev) block.reverse();
          const at = best.k < i ? best.k + 1 : best.k + 1 - len;
          seq.splice(at, 0, ...block); improved = true;
        }
      }
    }
  }
  return seq;
}

/* ===================== geocodificação ===================== */
const geoQueue = []; let geoBusy = false;
async function viaCep(cep) {
  cep = digits(cep); if (cep.length !== 8) return null;
  const c = await dbGet("kv", "cep:" + cep); if (c) return c;
  try { const r = await fetch(`https://viacep.com.br/ws/${cep}/json/`); const j = await r.json(); if (j.erro) return null; await dbSet("kv", "cep:" + cep, j); return j; } catch (e) { return null; }
}
async function nominatim(params) {
  const key = "geo:" + JSON.stringify(params); const c = await dbGet("kv", key); if (c) return c;
  const u = new URL("https://nominatim.openstreetmap.org/search");
  Object.entries({ format: "jsonv2", countrycodes: "br", limit: 1, "accept-language": "pt-BR", ...params }).forEach(([k, v]) => v && u.searchParams.set(k, v));
  const bias = st.start || st.cityCenter;
  if (!params.city) { if (bias) { const d = .6; u.searchParams.set("viewbox", [bias.lng - d, bias.lat + d, bias.lng + d, bias.lat - d].join(",")); } else u.searchParams.set("viewbox", REGION.viewbox); }
  const r = await fetch(u); const j = await r.json(); const out = j && j[0] ? { lat: +j[0].lat, lng: +j[0].lon } : null;
  if (out) await dbSet("kv", key, out);
  await sleep(1100); // limite de uso do serviço gratuito
  return out;
}
async function geocodeStop(s) {
  let city = s.city || st.settings.city;
  if (s.cep && (!s.street || !city)) { const v = await viaCep(s.cep); if (v) { s.street = s.street || v.logradouro; s.bairro = s.bairro || v.bairro; city = s.city = s.city || `${v.localidade} - ${v.uf}`; } }
  const num = /^\d+/.test(s.num || "") ? s.num.match(/^\d+/)[0] : "";
  const cityName = (city || "").split(" - ")[0];
  let g = null;
  if (s.street) g = await nominatim({ street: `${num} ${s.street}`.trim(), city: cityName, postalcode: digits(s.cep).length === 8 ? digits(s.cep).replace(/(\d{5})(\d{3})/, "$1-$2") : "" });
  if (!g && s.street) g = await nominatim({ q: [s.street + (num ? ", " + num : ""), s.bairro, cityName].filter(Boolean).join(", ") });
  if (!g && s.street) g = await nominatim({ q: [s.street, cityName].filter(Boolean).join(", ") });
  if (!g && s.cep) { const v = await viaCep(s.cep); if (v) g = await nominatim({ q: `${v.logradouro}, ${v.localidade}` }); }
  return g;
}
/* busca rápida: Photon (vários ao mesmo tempo) → Nominatim (um por vez) só para o que faltar */
const geoKey = s => ["g2", s.street, /^\d+/.test(s.num || "") ? s.num.match(/^\d+/)[0] : "", s.bairro, s.city || st.settings.city, digits(s.cep)].map(x => String(x || "").toLowerCase().trim()).join("|");
async function photon(s) {
  const city = s.city || st.settings.city || ""; const cityName = city.split(" - ")[0];
  const num = /^\d+/.test(s.num || "") ? s.num.match(/^\d+/)[0] : "";
  if (!s.street) return null;
  const q = [s.street + (num ? " " + num : ""), s.bairro, cityName].filter(Boolean).join(", ");
  const bias = (ondeEstou && Date.now() - ondeEstou.t < 30 * 60000 ? ondeEstou : null) || st.start || st.cityCenter || { lat: REGION.center[0], lng: REGION.center[1] };
  const u = new URL("https://photon.komoot.io/api/");
  u.searchParams.set("q", q); u.searchParams.set("limit", "3"); u.searchParams.set("lat", bias.lat); u.searchParams.set("lon", bias.lng);
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(u, { signal: ctl.signal }); if (!r.ok) return null;
    const j = await r.json();
    const ok = (j.features || []).find(f => (f.properties.countrycode || "").toUpperCase() === "BR" && hav({ lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }, bias) < 120);
    return ok ? { lat: ok.geometry.coordinates[1], lng: ok.geometry.coordinates[0], p: ok.properties } : null;
  } catch (e) { return null; } finally { clearTimeout(to); }
}
let geoRenderT = null;
function geoRender(fim) { clearTimeout(geoRenderT); if (fim) { renderAll(true); return; } geoRenderT = setTimeout(() => renderAll(false), 300); }
function queueGeocode(s) { s.geo = "busy"; geoQueue.push(s.id); clearTimeout(runGeo.t); runGeo.t = setTimeout(runGeo, 50); }
async function runGeo() {
  if (geoBusy) return; geoBusy = true;
  while (geoQueue.length) {
    const ids = geoQueue.splice(0); const lista = ids.map(id => st.stops.find(x => x.id === id)).filter(Boolean);
    if (!navigator.onLine) { lista.forEach(s => s.geo = "fail"); save(); geoRender(); continue; }
    // CEP sem rua: completa pelo ViaCEP primeiro
    await Promise.all(lista.filter(s => s.cep && (!s.street || !(s.city || st.settings.city))).map(async s => { const v = await viaCep(s.cep); if (v) { s.street = s.street || v.logradouro; s.bairro = s.bairro || v.bairro; s.city = s.city || `${v.localidade} - ${v.uf}`; } }));
    // endereços iguais: busca uma vez só
    const grupos = new Map(); lista.forEach(s => { const k = geoKey(s); if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(s); });
    const aplica = (grupo, g) => { grupo.forEach(s => { if (g) { s.lat = g.lat; s.lng = g.lng; s.geo = "ok"; nomeOficial(s, g.p); } }); if (g) guardarNaAgenda(grupo); };
    const faltam = [];
    // 1) memória do aparelho
    for (const [k, grupo] of grupos) { const c = await dbGet("kv", k); if (c) aplica(grupo, c); else faltam.push([k, grupo]); }
    geoRender();
    // 2) Photon, 5 ao mesmo tempo
    const depois = []; let i = 0;
    await Promise.all(Array.from({ length: Math.min(5, faltam.length) }, async () => {
      while (i < faltam.length) {
        const [k, grupo] = faltam[i++]; const g = await photon(grupo[0]);
        if (g) { aplica(grupo, g); dbSet("kv", k, g); geoRender(); } else depois.push([k, grupo]);
      }
    }));
    save();
    // 3) o que o Photon não achou: Nominatim, um por vez (regra do serviço)
    for (const [k, grupo] of depois) {
      let g = null; try { g = await geocodeStop(grupo[0]); } catch (e) {}
      if (g) { aplica(grupo, g); dbSet("kv", k, g); } else grupo.forEach(s => s.geo = "fail");
      save(); geoRender();
    }
  }
  geoBusy = false; save(); geoRender(true);
  autoOtimizar();
  const fails = st.stops.filter(s => s.geo === "fail").length;
  if (fails) toast(`${fails} endereço(s) não encontrados no mapa. Toque na parada para ajustar.`);
}
async function reverse(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&accept-language=pt-BR&lat=${lat}&lon=${lng}`);
    const j = await r.json(); const a = j.address || {};
    return { street: a.road || a.pedestrian || a.footway || "Ponto no mapa", num: a.house_number || "s/n", bairro: a.suburb || a.neighbourhood || "", city: a.city || a.town || a.village || "", cep: a.postcode || "" };
  } catch (e) { return { street: "Ponto no mapa", num: "s/n" }; }
}

/* ===================== leitura de endereços em texto ===================== */
const STREET_RE = /\b(rua|r\.|av\.?|avenida|travessa|tv\.?|trav\.?|alameda|al\.|estrada|estr\.?|rodovia|rod\.|pra[cç]a|p[cç]a\.?|largo|lgo\.?|viela|vila|via|beco|servid[aã]o|ladeira|parque|quadra|qd\.?|conjunto|cj\.?)\s+\S/i;
const CEP_RE = /\b(\d{5})-?(\d{3})\b/;
const PHONE_RE = /(\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4})/;
const COMP_RE = /\b(apto?\.?|apartamento|ap\b|bloco|bl\.?|casa|cs\.?|fundos|frente|sala|sl\.?|loja|lj\.?|andar|conj\.?|cj\b|torre|lote|lt\.?|quadra|qd\.?|kit|box)\b/i;
const UFS = "AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO";
/* TEXTO EM CAIXA ALTA → Texto Normal (Rua dos Goitacazes) */
function titulo(t) {
  t = String(t || ""); const letras = t.replace(/[^A-Za-zÀ-ú]/g, "");
  if (letras.length < 3 || t !== t.toUpperCase()) return t;
  return t.toLowerCase().replace(/(^|[\s\-\/(])([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(Da|De|Do|Das|Dos|E)\b/g, (m, x, i) => i ? m.toLowerCase() : m).replace(/\b(Mg|Sp|Rj|Es|Ba|Go|Df|Pr|Sc|Rs)\b$/, m => m.toUpperCase());
}
/* cidade e estado colados no fim ("Prado Belo Horizonte MG") */
function tiraCidade(rest, out) {
  const cidades = [...new Set([...RMBH, (st.settings.city || "").split(" - ")[0]].filter(Boolean))].sort((a, b) => b.length - a.length);
  const semAc = x => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const r0 = rest.replace(/[\s,\-–\/]+$/, "");
  let ufm = r0.match(new RegExp("[\\s,\\-–/]+(" + UFS + ")$", "i")); let base = ufm ? r0.slice(0, ufm.index) : r0;
  for (const c of cidades) {
    const b2 = semAc(base), c2 = semAc(c);
    if (b2.endsWith(c2) && (b2.length === c2.length || /[\s,\-–\/]/.test(b2[b2.length - c2.length - 1]))) {
      out.city = c + " - " + (ufm ? ufm[1].toUpperCase() : "MG"); return base.slice(0, base.length - c.length).replace(/[\s,\-–\/]+$/, "");
    }
  }
  if (ufm && /^[A-Z]{2}$/.test(ufm[1])) { const pe = base.split(/\s*[,–]\s*|\s-\s/); if (pe.length > 1) { out.city = pe.pop() + " - " + ufm[1]; return pe.join(", "); } }
  return rest;
}
function parseAddressLine(raw) {
  let line = raw.replace(/\s+/g, " ").trim().replace(/^(\d{1,3}\s*[.)\-–º°]|[-•*–>]|parada\s*\d+\s*[:\-]?)\s+/i, "").replace(/^(endere[cç]o|end\.?|destino|entrega)\s*[:\-]\s*/i, "").trim();
  const out = { raw: raw.trim(), street: "", num: "", comp: "", bairro: "", city: "", cep: "", phone: "" };
  // código de rastreio do manifesto (Shopee BR…, Mercado Livre, Correios AA123456789BR, Loggi, Amazon TBA…)
  const cod = line.match(/\b(BR\d{9,}[A-Z]?|AT\d{8,}\w*|TBA\d{9,}|[A-Z]{2}\d{9}[A-Z]{2}|SPX\w{8,}|\d{12,14})\b/);
  if (cod && !CEP_RE.test(cod[1])) { out.code = cod[1]; line = line.replace(cod[0], " ").replace(/\s+/g, " ").trim(); }
  const cm = line.match(CEP_RE);
  if (cm) {
    out.cep = cm[1] + "-" + cm[2];
    // linha de tabela: depois do CEP vem bairro repetido e a quantidade de pacotes ("... 30411046 Prado 10")
    const cauda = line.slice(cm.index + cm[0].length).replace(/^[\s,;|]+/, "");
    if (cauda && line.slice(0, cm.index).match(/\d/)) {
      const q = cauda.match(/(?:^|[\s,;|])(\d{1,3})\s*(?:pacotes?|volumes?|pcs?|un)?\s*$/i); if (q) out.pk = +q[1];
      const bt = cauda.replace(/(?:^|[\s,;|])\d{1,3}\s*(?:pacotes?|volumes?|pcs?|un)?\s*$/i, "").replace(/[,;|]+/g, " ").trim(); if (bt && !/\d/.test(bt)) out.bairroTab = bt;
      line = line.slice(0, cm.index);
    } else line = line.replace(cm[0], " ");
    line = line.replace(/\bcep\s*[:.]?\s*/i, " ");
  }
  // nome do local antes da rua ("DROGARIA ARAUJO - RUA DOS GOITACAZES, 1506")
  const sm = line.match(/(?:^|[\s,;|\-–])((?:rua|r\.|av\.?|avenida|travessa|tv\.|alameda|al\.|estrada|rodovia|pra[cç]a|largo|beco)\s+\S)/i);
  if (sm && sm.index > 0) {
    const pre = line.slice(0, sm.index).replace(/[\s,;|\-–:]+$/, "").replace(/^\d{1,4}\s+(?=[A-Za-zÀ-ú])/, "").trim();
    if (pre.length >= 3 && /[A-Za-zÀ-ú]{3}/.test(pre) && !/\b(na|no|em|para|pra|entregar|endere[cç]o)$/i.test(pre) && !/,\s*\d/.test(pre)) { out.client = titulo(pre); line = line.slice(sm.index).replace(/^[\s,;|\-–]+/, ""); }
  }
  const pm = line.match(PHONE_RE); if (pm && digits(pm[1]).length >= 10) { out.phone = pm[1]; line = line.replace(pm[1], " "); }
  line = line.replace(/\s+/g, " ").replace(/[\s,\-–]+$/, "").trim();
  const m = line.match(/^([^,]*[A-Za-zÀ-ú.][^,]*),\s*(?:n[º°o]?\.?\s*|n[uú]mero\s*)?(\d{1,6}[A-Za-z]?|s\/?n[º°]?)(?=$|[\s,\-–/])[\s,\-–/]*(.*)$/i) || line.match(/^(.*?[A-Za-zÀ-ú.]\s*)[,\s]+(?:n[º°o]?\.?\s*|n[uú]mero\s*)?(\d{1,6}[A-Za-z]?|s\/?n[º°]?)(?=$|[\s,\-–/])[\s,\-–/]*(.*)$/i);
  let rest = "";
  if (m) { out.street = m[1].replace(/[,\-–\s]+$/, "").trim(); out.num = /s\/?n/i.test(m[2]) ? "s/n" : m[2]; rest = m[3];
    if (/,/.test(out.street) && !out.client) { const ps = out.street.split(/\s*,\s*/); out.street = ps.pop(); const nm = ps.join(" ").replace(/\s+(rua|avenida|av\.?)$/i, "").trim(); if (nm) out.client = titulo(nm); } }
  else { const parts = line.split(/\s*[,\-–]\s*/); out.street = parts.shift() || ""; rest = parts.join(", "); }
  rest = tiraCidade(rest, out);
  const parts = rest.split(/\s*(?:[,–;]|\s-\s)\s*/).map(p => p.trim()).filter(Boolean);
  const comp = [], other = [];
  parts.forEach(p => {
    if (!COMP_RE.test(p)) { other.push(p); return; }
    const c2 = p.match(COMP_RE2); // "APTO 401 CARLOS PRATES" → complemento + bairro
    if (c2 && c2[0].trim().length < p.length && /^[A-Za-zÀ-ú]/.test(p.slice(c2[0].length).trim())) { comp.push(c2[0].trim()); other.push(p.slice(c2[0].length).trim()); }
    else comp.push(p);
  });
  out.comp = comp.join(", ");
  const uf = other.findIndex(p => /^[A-Za-zÀ-ú\s.']+\s*[\/-]\s*[A-Z]{2}$/.test(p) || /^[A-Z]{2}$/.test(p));
  if (uf >= 0) { if (/^[A-Z]{2}$/.test(other[uf]) && uf > 0) { out.city = other[uf - 1] + " - " + other[uf]; other.splice(uf - 1, 2); } else { out.city = other[uf].replace(/\s*\/\s*/, " - "); other.splice(uf, 1); } }
  if (other.length) out.bairro = other.join(", ");
  if (out.bairroTab) { if (!out.bairro) out.bairro = out.bairroTab; delete out.bairroTab; }
  out.bairro = titulo(out.bairro); out.comp = titulo(out.comp); out.street = titulo(out.street);
  out.street = out.street.replace(/^r\.\s/i, "Rua ").replace(/^av\.?\s/i, "Avenida ").replace(/^tv\.?\s/i, "Travessa ").replace(/^al\.\s/i, "Alameda ");
  out.street = out.street.charAt(0).toUpperCase() + out.street.slice(1);
  return out;
}
function extractAddresses(text) {
  const lines = String(text || "").split(/\r?\n/).map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const blocks = []; const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const isStreet = (STREET_RE.test(l) && /\d|s\/n/i.test(l + " " + (lines[i + 1] || ""))) || (CEP_RE.test(l) && /[A-Za-zÀ-ú]{3}[^,]*,\s*\d{1,5}\b/.test(l));
    if (!isStreet) continue;
    let block = l;
    if (!/\d/.test(l) && lines[i + 1] && /^\d|^n[º°o]/i.test(lines[i + 1])) { block += ", " + lines[++i]; }
    for (let k = 1; k <= 3 && i + 1 < lines.length; k++) {
      const nx = lines[i + 1];
      if (STREET_RE.test(nx) || CEP_RE.test(block)) break;
      if (CEP_RE.test(nx) || COMP_RE.test(nx) || /\b[A-Z]{2}\b\s*$/.test(nx) || /^bairro/i.test(nx) || /^(cidade|munic)/i.test(nx)) { block += " - " + nx.replace(/^(bairro|cidade|complemento|munic[ií]pio)\s*[:\-]\s*/i, ""); i++; } else break;
    }
    const key = block.toLowerCase(); if (seen.has(key)) continue; seen.add(key);
    blocks.push(block);
  }
  if (!blocks.length) lines.forEach(l => { if (/[A-Za-zÀ-ú]{3,}.*?[,\s]\d{1,6}\b/.test(l) && !seen.has(l.toLowerCase())) { seen.add(l.toLowerCase()); blocks.push(l); } });
  return blocks.map(parseAddressLine).filter(a => a.street.length > 2);
}

/* ===================== paradas ===================== */
/* ---------- deixa o endereço escrito certinho ---------- */
const semAcento = t => String(t || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const MINUS = new Set(["da", "de", "do", "das", "dos", "e", "d"]);
function titulo(t) {
  return String(t || "").trim().replace(/\s+/g, " ").toLowerCase().split(" ").map((w, i) => {
    if (!w) return w; if (i > 0 && MINUS.has(w)) return w;
    if (/^(mg|sp|rj|es|ba|go|df|pr|sc|rs)$/.test(w)) return w.toUpperCase();
    if (/^[ivx]+$/.test(w) && w.length > 1) return w.toUpperCase();
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join(" ");
}
const TIPOS = [[/^(r|r\.|rua)\s+/i, "Rua "], [/^(av|av\.|avda|avenida)\s+/i, "Avenida "], [/^(al|al\.|alameda)\s+/i, "Alameda "], [/^(tv|tv\.|trav\.?|travessa)\s+/i, "Travessa "],
  [/^(pc|pç|pca|pça|p[cç]a\.|praca|praça)\s+/i, "Praça "], [/^(rod|rod\.|rodovia)\s+/i, "Rodovia "], [/^(est|est\.|estrada)\s+/i, "Estrada "], [/^(bc|beco)\s+/i, "Beco "], [/^(lgo|largo)\s+/i, "Largo "]];
const COMP_RE2 = /^((apto?|ap|apartamento|sala|sl|loja|lj|bloco|bl|casa|cs|fundos|frente|lote|lt|quadra|qd|andar|conjunto|cj|box|galp[aã]o|torre|tr|kitnet|kit)\.?\s*[\w\-\/]*\s*)+/i;
const COMP_NOMES = [[/\bap(to?)?\.?\s*/i, "Apto "], [/\bapartamento\s*/i, "Apto "], [/\bsl\.?\s*/i, "Sala "], [/\blj\.?\s*/i, "Loja "], [/\bbl\.?\s*/i, "Bloco "], [/\bcs\.?\s*/i, "Casa "], [/\blt\.?\s*/i, "Lote "], [/\bqd\.?\s*/i, "Quadra "], [/\bcj\.?\s*/i, "Conjunto "], [/\btr\.?\s*/i, "Torre "]];
function cidadeNoFim(txt) {
  const t = semAcento(txt).replace(/[,\-\/]+/g, " ").replace(/\s+/g, " ").trim().replace(/\s+(mg|minas gerais)$/, "");
  if (/(^|\s)bh$/.test(t)) return { resto: txt.replace(/[\s,\-\/]*bh([\s,\-\/]*mg)?\s*$/i, ""), city: "Belo Horizonte - MG" };
  for (const c of RMBH) { const k = semAcento(c); if (t === k || t.endsWith(" " + k)) {
    const n = k.split(" ").length + (/\s(mg|minas gerais)\s*$/i.test(semAcento(txt).replace(/[,\-\/]+/g, " ")) ? 1 : 0);
    const palavras = String(txt).replace(/[,\-\/]+/g, " ").trim().split(/\s+/); return { resto: palavras.slice(0, Math.max(0, palavras.length - n)).join(" "), city: c + " - MG" }; } }
  return null;
}
function limparEndereco(a) {
  if (!a) return a; const o = { ...a };
  let st0 = String(o.street || "");
  // "Destinatário: Maria Endereço: R ..." → cliente + rua
  const mc = st0.match(/destinat[aá]rio\s*:?\s*(.+?)\s+endere[cç]o\s*:?\s*/i);
  if (mc) { o.client = o.client || mc[1].trim(); st0 = st0.slice(mc.index + mc[0].length); }
  st0 = st0.replace(/^.*\bendere[cç]o\s*:?\s*/i, "").replace(/\b(cep)\b.*$/i, "").trim();
  for (const [re, nome] of TIPOS) if (re.test(st0)) { st0 = nome + st0.replace(re, ""); break; }
  o.street = titulo(st0).replace(/^(Rua|Avenida|Alameda|Travessa|Praça|Rodovia|Estrada|Beco|Largo) /, (m) => m);
  // complemento: separa o que é apto/sala/loja do que é bairro/cidade grudado
  let comp = String(o.comp || "").trim();
  if (comp) {
    const cid = cidadeNoFim(comp); if (cid) { comp = cid.resto; o.city = o.city || cid.city; }
    comp = comp.replace(/\b(cep)?\s*\d{5}-?\d{3}\b/i, "").trim();
    const m = comp.match(COMP_RE2);
    if (m && m[0].trim().length < comp.length) { const resto = comp.slice(m[0].length).trim(); comp = m[0].trim(); if (resto && !o.bairro) o.bairro = resto; }
    else if (!m && !o.bairro && /^[a-zà-ú\s]+$/i.test(comp) && comp.split(/\s+/).length <= 4) { o.bairro = comp; comp = ""; }
    for (const [re, nome] of COMP_NOMES) comp = comp.replace(re, nome);
    o.comp = titulo(comp).replace(/\bApto\b/g, "Apto");
  }
  if (o.bairro) { const cid = cidadeNoFim(o.bairro); if (cid) { o.bairro = cid.resto; o.city = o.city || cid.city; } o.bairro = titulo(o.bairro.replace(/[,\-]+$/, "")); }
  if (o.city) { const c = String(o.city).trim(); if (/^bh\b/i.test(c)) o.city = "Belo Horizonte - MG"; else { const cid = cidadeNoFim(c); o.city = cid ? cid.city : titulo(c.replace(/\s*[-\/]\s*([a-z]{2})$/i, " - $1")); } }
  if (o.cep) { const d = digits(o.cep); if (d.length === 8) o.cep = d.replace(/(\d{5})(\d{3})/, "$1-$2"); }
  if (o.client) o.client = titulo(o.client);
  if (o.num) o.num = String(o.num).replace(/^n[º°o]?\.?\s*/i, "").trim() || "s/n";
  return o;
}
/* depois de achar no mapa: usa o nome oficial da rua, bairro e CEP */
function nomeOficial(s, p) {
  if (!p) return;
  const base = t => semAcento(t).replace(/^(rua|avenida|alameda|travessa|praca|rodovia|estrada|beco|largo)\s+/, "").replace(/\b(da|de|do|das|dos)\b/g, "").replace(/\s+/g, " ").trim();
  const rua = p.street || (p.type === "street" ? p.name : "");
  if (rua) { const a = base(s.street), b = base(rua); if (a && b && (a === b || a.includes(b) || b.includes(a))) s.street = rua; }
  const bairro = p.district || p.suburb || p.neighbourhood || p.locality;
  if (bairro && (!s.bairro || semAcento(s.bairro) === semAcento(bairro))) s.bairro = bairro;
  if (!s.cep && p.postcode && /^\d{5}-?\d{3}$/.test(p.postcode)) s.cep = p.postcode.replace(/^(\d{5})(\d{3})$/, "$1-$2");
  if (!s.city && p.city) s.city = p.city + (p.state === "Minas Gerais" ? " - MG" : "");
}

function newStop(o) {
  o = limparEndereco(o);
  return { id: uid(), street: o.street || "", num: o.num || "s/n", comp: o.comp || "", bairro: o.bairro || "", city: o.city || "", cep: o.cep || "",
    ref: o.ref || "", client: o.client || "", phone: o.phone || "", code: o.code || "", pk: Math.max(1, +o.pk || 1), win: o.win || "", prio: !!o.prio,
    lat: o.lat ?? null, lng: o.lng ?? null, geo: o.lat != null ? "ok" : "", status: "pending", reason: "", recv: "", note: "", photo: false, doneAt: null, src: o.src || "" };
}
/* rotas secundárias: cada lote adicionado depois ganha uma cor */
const COR_NOMES = ["", "laranja", "roxa", "azul", "rosa"];
const gNum = s => s && s.grupo ? ((s.grupo - 1) % 4) + 1 : 0;
const gCls = s => gNum(s) ? " g" + gNum(s) : "";
const gTag = s => gNum(s) ? `<span class="fact gtag g${gNum(s)}">Rota ${s.grupo + 1}</span>` : "";
function grupoDoLote() {
  const pend = st.stops.filter(x => x.status === "pending");
  if (!st.stops.length) return 0;
  const agora = Date.now(), ult = st.ultimaAdicao || 0;
  const atual = Math.max(0, ...st.stops.map(x => x.grupo || 0));
  if (agora - ult < 60000) return atual; // mesmo lote (ex.: bipando um pacote atrás do outro)
  return pend.length || st.stops.length ? atual + 1 : 0;
}
function addStops(list, { geocode = true } = {}) {
  const grupo = grupoDoLote();
  const added = list.map(newStop); added.forEach(x => x.grupo = grupo); guardarNaAgenda(added);
  st.ultimaAdicao = Date.now();
  st.stops.push(...added);
  added.forEach(s => { if (!hasGeo(s) && geocode) queueGeocode(s); });
  if (added.length) st.otimizada = false;
  save(); renderAll(true); autoOtimizar();
  return added;
}
const byId = id => st.stops.find(s => s.id === id);
const addrLine = s => `${s.street}${s.num ? ", " + s.num : ""}`;
const addrFull = s => [addrLine(s), s.bairro, s.city || st.settings.city].filter(Boolean).join(" - ");
const stopNumber = s => st.stops.indexOf(s) + 1;
function sameBuildingCount(s) {
  if (s.status !== "pending") return 0;
  const k = (s.street + "|" + s.num).toLowerCase();
  return st.stops.filter(x => x.status === "pending" && ((x.street + "|" + x.num).toLowerCase() === k || (hasGeo(x) && hasGeo(s) && hav(x, s) < 0.015))).length;
}

/* ===================== mapa ===================== */
/* Mapa base: Google Maps quando a chave existe (firebase-config.js → DELIVEROTA_GMAPS_KEY);
   sem chave, ou se o Google recusar, usa o OpenStreetMap. O layout do DeliveRota fica por cima. */
const GKEY = window.DELIVEROTA_GMAPS_KEY || "";
let osmBase = null, gBase = null, mapaGoogle = false;
function osmLayer() { if (!osmBase) osmBase = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }); return osmBase; }
function voltaOSM() { mapaGoogle = false; document.body.classList.remove("gmapa"); if (gBase && map) { try { map.removeLayer(gBase); } catch (e) {} } if (map && !map.hasLayer(osmLayer())) osmLayer().addTo(map); }
function carregaScript(src) { return new Promise((ok, erro) => { const t = document.createElement("script"); t.src = src; t.async = true; t.onload = ok; t.onerror = erro; document.head.appendChild(t); }); }
async function baseMapa() {
  if (!GKEY || !navigator.onLine) { osmLayer().addTo(map); return; }
  osmLayer().addTo(map); // aparece na hora; troca pelo Google quando carregar
  try {
    window.gm_authFailure = () => { voltaOSM(); console.warn("Chave do Google Maps recusada"); };
    if (!(window.google && google.maps)) await new Promise((ok, erro) => { window.__gmPronto = ok; carregaScript(`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GKEY)}&language=pt-BR&region=BR&loading=async&callback=__gmPronto`).catch(erro); setTimeout(() => erro(new Error("tempo")), 15000); });
    if (!L.gridLayer.googleMutant) await carregaScript("vendor/googlemutant.js");
    gBase = L.gridLayer.googleMutant({ type: "roadmap", maxZoom: 21, styles: [{ featureType: "poi.business", stylers: [{ visibility: "off" }] }, { featureType: "transit", elementType: "labels.icon", stylers: [{ visibility: "off" }] }] });
    gBase.addTo(map); mapaGoogle = true; document.body.classList.add("gmapa");
    setTimeout(() => { if (mapaGoogle && map.hasLayer(osmBase)) map.removeLayer(osmBase); }, 1500);
  } catch (e) { voltaOSM(); }
}
let map, layer, routeLine, pinMode = null, osrmKey = "", osrmLine = null, osrmKm = null;
function initMap() {
  if (!window.L) { $("#mapOff").hidden = false; return; }
  map = L.map("map", { zoomControl: false, attributionControl: true }).setView(REGION.center, REGION.zoom);
  baseMapa();
  layer = L.layerGroup().addTo(map);
  map.on("click", async e => {
    if (!pinMode) return;
    const { lat, lng } = e.latlng; const target = pinMode; setPinMode(null);
    if (target === "new") { toast("Buscando endereço do ponto..."); const a = await reverse(lat, lng); addStops([{ ...a, lat, lng, src: "mapa" }]); toast("Parada adicionada pelo mapa"); }
    else if (target === "start") { st.start = { lat, lng, label: "Ponto escolhido no mapa" }; save(); renderAll(true); toast("Ponto de partida definido"); }
    else if (target === "end") { st.end = { lat, lng, label: "Ponto escolhido no mapa" }; save(); if (pending().filter(hasGeo).length >= 2) optimize({ quieto: true }); else renderAll(true); toast("Ponto final definido"); }
    else { const s = byId(target); if (s) { s.lat = lat; s.lng = lng; s.geo = "ok"; save(); renderAll(true); toast("Local da parada ajustado"); } }
  });
}
function setPinMode(m) { pinMode = m; $("#pinBtn").setAttribute("aria-pressed", m === "new"); if (map) map.getContainer().style.cursor = m ? "crosshair" : ""; if (m) { if (m !== "new") toast("Toque no mapa no local certo"); else toast("Toque no mapa onde fica a entrega"); } }
function icon(cls, txt) { return L.divIcon({ className: "", html: `<div class="pin ${cls}">${txt}</div>`, iconSize: [38, 38], iconAnchor: [19, 19] }); }
function drawMap(fit) {
  if (!map) return;
  layer.clearLayers();
  const pts = [];
  if (st.start) { L.marker([st.start.lat, st.start.lng], { icon: icon("base", "P"), title: "Partida" }).addTo(layer); pts.push([st.start.lat, st.start.lng]); }
  const pend = pending();
  if (st.end && st.end.lat != null) { L.marker([st.end.lat, st.end.lng], { icon: icon("base", "F"), title: "Fim da rota" }).addTo(layer); pts.push([st.end.lat, st.end.lng]); }
  st.stops.forEach(s => {
    if (!hasGeo(s)) return;
    const n = stopNumber(s);
    const cls = s.status === "delivered" ? "done" : s.status === "failed" ? "fail" : (pend[0] === s ? "next" : "");
    const ehAlvo = NV.on && NV.alvo === s;
    const mk = L.marker([s.lat, s.lng], { icon: icon((ehAlvo ? "next" : (NV.on && cls === "next" ? "" : cls)) + gCls(s), s.status === "delivered" ? "✓" : n), zIndexOffset: ehAlvo ? 1500 : (cls === "next" ? 1000 : 0) })
      .on("click", () => NV.on ? navParadaSheet(s) : stopSheet(s)).addTo(layer);
    if (NV.on && s.status === "pending") mk.bindTooltip(`${esc(s.street || "")}${s.num ? ", " + esc(s.num) : ""}`, { permanent: true, direction: "right", offset: [16, 0], className: "navlbl" + (ehAlvo ? " alvo" : "") });
    pts.push([s.lat, s.lng]);
  });
  const path = [lastPoint(), ...pend, pend.length ? fimPt() : null].filter(p => p && p.lat != null).map(p => [p.lat, p.lng]);
  const key = path.map(p => p.map(x => x.toFixed(5)).join(",")).join(";");
  if (NV.on) { /* navegando: só a linha azul do caminho até a parada */ }
  else if (osrmLine && key === osrmKey) L.polyline(osrmLine, { color: "#18A957", weight: 5, opacity: .85 }).addTo(layer);
  else { if (path.length > 1) L.polyline(path, { color: "#18A957", weight: 4, opacity: .7, dashArray: "6 8" }).addTo(layer); fetchRoad(path, key); }
  if (fit && pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
}
let roadT;
function fetchRoad(path, key) {
  clearTimeout(roadT); osrmKm = null;
  if (path.length < 2 || !navigator.onLine) return;
  roadT = setTimeout(async () => {
    try {
      const chunks = []; for (let i = 0; i < path.length - 1; i += 24) chunks.push(path.slice(i, i + 25));
      let line = [], dist = 0;
      const partes = await Promise.all(chunks.map(async c => {
        const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${c.map(p => p[1] + "," + p[0]).join(";")}?overview=simplified&geometries=geojson`);
        const j = await r.json(); if (!j.routes || !j.routes[0]) throw 0; return j.routes[0];
      }));
      partes.forEach(rt => { line = line.concat(rt.geometry.coordinates.map(c2 => [c2[1], c2[0]])); dist += rt.distance; });
      osrmLine = line; osrmKey = key; osrmKm = dist / 1000; drawMap(false); renderStats();
    } catch (e) { /* sem internet ou serviço indisponível: fica a linha reta */ }
  }, 700);
}

/* ===================== telas ===================== */
function renderStats() {
  const p = pending(), total = st.stops.length, done = st.stops.filter(s => s.status === "delivered");
  const km = osrmKm ?? routeKm(p, lastPoint());
  $("#stLeft").textContent = p.length;
  $("#stKm").textContent = km1(km);
  const mins = p.length * st.settings.stopMin + km / SPEED[st.settings.vehicle] * 60;
  const d = new Date(Date.now() + mins * 60000);
  $("#stEnd").textContent = p.length ? d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : (total ? "ok" : "--");
  $("#stEarn").textContent = fmt(done.reduce((a, s) => a + s.pk, 0) * curRate());
  renderGoal(); renderPlat();
  $("#stDone").textContent = total - p.length; $("#stTotal").textContent = total;
  $("#ringFg").setAttribute("stroke-dasharray", `${total ? (total - p.length) / total * 100 : 0} 100`);
}
function navLinks(s, comProximas) {
  const dest = hasGeo(s) ? `${s.lat},${s.lng}` : encodeURIComponent(addrFull(s));
  if (comProximas) {
    const p = pending(), i = p.indexOf(s), seq = i >= 0 ? p.slice(i, i + 8) : [s];
    if (seq.length > 1) {
      const enc = x => hasGeo(x) ? `${x.lat},${x.lng}` : encodeURIComponent(addrFull(x));
      const gm = `https://www.google.com/maps/dir/?api=1&destination=${enc(seq[seq.length - 1])}&waypoints=${seq.slice(0, -1).map(enc).join("%7C")}&travelmode=driving`;
      return { ...navLinks(s), gmapsMulti: gm, multiN: seq.length };
    }
  }
  return {
    waze: hasGeo(s) ? `https://waze.com/ul?ll=${s.lat},${s.lng}&navigate=yes` : `https://waze.com/ul?q=${dest}&navigate=yes`,
    gmaps: `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`
  };
}
function modoMapa(on) {
  const b = document.body, era = b.classList.contains("mapa");
  b.classList.toggle("mapa", !!on); if (!on) b.classList.remove("folha-cheia");
  if (era !== !!on && map) { try { map.invalidateSize({ pan: false }); } catch (e) {} }
}
function ajustaFolha() {
  if (!document.body.classList.contains("mapa")) return;
  requestAnimationFrame(() => {
    const nb = $("#nextBox"); if (!nb || !nb.offsetHeight) return;
    const alvo = Math.round(Math.min(nb.offsetHeight + 44, innerHeight * 0.5));
    document.body.style.setProperty("--folha", alvo + "px");
    if (map) try { map.invalidateSize({ pan: false }); } catch (e) {}
  });
}
function renderNext() { renderNext0(); ajustaFolha(); }
function renderNext0() {
  const box = $("#nextBox"), p = pending();
  document.body.classList.remove("pronta", "inicio");
  modoMapa(st.stops.length > 0);
  if (!st.stops.length) {
    if (st.started) { st.started = false; save(); }
    document.body.classList.add("inicio");
    box.innerHTML = `<div class="cta-box">
      <h3>Rota de hoje</h3><p>Bipe os pacotes, mande a foto da etiqueta, a planilha ou a lista do WhatsApp.</p>
      <button class="btn primary cta" data-go="add"><svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>CARREGAR ROTA</button>
      <div class="cta-links"><button class="link-btn" data-act="sample">Testar com uma rota de exemplo</button><button class="link-btn" data-act="help">Tirar dúvidas</button></div></div>`;
    return;
  }
  if (!p.length) {
    box.innerHTML = `<div class="empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.4"><circle cx="12" cy="12" r="10"/><path d="m7 12 3.5 3.5L17 9"/></svg>
      <h3>Rota concluída</h3><p>Veja quanto você fez hoje e envie o relatório.</p><button class="btn primary" data-go="resumo">Ver resumo do dia</button>
      <button class="btn ghost" data-act="newroute" style="margin-top:10px;width:100%">Carregar nova rota</button></div>`;
    return;
  }
  if (!rotaComecou()) {
    const busy = p.filter(x => x.geo === "busy").length, semMapa = p.filter(x => !hasGeo(x) && x.geo !== "busy").length;
    const pv = previsao(p); const km = pv.km; const fim = hhmm(pv.fim);
    const grupos = [...new Set(p.map(x => x.grupo || 0))].sort((a, b) => a - b);
    const legenda = grupos.length > 1 ? `<div class="legenda">${grupos.map(g => `<span class="lg${g ? " g" + (((g - 1) % 4) + 1) : ""}"><i></i>${g ? "Rota " + (g + 1) : "Principal"}: ${p.filter(x => (x.grupo || 0) === g).length}</span>`).join("")}</div>` : "";
    const esperando = busy && st.queroComecar;
    box.innerHTML = `<div class="cta-box ready">
      <button class="xclose" data-act="cancelroute" aria-label="Cancelar rota" title="Cancelar rota">✕</button>
      <div class="ready-line"><span class="ready-tit">${busy ? "Organizando a rota" : "Rota pronta"}</span><span class="ready-num"><b>${p.length}</b> parada${p.length > 1 ? "s" : ""}${km ? ` · ${km1(km)} km` : ""}${busy ? "" : ` · término ~${fim}`}</span></div>
      <button class="inifim" data-act="inifim"><span>Início: <b>${esc(nomePonto(st.start, "onde você estiver"))}</b></span><span>Fim: <b>${esc(st.end ? nomePonto(st.end) : (st.settings.roundTrip && st.start ? "voltar ao início" : "última entrega"))}</b></span><i>✎</i></button>
      <span class="ready-st${busy ? " busy" : ""}">${busy ? `<i class="spin"></i>Achando ${busy} no mapa` : (grupos.length > 1 ? "✓ Tudo junto e otimizado" : "✓ Otimizada na melhor ordem")}</span>
      ${legenda}
      <button class="btn primary cta" data-act="start" ${esperando ? "disabled" : ""}><svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>${esperando ? "COMEÇANDO..." : "COMEÇAR ROTA"}</button>
      ${esperando ? `<p class="ok-txt">Começa sozinho assim que achar os ${busy} endereço(s) que faltam.</p>` : semMapa ? `<p class="ok-txt">${semMapa} endereço(s) sem local no mapa ficam no fim.</p>` : ""}
      <button class="btn dark addmore" data-act="addmore"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>Adicionar mais endereços</button>
      <button class="link-btn" data-go="paradas">Ver a lista de paradas</button></div>`;
    document.body.classList.add("pronta");
    return;
  }
  const s = p[0], L2 = navLinks(s, true), grp = sameBuildingCount(s), dist = hav(lastPoint(), s);
  if (L2.gmapsMulti) L2.gmaps = L2.gmapsMulti;
  const prefer = st.settings.nav === "waze" ? ["waze", "Waze", "gmaps", "Google Maps"] : ["gmaps", "Google Maps", "waze", "Waze"];
  const viaApp = st.settings.nav === "app";
  const perto = hasGeo(s) ? p.slice(2).filter(x => hasGeo(x) && hav(s, x) < 0.4).slice(0, 3) : [];
  const mins = dist ? Math.max(1, Math.round(dist / SPEED[st.settings.vehicle] * 60)) : 0;
  const I = {
    nav: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"><path d="M3 11 21 3l-8 18-2-8z"/></svg>',
    phone: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
    alt: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/></svg>',
    info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="10" r="2.5"/></svg>'
  };
  const later = p.slice(1, 4);
  const novas = st.otimizada === false ? p.filter(x => x.grupo && x.grupo === Math.max(...p.map(y => y.grupo || 0))).length : 0;
  box.innerHTML = `${novas ? `<div class="novas g${gNum(p.find(x => x.grupo === Math.max(...p.map(y => y.grupo || 0))))}"><div><b>+${novas} parada${novas > 1 ? "s" : ""} nova${novas > 1 ? "s" : ""}</b><span>Junte com o resto da rota</span></div><button class="btn dark" data-act="optall"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>Otimizar tudo</button></div>` : ""}<div class="next">
    <div class="next-top"><span class="next-num${gCls(s)}">${stopNumber(s)}</span>
      <div class="next-lbl"><span>Próxima entrega</span><em>${dist ? km1(dist) + " km · ~" + mins + " min" : "Toque em navegar para ir"}${p.length > 1 ? " · depois mais " + (p.length - 1) : ""}</em></div></div>
    <div class="addr">${esc(addrLine(s))}</div>
    ${perto.length ? `<div class="perto"><b>Pertinho desta entrega</b>${perto.map(x => `<div class="perto-row"><span class="badge${gCls(x)}">${stopNumber(x)}</span><span class="perto-t">${esc(addrLine(x))}<em>${Math.round(hav(s, x) * 1000)} m</em></span><button class="btn ghost sm" data-junto="${x.id}">Fazer junto</button></div>`).join("")}</div>` : ""}
    <div class="sub">${esc([s.comp || "Sem complemento", s.bairro, s.client].filter(Boolean).join(" · "))}</div>
    <div class="facts">
      ${gTag(s)}<span class="fact">${s.pk} ${s.pk > 1 ? "pacotes" : "pacote"}</span>
      ${s.code ? `<span class="fact mono">${esc(s.code)}</span>` : ""}
      ${s.prio ? `<span class="fact prio">Prioridade</span>` : ""}
      ${s.win ? `<span class="fact pos">${esc(s.win)}</span>` : ""}
      ${grp > 1 ? `<span class="fact grp">Mesmo prédio: ${grp} entregas</span>` : ""}
      ${!hasGeo(s) ? `<span class="fact prio">${s.geo === "busy" ? "Localizando no mapa..." : "Sem local no mapa"}</span>` : ""}
    </div>
    ${addrNote(s) ? `<div class="note warnnote">${I.info}<span><b>Você anotou neste endereço:</b> ${esc(addrNote(s))}</span></div>` : ""}
    ${s.ref ? `<div class="note">${I.info}<span><b>Referência:</b> ${esc(s.ref)}</span></div>` : ""}
    <div class="stack">
      <div class="navsw" role="group" aria-label="App de navegação"><span>Navegar pelo</span><button data-navset="google" aria-pressed="${st.settings.nav !== "waze"}">Google Maps</button><button data-navset="waze" aria-pressed="${st.settings.nav === "waze"}">Waze</button><button data-navset="app" aria-pressed="${st.settings.nav === "app"}">No app</button></div>
      <div class="actions">${viaApp ? `<button class="btn dark" data-act="navapp">${I.nav}<span class="navlbl">${NV.on ? "Navegando aqui no app" : "Navegar aqui no app"}<small>tela de perto, com cada curva</small></span></button>` : `<a class="btn dark" href="${L2[prefer[0]]}" target="_blank" rel="noopener">${I.nav}<span class="navlbl">Navegar no ${prefer[1]}${prefer[0] === "gmaps" && L2.multiN > 1 ? `<small>com as próximas ${L2.multiN} paradas no caminho</small>` : ""}</span></a>`}
        <a class="btn ghost icon" href="${L2[prefer[2]]}" target="_blank" rel="noopener" title="Abrir no ${prefer[3]}" aria-label="Abrir no ${prefer[3]}">${I.alt}</a>
        <button class="btn ghost icon" data-contact="${s.id}" title="Ligar ou mandar WhatsApp" aria-label="Contato do cliente">${I.phone}</button></div>
      <button class="btn primary big" data-deliver="${s.id}"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="m5 12 4.5 4.5L19 7"/></svg>Entregue</button>
      <div class="row"><button class="btn warn" data-fail="${s.id}">Não consegui entregar</button><button class="btn ghost" data-skip="${s.id}" style="flex:0 0 96px">Pular</button></div>
    </div></div>
    ${later.length ? `<div class="later"><h3>A seguir</h3>${later.map(x => `<div class="later-row" data-open="${x.id}"><span class="badge${gCls(x)}">${stopNumber(x)}</span><div><b>${esc(addrLine(x))}</b><span>${esc([x.comp, x.bairro, x.client].filter(Boolean).join(" · ") || "—")}</span></div></div>`).join("")}</div>` : ""}
    ${p.length > 1 ? `<a class="btn ghost" style="margin-top:12px" target="_blank" rel="noopener" href="${fullRouteLink()}">Abrir as próximas ${Math.min(p.length, 10)} paradas no Google Maps</a>` : ""}
    <button class="btn warn" data-act="cancelroute" style="margin-top:12px;width:100%">Cancelar rota</button>`;
}
/* ---------- fluxo simples: carregar → otimizar sozinho → começar → cancelar ---------- */
function rotaComecou() { return !!st.started || st.stops.some(s => s.status !== "pending"); }
let autoOptT = null;
function autoOtimizar() {
  if (rotaComecou()) return;
  clearTimeout(autoOptT);
  autoOptT = setTimeout(() => {
    const p = pending();
    if (rotaComecou() || p.some(x => x.geo === "busy")) { if (p.length) renderAll(false); return; }
    if (p.filter(hasGeo).length >= 2) optimize();
    st.otimizada = true; save();
    if (st.queroComecar) { comecarRota({ abrirNav: false }); return; }
    renderNext();
  }, 250);
}
function comecarRota({ abrirNav = true } = {}) {
  const p = pending(); if (!p.length) return;
  if (abrirNav && precisaPerguntarNav()) { navSheet(() => comecarRota()); return; }
  // ainda achando endereço no mapa: começa sozinho quando terminar
  if (p.some(x => x.geo === "busy")) { st.queroComecar = true; save(); go("rota"); renderNext(); toast("Terminando de achar os endereços. A rota começa sozinha."); return; }
  st.queroComecar = false;
  if (!st.otimizada && p.filter(hasGeo).length >= 2) optimize();
  st.started = true; st.otimizada = true; save(); go("rota"); renderAll(true);
  const s = pending()[0]; if (!s) return;
  toast("Rota começou. Boa entrega!");
  if (st.settings.speak) try { speak("Rota começou. Primeira entrega: " + s.street + ", " + spokenNum(s.num || "sem número") + "."); } catch (e) {}
  if (hasGeo(s)) iniciarNavApp(s); // tela aproximada com as curvas, sempre
  if (!abrirNav || st.settings.nav === "app") return; // sem toque do entregador o celular bloqueia abrir app externo
  const L2 = navLinks(s, true); const url = st.settings.nav === "waze" ? L2.waze : (L2.gmapsMulti || L2.gmaps);
  setTimeout(() => window.open(url, "_blank", "noopener"), 600);
}
/* desistir de adicionar: volta, otimiza tudo e começa */
function desistirEComecar() {
  $("#importBox").innerHTML = ""; importList = [];
  comecarRota();
}
function cancelarRota(btn) {
  const feitas = st.stops.filter(s => s.status !== "pending").length;
  const curto = btn.classList.contains("xclose");
  twoTap(btn, curto ? "Cancelar? Toque de novo" : feitas ? "Toque de novo: tira as pendentes" : "Toque de novo para cancelar", () => {
    st.stops = st.stops.filter(s => s.status !== "pending");
    st.queroComecar = false; if (NV.on) pararNavApp();
    if (!st.stops.length) { st.started = false; st.otimizada = false; st.ultimaAdicao = 0; st.rotaNome = ""; st.rotaData = ""; }
    save(); renderAll(true);
    toast(feitas ? "Paradas pendentes removidas. As entregas feitas continuam no resumo." : "Rota cancelada. Pode carregar outra.");
  });
}
function fullRouteLink() {
  const p = pending().slice(0, 10);
  const enc = s => hasGeo(s) ? `${s.lat},${s.lng}` : encodeURIComponent(addrFull(s));
  const dest = enc(p[p.length - 1]); const wps = p.slice(0, -1).map(enc).join("|");
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}${wps ? "&waypoints=" + wps : ""}&travelmode=driving`;
}
let searchQ = "", highlight = null;
function renderList() {
  $$("#filters button").forEach(b => b.setAttribute("aria-pressed", b.dataset.f === st.filter));
  const q = searchQ.toLowerCase();
  const rows = st.stops.filter(s => (st.filter === "all" || s.status === st.filter) && (!q || [s.street, s.num, s.client, s.code, s.bairro].join(" ").toLowerCase().includes(q)));
  if (!rows.length) { $("#list").innerHTML = `<p class="sub" style="padding:20px 0">${st.stops.length ? "Nenhuma parada encontrada." : "Nenhuma parada ainda. Vá em Adicionar."}</p>`; return; }
  $("#list").innerHTML = rows.map(s => `<div class="item ${s.status}${highlight === s.id ? " hl" : ""}" id="it-${s.id}">
    <span class="badge${s.status === "delivered" ? "" : gCls(s)}">${s.status === "delivered" ? "✓" : stopNumber(s)}</span>
    <div class="item-main" data-open="${s.id}"><b>${esc(addrLine(s))}</b>${gNum(s) && s.status === "pending" ? ` <span class="gdot g${gNum(s)}">Rota ${s.grupo + 1}</span>` : ""}<span>${esc([s.comp, s.bairro, s.client, s.code].filter(Boolean).join(" · ") || "—")}</span>
      ${s.status === "delivered" ? `<span class="pill ok">Entregue ${s.doneAt ? new Date(s.doneAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}${s.photo ? " · com foto" : ""}</span>` : ""}
      ${s.status === "failed" ? `<span class="pill bad">${esc(s.reason)}</span>` : ""}
      ${s.prio && s.status === "pending" ? `<span class="pill bad">Prioridade</span>` : ""}
      ${s.win ? `<span class="pill win">${esc(s.win)}</span>` : ""}
      ${sameBuildingCount(s) > 1 ? `<span class="pill grp">Mesmo prédio</span>` : ""}
      ${!hasGeo(s) ? `<span class="pill geo">${s.geo === "busy" ? "Localizando..." : "Ajustar local"}</span>` : ""}
    </div>
    ${s.status === "pending" ? `<div class="mv"><button data-up="${s.id}" aria-label="Subir">▲</button><button data-down="${s.id}" aria-label="Descer">▼</button></div>` : ""}
  </div>`).join("");
}
function reportText() {
  const done = st.stops.filter(s => s.status === "delivered"), fail = st.stops.filter(s => s.status === "failed");
  const pk = done.reduce((a, s) => a + s.pk, 0), km = routeKm(st.stops.filter(hasGeo), st.start);
  let r = `DeliveRota · ${new Date().toLocaleDateString("pt-BR")}\nEntregues: ${done.length} de ${st.stops.length} paradas (${pk} pacotes)\nKm estimados: ${km1(km)}\nGanho estimado: R$ ${fmt(pk * curRate())}`;
  if (fail.length) r += `\n\nNão entregues:\n` + fail.map(s => `- ${addrLine(s)}${s.code ? " (" + s.code + ")" : ""}: ${s.reason}`).join("\n");
  const p = pending(); if (p.length) r += `\n\nPendentes: ${p.length}`;
  return r;
}
function renderResumo() {
  const done = st.stops.filter(s => s.status === "delivered"), fail = st.stops.filter(s => s.status === "failed");
  const pk = done.reduce((a, s) => a + s.pk, 0);
  $("#kEarn").textContent = "R$ " + fmt(pk * curRate());
  $("#kEarnSub").textContent = `${pk} pacotes × R$ ${fmt(curRate())}${st.platform ? " · " + st.platform : ""}`;
  $("#kDone").textContent = done.length + "/" + st.stops.length;
  $("#kFail").textContent = fail.length;
  $("#kKm").textContent = km1(routeKm(st.stops.filter(hasGeo), st.start));
  $("#kPk").textContent = st.stops.reduce((a, s) => a + s.pk, 0);
  $("#report").textContent = reportText();
  renderYear(); renderPeriod(); renderDue(); renderMaint(); meiCheck(); renderGastos();
}
function renderAll(fit) { renderStats(); renderNext(); renderList(); renderResumo(); drawMap(fit); renderAddBar(); }

/* ===================== navegação entre abas ===================== */
/* barra no topo do Adicionar: com rota montada, dá para desistir e começar */
function renderAddBar() {
  const bar = $("#addBar"); if (!bar) return;
  const p = pending();
  if (!p.length || rotaComecou() || importList.length) { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  bar.innerHTML = `<div><b>Sua rota tem ${p.length} parada${p.length > 1 ? "s" : ""}</b><span>Terminou de adicionar? É só começar.</span></div>
    <div class="addbar-bt"><button class="btn primary" data-act="desistir"><svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>COMEÇAR ROTA</button>
    <button class="xclose static" data-act="cancelroute" aria-label="Cancelar rota" title="Cancelar rota">✕</button></div>`;
}
function go(name) {
  document.body.dataset.tab = name;
  if (name === "add") renderAddBar();
  if (name === "rota") setTimeout(ajustaFolha, 0);
  ["rota", "paradas", "add", "resumo"].forEach(n => $("#s-" + n).hidden = n !== name);
  $$(".nav button").forEach(b => b.dataset.s === name ? b.setAttribute("aria-current", "page") : b.removeAttribute("aria-current"));
  $(".panel").scrollTop = 0;
  if (name === "resumo") renderResumo();
  if (map) setTimeout(() => map.invalidateSize(), 50);
}

/* ===================== avisos, folhas, som ===================== */
let toastT;
function toast(m, ms = 2800) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
function sheet(html, onOpen) {
  $("#sheetHost").innerHTML = `<div class="sheet-bg" id="sbg"><div class="sheet" role="dialog" aria-modal="true">${html}</div></div>`;
  $("#sbg").addEventListener("click", e => { if (e.target.id === "sbg" || e.target.closest("[data-close]")) closeSheet(); });
  if (onOpen) onOpen($("#sbg"));
}
function closeSheet() { $("#sheetHost").innerHTML = ""; }
let actx;
function beep(ok = true) {
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); const o = actx.createOscillator(), g = actx.createGain();
    o.frequency.value = ok ? 1250 : 380; g.gain.value = .12; o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + (ok ? .09 : .25)); } catch (e) {}
  try { navigator.vibrate && navigator.vibrate(ok ? 60 : [80, 60, 80]); } catch (e) {}
}
function twoTap(btn, label, fn) {
  if (btn.dataset.armed) { fn(); return; }
  const old = btn.textContent; btn.dataset.armed = 1; btn.textContent = label;
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 3000);
}
async function compressPhoto(file) {
  const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = URL.createObjectURL(file); });
  const k = Math.min(1, 1280 / Math.max(img.width, img.height)); const c = document.createElement("canvas");
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return await new Promise(ok => c.toBlob(ok, "image/jpeg", .72));
}
function copyText(txt, el) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => toast("Copiado"), () => selectEl(el));
  else selectEl(el);
}
function selectEl(el) { if (!el) return; try { const r = document.createRange(); r.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(r); toast("Texto selecionado: use Copiar"); } catch (e) {} }
function download(blob, name) { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }

/* ===================== folhas de ação ===================== */
function deliverSheet(s) {
  let blob = null;
  sheet(`<h3>Confirmar entrega</h3><p class="sub">${esc(addrLine(s))}${s.client ? " · " + esc(s.client) : ""}</p>
    <label class="drop" for="podPhoto" style="margin-top:12px">Foto do comprovante<small>Pacote na porta, com o cliente ou na portaria</small></label>
    <input id="podPhoto" type="file" accept="image/*" capture="environment" hidden><img id="podPrev" class="photo-prev" alt="Comprovante" hidden>
    <div class="field" style="margin-top:10px"><label for="recv">Quem recebeu</label><select id="recv"><option>O próprio cliente</option><option>Portaria / zelador</option><option>Vizinho</option><option>Familiar</option><option>Deixado no local combinado</option></select></div>
    <div class="field"><label for="rname">Nome de quem recebeu (opcional)</label><input id="rname"></div>
    <div class="row"><button class="btn ghost" data-close>Voltar</button><button class="btn primary" id="okDeliver">Confirmar entrega</button></div>`, () => {
    $("#podPhoto").addEventListener("change", async e => { const f = e.target.files[0]; if (!f) return; blob = await compressPhoto(f); const i = $("#podPrev"); i.src = URL.createObjectURL(blob); i.hidden = false; });
    $("#okDeliver").addEventListener("click", async () => {
      s.status = "delivered"; s.recv = $("#recv").value + ($("#rname").value ? ": " + $("#rname").value : ""); s.doneAt = Date.now(); stampWhere(s);
      if (blob) { await dbSet("photos", s.id, blob); s.photo = true; }
      save(); closeSheet(); renderAll(false); beep(); toast(pending().length ? "Entrega registrada. Próxima!" : "Última entrega feita!"); sayNext("Entrega registrada. ");
    });
  });
}
const REASONS = ["Cliente ausente", "Endereço não encontrado", "Endereço incompleto", "Recusado pelo cliente", "Local fechado", "Área de risco / sem acesso", "Pacote avariado", "Outro motivo"];
function failSheet(s) {
  let reason = "", blob = null;
  sheet(`<h3>Por que não entregou?</h3><p class="sub">${esc(addrLine(s))}</p>
    <div class="reasons">${REASONS.map(r => `<button aria-pressed="false" data-r="${r}">${r}</button>`).join("")}</div>
    <label class="drop" for="failPhoto">Foto do local<small>Prova da tentativa, se a plataforma questionar</small></label>
    <input id="failPhoto" type="file" accept="image/*" capture="environment" hidden><img id="failPrev" class="photo-prev" alt="Foto do local" hidden>
    <div class="field" style="margin-top:10px"><label for="fnote">Observação</label><input id="fnote" placeholder="Ex.: tocou 3x, ninguém atendeu"></div>
    <label class="check"><input type="checkbox" id="fRem"> Lembrar desta observação nas próximas entregas neste endereço</label>
    <div class="row"><button class="btn ghost" data-close>Voltar</button><button class="btn warn" id="okFail" disabled>Registrar</button></div>`, () => {
    $$(".reasons button").forEach(b => b.addEventListener("click", () => { $$(".reasons button").forEach(x => x.setAttribute("aria-pressed", "false")); b.setAttribute("aria-pressed", "true"); reason = b.dataset.r; $("#okFail").disabled = false; }));
    $("#failPhoto").addEventListener("change", async e => { const f = e.target.files[0]; if (!f) return; blob = await compressPhoto(f); const i = $("#failPrev"); i.src = URL.createObjectURL(blob); i.hidden = false; });
    $("#okFail").addEventListener("click", async () => {
      s.status = "failed"; s.reason = reason; s.note = $("#fnote").value; s.doneAt = Date.now(); stampWhere(s); if ($("#fRem") && $("#fRem").checked && s.note) setAddrNote(s, s.note);
      if (blob) { await dbSet("photos", s.id, blob); s.photo = true; }
      save(); closeSheet(); renderAll(false); beep(false); toast("Registrado. Seguindo para a próxima."); sayNext();
    });
  });
}
function contactSheet(s) {
  const tel = digits(s.phone); const mins = Math.max(2, Math.round(hav(lastPoint(), s) / SPEED[st.settings.vehicle] * 60));
  const msg = st.settings.msg.replace("{nome}", (s.client || "").split(" ")[0] || "").replace("{min}", mins).replace(/\s+!/, "!");
  const wa = tel ? `https://wa.me/${tel.length <= 11 ? "55" + tel : tel}?text=${encodeURIComponent(msg)}` : "";
  sheet(`<h3>${esc(s.client || "Cliente")}</h3><p class="sub">${esc(addrLine(s))}</p>
    ${tel ? `<div class="row" style="margin:12px 0"><a class="btn primary" href="${wa}" target="_blank" rel="noopener">WhatsApp</a><a class="btn ghost" href="tel:${tel}">Ligar</a></div>
      <button class="btn ghost" id="cpPhone" style="width:100%;font-family:var(--mono)">${esc(s.phone)}</button>`
      : `<p class="note" style="margin-top:12px">Esta parada não tem telefone. Toque na parada na lista para editar e incluir.</p>`}
    <div class="field" style="margin-top:12px"><label>Mensagem</label><textarea id="msgBox">${esc(msg)}</textarea></div>
    <div class="row"><button class="btn ghost" data-close>Fechar</button><button class="btn ghost" id="cpMsg">Copiar mensagem</button></div>`, () => {
    const cp = $("#cpPhone"); if (cp) cp.addEventListener("click", () => copyText(s.phone, cp));
    $("#cpMsg").addEventListener("click", () => copyText($("#msgBox").value, $("#msgBox")));
  });
}
function stopFields(s = {}) {
  const v = k => esc(s[k] ?? "");
  return `<div class="grid2"><div class="field"><label for="e-cep">CEP</label><input id="e-cep" value="${v("cep")}"></div><div class="field"><label for="e-num">Número</label><input id="e-num" value="${v("num")}"></div></div>
    <div class="field"><label for="e-street">Rua</label><input id="e-street" value="${v("street")}"></div>
    <div class="grid2"><div class="field"><label for="e-bairro">Bairro</label><input id="e-bairro" value="${v("bairro")}"></div><div class="field"><label for="e-city">Cidade</label><input id="e-city" value="${v("city")}"></div></div>
    <div class="grid2"><div class="field"><label for="e-comp">Complemento</label><input id="e-comp" value="${v("comp")}"></div><div class="field"><label for="e-win">Horário</label><select id="e-win">${["", "Até 12:00", "12:00–15:00", "Depois das 15:00"].map(o => `<option ${s.win === o ? "selected" : ""} value="${o}">${o || "Qualquer hora"}</option>`).join("")}</select></div></div>
    <div class="field"><label for="e-ref">Referência</label><input id="e-ref" value="${v("ref")}"></div>
    <div class="grid2"><div class="field"><label for="e-client">Cliente</label><input id="e-client" value="${v("client")}"></div><div class="field"><label for="e-phone">Telefone</label><input id="e-phone" value="${v("phone")}"></div></div>
    <div class="grid2"><div class="field"><label for="e-code">Código</label><input id="e-code" value="${v("code")}"></div><div class="field"><label for="e-pk">Pacotes</label><input id="e-pk" type="number" min="1" value="${s.pk || 1}"></div></div>
    <label class="check"><input type="checkbox" id="e-prio" ${s.prio ? "checked" : ""}> Prioridade</label>`;
}
function readFields() {
  const g = id => ($("#e-" + id) || {}).value || "";
  return { cep: g("cep"), num: g("num") || "s/n", street: g("street"), bairro: g("bairro"), city: g("city"), comp: g("comp"), win: g("win"), ref: g("ref"), client: g("client"), phone: g("phone"), code: g("code").trim(), pk: Math.max(1, +g("pk") || 1), prio: $("#e-prio").checked };
}
async function stopSheet(s) {
  const photo = s.photo ? await dbGet("photos", s.id) : null;
  sheet(`<div class="sec-h"><h3>Parada ${stopNumber(s)}</h3><span class="pill ${s.status === "delivered" ? "ok" : s.status === "failed" ? "bad" : "win"}">${{ pending: "Pendente", delivered: "Entregue", failed: "Não entregue" }[s.status]}</span></div>
    <p class="sub">${esc(addrFull(s))}</p>
    ${s.status === "delivered" ? `<p class="note">Recebido por: ${esc(s.recv || "-")} · ${s.doneAt ? new Date(s.doneAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : ""}</p>` : ""}
    ${s.status === "failed" ? `<p class="note">${esc(s.reason)}${s.note ? " · " + esc(s.note) : ""}</p>` : ""}
    ${photo ? `<img class="photo-prev" src="${URL.createObjectURL(photo)}" alt="Foto da parada">` : ""}
    ${s.status !== "pending" ? `<button class="btn ghost" id="aProof" style="width:100%;margin-top:10px">Gerar comprovante em PDF${s.where ? " (com GPS)" : ""}</button>` : ""}
    <div class="field" style="margin-top:12px"><label for="aNote">Observação fixa deste endereço</label><textarea id="aNote" style="min-height:60px" placeholder="Ex.: entregar na portaria lateral, cachorro bravo">${esc(addrNote(s))}</textarea><span class="hint">Fica salva e aparece sempre que este endereço voltar na rota.</span></div>
    <button class="btn ghost sm" id="aNoteSave">Salvar observação</button>
    <div id="editBox" hidden style="margin-top:12px">${stopFields(s)}<div class="row"><button class="btn ghost" id="cancelEdit">Cancelar</button><button class="btn primary" id="saveEdit">Salvar e localizar</button></div></div>
    <div id="actBox" class="stack" style="margin-top:12px">
      ${s.status === "pending" ? `<div class="row"><button class="btn primary" id="aDel">Entregue</button><button class="btn warn" id="aFail">Não entregue</button></div><button class="btn ghost" id="aNext">Fazer esta agora (mover para próxima)</button>` : `<button class="btn ghost" id="aBack">Voltar para pendente</button>`}
      <div class="row"><button class="btn ghost" id="aEdit">Editar</button><button class="btn ghost" id="aPin">Ajustar no mapa</button></div>
      <div class="row"><button class="btn ghost" id="aContact">Contato</button><button class="btn warn" id="aRemove">Excluir parada</button></div>
      <button class="btn ghost" data-close>Fechar</button>
    </div>`, () => {
    const on = (id, fn) => { const b = $("#" + id); if (b) b.addEventListener("click", fn); };
    on("aProof", () => proofPdf(s)); on("aNoteSave", () => { setAddrNote(s, $("#aNote").value); renderAll(false); toast("Observação salva para este endereço"); });
    on("aDel", () => deliverSheet(s)); on("aFail", () => failSheet(s)); on("aContact", () => contactSheet(s));
    on("aNext", () => { const p = pending(); const first = st.stops.indexOf(p[0]); st.stops.splice(st.stops.indexOf(s), 1); st.stops.splice(first, 0, s); save(); closeSheet(); renderAll(false); go("rota"); });
    on("aBack", () => { s.status = "pending"; s.reason = ""; s.doneAt = null; st.stops.splice(st.stops.indexOf(s), 1); st.stops.push(s); save(); closeSheet(); renderAll(false); toast("Voltou para o fim da rota"); });
    on("aEdit", () => { $("#editBox").hidden = false; $("#actBox").hidden = true; });
    on("cancelEdit", () => { $("#editBox").hidden = true; $("#actBox").hidden = false; });
    on("saveEdit", () => { const f = readFields(); const moved = f.street !== s.street || f.num !== s.num || f.cep !== s.cep || f.city !== s.city || f.bairro !== s.bairro; Object.assign(s, f); if (moved || !hasGeo(s)) { s.lat = s.lng = null; queueGeocode(s); } save(); closeSheet(); renderAll(false); toast("Parada atualizada"); });
    on("aPin", () => { closeSheet(); go("rota"); setPinMode(s.id); });
    on("aRemove", e => twoTap(e.currentTarget, "Toque de novo para excluir", async () => { st.stops.splice(st.stops.indexOf(s), 1); await dbDel("photos", s.id); save(); closeSheet(); renderAll(false); toast("Parada excluída"); }));
  });
}
let deferredInstall = null;
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstall = e; });
function settingsSheet() {
  const S = st.settings; const rates = S.platRates || {};
  sheet(`<h3>Configurações</h3>
    <div class="acct"><span class="av">${esc((user.name || user.email || "?").charAt(0).toUpperCase())}</span><div><b>${esc(user.name || "")}</b><span>${esc(user.email)}</span></div></div>
    ${plano ? `<div class="note plano-note"><b>${esc(textoPlano(plano))}</b>${!NA_PLAY && plano.acesso !== "admin" ? `<a class="btn primary sm" href="planos.html">Minha assinatura</a>` : ""}</div>` : ""}
    <div class="row wrap"><button class="btn ghost sm" id="cfPass">Trocar senha</button>${isAdmin() ? `<button class="btn ghost sm" id="cfAdmin">Cadastrar entregador</button>` : ""}${isAdmin() && PLANOS_ON() ? `<a class="btn ghost sm" href="admin.html">Painel master</a>` : ""}<button class="btn warn sm" id="cfOut">Sair da conta</button></div>

    <h4 class="cfg-h">Rota</h4>
    <div class="field"><label for="cfCity">Cidade / região onde você entrega</label><input id="cfCity" list="cfCityList" value="${esc(S.city)}" placeholder="Ex.: Belo Horizonte - MG"><datalist id="cfCityList">${RMBH.map(c => `<option value="${c} - MG">`).join("")}</datalist><span class="hint">Belo Horizonte - MG cobre toda a Grande BH. Pode trocar por qualquer cidade.</span></div>
    <div class="field"><label>Ponto de partida</label><div class="sub" style="margin-bottom:6px">${st.start ? esc(st.start.label || "Definido") : "Ainda não definido"}</div>
      <div class="row"><button class="btn ghost sm" id="cfGps" style="flex:1">Usar minha localização</button><button class="btn ghost sm" id="cfMap" style="flex:1">Escolher no mapa</button></div></div>
    <label class="check"><input type="checkbox" id="cfRound" ${S.roundTrip ? "checked" : ""}> Voltar ao ponto de partida no fim</label>
    <div class="grid2"><div class="field"><label for="cfStop">Minutos por parada</label><input id="cfStop" type="number" min="1" value="${S.stopMin}"></div>
      <div class="field"><label for="cfNav">App de navegação</label><select id="cfNav"><option value="waze" ${S.nav === "waze" ? "selected" : ""}>Waze</option><option value="google" ${S.nav === "google" ? "selected" : ""}>Google Maps</option></select></div></div>
    <label class="check"><input type="checkbox" id="cfSpeak" ${S.speak ? "checked" : ""}> O app fala a próxima entrega em voz alta</label>

    <h4 class="cfg-h">Ganhos e meta</h4>
    <div class="grid2"><div class="field"><label for="cfRate">Ganho por pacote (padrão, R$)</label><input id="cfRate" type="number" step="0.1" min="0" value="${S.rate}"></div>
      <div class="field"><label for="cfGoal">Meta por dia (R$)</label><input id="cfGoal" type="number" step="10" min="0" value="${S.goal || ""}" placeholder="Ex.: 200"></div></div>
    <div class="field"><label>Ganho por pacote em cada plataforma (deixe vazio para usar o padrão)</label>
      <div class="grid2">${PLATS.map((pl, i) => `<input id="cfPl${i}" type="number" step="0.1" min="0" placeholder="${esc(pl)}" aria-label="${esc(pl)}" value="${rates[pl] || ""}">`).join("")}</div></div>

    <h4 class="cfg-h">Veículo e custos</h4>
    <div class="grid2"><div class="field"><label for="cfVeh">Veículo</label><select id="cfVeh">${Object.keys(VEHICLE_LABEL).map(k => `<option value="${k}" ${S.vehicle === k ? "selected" : ""}>${VEHICLE_LABEL[k]}</option>`).join("")}</select></div>
      <div class="field"><label for="cfKml">Consumo (km por litro)</label><input id="cfKml" type="number" step="0.5" min="0" value="${S.kml || KML_DEFAULT[S.vehicle]}"></div></div>
    <div class="grid2"><div class="field"><label for="cfFuel">Preço da gasolina (R$/litro)</label><input id="cfFuel" type="number" step="0.01" min="0" value="${S.fuelPrice}"></div>
      <div class="field"><label for="cfOther">Óleo, pneu e manutenção (R$ por km)</label><input id="cfOther" type="number" step="0.01" min="0" value="${otherKm()}"></div></div>
    <div class="grid2"><div class="field"><label for="cfFixed">Custos fixos por mês (parcela, seguro, celular)</label><input id="cfFixed" type="number" step="10" min="0" value="${S.fixedMonth || ""}" placeholder="R$"></div>
      <div class="field"><label for="cfWd">Dias trabalhados por mês</label><input id="cfWd" type="number" min="1" max="31" value="${S.workDays || 26}"></div></div>

    <h4 class="cfg-h">Relatórios</h4>
    <div class="field"><label for="cfAuto">Relatório automático</label><select id="cfAuto">${[["none", "Não enviar"], ["day", "Todo dia"], ["week", "Toda semana (segunda-feira)"], ["month", "Todo mês (dia 1º)"]].map(o => `<option value="${o[0]}" ${S.autoRep === o[0] ? "selected" : ""}>${o[1]}</option>`).join("")}</select>
      <span class="hint">Quando chegar a hora, o app avisa e o relatório sai com um toque.</span></div>
    <div class="grid2"><div class="field"><label for="cfRepWa">WhatsApp para o relatório</label><input id="cfRepWa" inputmode="tel" placeholder="(31) 99999-0000" value="${esc(S.repWa)}"></div>
      <div class="field"><label for="cfRepMail">E-mail para o relatório</label><input id="cfRepMail" type="email" placeholder="voce@email.com" value="${esc(S.repMail)}"></div></div>
    <div class="field"><label for="cfMei">Acompanhar limite anual do MEI (opcional, R$)</label><input id="cfMei" type="number" step="1000" min="0" value="${S.meiLimit || ""}" placeholder="Vazio = sem limite"><span class="hint">O app não trava nada. Se preencher, só mostra quanto do valor você já faturou no ano.</span></div>

    <h4 class="cfg-h">Clientes e segurança</h4>
    <div class="field"><label for="cfMsg">Mensagem para o cliente</label><textarea id="cfMsg" style="min-height:80px">${esc(S.msg)}</textarea><span class="hint">{nome} e {min} são trocados automaticamente.</span></div>
    <div class="grid2"><div class="field"><label for="cfSosN">Contato de emergência</label><input id="cfSosN" value="${esc(S.sosName || "")}" placeholder="Nome"></div>
      <div class="field"><label for="cfSosP">WhatsApp de emergência</label><input id="cfSosP" inputmode="tel" value="${esc(S.sosPhone || "")}" placeholder="(31) 99999-0000"></div></div>

    <h4 class="cfg-h">Ajuda</h4>
    ${videoBlock()}
    <button class="btn ghost" id="cfHelp" style="width:100%;margin-top:8px">Abrir assistente de dúvidas</button>

    <h4 class="cfg-h">Aparência</h4>
    <div class="field"><label for="cfTheme">Tema</label><select id="cfTheme"><option value="system">Igual ao aparelho</option><option value="light" ${S.theme === "light" ? "selected" : ""}>Claro</option><option value="dark" ${S.theme === "dark" ? "selected" : ""}>Escuro</option></select></div>
    <div class="stack">
      ${deferredInstall ? `<button class="btn primary" id="cfInstall">Instalar o DeliveRota neste aparelho</button>` : ""}
      <button class="btn ghost" id="cfSample">Carregar rota de exemplo</button>
      <button class="btn warn" id="cfClear">Apagar todas as paradas</button>
      <button class="btn primary big" id="cfSave">Salvar</button>
    </div>`, () => {
    $("#cfPass").addEventListener("click", () => { closeSheet(); changePassword(); });
    $("#cfHelp").addEventListener("click", () => { closeSheet(); helpSheet2(); });
    const adm = $("#cfAdmin"); if (adm) adm.addEventListener("click", () => { closeSheet(); adminSheet(); });
    $("#cfOut").addEventListener("click", e => twoTap(e.currentTarget, "Toque de novo para sair", logout));
    $("#cfGps").addEventListener("click", () => useGps(true));
    $("#cfMap").addEventListener("click", () => { closeSheet(); go("rota"); setPinMode("start"); });
    $("#cfSample").addEventListener("click", () => { closeSheet(); loadSample(); });
    $("#cfClear").addEventListener("click", e => twoTap(e.currentTarget, "Toque de novo para apagar tudo", () => { st.stops = []; st.started = false; st.otimizada = false; save(); closeSheet(); renderAll(true); toast("Rota apagada"); }));
    const inst = $("#cfInstall"); if (inst) inst.addEventListener("click", async () => { deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; closeSheet(); });
    $("#cfVeh").addEventListener("change", e => { $("#cfKml").value = KML_DEFAULT[e.target.value] || 0; $("#cfOther").value = OTHER_KM_DEFAULT[e.target.value] || 0; });
    $("#cfSave").addEventListener("click", () => {
      const oldCity = S.city, num = (id, d = 0) => Math.max(0, parseFloat($("#" + id).value) || d);
      const pr = {}; PLATS.forEach((pl, i) => { const v = parseFloat($("#cfPl" + i).value); if (v > 0) pr[pl] = v; });
      Object.assign(S, { city: $("#cfCity").value.trim(), roundTrip: $("#cfRound").checked, stopMin: Math.max(1, +$("#cfStop").value || 3), nav: $("#cfNav").value, speak: $("#cfSpeak").checked,
        rate: num("cfRate"), goal: num("cfGoal"), platRates: pr, vehicle: $("#cfVeh").value, kml: num("cfKml"), fuelPrice: num("cfFuel"), otherKm: num("cfOther"), fixedMonth: num("cfFixed"), workDays: Math.min(31, Math.max(1, +$("#cfWd").value || 26)),
        autoRep: $("#cfAuto").value, repWa: $("#cfRepWa").value.trim(), repMail: $("#cfRepMail").value.trim(), meiLimit: num("cfMei", 0),
        msg: $("#cfMsg").value, sosName: $("#cfSosN").value.trim(), sosPhone: $("#cfSosP").value.trim(), theme: $("#cfTheme").value });
      applyTheme(); save(); closeSheet(); renderAll(false); toast("Configurações salvas");
      if (S.city && (S.city !== oldCity || !st.cityCenter || st.cityCenter.name !== S.city)) centerOnCity();
    });
  });
}
async function centerOnCity() {
  const city = st.settings.city; if (/^belo horizonte/i.test(city || "")) { st.cityCenter = { lat: REGION.center[0], lng: REGION.center[1], name: city }; save(); if (map && !st.stops.some(hasGeo) && !st.start) map.setView(REGION.center, REGION.zoom); return; }
  if (!city || !navigator.onLine) return;
  try {
    const u = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=br&limit=1&accept-language=pt-BR&q=${encodeURIComponent(city)}`;
    const j = await (await fetch(u)).json(); if (!j[0]) { toast("Não achei a cidade " + city + " no mapa"); return; }
    st.cityCenter = { lat: +j[0].lat, lng: +j[0].lon, name: city }; save();
    if (map && !st.stops.some(hasGeo) && !st.start) map.setView([st.cityCenter.lat, st.cityCenter.lng], 13);
  } catch (e) {}
}
function applyTheme() { const t = st.settings.theme; if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t; }
function useGps(fromSettings) {
  if (!navigator.geolocation) { toast("Este aparelho não informa a localização"); return; }
  toast("Buscando sua localização...");
  navigator.geolocation.getCurrentPosition(async p => {
    st.start = { lat: p.coords.latitude, lng: p.coords.longitude, label: "Minha localização" }; ondeEstou = { lat: st.start.lat, lng: st.start.lng, t: Date.now() };
    if (!st.settings.city) { const a = await reverse(st.start.lat, st.start.lng); if (a.city) st.settings.city = a.city; }
    save(); if (fromSettings) closeSheet(); renderAll(true); toast("Partida: sua localização atual");
  }, () => toast("Não consegui a localização. Libere a permissão de localização."), { enableHighAccuracy: true, timeout: 15000 });
}

/* ===================== importação (revisão) ===================== */
let importList = [];
function showImport(list, source) {
  importList = list.map(a => ({ ...limparEndereco(a), src: source, ok: true }));
  const box = $("#importBox");
  if (!importList.length) { box.innerHTML = `<div class="imp"><h4>Nenhum endereço encontrado</h4><p class="sub">Confira se o texto tem rua e número. Você também pode digitar o endereço.</p></div>`; return; }
  const temRota = pending().length > 0;
  const PLAY = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>';
  const MAIS = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  box.innerHTML = `<div class="imp"><div class="imp-top">
      <button class="xclose" data-act="impcancel" aria-label="Cancelar" title="Cancelar estes endereços">✕</button>
      <div class="imp-h"><h4>${importList.length} endereço${importList.length > 1 ? "s" : ""} encontrado${importList.length > 1 ? "s" : ""}</h4><span class="hint">${temRota ? "Entram na rota que você já tem, em outra cor." : "Desmarque o que não for entrega."}</span></div>
      <button class="btn primary cta" id="impStart" data-act="impstart">${PLAY}COMEÇAR ROTA</button>
      <button class="btn dark addmore" id="impGo" data-act="impgo">${MAIS}Adicionar mais endereços</button></div>
    ${importList.map((a, i) => `<label class="imp-row"><input type="checkbox" data-imp="${i}" checked><div><b>${esc(addrLine(a) || a.raw || "Endereço sem rua")}</b><br><span class="sub">${esc([a.comp, a.bairro, a.city, a.cep, a.client, a.code].filter(Boolean).join(" · ") || "")}</span></div></label>`).join("")}
    <button class="btn primary cta" data-act="impstart" style="margin-top:12px;width:100%">${PLAY}COMEÇAR ROTA</button></div>`;
  renderAddBar();
  box.scrollIntoView({ behavior: "smooth", block: "start" });
}
function confirmImport({ fica = false } = {}) {
  const list = importList.filter(a => a.ok);
  if (!list.length) { toast("Marque pelo menos um endereço"); return false; }
  const exist = new Set(st.stops.map(s => (s.street + "|" + s.num + "|" + s.comp).toLowerCase()));
  const fresh = list.filter(a => !exist.has((a.street + "|" + a.num + "|" + a.comp).toLowerCase()));
  addStops(fresh);
  $("#importBox").innerHTML = ""; importList = []; ["#docStatus", "#ocrStatus"].forEach(q => { const x = $(q); if (x) x.hidden = true; }); renderAddBar();
  if (fica) {
    toast(`${fresh.length} parada(s) na rota. Adicione mais ou toque em COMEÇAR ROTA.`, 3500);
    ["#docStatus", "#ocrStatus"].forEach(q => { const x = $(q); if (x) x.hidden = true; });
    renderAddBar(); $(".panel").scrollTop = 0; return true;
  }
  toast(`${fresh.length} parada(s) adicionadas${list.length - fresh.length ? ` (${list.length - fresh.length} repetidas ignoradas)` : ""}.`, 3000);
  go("rota");
  return true;
}

/* ===================== entrada: foto / print (OCR) ===================== */
/* Prepara a foto para ler TODOS os endereços: mantém a letra grande (amplia print pequeno,
   não encolhe foto grande demais), deixa em cinza com contraste e corta listas compridas em
   faixas nos espaços em branco entre as linhas, para nenhuma linha ficar pequena demais. */
async function prepararFotoOcr(file) {
  const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = URL.createObjectURL(file); });
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  let k = 2200 / W; if (W < 1100) k = Math.min(3, 2200 / W); k = Math.max(Math.min(k, 3), 0.25);
  const cw = Math.round(W * k), ch = Math.round(H * k);
  const c = document.createElement("canvas"); c.width = cw; c.height = ch;
  const g = c.getContext("2d", { willReadFrequently: true }); g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, cw, ch);
  // cinza + contraste automático
  const d = g.getImageData(0, 0, cw, ch), px = d.data, hist = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) { const y = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 | 0; px[i] = y; hist[y]++; }
  const tot = cw * ch; let lo = 0, hi = 255, acc = 0; while (lo < 255 && (acc += hist[lo]) < tot * .01) lo++; acc = 0; while (hi > 0 && (acc += hist[hi]) < tot * .01) hi--;
  const esc2 = hi - lo > 30 ? 255 / (hi - lo) : 1;
  const linha = new Float64Array(ch);
  for (let i = 0, n = 0; i < px.length; i += 4, n++) { let y = (px[i] - lo) * esc2; y = y < 0 ? 0 : y > 255 ? 255 : y; px[i] = px[i + 1] = px[i + 2] = y; linha[(n / cw) | 0] += 255 - y; }
  g.putImageData(d, 0, 0);
  // fatias de ~1600 px cortadas na linha mais "vazia" (entre uma linha de texto e outra)
  const faixas = []; const ALVO = 1600;
  let y0 = 0;
  while (y0 < ch) {
    let y1 = Math.min(ch, y0 + ALVO);
    if (y1 < ch) { let melhor = y1, min = Infinity; for (let y = y1; y > y0 + ALVO * .6; y--) { if (linha[y] < min) { min = linha[y]; melhor = y; } } y1 = melhor; }
    const f = document.createElement("canvas"); f.width = cw; f.height = y1 - y0;
    f.getContext("2d").drawImage(c, 0, y0, cw, y1 - y0, 0, 0, cw, y1 - y0);
    faixas.push(f); y0 = y1;
  }
  URL.revokeObjectURL(img.src);
  return faixas;
}
let ocrWorker = null;
async function workerOcr(onProg) {
  await loadScript(LIBS.ocr);
  if (!ocrWorker) ocrWorker = await Tesseract.createWorker("por", 1, { logger: m => { if (m.status === "recognizing text" && ocrWorker && ocrWorker.__prog) ocrWorker.__prog(m.progress); } });
  ocrWorker.__prog = onProg; return ocrWorker;
}
const chaveEnd = a => [a.street, a.num, a.comp, a.cep].map(x => norm(x || "")).join("|");
async function handleOcr(files) {
  const status = $("#ocrStatus"); status.hidden = false;
  try {
    status.textContent = "Preparando leitura de texto (na primeira vez baixa uns 10 MB)...";
    const todos = []; const vistos = new Set();
    for (let i = 0; i < files.length; i++) {
      const faixas = await prepararFotoOcr(files[i]);
      const nome = files.length > 1 ? `foto ${i + 1} de ${files.length}` : "foto";
      let texto = "";
      for (let f = 0; f < faixas.length; f++) {
        const w = await workerOcr(pr => { status.textContent = `Lendo ${nome}${faixas.length > 1 ? `, parte ${f + 1} de ${faixas.length}` : ""}: ${Math.round(pr * 100)}% · ${todos.length} endereço(s) até agora`; });
        await w.setParameters({ tessedit_pageseg_mode: "3", preserve_interword_spaces: "1" });
        let r = (await w.recognize(faixas[f])).data.text;
        // tabela: se tem mais CEPs que endereços achados, tenta de novo lendo linha por linha
        const ceps = (r.match(/\b\d{5}-?\d{3}\b/g) || []).length, achou = extractAddresses(r).length;
        if (ceps > achou) { await w.setParameters({ tessedit_pageseg_mode: "6" }); const r6 = (await w.recognize(faixas[f])).data.text; if (extractAddresses(r6).length > achou) r = r6; }
        texto += "\n" + r;
      }
      extractAddresses(texto).forEach(a => { const k = chaveEnd(a); if (!vistos.has(k) || a.client) { vistos.add(k); todos.push(a); } });
    }
    status.textContent = todos.length ? `Li ${todos.length} endereço(s). Confira abaixo.` : "Não achei endereço na imagem. Tente uma foto mais de perto, com boa luz.";
    showImport(todos, "foto");
  } catch (e) { status.textContent = (e && e.message) || "Não consegui ler a imagem."; }
}

/* ===================== entrada: planilha / PDF / TXT ===================== */
const COLS = {
  street: /endere[cç]o|logradouro|address|^rua\b|^destino|^local de entrega/i, num: /^(n[uú]mero|n[º°o]?\.?$|num\b|n[º°]\s)/i, comp: /^(complemento|compl)/i,
  bairro: /^(bairro|distrito|neighbo|district)/i, city: /^(cidade|munic[ií]pio|city)/i, uf: /^(uf|estado|state)$/i, cep: /^(cep|zip|postal|c[oó]digo postal)/i, client: /^(cliente|nome|destinat[aá]rio|recebedor|recipient|customer)/i,
  phone: /^(telefone|fone|celular|whats|contato|tel|phone)/i, code: /^(c[oó]digo|pedido|rastreio|rastreamento|id\b|tracking|nf|nota|spx|tn\b|awb|at id|shipment|package)/i, pk: /^(qtd|quantidade|volumes|pacotes|packages)/i, ref: /^(refer[eê]ncia|obs|observa|notes?)/i,
  lat: /^(lat|latitude)\b/i, lng: /^(lng|lon|long|longitude)\b/i
};
const COL_ORDEM = ["lat", "lng", "cep", "num", "comp", "bairro", "city", "uf", "client", "phone", "code", "pk", "ref", "street"]; // rua por último: "Complemento do endereço" é complemento
const coord = (v, max) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return isFinite(n) && n !== 0 && Math.abs(n) <= max ? n : null; };
function rowsToAddresses(rows) {
  rows = rows.filter(r => r && r.some(c => String(c ?? "").trim()));
  let hi = -1, map2 = {};
  for (let i = 0; i < Math.min(8, rows.length); i++) {
    if (rows[i].some(c => CEP_RE.test(String(c ?? "")) || /[A-Za-zÀ-ú]{3}.*,\s*\d/.test(String(c ?? "")))) continue; // linha de dados, não cabeçalho
    const m = {}; rows[i].forEach((c, j) => { const h = String(c ?? "").trim(); if (!h) return; for (const k of COL_ORDEM) { const re = COLS[k]; if (m[k] == null && !Object.values(m).includes(j) && re.test(h)) { m[k] = j; break; } } });
    if (m.street != null || m.cep != null || (m.lat != null && m.lng != null)) { hi = i; map2 = m; break; }
  }
  if (hi < 0) return extractAddresses(rows.map(r => r.filter(c => String(c ?? "").trim()).join(", ")).join("\n"));
  // sem coluna de rua reconhecida: usa a coluna que mais parece endereço (texto com nome de rua)
  if (map2.street == null) {
    const usadas = new Set(Object.values(map2)); let best = -1, bestN = 0;
    (rows[hi] || []).forEach((_, j) => { if (usadas.has(j)) return; const n = rows.slice(hi + 1, hi + 40).filter(r => STREET_RE.test(String(r[j] ?? ""))).length; if (n > bestN) { bestN = n; best = j; } });
    if (best >= 0) map2.street = best;
  }
  return rows.slice(hi + 1).map(r => {
    const g = k => map2[k] != null ? String(r[map2[k]] ?? "").trim() : "";
    let a = { raw: g("street"), street: g("street"), num: g("num"), comp: g("comp"), bairro: g("bairro"), city: [g("city"), g("uf")].filter(Boolean).join(" - "), cep: g("cep") };
    if (a.street && (!a.num || /,/.test(a.street))) { const p = parseAddressLine(a.street); a = { ...a, street: p.street, num: a.num || p.num || "s/n", comp: a.comp || p.comp, bairro: a.bairro || p.bairro, city: a.city || p.city, cep: a.cep || p.cep }; }
    if (a.cep && digits(a.cep).length <= 8) a.cep = digits(a.cep).padStart(8, "0").replace(/(\d{5})(\d{3})/, "$1-$2");
    const lat = coord(g("lat"), 90), lng = coord(g("lng"), 180);
    const o = { ...a, street: titulo(a.street), bairro: titulo(a.bairro), comp: titulo(a.comp), client: titulo(g("client")), phone: g("phone"), code: g("code"), pk: +g("pk") || 1, ref: g("ref") };
    if (lat != null && lng != null && lat < 6 && lat > -34 && lng < -28 && lng > -74) { o.lat = lat; o.lng = lng; } // ponto já vem na planilha: nem precisa procurar no mapa
    return o;
  }).filter(a => a.street || a.cep || a.lat != null);
}
async function handleDoc(file) {
  const status = $("#docStatus"); status.hidden = false; status.textContent = "Lendo " + file.name + "...";
  try {
    const name = file.name.toLowerCase(); let found = [];
    if (name.endsWith(".pdf")) {
      await loadScript(LIBS.pdf); pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise; let text = "";
      for (let p = 1; p <= pdf.numPages; p++) {
        status.textContent = `Lendo página ${p} de ${pdf.numPages}...`;
        const c = await (await pdf.getPage(p)).getTextContent(); let lastY = null;
        c.items.forEach(it => { const y = Math.round(it.transform[5]); text += (lastY !== null && Math.abs(y - lastY) > 3 ? "\n" : " ") + it.str; lastY = y; }); text += "\n";
      }
      found = extractAddresses(text);
      if (!found.length) status.textContent = "Este PDF parece ser uma imagem escaneada. Tire um print e use a opção Foto ou print.";
    } else if (name.endsWith(".txt")) { found = extractAddresses(await file.text()); }
    else {
      await loadScript(LIBS.xlsx);
      const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
      wb.SheetNames.forEach(n => { found = found.concat(rowsToAddresses(XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: "" }))); });
    }
    if (found.length) status.textContent = `${found.length} endereço(s) encontrados em ${file.name}.`;
    else if (!status.textContent.includes("escaneado")) status.textContent = "Não encontrei endereços. Confira se existe uma coluna Endereço ou Rua.";
    showImport(found, "arquivo");
  } catch (e) { status.textContent = e.message || "Não consegui abrir o arquivo."; }
}

/* ===================== entrada: voz ===================== */
function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $("#voiceText").textContent = "Este navegador não tem reconhecimento de voz. Use o Chrome (Android) ou o Edge (Windows)."; return; }
  const r = new SR(); r.lang = "pt-BR"; r.interimResults = true; r.maxAlternatives = 1;
  const mic = $("#micBtn"); mic.classList.add("on"); $("#voiceText").textContent = "Ouvindo...";
  let finalText = "";
  r.onresult = e => { const t = Array.from(e.results).map(x => x[0].transcript).join(" "); $("#voiceText").textContent = `"${t}"`; if (e.results[e.results.length - 1].isFinal) finalText = t; };
  r.onerror = e => { mic.classList.remove("on"); $("#voiceText").textContent = e.error === "not-allowed" ? "Libere o microfone para o DeliveRota." : "Não entendi. Toque e tente de novo."; };
  r.onend = () => {
    mic.classList.remove("on"); if (!finalText) return;
    const spoken = finalText.replace(/\bnúmero\b/gi, ",").replace(/\bsem número\b/gi, "s/n").replace(/\bapartamento\b/gi, "apto");
    const a = parseAddressLine(spoken.match(STREET_RE) ? spoken : "Rua " + spoken);
    fillForm(a); setMode("type"); toast("Confira os campos e toque em Adicionar parada");
  };
  r.start();
}
function fillForm(a) { ["street", "num", "comp", "bairro", "city", "cep", "client", "phone", "code"].forEach(k => { if (a[k] && $("#" + k)) $("#" + k).value = a[k]; }); }

/* ===================== entrada: QR code / código de barras ===================== */
let scanStream = null, scanTimer = null, lastCode = "", lastAt = 0, scanMode = "add", detector = null, zx = null;
async function openScanner(mode) {
  scanMode = mode;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast("Câmera indisponível. Abra o app pelo endereço https ou pelo atalho instalado."); return; }
  const host = document.createElement("div"); host.className = "scanner"; host.id = "scanner";
  host.innerHTML = `<video playsinline muted></video><div class="scan-frame" id="scanFrame"></div>
    <div class="scan-bar"><div class="scan-msg" id="scanMsg">${mode === "find" ? "Bipe o pacote para ver o número da parada" : "Aponte para o QR code ou código de barras"}</div>
    <div class="row"><button class="btn ghost" id="scanTorch">Lanterna</button><button class="btn primary" id="scanClose">Concluir</button></div></div>`;
  document.body.appendChild(host);
  $("#scanClose").addEventListener("click", closeScanner);
  try {
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch (e) { closeScanner(); toast("Permissão da câmera negada. Libere a câmera para o DeliveRota."); return; }
  const v = $("video", host); v.srcObject = scanStream; await v.play().catch(() => {});
  const track = scanStream.getVideoTracks()[0];
  $("#scanTorch").addEventListener("click", async () => { try { const on = !track._torch; await track.applyConstraints({ advanced: [{ torch: on }] }); track._torch = on; } catch (e) { toast("Lanterna não disponível neste aparelho"); } });
  if ("BarcodeDetector" in window) { try { detector = new BarcodeDetector({ formats: ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "itf", "data_matrix", "pdf417", "upc_a"] }); } catch (e) { detector = null; } }
  if (!detector) { try { await loadScript(LIBS.zxing); const hints = new Map(); hints.set(ZXing.DecodeHintType.TRY_HARDER, true); zx = new ZXing.MultiFormatReader(); zx.setHints(hints); } catch (e) { $("#scanMsg").textContent = "Leitor precisa de internet na primeira vez."; } }
  const c = document.createElement("canvas"), ctx = c.getContext("2d", { willReadFrequently: true });
  const tick = async () => {
    if (!scanStream) return;
    if (v.readyState >= 2) {
      let code = null;
      try {
        if (detector) { const r = await detector.detect(v); if (r[0]) code = r[0].rawValue; }
        else if (zx) {
          const w = Math.min(v.videoWidth, 960), h = Math.round(v.videoHeight * w / v.videoWidth); c.width = w; c.height = h; ctx.drawImage(v, 0, 0, w, h);
          try { const bmp = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(new ZXing.HTMLCanvasElementLuminanceSource(c))); code = zx.decode(bmp).getText(); } catch (e) { code = null; }
        }
      } catch (e) {}
      if (code && (code !== lastCode || Date.now() - lastAt > 2500)) { lastCode = code; lastAt = Date.now(); onScan(code); if (!$("#scanCont").checked && scanMode === "add") { setTimeout(closeScanner, 700); return; } }
    }
    scanTimer = setTimeout(tick, 220);
  };
  tick();
}
function closeScanner() { clearTimeout(scanTimer); if (scanStream) scanStream.getTracks().forEach(t => t.stop()); scanStream = null; const h = $("#scanner"); if (h) h.remove(); renderScanLog(); }
let scanLog = [];
function codeFrom(raw) {
  try { const j = JSON.parse(raw); return { json: j, code: String(j.id || j.tracking || j.codigo || j.code || j.shipment_id || j.pedido || "") }; } catch (e) {}
  const m = raw.match(/[?&](?:id|code|codigo|tracking)=([^&]+)/i); return { code: m ? decodeURIComponent(m[1]) : raw.trim() };
}
function onScan(raw) {
  const frame = $("#scanFrame"); if (frame) { frame.classList.add("hit"); setTimeout(() => frame && frame.classList.remove("hit"), 400); }
  const { json, code } = codeFrom(raw);
  const hit = st.stops.find(s => s.code && (s.code === code || s.code === raw.trim() || (code.length > 5 && (s.code.includes(code) || code.includes(s.code)))));
  const msg = $("#scanMsg");
  if (hit) {
    beep();
    if (msg) msg.innerHTML = `<span style="font-size:44px;font-family:var(--display);display:block;line-height:1">PARADA ${stopNumber(hit)}</span>${esc(addrLine(hit))}`;
    highlight = hit.id; scanLog.unshift({ code, txt: `Parada ${stopNumber(hit)} · ${addrLine(hit)}`, ok: true }); return;
  }
  let addr = null;
  if (json) { const a = json.address || json.endereco || json.receiver_address || json; const street = a.street_name || a.logradouro || a.rua || a.street || a.address_line; if (street) addr = { street, num: String(a.street_number || a.numero || a.number || "s/n"), comp: a.comment || a.complemento || "", bairro: (a.neighborhood && a.neighborhood.name) || a.bairro || "", city: (a.city && a.city.name) || a.cidade || a.city || "", cep: a.zip_code || a.cep || "" }; }
  if (!addr) { const ex = extractAddresses(raw); if (ex.length) addr = ex[0]; }
  if (addr && scanMode === "add") { addStops([{ ...addr, code: code.length < 40 ? code : "", src: "qr" }]); beep(); if (msg) msg.textContent = "Parada criada: " + addrLine(addr); scanLog.unshift({ code, txt: "Parada criada: " + addrLine(addr), ok: true }); return; }
  beep(false);
  if (msg) msg.textContent = scanMode === "find" ? "Pacote não está na rota: " + code.slice(0, 30) : "Código lido. Ligue a uma parada depois de concluir.";
  scanLog.unshift({ code, txt: "Sem endereço no código", ok: false });
}
function renderScanLog() {
  const box = $("#scanLog"); if (!box) return;
  box.innerHTML = scanLog.slice(0, 30).map((l, i) => `<div class="scanlog-item"><div><code>${esc(l.code.slice(0, 60))}</code><br><span class="sub">${esc(l.txt)}</span></div>${l.ok ? "" : `<button class="btn ghost sm" data-link="${i}">Ligar</button>`}</div>`).join("");
  if (highlight) { renderList(); }
}
function linkSheet(i) {
  const l = scanLog[i]; const opts = pending().filter(s => !s.code);
  sheet(`<h3>Ligar código a uma parada</h3><p class="sub" style="font-family:var(--mono);overflow-wrap:anywhere">${esc(l.code)}</p>
    <div class="reasons">${opts.map(s => `<button data-to="${s.id}">${stopNumber(s)} · ${esc(addrLine(s))}</button>`).join("") || `<p class="sub">Todas as paradas já têm código.</p>`}</div>
    <div class="row"><button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="lkNew">Nova parada com este código</button></div>`, () => {
    $$("[data-to]").forEach(b => b.addEventListener("click", () => { const s = byId(b.dataset.to); s.code = l.code; l.ok = true; l.txt = "Ligado à parada " + stopNumber(s); save(); closeSheet(); renderScanLog(); renderAll(false); toast("Código ligado à parada " + stopNumber(s)); }));
    $("#lkNew").addEventListener("click", () => { closeSheet(); setMode("type"); $("#code").value = l.code; $("#cep").focus(); });
  });
}

/* ===================== modos de entrada ===================== */
function setMode(m) {
  $$("#modes .mode").forEach(b => b.setAttribute("aria-pressed", b.dataset.m === m));
  ["type", "scan", "photo", "file", "paste", "voice", "audio", "map"].forEach(k => $("#f-" + k).hidden = k !== m);
  if (m === "scan") renderScanLog();
}

/* ===================== primeiro acesso: onde você entrega ===================== */
function onboardSheet() {
  sheet(`<h3>Onde você vai entregar?</h3><p class="sub">O mapa e a busca de endereços ficam ajustados para a sua região. Dá para mudar depois em Configurações.</p>
    <div class="reasons" id="obOpts">
      <button aria-pressed="true" data-ob="bh"><b>Belo Horizonte e Grande BH</b><br><span class="sub">Recomendado · BH, Contagem, Betim, Nova Lima e região</span></button>
      <button aria-pressed="false" data-ob="city"><b>Uma cidade específica</b></button>
    </div>
    <div class="field" id="obCityF" hidden><label for="obCity">Cidade</label><input id="obCity" list="rmbhList" placeholder="Ex.: Contagem - MG"><datalist id="rmbhList">${RMBH.map(c => `<option value="${c} - MG">`).join("")}</datalist><span class="hint">Pode ser qualquer cidade do Brasil.</span></div>
    <label class="check"><input type="checkbox" id="obGps" checked> Usar minha localização como ponto de partida</label>
    <button class="btn primary big" id="obGo">Começar</button>`, () => {
    let pick = "bh";
    $$("#obOpts button").forEach(b => b.addEventListener("click", () => { $$("#obOpts button").forEach(x => x.setAttribute("aria-pressed", x === b)); pick = b.dataset.ob; $("#obCityF").hidden = pick !== "city"; if (pick === "city") $("#obCity").focus(); }));
    $("#obGo").addEventListener("click", () => {
      if (pick === "city" && !$("#obCity").value.trim()) { toast("Escreva a cidade"); return; }
      const wantGps = $("#obGps").checked;
      st.settings.city = pick === "bh" ? "Belo Horizonte - MG" : $("#obCity").value.trim();
      st.settings.region = pick; st.onboarded = true; st.cityCenter = null; save(); closeSheet();
      if (pick === "bh" && map) map.setView(REGION.center, REGION.zoom); else centerOnCity();
      if (wantGps) useGps(false);
      toast("Pronto! Região: " + (pick === "bh" ? "Belo Horizonte e Grande BH" : st.settings.city));
      if (!st.navAsked) setTimeout(() => navSheet(), 350);
    });
  });
}

/* ===================== app de navegação: Google Maps (padrão) ou Waze ===================== */
const NAV_ICON = { app: '<svg width="26" height="26" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#18A957"/><path d="M12 5 18 18 12 15 6 18z" fill="#fff"/></svg>', google: '<svg width="26" height="26" viewBox="0 0 24 24"><path fill="#34A853" d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7z"/><circle cx="12" cy="9" r="2.6" fill="#fff"/></svg>',
  waze: '<svg width="26" height="26" viewBox="0 0 24 24"><circle cx="12" cy="11" r="8.5" fill="#33CCFF"/><circle cx="9.3" cy="10" r="1.2" fill="#0B1A2A"/><circle cx="14.7" cy="10" r="1.2" fill="#0B1A2A"/><path d="M8.8 13.3c1.8 1.6 4.6 1.6 6.4 0" stroke="#0B1A2A" stroke-width="1.4" fill="none" stroke-linecap="round"/></svg>' };
function precisaPerguntarNav() { return !st.navAsked || !st.navV2 || Date.now() - st.navAsked > 604800000; }
function navSheet(depois) {
  sheet(`<h3>Qual app você usa para navegar?</h3><p class="sub">Ao começar a rota, a tela do DeliveRota já aproxima e mostra cada curva. Escolha também onde abrir a navegação. Dá para trocar a qualquer hora no cartão da entrega.</p>
    <div class="navpick">
      <button data-navpick="app" aria-pressed="${st.settings.nav === "app"}">${NAV_ICON.app}<span><b>Aqui no DeliveRota</b><em>Mapa em tela cheia, seta de cada curva e voz</em></span></button>
      <button data-navpick="google" aria-pressed="${st.settings.nav === "google"}">${NAV_ICON.google}<span><b>Google Maps</b><em>Abre o app do Google com as próximas paradas</em></span></button>
      <button data-navpick="waze" aria-pressed="${st.settings.nav === "waze"}">${NAV_ICON.waze}<span><b>Waze</b><em>Uma parada por vez</em></span></button>
    </div>`, bg => {
    bg.querySelectorAll("[data-navpick]").forEach(b => b.addEventListener("click", () => {
      st.settings.nav = b.dataset.navpick; st.navAsked = Date.now(); st.navV2 = 1; save(); closeSheet(); renderNext();
      toast("Navegação pelo " + ({ waze: "Waze", app: "DeliveRota" }[st.settings.nav] || "Google Maps"));
      if (depois) depois();
    }));
  });
}
/* ===================== navegação dentro do app: tela aproximada, seta de cada curva ===================== */
let ondeEstou = null;            // última posição do GPS (também usada para buscar endereço perto de onde a pessoa está)
const NV = { on: false, alvo: null, rota: null, passos: [], prox: 1, watch: null, eu: null, euAnt: null, rumo: 0, ultRecalc: 0, fora: 0, falou: {}, layer: null, meMk: null, chegou: false };
const MOD_ROT = { "straight": 0, "slight right": 40, "right": 90, "sharp right": 135, "uturn": 180, "sharp left": -135, "left": -90, "slight left": -40 };
function mDist(a, b) { return hav(a, b) * 1000; }
function distSeg(p, a, b) { // metros do ponto p até o segmento a-b
  const k = 111320, cl = Math.cos(p.lat * Math.PI / 180);
  const ax = (a.lng - p.lng) * k * cl, ay = (a.lat - p.lat) * k, bx = (b.lng - p.lng) * k * cl, by = (b.lat - p.lat) * k;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}
function rumoEntre(a, b) { const y = Math.sin((b.lng - a.lng) * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180), x = Math.cos(a.lat * Math.PI / 180) * Math.sin(b.lat * Math.PI / 180) - Math.sin(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.cos((b.lng - a.lng) * Math.PI / 180); return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360; }
function textoPasso(p) {
  const m = p.maneuver || {}, nome = p.name ? p.name : "", na = nome ? " na " + nome : "";
  if (m.type === "arrive") return "Você chegou ao destino";
  if (m.type === "depart") return "Siga" + (nome ? " pela " + nome : "");
  if (m.type === "roundabout" || m.type === "rotary" || m.type === "roundabout turn") return `Na rotatória, pegue a ${m.exit || 1}ª saída${nome ? " para a " + nome : ""}`;
  const mod = m.modifier || "straight";
  const v = { "left": "Vire à esquerda", "right": "Vire à direita", "slight left": "Mantenha a esquerda", "slight right": "Mantenha a direita", "sharp left": "Curva fechada à esquerda", "sharp right": "Curva fechada à direita", "straight": "Siga em frente", "uturn": "Faça o retorno" }[mod] || "Siga";
  return v + na;
}
function setaPasso(p) {
  const m = p.maneuver || {};
  if (m.type === "arrive") return '<svg viewBox="0 0 48 48" width="64" height="64"><path d="M24 4c-7.7 0-14 6.1-14 13.8C10 28.2 24 44 24 44s14-15.8 14-26.2C38 10.1 31.7 4 24 4z" fill="#fff"/><circle cx="24" cy="18" r="5.5" fill="#0E8A44"/></svg>';
  if (m.type === "roundabout" || m.type === "rotary" || m.type === "roundabout turn") return `<svg viewBox="0 0 48 48" width="64" height="64" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="26" r="9"/><path d="M24 35v10M33 26h10l-5-5M38 31l5-5"/></svg>`;
  const rot = MOD_ROT[m.modifier || "straight"] ?? 0;
  if ((m.modifier || "") === "uturn") return '<svg viewBox="0 0 48 48" width="64" height="64" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"><path d="M30 44V20a8 8 0 0 0-16 0v6"/><path d="M8 20l6 7 6-7"/></svg>';
  return `<svg viewBox="0 0 48 48" width="64" height="64" style="transform:rotate(${rot}deg)"><path d="M24 6 10 22h9v20h10V22h9z" fill="#fff"/></svg>`;
}
const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(1).replace(".", ",") + " km" : (m > 100 ? Math.round(m / 10) * 10 : Math.max(5, Math.round(m / 5) * 5)) + " m";
async function buscarRotaApp(de, para) {
  const u = `https://router.project-osrm.org/route/v1/driving/${de.lng},${de.lat};${para.lng},${para.lat}?steps=true&geometries=geojson&overview=full`;
  const j = await (await fetch(u)).json();
  if (!j.routes || !j.routes[0]) throw new Error("sem rota");
  const r = j.routes[0];
  return { linha: r.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] })), passos: r.legs[0].steps.filter(s => s.maneuver), km: r.distance / 1000, min: r.duration / 60 };
}
function navUI() {
  let b = $("#navBan");
  if (!b) {
    $(".mapcol").insertAdjacentHTML("beforeend", `<div id="navBan" class="navban" hidden><div class="nb-seta" id="nbSeta"></div><div class="nb-txt"><b id="nbDist"></b><span id="nbInstr"></span><em id="nbDepois"></em></div></div>
      <div id="nfPerto" class="nfperto" hidden><div id="npTxt"></div><button class="btn primary sm" id="npFaz">Fazer agora</button><button class="btn ghost sm" id="npPula" aria-label="Agora não">✕</button></div>
      <div id="navFoot" class="navfoot" hidden><div><b id="nfDest"></b><span id="nfResto"></span><em id="nfTerm"></em></div><button class="btn ghost sm" id="nfLista" aria-label="Lista de paradas">☰ Paradas</button><button class="btn primary sm" id="nfEntregue" hidden>Entregue</button><button class="btn ghost sm" id="nfCentro" aria-label="Centralizar">◎ Centro</button><button class="btn ghost sm" id="nfFora" aria-label="Abrir em outro app">↗ ${st.settings.nav === "waze" ? "Waze" : "Maps"}</button><button class="btn warn sm" id="nfSair">Sair</button></div>`);
    $("#nfFora").addEventListener("click", () => { if (!NV.alvo) return; const L2 = navLinks(NV.alvo, true); window.open(st.settings.nav === "waze" ? L2.waze : (L2.gmapsMulti || L2.gmaps), "_blank", "noopener"); });
    $("#nfEntregue").addEventListener("click", () => { if (NV.alvo) deliverSheet(NV.alvo); });
    $("#nfSair").addEventListener("click", () => pararNavApp(true));
    $("#nfLista").addEventListener("click", navListaSheet);
    $("#npFaz").addEventListener("click", () => { const x = byId($("#nfPerto").dataset.id); if (x) trocarAlvoNav(x); });
    $("#npPula").addEventListener("click", () => { const id = $("#nfPerto").dataset.id; NV.pulouPerto = NV.pulouPerto || {}; NV.pulouPerto[id] = 1; $("#nfPerto").hidden = true; });
    $("#nfCentro").addEventListener("click", () => { if (NV.eu && map) map.setView([NV.eu.lat, NV.eu.lng], 18); NV.solto = false; });
    b = $("#navBan");
  }
  return b;
}
async function iniciarNavApp(s) {
  if (!map || !window.L) { toast("O mapa precisa de internet para a navegação aqui no app."); return; }
  if (!s) s = pending()[0]; if (!s || !hasGeo(s)) { toast("Essa parada ainda não tem local no mapa."); return; }
  if (!navigator.geolocation) { toast("Este aparelho não informa a localização."); return; }
  NV.on = true; NV.alvo = s; NV.rota = null; NV.prox = 1; NV.falou = {}; NV.chegou = false; NV.solto = false;
  document.body.classList.add("navon"); navUI().hidden = false; $("#navFoot").hidden = false;
  $("#nbInstr").textContent = "Buscando sua localização..."; $("#nbDist").textContent = ""; $("#nbDepois").textContent = ""; $("#nbSeta").innerHTML = "";
  $("#nfDest").textContent = `Parada ${stopNumber(s)} · ${addrLine(s)}`; $("#nfResto").textContent = ""; termNav();
  setTimeout(() => { map.invalidateSize(); if (s && hasGeo(s)) map.setView([s.lat, s.lng], 17); }, 80);
  setTimeout(() => map.invalidateSize(), 400);
  try { navigator.wakeLock && navigator.wakeLock.request("screen").then(l => NV.lock = l).catch(() => {}); } catch (e) {}
  if (NV.watch == null) NV.watch = navigator.geolocation.watchPosition(novaPosicao, err => { if (err && err.code === 1) { pararNavApp(); toast("Libere a localização para o DeliveRota mostrar as curvas aqui no app.", 4500); } else $("#nbInstr").textContent = "Procurando o sinal do GPS..."; }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  map.on("dragstart", soltouMapa);
  drawMap(false);
}
/* navegando: tocar numa parada do mapa → fazer esta agora (fora da ordem) e depois volta para a rota */
function navParadaSheet(s) {
  const d = NV.eu && hasGeo(s) ? fmtDist(mDist(NV.eu, s)) : "";
  sheet(`<h3>Parada ${stopNumber(s)}</h3><p class="sub"><b>${esc(addrLine(s))}</b>${s.comp ? " · " + esc(s.comp) : ""}${s.client ? "<br>" + esc(s.client) : ""}${d ? "<br>" + d + " de você" : ""}</p>
    <div class="col" style="display:flex;flex-direction:column;gap:8px">
      ${s.status === "pending" && NV.alvo !== s ? `<button class="btn primary" id="npIr">Fazer esta agora</button>` : ""}
      ${s.status === "pending" ? `<button class="btn ghost" id="npOk">Já entreguei esta</button>` : ""}
      <button class="btn ghost" id="npFecha">Fechar</button></div>
    <p class="sub" style="margin-top:8px">Depois desta, a navegação volta sozinha para a ordem da rota.</p>`, bg => {
    const ir = bg.querySelector("#npIr"); if (ir) ir.addEventListener("click", () => { closeSheet(); trocarAlvoNav(s); });
    const okb = bg.querySelector("#npOk"); if (okb) okb.addEventListener("click", () => { closeSheet(); deliverSheet(s); });
    bg.querySelector("#npFecha").addEventListener("click", closeSheet);
  });
}
function trocarAlvoNav(s) {
  if (!NV.on || !s) return;
  NV.alvo = s; NV.rota = null; NV.prox = 1; NV.falou = {}; NV.chegou = false; NV.solto = false; NV.pulouPerto = NV.pulouPerto || {};
  $("#nfDest").textContent = `Parada ${stopNumber(s)} · ${addrLine(s)}`; $("#nbInstr").textContent = "Calculando o caminho..."; $("#nbDist").textContent = ""; $("#nbDepois").textContent = "";
  const ch = $("#nfPerto"); if (ch) ch.hidden = true;
  if (NV.layer) NV.layer.clearLayers();
  drawMap(false); if (NV.eu) novaPosicao({ coords: { latitude: NV.eu.lat, longitude: NV.eu.lng, heading: null, speed: 0 } });
  if (st.settings.speak) try { speak(`Indo para a parada ${stopNumber(s)}, ${s.street}, ${spokenNum(s.num || "sem número")}.`); } catch (e) {}
}
/* passando perto de outra parada (fora da ordem): oferece fazer agora */
function avisoPerto(eu) {
  const ch = $("#nfPerto"); if (!ch) return;
  NV.pulouPerto = NV.pulouPerto || {};
  const perto = pending().filter(x => x !== NV.alvo && hasGeo(x) && !NV.pulouPerto[x.id]).map(x => ({ x, d: mDist(eu, x) })).filter(o => o.d < 150).sort((a, b) => a.d - b.d)[0];
  if (!perto) { ch.hidden = true; return; }
  const x = perto.x;
  if (ch.dataset.id !== x.id) { ch.dataset.id = x.id; if (st.settings.speak) try { speak(`Parada ${stopNumber(x)} aqui perto.`); } catch (e) {} }
  $("#npTxt").innerHTML = `<b>Parada ${stopNumber(x)} aqui perto</b><span>${esc(addrLine(x))} · ${fmtDist(perto.d)}</span>`;
  ch.hidden = false;
}
function termNav() {
  const el = $("#nfTerm"); if (!el) return; const pv = previsao(); const n = pending().length;
  el.textContent = `Término ${hhmm(pv.fim)} · ${n} parada${n > 1 ? "s" : ""} · ${km1(pv.km)} km${pv.volta ? " com a volta" : ""}`;
}
/* navegando: lista das paradas com o horário previsto de cada uma */
function navListaSheet() {
  const pv = previsao();
  sheet(`<h3>Paradas da rota</h3><p class="sub">Término ${hhmm(pv.fim)} · ${pv.itens.length} paradas · ${km1(pv.km)} km${pv.volta ? " com a volta" : ""}</p>
    <div class="anlist navlista">${pv.itens.map(o => `<button data-np="${o.s.id}" class="${NV.alvo === o.s ? "alvo" : ""}"><span class="nl-n">${stopNumber(o.s)}<em>${hhmm(o.t)}</em></span><span class="nl-t"><b>${esc(addrLine(o.s))}</b><em>${esc([o.s.comp, o.s.client, o.s.bairro].filter(Boolean).join(" · "))}</em></span></button>`).join("")}
    ${fimPt() ? `<div class="nl-fim"><span class="nl-n">🏠<em>${hhmm(pv.fim)}</em></span><span class="nl-t"><b>${esc(st.end ? nomePonto(st.end) : "Volta ao início")}</b><em>Fim da rota</em></span></div>` : ""}</div>
    <button class="btn ghost" id="nlFecha" style="width:100%;margin-top:10px">Voltar ao mapa</button>`, bg => {
    bg.querySelectorAll("[data-np]").forEach(b => b.addEventListener("click", () => { const x = byId(b.dataset.np); closeSheet(); if (x) navParadaSheet(x); }));
    bg.querySelector("#nlFecha").addEventListener("click", closeSheet);
  });
}
function soltouMapa() { if (NV.on) NV.solto = true; }
function pararNavApp(manual) {
  NV.on = false; if (NV.watch != null) { navigator.geolocation.clearWatch(NV.watch); NV.watch = null; }
  try { NV.lock && NV.lock.release(); } catch (e) {} NV.lock = null;
  if (NV.layer) { NV.layer.remove(); NV.layer = null; } NV.meMk = null;
  document.body.classList.remove("navon"); const b = $("#navBan"); if (b) { b.hidden = true; $("#navFoot").hidden = true; }
  if (map) { map.off("dragstart", soltouMapa); setTimeout(() => { map.invalidateSize(); drawMap(true); }, 80); }
  if (manual) toast("Navegação do app desligada");
}
async function novaPosicao(pos) {
  const eu = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  ondeEstou = { ...eu, t: Date.now() };
  if (!NV.on) return;
  if (NV.eu && mDist(NV.eu, eu) > 3) NV.rumo = (pos.coords.heading != null && !isNaN(pos.coords.heading) && pos.coords.speed > 1) ? pos.coords.heading : rumoEntre(NV.eu, eu);
  NV.eu = eu;
  try { avisoPerto(eu); } catch (e) {}
  const s = NV.alvo;
  if (!s || s.status !== "pending") { const n = pending()[0]; if (!n) { pararNavApp(); return; } NV.alvo = n; NV.rota = null; NV.prox = 1; NV.falou = {}; NV.chegou = false; $("#nfDest").textContent = `Parada ${stopNumber(n)} · ${addrLine(n)}`; drawMap(false); }
  // chegou
  if (mDist(eu, NV.alvo) < 35) {
    $("#nfEntregue").hidden = false;
    if (!NV.chegou) { NV.chegou = true; speak(`Você chegou. Parada ${stopNumber(NV.alvo)}, ${NV.alvo.street}, ${spokenNum(NV.alvo.num)}.`, true); beep(); }
    $("#nbSeta").innerHTML = setaPasso({ maneuver: { type: "arrive" } }); $("#nbDist").textContent = "Chegou"; $("#nbInstr").textContent = addrLine(NV.alvo) + (NV.alvo.comp ? " · " + NV.alvo.comp : ""); $("#nbDepois").textContent = "Toque em Entregue quando terminar";
    desenharNav(); return;
  }
  $("#nfEntregue").hidden = true;
  // rota: busca a primeira vez, quando sai do caminho ou a cada 2 min
  const agora = Date.now();
  let longe = false;
  if (NV.rota) { let dmin = 1e9; const L_ = NV.rota.linha; for (let i = 0; i < L_.length - 1; i++) dmin = Math.min(dmin, distSeg(eu, L_[i], L_[i + 1])); longe = dmin > 45; NV.fora = longe ? NV.fora + 1 : 0; }
  if ((!NV.rota || NV.fora >= 2 || agora - NV.ultRecalc > 120000) && agora - NV.ultRecalc > 8000) {
    NV.ultRecalc = agora;
    try { NV.rota = await buscarRotaApp(eu, NV.alvo); NV.prox = 1; NV.fora = 0; NV.falou = {}; if (longe) speak("Recalculando a rota.", true); }
    catch (e) { if (!NV.rota) { $("#nbInstr").textContent = "Sem internet para traçar a rota. Siga pelo mapa."; desenharNav(); return; } }
  }
  if (!NV.rota) return;
  const P = NV.rota.passos;
  // avança o passo quando passa da curva
  while (NV.prox < P.length - 1) {
    const loc = { lat: P[NV.prox].maneuver.location[1], lng: P[NV.prox].maneuver.location[0] };
    if (mDist(eu, loc) < 18) NV.prox++; else break;
  }
  const passo = P[Math.min(NV.prox, P.length - 1)];
  const loc = { lat: passo.maneuver.location[1], lng: passo.maneuver.location[0] };
  const d = mDist(eu, loc);
  $("#nbSeta").innerHTML = setaPasso(passo); $("#nbDist").textContent = fmtDist(d); $("#nbInstr").textContent = textoPasso(passo);
  const dep = P[NV.prox + 1]; $("#nbDepois").textContent = dep && dep.maneuver.type !== "arrive" ? "Depois: " + textoPasso(dep).toLowerCase() : (dep ? "Depois: chegada" : "");
  // restante
  let resto = mDist(eu, loc); for (let i = NV.prox; i < P.length; i++) resto += P[i].distance || 0;
  const minAlvo = NV.rota.km > 0 && NV.rota.min ? NV.rota.min * (resto / 1000) / NV.rota.km : resto / 1000 / SPEED[st.settings.vehicle] * 60;
  $("#nfResto").textContent = `${Math.max(1, Math.round(minAlvo))} min · chega ${hhmm(Date.now() + minAlvo * 60000)} · ${fmtDist(resto)}`;
  termNav();
  // voz: avisa a 200 m e na hora da curva
  const k = NV.prox;
  if (d < 220 && d > 60 && !NV.falou[k + "a"]) { NV.falou[k + "a"] = 1; speak(`Em ${fmtDist(d).replace(" m", " metros")}, ${textoPasso(passo).toLowerCase()}.`, true); }
  if (d <= 40 && !NV.falou[k + "b"]) { NV.falou[k + "b"] = 1; speak(textoPasso(passo) + ".", true); }
  desenharNav();
}
function desenharNav() {
  if (!map || !NV.eu) return;
  if (!NV.layer) NV.layer = L.layerGroup().addTo(map); NV.layer.clearLayers();
  if (NV.rota) {
    const pts = NV.rota.linha.map(p => [p.lat, p.lng]);
    L.polyline(pts, { color: "#0B5CFF", weight: 11, opacity: .25 }).addTo(NV.layer);
    L.polyline(pts, { color: "#1A73E8", weight: 7, opacity: .95 }).addTo(NV.layer);
    const P = NV.rota.passos[NV.prox]; if (P && P.maneuver.type !== "arrive") L.circleMarker([P.maneuver.location[1], P.maneuver.location[0]], { radius: 9, color: "#fff", weight: 3, fillColor: "#1A73E8", fillOpacity: 1 }).addTo(NV.layer);
  }
  L.marker([NV.eu.lat, NV.eu.lng], { icon: L.divIcon({ className: "", html: `<div class="meseta" style="transform:rotate(${NV.rumo}deg)"><svg viewBox="0 0 40 40" width="44" height="44"><circle cx="20" cy="20" r="18" fill="#1A73E8" stroke="#fff" stroke-width="3"/><path d="M20 8 29 29 20 24 11 29z" fill="#fff"/></svg></div>`, iconSize: [44, 44], iconAnchor: [22, 22] }), zIndexOffset: 2000, interactive: false }).addTo(NV.layer);
  if (!NV.solto) map.setView([NV.eu.lat, NV.eu.lng], 18, { animate: true });
}

/* ===================== voz inteligente: entende para qual parada a pessoa quer ir ===================== */
const PALAVRA_VAZIA = new Set(["rua", "r", "avenida", "av", "travessa", "alameda", "praca", "rodovia", "estrada", "beco", "da", "de", "do", "das", "dos", "e", "a", "o", "na", "no", "para", "pra", "pro", "numero", "n", "ir", "vou", "vamos", "me", "leva", "leve", "fazer", "faz", "entregar", "entrega", "agora", "a", "proxima", "parada", "cliente", "ate", "la", "em", "bora", "partiu", "casa", "passar", "ali", "endereco", "vamo", "quero", "preciso", "que", "depois", "primeiro", "aquela", "aquele", "seu", "dona", "senhor", "senhora"]);
function lev(a, b) { if (a === b) return 0; const m = a.length, n = b.length; if (!m || !n) return m || n; let v = Array.from({ length: n + 1 }, (_, i) => i); for (let i = 1; i <= m; i++) { let prev = v[0]; v[0] = i; for (let j = 1; j <= n; j++) { const tmp = v[j]; v[j] = Math.min(v[j] + 1, v[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; } } return v[n]; }
const NUM_FALADO = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16, dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90, cem: 100, cento: 100, duzentos: 200, trezentos: 300, quatrocentos: 400, quinhentos: 500, seiscentos: 600, setecentos: 700, oitocentos: 800, novecentos: 900, mil: 1000 };
function numerosDaFala(t) {
  const out = (t.match(/\d+/g) || []).map(Number);
  let acc = 0, tem = false;
  t.split(/\s+/).forEach(w => { if (NUM_FALADO[w] != null) { acc += NUM_FALADO[w]; tem = true; } else if (w !== "e" && tem) { out.push(acc); acc = 0; tem = false; } });
  if (tem) out.push(acc);
  return out;
}
function palavrasChave(t) { return norm(t).split(" ").filter(w => w.length > 1 && !PALAVRA_VAZIA.has(w) && !/^\d+$/.test(w) && NUM_FALADO[w] == null); }
function pontuaParada(s, ws, nums) {
  const alvo = palavrasChave([s.street, s.bairro, s.client, s.comp].join(" "));
  let pts = 0, bate = 0;
  ws.forEach(w => {
    let melhor = 0;
    alvo.forEach(a => { if (a === w) melhor = Math.max(melhor, 1); else if (w.length >= 4 && a.length >= 4 && (a.startsWith(w) || w.startsWith(a))) melhor = Math.max(melhor, .85); else if (w.length >= 4 && lev(a, w) <= (w.length >= 7 ? 2 : 1)) melhor = Math.max(melhor, .75); });
    if (melhor) bate++; pts += melhor;
  });
  if (!ws.length) pts = 0;
  const num = String(s.num || "").match(/\d+/); if (num && nums.includes(+num[0])) pts += 1.2;
  if (s.code && ws.some(w => norm(s.code).includes(w))) pts += 1.5;
  const nStop = stopNumber(s); if (/\bparada\b/.test(ws.__frase || "") && nums.includes(nStop)) pts += 2;
  const perto = ondeEstou && hasGeo(s) ? hav(ondeEstou, s) : null; if (perto != null) pts += Math.max(0, .4 - perto * .08); // empate: a mais perto de onde a pessoa está
  return { s, pts, cobertura: ws.length ? bate / ws.length : 0 };
}
function acharParadaFalada(frases) {
  const lista = Array.isArray(frases) ? frases : [frases];
  let todos = [];
  lista.forEach((f, k) => {
    const t = norm(f), ws = palavrasChave(t); ws.__frase = t; const nums = numerosDaFala(t);
    // "parada 12" direto
    const mP = t.match(/\bparada (\d+)\b/); if (mP) { const s = st.stops[+mP[1] - 1]; if (s && s.status === "pending") todos.push({ s, pts: 9, cobertura: 1 }); }
    pending().forEach(s => { const r = pontuaParada(s, ws, nums); r.pts -= k * .05; todos.push(r); });
  });
  todos.sort((a, b) => b.pts - a.pts);
  const vistos = new Set(); todos = todos.filter(r => !vistos.has(r.s.id) && vistos.add(r.s.id));
  const [a, b] = todos;
  if (!a || a.pts < 1 || a.cobertura < .5) return { achou: null, opcoes: todos.filter(r => r.pts >= .8).slice(0, 3) };
  if (b && a.pts - b.pts < .35) return { achou: null, opcoes: todos.slice(0, 3) };
  return { achou: a.s };
}
function irParaParada(s, porVoz) {
  const p = pending(); const atual = p[0];
  if (atual && atual !== s) { st.stops.splice(st.stops.indexOf(s), 1); st.stops.splice(st.stops.indexOf(atual), 0, s); }
  st.started = true; save(); go("rota"); renderAll(false);
  if (porVoz) speak(`Indo para a parada ${stopNumber(s)}, ${s.street}, ${spokenNum(s.num)}.`, true);
  if (NV.on) { NV.alvo = s; NV.rota = null; NV.prox = 1; NV.chegou = false; NV.ultRecalc = 0; $("#nfDest").textContent = `Parada ${stopNumber(s)} · ${addrLine(s)}`; }
}
function escolherParadaSheet(ops, frase) {
  sheet(`<h3>Qual destas?</h3><p class="sub">Você falou: "${esc(frase)}"</p>
    <div class="reasons">${ops.map(r => `<button data-vaipara="${r.s.id}"><b>Parada ${stopNumber(r.s)} · ${esc(addrLine(r.s))}</b><br><span class="sub">${esc([r.s.comp, r.s.bairro, r.s.client].filter(Boolean).join(" · ") || "")}${ondeEstou && hasGeo(r.s) ? " · " + km1(hav(ondeEstou, r.s)) + " km daqui" : ""}</span></button>`).join("")}</div>
    <button class="btn ghost" data-close style="width:100%;margin-top:10px">Nenhuma</button>`, bg => {
    bg.querySelectorAll("[data-vaipara]").forEach(b => b.addEventListener("click", () => { closeSheet(); irParaParada(byId(b.dataset.vaipara), true); }));
  });
  speak("Achei mais de uma. Toque na certa.", true);
}
/* ===================== gastos do dia (manual, foto da notinha ou arquivo) ===================== */
const GASTO_CATS = [
  ["combustivel", "Combustível", "⛽"], ["alimentacao", "Alimentação", "🍽"], ["manutencao", "Manutenção", "🔧"],
  ["estacionamento", "Estacionamento", "🅿"], ["pedagio", "Pedágio", "🛣"], ["lavagem", "Lavagem", "🧽"], ["celular", "Celular / internet", "📱"], ["outros", "Outros", "•"]];
const catNome = c => (GASTO_CATS.find(x => x[0] === c) || GASTO_CATS[GASTO_CATS.length - 1])[1];
const catIco = c => (GASTO_CATS.find(x => x[0] === c) || GASTO_CATS[GASTO_CATS.length - 1])[2];
const gastosDe = (de, ate) => (st.gastos || []).filter(g => g.iso >= de && g.iso <= (ate || de));
const totalGastos = lista => lista.reduce((a, g) => a + (+g.valor || 0), 0);
const dinheiro = t => { const m = String(t).replace(/\s/g, "").match(/^(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?$/); return m ? parseFloat(m[1].replace(/\./g, "") + "." + (m[2] || "0")) : NaN; };
/* lê a notinha: valor total, data e tipo de gasto */
function lerNotinha(texto) {
  const t = String(texto || ""), T = semAcento(t).toUpperCase();
  let valor = null;
  const linhas = T.split(/\n/);
  const NUMR = "(\\d{1,3}(?:\\.\\d{3})*,\\d{2}|\\d+,\\d{2})";
  const prioridades = [/VALOR\s*(TOTAL|A\s*PAGAR|PAGO)|TOTAL\s*A\s*PAGAR|VL\.?\s*TOTAL|TOTAL\s*GERAL/, /(^|[^B])TOTAL/];
  for (const pr of prioridades) {
    for (const l of linhas) {
      if (/SUBTOTAL|SUB-TOTAL|SUB TOTAL|TROCO|DESCONTO|TRIBUT|IMPOSTO|APROX|ITENS/.test(l) || !pr.test(l)) continue;
      const m = l.match(new RegExp(pr.source + "\\D{0,14}" + NUMR)); const nums = l.match(/\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2}/g);
      const v = m ? dinheiro(m[m.length - 1]) : nums ? dinheiro(nums[nums.length - 1]) : NaN;
      if (v > 0) { valor = v; break; }
    }
    if (valor != null) break;
  }
  if (valor == null) { const todos = (T.match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || []).map(dinheiro).filter(v => v > 0 && v < 5000); if (todos.length) valor = Math.max(...todos); }
  let iso = null; const d = T.match(/\b(\d{2})[\/.-](\d{2})[\/.-](\d{2,4})\b/);
  if (d) { const y = d[3].length === 2 ? "20" + d[3] : d[3]; const cand = `${y}-${d[2]}-${d[1]}`; if (!isNaN(new Date(cand + "T12:00")) && +d[2] <= 12 && +d[1] <= 31) iso = cand; }
  const C = [["combustivel", /GASOLINA|ETANOL|ALCOOL|DIESEL|COMBUST|POSTO|LITRO|\bGNV\b|ABASTEC|SHELL|IPIRANGA|PETROBRAS|\bBR\b MANIA/],
    ["estacionamento", /ESTACION|PARKING|\bPARK\b|ROTATIVO/], ["pedagio", /PEDAGIO|SEM PARAR|CONECTCAR|VELOE/],
    ["lavagem", /LAVA\s*JATO|LAVAGEM|LAVA-JATO/], ["manutencao", /OFICINA|PNEU|OLEO|MECANIC|PECAS?\b|BORRACHARIA|AUTO\s*PECAS|FILTRO|REVISAO|CORRENTE|RELACAO/],
    ["alimentacao", /LANCH|RESTAUR|PADARIA|ALIMENT|REFEIC|MERCADO|SUPERMERC|BAR\b|CAFE|PASTEL|MARMIT|SALGAD|REFRIG|AGUA MINERAL/], ["celular", /RECARGA|CLARO|VIVO|\bTIM\b|OI MOVEL|CREDITO CELULAR/]];
  const cat = (C.find(([, re]) => re.test(T)) || [null])[0];
  const lit = T.match(/(\d+[.,]\d{1,3})\s*L(ITROS?)?\b/);
  return { valor, iso, cat, litros: lit ? parseFloat(lit[1].replace(",", ".")) : null };
}
async function gastoSheet(g0, preFoto) {
  const novo = !g0; const g = g0 ? { ...g0 } : { id: uid(), iso: isoOf(new Date()), valor: "", cat: "", desc: "", pag: "", temFoto: false, tipo: "" };
  let arquivo = null; // Blob novo escolhido agora
  const urlAntiga = g.temFoto ? await dbGet("photos", "g_" + g.id) : null;
  sheet(`<div class="sec-h"><h3>${novo ? "Lançar gasto" : "Gasto"}</h3>${novo ? "" : `<span class="pill win">${brOf(g.iso)}</span>`}</div>
    <p class="sub">Tire foto da notinha ou mande o arquivo: o app lê o valor, a data e o tipo sozinho. Também dá para digitar.</p>
    <div class="gfoto">
      <label class="btn primary"><input type="file" id="gCam" accept="image/*" capture="environment" hidden>📷 Foto da notinha</label>
      <label class="btn ghost"><input type="file" id="gArq" accept="image/*,application/pdf" hidden>📎 Arquivo / PDF</label>
    </div>
    <div id="gPrev" class="gprev"${urlAntiga || preFoto ? "" : " hidden"}></div>
    <p class="hint" id="gLendo" hidden></p>
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label for="gValor">Valor (R$)</label><input id="gValor" inputmode="decimal" placeholder="0,00" value="${g.valor !== "" ? String(g.valor).replace(".", ",") : ""}"></div>
      <div class="field"><label for="gDia">Dia</label><input id="gDia" type="date" value="${g.iso}"></div>
    </div>
    <div class="field"><label>Tipo</label><div class="gcats" id="gCats">${GASTO_CATS.map(([k, n, ic]) => `<button type="button" data-gcat="${k}" aria-pressed="${g.cat === k}">${ic} ${n}</button>`).join("")}</div></div>
    <div class="field"><label for="gDesc">Descrição</label><input id="gDesc" placeholder="Ex.: gasolina do posto da Amazonas, 10 litros" value="${esc(g.desc || "")}"></div>
    <div class="field"><label for="gPag">Pago com</label><select id="gPag"><option value="">—</option>${["Dinheiro", "Pix", "Cartão de débito", "Cartão de crédito", "Vale / empresa"].map(x => `<option${g.pag === x ? " selected" : ""}>${x}</option>`).join("")}</select></div>
    <div class="row">${novo ? `<button class="btn ghost" data-close>Cancelar</button>` : `<button class="btn warn" id="gDel">Apagar</button>`}<button class="btn primary" id="gSalvar">${novo ? "Salvar gasto" : "Salvar"}</button></div>`, () => {
    const mostra = blob => {
      const box = $("#gPrev"); box.hidden = false;
      const u = URL.createObjectURL(blob);
      box.innerHTML = blob.type === "application/pdf" ? `<a class="btn ghost" href="${u}" target="_blank" rel="noopener">📄 Ver PDF da nota</a>` : `<img src="${u}" alt="Foto da notinha">`;
    };
    if (urlAntiga) mostra(urlAntiga);
    $$("#gCats button").forEach(b => b.addEventListener("click", () => { $$("#gCats button").forEach(x => x.setAttribute("aria-pressed", x === b)); g.cat = b.dataset.gcat; }));
    const preenche = r => {
      if (r.valor && !$("#gValor").value) $("#gValor").value = r.valor.toFixed(2).replace(".", ",");
      if (r.iso && r.iso <= isoOf(new Date())) $("#gDia").value = r.iso;
      if (r.cat && !g.cat) { g.cat = r.cat; $$("#gCats button").forEach(x => x.setAttribute("aria-pressed", x.dataset.gcat === r.cat)); }
      if (r.cat === "combustivel" && r.litros && !$("#gDesc").value) $("#gDesc").value = `${String(r.litros).replace(".", ",")} litros`;
    };
    const recebe = async file => {
      if (!file) return;
      const ehPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      arquivo = ehPdf ? file : await compressPhoto(file).catch(() => file);
      mostra(arquivo);
      const st_ = $("#gLendo"); st_.hidden = false; st_.textContent = "Lendo a notinha...";
      try {
        let texto = "";
        if (ehPdf) {
          await loadScript(LIBS.pdf); pdfjsLib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
          const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
          for (let p = 1; p <= Math.min(2, pdf.numPages); p++) { const c = await (await pdf.getPage(p)).getTextContent(); texto += c.items.map(i => i.str).join("\n") + "\n"; }
        } else {
          await loadScript(LIBS.ocr);
          const r = await Tesseract.recognize(arquivo, "por", { logger: m => { if (m.status === "recognizing text") st_.textContent = `Lendo a notinha: ${Math.round(m.progress * 100)}%`; } });
          texto = r.data.text;
        }
        const r = lerNotinha(texto); preenche(r);
        st_.textContent = r.valor ? `Li a nota: R$ ${fmt(r.valor)}${r.cat ? " · " + catNome(r.cat) : ""}. Confira e salve.` : "Não consegui ler o valor. Digite o valor da nota.";
      } catch (e) { st_.textContent = navigator.onLine ? "Não consegui ler a nota. Digite o valor." : "Sem internet para ler a nota agora. Digite o valor; a foto fica guardada."; }
    };
    $("#gCam").addEventListener("change", e => recebe(e.target.files[0]));
    $("#gArq").addEventListener("change", e => recebe(e.target.files[0]));
    if (preFoto) recebe(preFoto);
    $("#gSalvar").addEventListener("click", async () => {
      const v = dinheiro($("#gValor").value.trim()) || parseFloat($("#gValor").value.replace(",", "."));
      if (!(v > 0)) { toast("Coloque o valor do gasto"); $("#gValor").focus(); return; }
      g.valor = Math.round(v * 100) / 100; g.iso = $("#gDia").value || isoOf(new Date()); g.desc = $("#gDesc").value.trim(); g.pag = $("#gPag").value; g.cat = g.cat || "outros";
      if (arquivo) { await dbSet("photos", "g_" + g.id, arquivo); g.temFoto = true; g.tipo = arquivo.type || ""; }
      st.gastos = st.gastos || []; const i = st.gastos.findIndex(x => x.id === g.id); if (i >= 0) st.gastos[i] = g; else st.gastos.push(g);
      save(); closeSheet(); renderGastos(); renderResumo(); toast(`Gasto salvo: R$ ${fmt(g.valor)} · ${catNome(g.cat)}`);
    });
    const del = $("#gDel"); if (del) del.addEventListener("click", e => twoTap(e.currentTarget, "Toque de novo para apagar", async () => {
      st.gastos = st.gastos.filter(x => x.id !== g.id); try { await dbDel("photos", "g_" + g.id); } catch (er) {} save(); closeSheet(); renderGastos(); renderResumo(); toast("Gasto apagado");
    }));
  });
}
function renderGastos() {
  const box = $("#gastosBox"); if (!box) return;
  const hoje = isoOf(new Date()), lista = gastosDe(hoje).sort((a, b) => b.id < a.id ? -1 : 1), tot = totalGastos(lista);
  box.innerHTML = `<div class="gastos">
    <div class="gastos-h"><div><b>Gastos de hoje</b><span>${lista.length ? `R$ ${fmt(tot)} em ${lista.length} lançamento${lista.length > 1 ? "s" : ""}` : "Nada lançado ainda"}</span></div>
      <div class="gastos-bt"><label class="btn primary sm"><input type="file" id="gQuick" accept="image/*" capture="environment" hidden>📷 Notinha</label><button class="btn ghost sm" data-act="gasto">+ Digitar</button></div></div>
    ${lista.map(g => `<button class="gasto-row" data-gasto="${g.id}"><span class="gico">${catIco(g.cat)}</span><span class="gtx"><b>${esc(catNome(g.cat))}${g.desc ? " · " + esc(g.desc) : ""}</b><em>${g.pag ? esc(g.pag) : ""}${g.temFoto ? (g.pag ? " · " : "") + "com nota" : ""}</em></span><b class="gval">R$ ${fmt(g.valor)}</b></button>`).join("")}</div>`;
  const q = $("#gQuick"); if (q) q.addEventListener("change", e => { const f = e.target.files[0]; if (f) gastoSheet(null, f); });
}
/* "gastei 50 de gasolina" */
function gastoPorVoz(raw) {
  const t = norm(raw); const nums = (t.match(/\d+(?:[.,]\d{1,2})?/g) || []).map(x => parseFloat(x.replace(",", ".")));
  let v = nums.length ? nums[0] : null; if (v == null) { const n = numerosDaFala(t); if (n.length) v = n[0]; }
  if (!v) return false;
  const r = lerNotinha(raw); const cat = r.cat || (/abastec|gasolin|etanol|alcool/.test(t) ? "combustivel" : /almoc|lanche|janta|cafe|comi/.test(t) ? "alimentacao" : /estacion/.test(t) ? "estacionamento" : "outros");
  st.gastos = st.gastos || []; st.gastos.push({ id: uid(), iso: isoOf(new Date()), valor: v, cat, desc: "por voz", pag: "", temFoto: false });
  save(); renderGastos(); renderResumo();
  speak(`Gasto lançado: ${String(v).replace(".", ",")} reais de ${catNome(cat).toLowerCase()}.`, true); return true;
}
/* ===================== barra rápida, rotas com nome/data, paradas anteriores, compartilhar e manifesto ===================== */
const AG_MAX = 400;
function guardarNaAgenda(lista) {
  st.agenda = st.agenda || [];
  lista.forEach(s => {
    if (!s.street) return;
    const k = (s.street + "|" + s.num + "|" + (s.comp || "")).toLowerCase();
    const i = st.agenda.findIndex(a => a.k === k); const item = { k, street: s.street, num: s.num, comp: s.comp, bairro: s.bairro, city: s.city, cep: s.cep, client: s.client, phone: s.phone, ref: s.ref, lat: s.lat, lng: s.lng, ult: Date.now(), vezes: 1 };
    if (i >= 0) { item.vezes = (st.agenda[i].vezes || 1) + 1; if (item.lat == null) { item.lat = st.agenda[i].lat; item.lng = st.agenda[i].lng; } st.agenda.splice(i, 1); }
    st.agenda.unshift(item);
  });
  if (st.agenda.length > AG_MAX) st.agenda.length = AG_MAX;
}
function alcaFolha() {
  if ($("#folhaAlca")) return;
  $(".panel").insertAdjacentHTML("afterbegin", `<button class="folha-alca" id="folhaAlca" aria-label="Abrir ou fechar o painel"><i></i></button>`);
  const h = $("#folhaAlca"); let y0 = null;
  const alterna = abrir => { document.body.classList.toggle("folha-cheia", abrir ?? !document.body.classList.contains("folha-cheia")); setTimeout(() => map && map.invalidateSize({ pan: false }), 260); };
  h.addEventListener("click", () => alterna());
  h.addEventListener("touchstart", e => { y0 = e.touches[0].clientY; }, { passive: true });
  h.addEventListener("touchend", e => { if (y0 == null) return; const dy = e.changedTouches[0].clientY - y0; y0 = null; if (Math.abs(dy) > 25) { e.preventDefault(); alterna(dy < 0); } });
}
function quickBar() {
  alcaFolha();
  if ($("#qbar")) return;
  $(".mapcol").insertAdjacentHTML("afterbegin", `<form class="qbar" id="qbar" autocomplete="off">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="qIn" placeholder="Toque para adicionar endereço" aria-label="Adicionar endereço" enterkeyhint="done">
      <button type="button" class="qb" id="qScan" aria-label="Bipar pacote" title="Bipar pacote"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10"/></svg></button>
      <button type="button" class="qb" id="qMic" aria-label="Falar endereço" title="Falar endereço"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button>
      <button type="button" class="qb" id="qMenu" aria-label="Mais opções" title="Mais opções"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
    </form>`);
  $("#qbar").addEventListener("submit", e => { e.preventDefault(); adicionarRapido($("#qIn").value); });
  $("#qScan").addEventListener("click", () => openScanner("add"));
  $("#qMenu").addEventListener("click", menuRotas);
  $("#qMic").addEventListener("click", () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast("Este navegador não tem reconhecimento de voz"); return; }
    const r = new SR(); r.lang = "pt-BR"; r.interimResults = true; r.maxAlternatives = 3; let fim = "", alts = [];
    $("#qMic").classList.add("on"); $("#qIn").placeholder = "Fale o endereço…";
    r.onresult = e => { const x = e.results[e.results.length - 1]; $("#qIn").value = x[0].transcript; if (x.isFinal) { fim = x[0].transcript; alts = Array.from(x).map(a => a.transcript); } };
    r.onend = () => { $("#qMic").classList.remove("on"); $("#qIn").placeholder = "Toque para adicionar endereço"; if (fim) adicionarRapido(fim, alts); };
    r.onerror = () => { $("#qMic").classList.remove("on"); };
    try { r.start(); } catch (e) {}
  });
}
function adicionarRapido(txt, alts) {
  txt = String(txt || "").trim(); if (!txt) { $("#qIn").focus(); return; }
  const t = norm(txt);
  if (/^(ir |vou |vamos |me leva|leva |bora |partiu|entreg|proxima|navegar|gastei|abasteci|paguei|pular|otimiz)/.test(t)) { $("#qIn").value = ""; handleCommand(txt, alts); return; }
  // da agenda: o mesmo endereço já usado antes vem com o local certo
  const a = parseAddressLine(STREET_RE.test(txt) ? txt : "Rua " + txt);
  if (!a.street || a.street.length < 3) { toast("Escreva rua e número. Ex.: Rua da Bahia, 1148"); return; }
  const lim = limparEndereco(a); const k = (lim.street + "|" + lim.num + "|" + (lim.comp || "")).toLowerCase();
  const ag = (st.agenda || []).find(x => x.k === k);
  addStops([{ ...a, ...(ag && ag.lat != null ? { lat: ag.lat, lng: ag.lng } : {}), src: "rápido" }]);
  $("#qIn").value = ""; $("#qIn").blur();
  toast(`Parada adicionada: ${lim.street}, ${lim.num || "s/n"}`);
}
function menuRotas() {
  const tem = st.stops.length > 0, pl = (st.planejadas || []).length;
  sheet(`<h3>Rotas</h3>${st.rotaNome ? `<p class="sub">Rota atual: <b>${esc(st.rotaNome)}</b>${st.rotaData ? " · " + brOf(st.rotaData) : ""}</p>` : ""}
    <div class="menu-list">
      <button data-m="criar"><span>🗓</span><b>Criar rota</b><em>Com nome e data: hoje, amanhã ou outro dia</em></button>
      <button data-m="inifim"><span>🏠</span><b>Início e fim da rota</b><em>De onde sai e onde termina (ex.: voltar para casa)</em></button>
      <button data-m="salvas"><span>📂</span><b>Rotas salvas</b><em>${pl ? pl + " rota" + (pl > 1 ? "s" : "") + " para os próximos dias" : "Nenhuma ainda"}</em></button>
      <button data-m="anteriores"><span>↺</span><b>Reutilizar paradas anteriores</b><em>Endereços que você já entregou</em></button>
      <button data-m="copia"${tem ? "" : " disabled"}><span>⤴</span><b>Compartilhar cópia da rota</b><em>Manda as paradas para outro entregador</em></button>
      <button data-m="transferir"${tem ? "" : " disabled"}><span>⇄</span><b>Transferir paradas</b><em>Passa paradas para outro entregador e tira da sua rota</em></button>
      <button data-m="manifesto-foto"><span>📷</span><b>Ler manifesto de rotas</b><em>Foto do manifesto ou da lista da transportadora</em></button>
      <button data-m="manifesto-arq"><span>📄</span><b>Importar manifesto de rotas</b><em>Planilha, PDF ou texto do manifesto</em></button>
    </div>`, bg => {
    bg.querySelectorAll("[data-m]").forEach(b => b.addEventListener("click", () => {
      const m = b.dataset.m;
      if (m === "criar") criarRotaSheet();
      if (m === "inifim") inicioFimSheet();
      if (m === "salvas") rotasSalvasSheet();
      if (m === "anteriores") anterioresSheet();
      if (m === "copia") compartilharSheet(false);
      if (m === "transferir") compartilharSheet(true);
      if (m === "manifesto-foto") { closeSheet(); go("add"); setMode("photo"); $("#ocrFile").click(); }
      if (m === "manifesto-arq") { closeSheet(); go("add"); setMode("file"); $("#docFile").click(); }
    }));
  });
}
function nomePadrao(iso) { const d = new Date(iso + "T12:00"); const dia = d.toLocaleDateString("pt-BR", { weekday: "long" }); const n = (st.planejadas || []).filter(p => p.data === iso).length + (st.rotaData === iso && st.stops.length ? 1 : 0); return `${dia} Rota ${n + 1}`; }
function criarRotaSheet() {
  const hoje = isoOf(new Date()), am = isoOf(new Date(Date.now() + 864e5));
  let quando = hoje;
  sheet(`<h3>Criar rota</h3>
    <div class="field"><label for="crNome">Nome da rota (opcional)</label><input id="crNome" placeholder="${esc(nomePadrao(hoje))}"></div>
    <div class="field"><label>Data</label><div class="reasons" id="crData">
      <button aria-pressed="true" data-d="${hoje}"><b>Hoje</b> <span class="sub">${new Date().toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" })}</span></button>
      <button aria-pressed="false" data-d="${am}"><b>Amanhã</b> <span class="sub">${new Date(Date.now() + 864e5).toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" })}</span></button>
      <button aria-pressed="false" data-d="outro"><b>Escolher data</b></button></div>
      <input id="crOutra" type="date" min="${hoje}" hidden style="margin-top:8px"></div>
    <label class="check"><input type="checkbox" id="crReusar"> Reutilizar paradas anteriores</label>
    ${st.stops.some(s => s.status === "pending") ? `<p class="hint" id="crAviso">Você tem uma rota em andamento. ${"Se a nova for para hoje, a atual é guardada em Rotas salvas."}</p>` : ""}
    <button class="btn primary big" id="crGo">Confirmar</button>`, () => {
    $$("#crData button").forEach(b => b.addEventListener("click", () => {
      $$("#crData button").forEach(x => x.setAttribute("aria-pressed", x === b));
      $("#crOutra").hidden = b.dataset.d !== "outro"; quando = b.dataset.d === "outro" ? ($("#crOutra").value || "") : b.dataset.d;
      $("#crNome").placeholder = nomePadrao(quando || hoje);
    }));
    $("#crOutra").addEventListener("change", e => { quando = e.target.value; $("#crNome").placeholder = nomePadrao(quando || hoje); });
    $("#crGo").addEventListener("click", () => {
      if (!quando) { toast("Escolha a data"); return; }
      const nome = $("#crNome").value.trim() || nomePadrao(quando), reusar = $("#crReusar").checked;
      if (quando === hoje) {
        if (st.stops.some(s => s.status === "pending")) { guardarRotaAtual(); }
        if (!st.stops.some(s => s.status !== "pending")) st.stops = [];
        st.rotaNome = nome; st.rotaData = hoje; st.started = false; st.otimizada = false; save(); closeSheet(); renderAll(true);
        if (reusar) anterioresSheet(); else { go("add"); toast(`Rota "${nome}" criada. Adicione as paradas.`); }
      } else {
        st.planejadas = st.planejadas || []; const p = { id: uid(), nome, data: quando, stops: [] }; st.planejadas.push(p); save(); closeSheet();
        if (reusar) anterioresSheet(p.id); else { toast(`Rota "${nome}" salva para ${brOf(quando)}. Adicione as paradas em Rotas salvas.`, 4000); rotasSalvasSheet(); }
      }
    });
  });
}
function compacta(s) { return { street: s.street, num: s.num, comp: s.comp, bairro: s.bairro, city: s.city, cep: s.cep, client: s.client, phone: s.phone, code: s.code, pk: s.pk, ref: s.ref, win: s.win, prio: s.prio, lat: s.lat, lng: s.lng }; }
function guardarRotaAtual() {
  const pend = st.stops.filter(s => s.status === "pending"); if (!pend.length) return;
  st.planejadas = st.planejadas || [];
  st.planejadas.push({ id: uid(), nome: st.rotaNome || "Rota guardada " + new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }), data: st.rotaData || isoOf(new Date()), stops: pend.map(compacta) });
  st.stops = st.stops.filter(s => s.status !== "pending");
}
function rotasSalvasSheet() {
  const L_ = (st.planejadas || []).slice().sort((a, b) => a.data < b.data ? -1 : 1);
  sheet(`<h3>Rotas salvas</h3>${L_.length ? "" : `<p class="sub">Nenhuma rota salva. Use <b>Criar rota</b> e escolha amanhã ou outra data.</p>`}
    <div class="stack">${L_.map(p => `<div class="rsalva"><div><b>${esc(p.nome)}</b><span>${brOf(p.data)} · ${p.stops.length} parada${p.stops.length === 1 ? "" : "s"}</span></div>
      <div class="row"><button class="btn ghost sm" data-radd="${p.id}">+ Paradas</button><button class="btn primary sm" data-rabrir="${p.id}">Carregar</button><button class="btn ghost sm" data-rdel="${p.id}" aria-label="Apagar">✕</button></div></div>`).join("")}</div>
    <button class="btn ghost" data-close style="width:100%;margin-top:10px">Fechar</button>`, bg => {
    bg.querySelectorAll("[data-rabrir]").forEach(b => b.addEventListener("click", () => carregarPlanejada(b.dataset.rabrir)));
    bg.querySelectorAll("[data-radd]").forEach(b => b.addEventListener("click", () => anterioresSheet(b.dataset.radd)));
    bg.querySelectorAll("[data-rdel]").forEach(b => b.addEventListener("click", e => twoTap(e.currentTarget, "Apagar?", () => { st.planejadas = st.planejadas.filter(x => x.id !== b.dataset.rdel); save(); rotasSalvasSheet(); })));
  });
}
function carregarPlanejada(id) {
  const p = (st.planejadas || []).find(x => x.id === id); if (!p) return;
  if (!p.stops.length) { toast("Essa rota ainda não tem paradas. Toque em + Paradas."); return; }
  if (st.stops.some(s => s.status === "pending")) guardarRotaAtual();
  st.planejadas = st.planejadas.filter(x => x.id !== id);
  st.rotaNome = p.nome; st.rotaData = isoOf(new Date()); st.started = false; st.ultimaAdicao = 0;
  addStops(p.stops); closeSheet(); go("rota"); toast(`Rota "${p.nome}" carregada: ${p.stops.length} paradas`);
}
function avisoRotaDoDia() {
  const hoje = isoOf(new Date()); const p = (st.planejadas || []).find(x => x.data <= hoje && x.stops.length);
  if (!p || st.stops.some(s => s.status === "pending") || $("#sheetHost").innerHTML) return;
  sheet(`<h3>Rota de hoje pronta</h3><p class="sub">Você salvou <b>${esc(p.nome)}</b> com ${p.stops.length} paradas para ${p.data === hoje ? "hoje" : brOf(p.data)}.</p>
    <div class="row"><button class="btn ghost" data-close>Agora não</button><button class="btn primary" id="avCarregar">Carregar rota</button></div>`, () => $("#avCarregar").addEventListener("click", () => carregarPlanejada(p.id)));
}
function anterioresSheet(destino) {
  const ag = st.agenda || [];
  sheet(`<h3>Paradas anteriores</h3><p class="sub">${ag.length ? "Marque os endereços para colocar na rota" + (destino ? " salva" : "") + "." : "Ainda não tem endereços guardados. Eles aparecem aqui depois que você monta rotas."}</p>
    ${ag.length ? `<input id="anBusca" class="busca" placeholder="Buscar rua, bairro ou cliente">
    <div class="anlist" id="anList">${ag.map((a, i) => `<label class="imp-row" data-busca="${esc(norm([a.street, a.num, a.bairro, a.client].join(" ")))}"><input type="checkbox" data-an="${i}"><div><b>${esc(a.street + ", " + (a.num || "s/n"))}</b><br><span class="sub">${esc([a.comp, a.bairro, a.client].filter(Boolean).join(" · "))}${a.vezes > 1 ? ` · ${a.vezes}×` : ""}</span></div></label>`).join("")}</div>
    <button class="btn primary big" id="anGo" style="margin-top:10px">Colocar na rota</button>` : `<button class="btn ghost" data-close style="width:100%">Fechar</button>`}`, () => {
    if (!ag.length) return;
    $("#anBusca").addEventListener("input", e => { const q = norm(e.target.value); $$("#anList [data-busca]").forEach(r => r.hidden = q && !r.dataset.busca.includes(q)); });
    $("#anGo").addEventListener("click", () => {
      const sel = $$("#anList [data-an]:checked").map(c => ag[+c.dataset.an]); if (!sel.length) { toast("Marque pelo menos um endereço"); return; }
      const lista = sel.map(a => ({ street: a.street, num: a.num, comp: a.comp, bairro: a.bairro, city: a.city, cep: a.cep, client: a.client, phone: a.phone, ref: a.ref, lat: a.lat, lng: a.lng, src: "anterior" }));
      const p = destino && (st.planejadas || []).find(x => x.id === destino);
      if (p) { p.stops.push(...lista); save(); toast(`${lista.length} parada(s) na rota "${p.nome}"`); rotasSalvasSheet(); return; }
      addStops(lista); closeSheet(); go("rota"); toast(`${lista.length} parada(s) colocadas na rota`);
    });
  });
}
/* compartilhar: link compactado para mandar no WhatsApp */
const b64url = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const deb64url = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
async function empacotar(obj) {
  const raw = new TextEncoder().encode(JSON.stringify(obj));
  if (window.CompressionStream) { const cs = new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw")); return "z" + b64url(new Uint8Array(await new Response(cs).arrayBuffer())); }
  let s = ""; for (let i = 0; i < raw.length; i += 8192) s += String.fromCharCode(...raw.subarray(i, i + 8192)); return "j" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function desempacotar(s) {
  const tipo = s[0], u8 = deb64url(s.slice(1));
  const txt = tipo === "z" ? await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).text() : new TextDecoder().decode(u8);
  return JSON.parse(txt);
}
const CAMPOS = ["street", "num", "comp", "bairro", "city", "cep", "client", "phone", "code", "pk", "ref", "lat", "lng"];
function compartilharSheet(transferir) {
  const pend = pending(); if (!pend.length) { toast("Nenhuma parada pendente"); return; }
  sheet(`<h3>${transferir ? "Transferir paradas" : "Compartilhar cópia da rota"}</h3>
    <p class="sub">${transferir ? "As paradas marcadas vão para o outro entregador e saem da sua rota." : "O outro entregador recebe um link e as paradas entram no DeliveRota dele."}</p>
    <div class="row" style="margin:6px 0"><button class="btn ghost sm" id="shTodas">Marcar todas</button><button class="btn ghost sm" id="shNenhuma">Desmarcar</button></div>
    <div class="anlist">${pend.map(s => `<label class="imp-row"><input type="checkbox" data-sh="${s.id}" ${transferir ? "" : "checked"}><div><b>${stopNumber(s)}. ${esc(addrLine(s))}</b><br><span class="sub">${esc([s.comp, s.bairro, s.client].filter(Boolean).join(" · "))}</span></div></label>`).join("")}</div>
    <button class="btn primary big" id="shGo" style="margin-top:10px">${transferir ? "Transferir pelo WhatsApp" : "Enviar pelo WhatsApp"}</button>
    <button class="btn ghost" id="shCopiar" style="width:100%;margin-top:8px">Copiar link</button>`, () => {
    $("#shTodas").addEventListener("click", () => $$("[data-sh]").forEach(c => c.checked = true));
    $("#shNenhuma").addEventListener("click", () => $$("[data-sh]").forEach(c => c.checked = false));
    const montar = async () => {
      const sel = $$("[data-sh]:checked").map(c => byId(c.dataset.sh)).filter(Boolean);
      if (!sel.length) { toast("Marque pelo menos uma parada"); return null; }
      const pacote = { v: 1, de: (user && (user.name || user.email)) || "", nome: st.rotaNome || "", p: sel.map(s => CAMPOS.map(k => s[k] ?? "")) };
      const link = location.origin + location.pathname.replace(/[^/]*$/, "") + "#rota=" + await empacotar(pacote);
      return { sel, link };
    };
    const tirar = sel => { if (!transferir) return; st.stops = st.stops.filter(s => !sel.includes(s)); save(); renderAll(true); };
    $("#shGo").addEventListener("click", async () => {
      const r = await montar(); if (!r) return;
      const msg = `${r.sel.length} parada${r.sel.length > 1 ? "s" : ""} para você no DeliveRota${st.rotaNome ? " (" + st.rotaNome + ")" : ""}. Toque para abrir:\n${r.link}`;
      openUrl("https://wa.me/?text=" + encodeURIComponent(msg)); tirar(r.sel); closeSheet();
      toast(transferir ? `${r.sel.length} parada(s) transferidas` : "Link enviado");
    });
    $("#shCopiar").addEventListener("click", async () => {
      const r = await montar(); if (!r) return;
      try { await navigator.clipboard.writeText(r.link); toast("Link copiado. Cole no WhatsApp do outro entregador."); } catch (e) { prompt("Copie o link:", r.link); }
      tirar(r.sel); if (transferir) closeSheet();
    });
  });
}
async function receberRotaDoLink() {
  const h = location.hash; if (!h.startsWith("#rota=")) return;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const pk = await desempacotar(h.slice(6));
    const lista = (pk.p || []).map(a => { const o = {}; CAMPOS.forEach((k, i) => { if (a[i] !== "" && a[i] != null) o[k] = a[i]; }); if (o.lat != null) { o.lat = +o.lat; o.lng = +o.lng; } o.pk = +o.pk || 1; return o; });
    if (!lista.length) return;
    go("add"); showImport(lista, "compartilhado");
    toast(`${pk.de ? pk.de + " te enviou " : "Você recebeu "}${lista.length} parada${lista.length > 1 ? "s" : ""}${pk.nome ? " (" + pk.nome + ")" : ""}`, 5000);
  } catch (e) { toast("Não consegui abrir esse link de rota. Peça para enviar de novo."); }
}
/* ===================== exemplo ===================== */

function loadSample() {
  const S = [
    ["Rua Pernambuco", "1000", "Apto 501", "Mariana S.", "(31) 98123-4410", -19.9362, -43.9334, "", "Prédio de vidro"],
    ["Rua Pernambuco", "1000", "Apto 1203", "Carlos R.", "(31) 99654-2201", -19.9362, -43.9334, "", "Mesma portaria"],
    ["Rua Antônio de Albuquerque", "330", "Loja 2", "Studio Lume", "(31) 3281-8890", -19.9377, -43.9358, "Até 12:00", "Ao lado da farmácia"],
    ["Avenida Getúlio Vargas", "1300", "Sala 804", "João P.", "(31) 97788-1203", -19.9369, -43.9301, "", "Recepção no térreo"],
    ["Rua Tomé de Souza", "845", "", "Aline M.", "(31) 98450-7712", -19.9389, -43.9322, "", "Portão cinza"],
    ["Rua dos Timbiras", "1500", "Apto 302", "Pedro L.", "(31) 99012-3345", -19.9316, -43.9381, "12:00–15:00", "Interfone 302"],
    ["Rua da Bahia", "1800", "", "Fernanda T.", "(31) 98877-6654", -19.9291, -43.9439, "", "Interfone quebrado, ligar"],
    ["Avenida Álvares Cabral", "1000", "", "Auto Center Zé", "(31) 3337-2290", -19.9331, -43.9461, "Até 12:00", "Oficina"],
    ["Rua Rio de Janeiro", "2000", "Apto 8", "Rafael C.", "(31) 99321-5567", -19.9334, -43.9489, "", ""],
    ["Rua Gonçalves Dias", "1200", "Sala 4", "Clínica Bem", "(31) 3262-4411", -19.9344, -43.9371, "Depois das 15:00", "Recepção no térreo"],
    ["Rua Cláudio Manoel", "600", "", "Bianca F.", "(31) 98760-0098", -19.9396, -43.9341, "", "Prédio azul"],
    ["Rua Paraíba", "900", "Fundos", "Lucas A.", "(31) 97654-3321", -19.9351, -43.9326, "", "Campainha à esquerda"]
  ];
  const BAIRRO = ["Savassi", "Savassi", "Savassi", "Funcionários", "Savassi", "Funcionários", "Lourdes", "Lourdes", "Lourdes", "Funcionários", "Funcionários", "Savassi"];
  st.start = { lat: -19.9320, lng: -43.9378, label: "Exemplo: ponto de coleta na Praça da Liberdade" };
  if (!st.settings.city) st.settings.city = "Belo Horizonte - MG";
  addStops(S.map((r, i) => ({ street: r[0], num: r[1], comp: r[2], client: r[3], phone: r[4], lat: r[5], lng: r[6], win: r[7], ref: r[8], bairro: BAIRRO[i], city: "Belo Horizonte - MG", code: "EX" + (48210730 + i * 137), pk: i % 4 === 0 ? 2 : 1, src: "exemplo" })), { geocode: false });
  toast("Rota de exemplo carregada e organizada. Toque em Começar rota.");
  go("rota");
}

/* ===================== resumo: enviar, planilha, encerrar ===================== */
async function exportXlsx() {
  const rows = st.stops.map((s, i) => ({ "Nº": i + 1, Endereço: addrLine(s), Complemento: s.comp, Bairro: s.bairro, Cidade: s.city, CEP: s.cep, Cliente: s.client, Telefone: s.phone, Código: s.code, Pacotes: s.pk,
    Situação: { pending: "Pendente", delivered: "Entregue", failed: "Não entregue" }[s.status], Motivo: s.reason, "Recebido por": s.recv, Horário: s.doneAt ? new Date(s.doneAt).toLocaleTimeString("pt-BR") : "", Foto: s.photo ? "Sim" : "" }));
  const name = `DeliveRota-${new Date().toISOString().slice(0, 10)}`;
  try {
    await loadScript(LIBS.xlsx); const ws = XLSX.utils.json_to_sheet(rows); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Entregas");
    download(new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), name + ".xlsx");
  } catch (e) {
    const keys = Object.keys(rows[0] || { Endereço: "" }); const csv = [keys.join(";")].concat(rows.map(r => keys.map(k => `"${String(r[k] ?? "").replace(/"/g, '""')}"`).join(";"))).join("\n");
    download(new Blob(["﻿" + csv], { type: "text/csv" }), name + ".csv");
  }
}

/* ===================== assistente de voz (falar com o app) ===================== */
const norm = t => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[.,!?]/g, " ").replace(/\s+/g, " ").trim();
let voices = [];
function loadVoices() { try { voices = speechSynthesis.getVoices().filter(v => /^pt/i.test(v.lang)); } catch (e) {} }
if ("speechSynthesis" in window) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
function speak(text, force) {
  if (!force && !st.settings.speak) return;
  try {
    if (!("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text); u.lang = "pt-BR"; u.rate = 1.05;
    const v = voices.find(x => /pt-BR/i.test(x.lang)) || voices[0]; if (v) u.voice = v;
    u.onstart = () => { speaking = true; }; u.onend = u.onerror = () => { speaking = false; if (handsFree) setTimeout(listen, 250); };
    speaking = true; speechSynthesis.speak(u);
  } catch (e) {}
}
const spokenNum = n => String(n).replace(/^s\/n$/i, "sem número");
function sayNext(prefix = "") {
  const p = pending();
  if (!st.stops.length) return speak(prefix + "Nenhuma parada na rota ainda.");
  if (!p.length) return speak(prefix + "Rota concluída. Parabéns!");
  const s = p[0];
  speak(`${prefix}Próxima: parada ${stopNumber(s)}, ${s.street}, ${spokenNum(s.num)}${s.comp ? ", " + s.comp : ""}${s.client ? ", cliente " + s.client : ""}${s.ref ? ". Referência: " + s.ref : ""}.`);
}
const COMMANDS = [
  ["entregue / entreguei / feito", "Marca a próxima como entregue"],
  ["não entreguei / ninguém em casa", "Registra cliente ausente"],
  ["endereço não encontrado / recusou", "Registra o motivo"],
  ["qual a próxima / repetir", "Fala a próxima entrega"],
  ["ir para rua tal, 170 / vou na casa da Maria", "Acha a parada na rota (mesmo falando errado) e vai para ela"],
  ["navegar aqui / sair da navegação", "Liga ou desliga a tela de perto com as curvas"],
  ["navegar / abrir Waze / Google Maps", "Abre a navegação"],
  ["ligar / mandar mensagem", "Liga ou abre o WhatsApp do cliente"],
  ["pular", "Joga a parada para o fim"],
  ["otimizar rota", "Reorganiza as paradas"],
  ["quantas faltam / quanto ganhei", "Fala o andamento do dia"],
  ["gastei 50 de gasolina / abasteci 80", "Lança o gasto do dia"],
  ["adicionar rua tal, número tal", "Cria uma nova parada"],
  ["bipar pacote", "Abre o leitor de código"],
  ["mãos livres / parar de ouvir", "Liga ou desliga a escuta contínua"]
];
function helpSheet() {
  sheet(`<h3>Fale com o DeliveRota</h3><p class="sub">Toque no microfone verde e diga um destes comandos. No modo mãos livres o app fica ouvindo sem precisar tocar.</p>
    <div class="cmds">${COMMANDS.map(c => `<div class="cmd"><b>"${esc(c[0])}"</b><span>${esc(c[1])}</span></div>`).join("")}</div>
    <div class="row"><button class="btn ghost" data-close>Fechar</button><button class="btn primary" id="hfToggle">${handsFree ? "Desligar mãos livres" : "Ligar mãos livres"}</button></div>`, () => {
    $("#hfToggle").addEventListener("click", () => { closeSheet(); setHandsFree(!handsFree); });
  });
}
function openUrl(u) { const a = document.createElement("a"); a.href = u; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove(); }
function quickFail(reason) {
  const s = pending()[0]; if (!s) return speak("Não há entrega pendente.");
  s.status = "failed"; s.reason = reason; s.doneAt = Date.now(); stampWhere(s); save(); renderAll(false); beep(false);
  sayNext(`Registrado: ${reason}. `);
}
function handleCommand(raw, alts) {
  const t = norm(raw); const s = pending()[0]; alts = alts && alts.length ? alts : [raw];
  vb("Entendi", `"${raw}"`);
  const has = (...w) => w.some(x => t.includes(x));
  if (has("socorro", "emergencia", "sos", "ajuda urgente")) { sosSheet(); return sendSos(); }
  if (has("parar de ouvir", "desligar maos livres", "para de ouvir", "silencio")) { setHandsFree(false); return speak("Ok, parei de ouvir.", true); }
  if (has("maos livres", "modo moto", "fica ouvindo")) { setHandsFree(true); return speak("Mãos livres ligado. Pode falar.", true); }
  if (/^(adicionar|adiciona|nova parada|novo endereco|anota|anotar)\b/.test(t)) {
    const rest = raw.replace(/^\s*(adicionar|adiciona|nova parada|novo endereço|novo endereco|anota|anotar)\s*(parada|endereço|endereco)?\s*/i, "")
      .replace(/\bnúmero\b/gi, ",").replace(/\bsem número\b/gi, "s/n").replace(/\bapartamento\b/gi, "apto");
    const a = parseAddressLine(STREET_RE.test(rest) ? rest : "Rua " + rest);
    if (!a.street || a.street.length < 4) return speak("Não entendi o endereço. Diga, por exemplo: adicionar rua Harmonia, 456.");
    addStops([{ ...a, src: "voz" }]); return speak(`Parada adicionada: ${a.street}, ${spokenNum(a.num || "s/n")}.`);
  }
  if (/\b(gastei|gasto de|abasteci|paguei)\b/.test(t) && gastoPorVoz(raw)) return;
  if (has("nao entreg", "ninguem em casa", "ausente", "nao tinha ninguem")) return quickFail("Cliente ausente");
  if (has("nao encontr", "nao achei")) return quickFail("Endereço não encontrado");
  if (has("recus")) return quickFail("Recusado pelo cliente");
  if (has("fechado")) return quickFail("Local fechado");
  if (/\b(entregue|entreguei|entregado|feito|finalizado|concluido|pronto)\b/.test(t)) {
    if (!s) return speak("Não há entrega pendente.");
    s.status = "delivered"; s.recv = "Confirmado por voz"; s.doneAt = Date.now(); stampWhere(s); save(); renderAll(false); beep();
    return sayNext("Entrega registrada. ");
  }
  if (has("pular", "pula", "depois")) { if (!s) return speak("Não há entrega pendente."); st.stops.splice(st.stops.indexOf(s), 1); st.stops.push(s); save(); renderAll(false); return sayNext("Pulei. "); }
  if (has("otimiz", "organiza")) { optimize(); return sayNext("Rota otimizada. "); }
  if (has("bipar", "escanear", "ler codigo", "qr")) { openScanner("find"); return speak("Abrindo o leitor.", true); }
  if (has("sair da navegacao", "parar navegacao", "parar de navegar", "fechar navegacao")) { pararNavApp(true); return speak("Navegação desligada.", true); }
  if (has("navegar aqui", "navegacao do app", "navegar no app", "tela de perto", "aproxima", "aproximar")) { if (!s) return speak("Não há entrega pendente."); iniciarNavApp(); return speak(`Navegando até a parada ${stopNumber(s)}.`, true); }
  const IR = /\b(ir para|ir pra|ir pro|ir na|ir no|vou para|vou pra|vou pro|vou na|vou no|vamos para|vamos pra|me leva|me leve|leva pra|leva para|leva pro|bora pra|bora pro|partiu|fazer a|fazer o|faz a|faz o|entregar na|entregar no|entregar para|entregar pro|agora e|proxima e|primeiro na|primeiro no|passar na|passar no)\b/;
  if (IR.test(t) && !/^(adicionar|adiciona|nova parada|novo endereco|anota|anotar)\b/.test(t)) {
    const r = acharParadaFalada(alts);
    if (r.achou) { irParaParada(r.achou, true); if (!NV.on && st.settings.nav === "app") iniciarNavApp(r.achou); return; }
    if (r.opcoes && r.opcoes.length) return escolherParadaSheet(r.opcoes, raw);
    if (!has("waze", "google", "navegar", "navega")) return speak("Não achei essa parada na rota. Para incluir, diga: adicionar rua tal, número tal.", true);
  }
  if (has("waze", "google maps", "navegar", "navega", "ir para", "rota para", "me leva")) {
    if (!s) return speak("Não há entrega pendente.");
    if (!t.includes("google") && !t.includes("waze") && st.settings.nav === "app") { iniciarNavApp(); return speak(`Navegando até a parada ${stopNumber(s)}.`, true); }
    const L2 = navLinks(s, true); const g = t.includes("google") || (!t.includes("waze") && st.settings.nav !== "waze");
    speak(`Abrindo ${g ? "Google Maps" : "Waze"}.`); return openUrl(g ? (L2.gmapsMulti || L2.gmaps) : L2.waze);
  }
  if (has("ligar", "liga pro", "liga para", "chamar")) { if (!s || !digits(s.phone)) return speak("Essa parada não tem telefone."); return openUrl("tel:" + digits(s.phone)); }
  if (has("mensagem", "whatsapp", "zap", "avisar")) {
    if (!s || !digits(s.phone)) return speak("Essa parada não tem telefone.");
    const tel = digits(s.phone); const mins = Math.max(2, Math.round(hav(lastPoint(), s) / SPEED[st.settings.vehicle] * 60));
    const msg = st.settings.msg.replace("{nome}", (s.client || "").split(" ")[0] || "").replace("{min}", mins);
    speak("Abrindo o WhatsApp do cliente."); return openUrl(`https://wa.me/${tel.length <= 11 ? "55" + tel : tel}?text=${encodeURIComponent(msg)}`);
  }
  if (has("quanto ganhei", "ganho", "quanto fiz", "dinheiro", "meta")) {
    const pk = st.stops.filter(x => x.status === "delivered").reduce((a, x) => a + x.pk, 0);
    return speak(`Hoje: ${pk} pacotes entregues, cerca de ${Math.round(pk * curRate())} reais.${st.settings.goal ? ` Faltam ${Math.max(0, Math.round(st.settings.goal - pk * curRate()))} reais para a meta.` : ""}`);
  }
  if (has("quanto falta", "quantas faltam", "falta quanto", "andamento", "resumo")) {
    const p = pending(); const km = osrmKm ?? routeKm(p, lastPoint()); const mins = Math.round(p.length * st.settings.stopMin + km / SPEED[st.settings.vehicle] * 60);
    return speak(p.length ? `Faltam ${p.length} paradas, uns ${Math.round(km)} quilômetros, cerca de ${mins} minutos.` : "Não falta nenhuma. Rota concluída.");
  }
  if (has("proxima", "repet", "onde", "qual", "endereco")) return sayNext();
  if (has("comandos", "o que posso falar")) { helpSheet(); return speak("Estes são os comandos.", true); }
  if (/^(como|onde|o que|ajuda|duvida|qual)\b/.test(t)) { helpSheet2(raw); const r = helpSearch(raw)[0]; return speak(r ? r.a.replace(/<[^>]+>/g, "") : "Não achei. Veja os temas na tela.", true); }
  { const r = acharParadaFalada(alts); if (r.achou) return irParaParada(r.achou, true); if (r.opcoes && r.opcoes.length >= 2 && r.opcoes[0].pts >= 1.5) return escolherParadaSheet(r.opcoes, raw); }
  vb("Não entendi", `"${raw}". Toque em Ver comandos.`); speak("Não entendi. Tente: entregue, próxima, ir para rua tal, navegar ou ajuda.");
}
let rec = null, listening = false, handsFree = false, speaking = false, vbT;
function vb(title, text, keep) {
  const b = $("#vbubble"); $("#vbTitle").textContent = title; $("#vbText").textContent = text; b.hidden = false;
  clearTimeout(vbT); if (!keep && !handsFree) vbT = setTimeout(() => b.hidden = true, 5000);
}
function setHandsFree(on) {
  handsFree = on; $("#voiceFab").classList.toggle("hands", on);
  if (on) { try { navigator.wakeLock && navigator.wakeLock.request("screen").then(l => wakeLock = l).catch(() => {}); } catch (e) {} listen(); vb("Mãos livres ligado", "Fale os comandos sem tocar na tela.", true); }
  else { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; if (rec) try { rec.abort(); } catch (e) {} $("#vbubble").hidden = true; }
}
let wakeLock = null;
function listen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { vb("Voz indisponível", "Use o Chrome no Android ou o Edge/Chrome no Windows."); handsFree = false; return; }
  if (listening || speaking) return;
  rec = new SR(); rec.lang = "pt-BR"; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 5;
  let finalText = "", alts = [];
  rec.onstart = () => { listening = true; $("#voiceFab").classList.add("on"); vb("Ouvindo...", handsFree ? "Mãos livres: fale um comando" : "Diga um comando, por exemplo \"entregue\"", true); };
  rec.onresult = e => { const r = e.results[e.results.length - 1]; $("#vbText").textContent = `"${r[0].transcript}"`; if (r.isFinal) { finalText = r[0].transcript; alts = Array.from(r).map(x => x.transcript); } };
  rec.onerror = e => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { setHandsFree(false); vb("Microfone bloqueado", "Libere o microfone para o DeliveRota nas permissões do navegador."); } };
  rec.onend = () => {
    listening = false; $("#voiceFab").classList.remove("on");
    if (finalText) handleCommand(finalText, alts); else if (!handsFree) $("#vbubble").hidden = true;
    if (handsFree && !speaking) setTimeout(listen, 300);
  };
  try { rec.start(); } catch (e) { listening = false; }
}

/* ===================== entrada: arquivo de áudio (transcrição no aparelho) ===================== */
let asr = null;
async function decodeTo16k(file) {
  const buf = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const audio = await ctx.decodeAudioData(buf.slice(0)); ctx.close && ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(audio.duration * 16000), 16000);
  const src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0);
}
async function handleAudio(files) {
  const status = $("#audioStatus"); status.hidden = false; $("#audioForm").hidden = true;
  try {
    if (!asr) {
      status.textContent = "Preparando a transcrição (na primeira vez baixa uns 80 MB, depois funciona sem internet)...";
      const T = await import("https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2");
      T.env.allowLocalModels = false;
      asr = await T.pipeline("automatic-speech-recognition", "Xenova/whisper-base", {
        quantized: true, progress_callback: p => { if (p.status === "progress" && p.file && /onnx/.test(p.file)) status.textContent = `Baixando o reconhecedor de voz: ${Math.round(p.progress)}%`; }
      });
    }
    let text = "";
    for (let i = 0; i < files.length; i++) {
      status.textContent = `Ouvindo o áudio ${i + 1} de ${files.length}...`;
      let pcm;
      try { pcm = await decodeTo16k(files[i]); } catch (e) { throw new Error("Não consegui abrir esse formato de áudio. Tente .ogg, .opus, .m4a ou .mp3."); }
      const out = await asr(pcm, { language: "portuguese", task: "transcribe", chunk_length_s: 30, stride_length_s: 5 });
      text += (text ? "\n" : "") + (out.text || "").trim();
    }
    const spoken = text.replace(/\bnúmero\b/gi, ",").replace(/\bsem número\b/gi, "s/n").replace(/\bapartamento\b/gi, "apto").replace(/\.\s+/g, ".\n");
    $("#audioText").value = text; $("#audioForm").hidden = false;
    const found = extractAddresses(spoken);
    status.textContent = found.length ? "Transcrição pronta. Confira os endereços abaixo." : "Transcrevi o áudio, mas não achei rua e número. Corrija o texto e toque em Buscar.";
    showImport(found, "áudio");
  } catch (e) { status.textContent = e.message || "Não consegui transcrever o áudio. Verifique a internet na primeira vez."; }
}

/* ===================== arquivos recebidos pelo "Compartilhar" ===================== */
async function receiveShared() {
  try {
    const c = await caches.open("deliverota-share"); const keys = await c.keys(); if (!keys.length) return;
    const files = []; let text = "";
    for (const k of keys) {
      const r = await c.match(k); const name = decodeURIComponent(new URL(k.url).searchParams.get("n") || "arquivo");
      if (k.url.includes("/__share/text")) text += (await r.text()) + "\n";
      else files.push(new File([await r.blob()], name, { type: r.headers.get("content-type") || "" }));
      await c.delete(k);
    }
    go("add");
    const aud = files.filter(f => f.type.startsWith("audio/") || /\.(opus|ogg|oga|m4a|mp3|wav|aac)$/i.test(f.name));
    const img = files.filter(f => f.type.startsWith("image/"));
    const doc = files.filter(f => !aud.includes(f) && !img.includes(f));
    if (aud.length) { setMode("audio"); handleAudio(aud); }
    else if (img.length) { setMode("photo"); handleOcr(img); }
    else if (doc.length) { setMode("file"); handleDoc(doc[0]); }
    else if (text.trim()) { setMode("paste"); $("#pasteBox").value = text.trim(); showImport(extractAddresses(text), "compartilhado"); }
  } catch (e) {}
}

/* ===================== calendário anual de ganhos ===================== */
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const brOf = iso => iso.split("-").reverse().join("/");
function histIso(h) { if (h.iso) return h.iso; const m = String(h.date || "").match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : ""; }
function todayEntry() {
  const done = st.stops.filter(s => s.status === "delivered"), pk = done.reduce((a, s) => a + s.pk, 0);
  return { iso: isoOf(new Date()), date: new Date().toLocaleDateString("pt-BR"), done: done.length, fail: st.stops.filter(s => s.status === "failed").length, total: st.stops.length, pk,
    km: routeKm(st.stops.filter(hasGeo), st.start), earn: pk * curRate(), hours: dayHours(), platform: st.platform || "",
    plats: [{ pl: st.platform || "Sem plataforma", done: done.length, pk, km: routeKm(st.stops.filter(hasGeo), st.start), earn: pk * curRate(), hours: dayHours(), days: 1 }],
    items: st.stops.map((s, i) => ({ n: i + 1, a: addrLine(s), b: s.bairro, c: s.client, k: s.code, p: s.pk, st: s.status, r: s.reason, t: s.doneAt })) };
}
function dayTotals() {
  const m = {};
  const add = (iso, h, live) => { if (!iso) return; const x = m[iso] || (m[iso] = { iso, done: 0, fail: 0, pk: 0, km: 0, earn: 0, items: [], entries: [], live: false });
    x.hours = (x.hours || 0) + (h.hours || 0); x.plats = (x.plats || []).concat(h.plats || (h.platform ? [{ pl: h.platform, done: h.done, pk: h.pk, km: h.km, earn: h.earn, hours: h.hours || 0, days: 1 }] : [])); x.done += h.done || 0; x.fail += h.fail || 0; x.pk += h.pk || 0; x.km += h.km || 0; x.earn += h.earn || 0; if (h.items) x.items = x.items.concat(h.items); if (live) x.live = true; else x.entries.push(h); };
  st.history.forEach(h => add(histIso(h), h));
  if (st.stops.some(s => s.status !== "pending")) add(isoOf(new Date()), todayEntry(), true);
  return m;
}
let calYear = new Date().getFullYear(), calMonth = new Date().getMonth();
function renderYear() {
  const days = dayTotals(); const y = calYear; $("#yLabel").textContent = y;
  const inYear = Object.values(days).filter(d => d.iso.startsWith(y + "-"));
  const tot = inYear.reduce((a, d) => a + d.earn, 0), worked = inYear.filter(d => d.earn > 0 || d.done > 0).length;
  const best = inYear.reduce((b, d) => d.earn > (b ? b.earn : -1) ? d : b, null);
  $("#yKpis").innerHTML = `<div><b>R$ ${fmt(tot)}</b><span>no ano</span></div><div><b>${worked}</b><span>dias trabalhados</span></div><div><b>R$ ${fmt(worked ? tot / worked : 0)}</b><span>média por dia</span></div><div><b>${best ? brOf(best.iso).slice(0, 5) : "--"}</b><span>${best ? "melhor: R$ " + Math.round(best.earn) : "melhor dia"}</span></div>${st.settings.meiLimit > 0 ? `<div class="mei"><span>Limite do MEI usado no ano</span><div class="goal-bar"><i style="width:${Math.min(100, tot / st.settings.meiLimit * 100)}%"></i></div><b>${(tot / st.settings.meiLimit * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% de R$ ${fmt(st.settings.meiLimit)}</b></div>` : ""}`;
  const max = Math.max(1, ...inYear.map(d => d.earn));
  const todayIso = isoOf(new Date());
  $("#history").innerHTML = MESES.map((nm, mi) => {
    const first = new Date(y, mi, 1), nd = new Date(y, mi + 1, 0).getDate(), lead = (first.getDay() + 6) % 7;
    let mt = 0, cells = "";
    for (let i = 0; i < lead; i++) cells += `<span class="day blank"></span>`;
    for (let d = 1; d <= nd; d++) {
      const iso = `${y}-${String(mi + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`, x = days[iso];
      const lv = x && x.earn > 0 ? Math.min(4, Math.ceil(x.earn / max * 4)) : (x && x.done ? 1 : 0); if (x) mt += x.earn;
      cells += `<button class="day ${lv ? "l" + lv : ""}${iso === todayIso ? " today" : ""}" data-day="${iso}" title="${brOf(iso)}${x ? " · R$ " + fmt(x.earn) : ""}">${d}</button>`;
    }
    return `<div class="month${mi === calMonth ? " sel" : ""}"><div class="month-h" data-month="${mi}"><b>${nm}</b><span>${mt ? "R$ " + fmt(mt) : ""}</span></div>
      <div class="mgrid">${["S", "T", "Q", "Q", "S", "S", "D"].map(w => `<i>${w}</i>`).join("")}${cells}</div></div>`;
  }).join("");
}
function daySheet(iso) {
  const x = dayTotals()[iso];
  const manual = x && x.entries.find(e => e.manual);
  sheet(`<h3>${new Date(iso + "T12:00").toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</h3>
    ${x ? `<div class="kpis"><div class="kpi hero"><span>Ganho do dia</span><b>R$ ${fmt(x.earn)}</b><span>${x.live ? "Dia em andamento" : ""}</span></div>
      <div class="kpi"><span>Entregues</span><b>${x.done}</b></div><div class="kpi"><span>Com problema</span><b>${x.fail}</b></div>
      <div class="kpi"><span>Pacotes</span><b>${x.pk}</b></div><div class="kpi"><span>Km</span><b>${km1(x.km)}</b></div><div class="kpi"><span>Gasolina</span><b>R$ ${fmt(fuelOf(x.km))}</b></div><div class="kpi"><span>Lucro</span><b>R$ ${fmt(x.earn - fuelOf(x.km))}</b></div></div>
      ${x.items.length ? `<h3 class="sub-h">Entregas</h3>${x.items.map(it => `<div class="hist"><span>${it.n}. ${esc(it.a)}</span><b style="color:${it.st === "delivered" ? "var(--green-strong)" : it.st === "failed" ? "var(--red)" : "var(--muted)"}">${it.st === "delivered" ? "Entregue" : it.st === "failed" ? esc(it.r || "Problema") : "Pendente"}</b></div>`).join("")}` : ""}`
      : `<p class="sub">Nenhum registro neste dia.</p>`}
    ${x && (x.live || x.entries.some(e => !e.manual)) ? "" : `<h3 class="sub-h">${manual ? "Corrigir lançamento" : "Lançar dia manualmente"}</h3>
      <div class="grid2"><div class="field"><label for="mDone">Entregas feitas</label><input id="mDone" type="number" min="0" value="${manual ? manual.done : ""}"></div>
      <div class="field"><label for="mPk">Pacotes</label><input id="mPk" type="number" min="0" value="${manual ? manual.pk : ""}"></div></div>
      <div class="grid2"><div class="field"><label for="mEarn">Quanto ganhou (R$)</label><input id="mEarn" type="number" step="0.01" min="0" value="${manual ? manual.earn : ""}"></div>
      <div class="field"><label for="mKm">Km rodados</label><input id="mKm" type="number" step="0.1" min="0" value="${manual ? manual.km : ""}"></div></div>
      <p class="hint">Se deixar o ganho em branco, o app calcula pelos pacotes × R$ ${fmt(curRate())}.</p>`}
    <div class="row">${manual ? `<button class="btn warn" id="mDel">Apagar lançamento</button>` : ""}<button class="btn ghost" data-close>Fechar</button>${x && (x.live || x.entries.some(e => !e.manual)) ? "" : `<button class="btn primary" id="mSave">Salvar</button>`}</div>`, () => {
    const sv = $("#mSave"); if (sv) sv.addEventListener("click", () => {
      const pk = Math.max(0, +$("#mPk").value || 0), done = Math.max(0, +$("#mDone").value || 0);
      const earn = $("#mEarn").value !== "" ? Math.max(0, parseFloat($("#mEarn").value) || 0) : pk * curRate();
      if (manual) st.history.splice(st.history.indexOf(manual), 1);
      st.history.push({ iso, date: brOf(iso), manual: true, done, pk: pk || done, earn, km: Math.max(0, parseFloat($("#mKm").value) || 0), fail: 0, items: [] });
      save(); closeSheet(); renderYear(); toast("Dia salvo no calendário");
    });
    const dl = $("#mDel"); if (dl) dl.addEventListener("click", e => twoTap(e.currentTarget, "Toque de novo para apagar", () => { st.history.splice(st.history.indexOf(manual), 1); save(); closeSheet(); renderYear(); toast("Lançamento apagado"); }));
  });
}
const KML_DEFAULT = { moto: 35, carro: 11, bike: 0, pe: 0 };
const kml = () => st.settings.kml || KML_DEFAULT[st.settings.vehicle] || 0;
const fuelOf = km => kml() ? km / kml() * st.settings.fuelPrice : 0;
let perKind = "week";
function rangeOf(kind, ref = new Date()) {
  const y = ref.getFullYear(), m = ref.getMonth(), d = ref.getDate();
  if (kind === "today" || kind === "day") return { from: isoOf(ref), to: isoOf(ref), label: brOf(isoOf(ref)), slug: isoOf(ref) };
  if (kind === "week") { const wd = (ref.getDay() + 6) % 7; const f = new Date(y, m, d - wd), t = new Date(y, m, d - wd + 6); return { from: isoOf(f), to: isoOf(t), label: `semana de ${brOf(isoOf(f)).slice(0, 5)} a ${brOf(isoOf(t)).slice(0, 5)}`, slug: "semana-" + isoOf(f) }; }
  if (kind === "month") { const f = new Date(y, m, 1), t = new Date(y, m + 1, 0); return { from: isoOf(f), to: isoOf(t), label: `${MESES[m]} de ${y}`, slug: `${MESES[m]}-${y}` }; }
  if (kind === "year") return { from: `${y}-01-01`, to: `${y}-12-31`, label: `ano de ${y}`, slug: "ano-" + y };
  const f = $("#perFrom").value || isoOf(ref), t = $("#perTo").value || f;
  return { from: f < t ? f : t, to: f < t ? t : f, label: `${brOf(f < t ? f : t)} a ${brOf(f < t ? t : f)}`, slug: `${f}-a-${t}` };
}
function periodData(r) {
  const list = Object.values(dayTotals()).filter(d => d.iso >= r.from && d.iso <= r.to).sort((a, b) => a.iso < b.iso ? -1 : 1);
  const T = k => list.reduce((s, d) => s + d[k], 0);
  const km = T("km"), earn = T("earn"), c = costsOf(km, list.length), hours = list.reduce((a, d) => a + (d.hours || 0), 0);
  const gl = gastosDe(r.from, r.to), gComb = totalGastos(gl.filter(g => g.cat === "combustivel")), gOutros = totalGastos(gl.filter(g => g.cat !== "combustivel"));
  const fuel = gComb > 0 ? gComb : c.fuel, cost = fuel + c.wear + c.fixed + gOutros;
  return { r, list, days: list.length, done: T("done"), fail: T("fail"), pk: T("pk"), km, earn, fuel, fuelReal: gComb > 0, wear: c.wear, fixed: c.fixed, gastos: gl, gOutros, cost, hours, net: earn - cost };
}
function periodText(p) {
  let t = `DeliveRota · Relatório ${p.r.label}\nDias trabalhados: ${p.days}\nEntregas: ${p.done} (${p.pk} pacotes)${p.fail ? `\nNão entregues: ${p.fail}` : ""}\nKm rodados (estimado): ${km1(p.km)}\nGanho: R$ ${fmt(p.earn)}`;
  t += `\nGasolina${p.fuelReal ? " (notas lançadas)" : ""}: R$ ${fmt(p.fuel)}${p.gOutros ? `\nOutros gastos lançados: R$ ${fmt(p.gOutros)}` : ""}\nDesgaste do veículo: R$ ${fmt(p.wear)}${p.fixed ? `\nCustos fixos: R$ ${fmt(p.fixed)}` : ""}\nLucro real: R$ ${fmt(p.net)}${p.km ? `\nCusto por km: R$ ${fmt(p.cost / p.km)}` : ""}${p.hours ? `\nLucro por hora: R$ ${fmt(p.net / p.hours)}` : ""}`;
  if (p.list.length > 1 && p.list.length <= 31) t += "\n\nPor dia:\n" + p.list.map(d => `${brOf(d.iso).slice(0, 5)}: ${d.done} entregas · R$ ${fmt(d.earn)}${kml() ? ` · gas. R$ ${fmt(fuelOf(d.km))}` : ""}`).join("\n");
  return t;
}
function renderPeriod() {
  $$("#perSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.per === perKind));
  $("#perCustom").hidden = perKind !== "custom";
  const ref = perKind === "month" ? new Date(calYear, calMonth, 15) : perKind === "year" ? new Date(calYear, 5, 1) : new Date();
  const p = periodData(rangeOf(perKind, ref));
  $("#perSum").innerHTML = `<p class="sub" style="margin:0 0 6px">${esc(p.r.label.charAt(0).toUpperCase() + p.r.label.slice(1))} · ${p.days} ${p.days === 1 ? "dia trabalhado" : "dias trabalhados"}</p><div class="persum">
    <div><b>${p.done}</b><span>entregas</span></div><div><b>${km1(p.km)}</b><span>km</span></div><div><b>R$ ${fmt(p.earn)}</b><span>ganho</span></div>
    <div class="fuel"><b>R$ ${fmt(p.fuel)}</b><span>gasolina</span></div><div class="fuel"><b>R$ ${fmt(p.wear + p.fixed)}</b><span>desgaste e fixos</span></div><div><b>R$ ${fmt(p.km ? p.cost / p.km : 0)}</b><span>custo por km</span></div>
    <div class="net"><b>R$ ${fmt(p.net)}</b><span>lucro real (ganho − todos os custos) · R$ ${fmt(p.days ? p.net / p.days : 0)} por dia${p.hours ? " · R$ " + fmt(p.net / p.hours) + " por hora" : ""}</span></div></div>`;
  renderPlatCompare(p); renderCharts(p);
  return p;
}
async function periodFile(p) {
  const resumo = p.list.map(d => ({ Data: brOf(d.iso), "Dia da semana": new Date(d.iso + "T12:00").toLocaleDateString("pt-BR", { weekday: "long" }), Entregas: d.done, "Com problema": d.fail, Pacotes: d.pk, Km: +d.km.toFixed(1), "Ganho (R$)": +d.earn.toFixed(2), "Gasolina (R$)": +fuelOf(d.km).toFixed(2), "Desgaste+fixos (R$)": +(costsOf(d.km, 1).wear + costsOf(d.km, 1).fixed).toFixed(2), "Lucro (R$)": +(d.earn - costsOf(d.km, 1).total).toFixed(2) }));
  resumo.push({ Data: "TOTAL", "Dia da semana": `${p.days} dias`, Entregas: p.done, "Com problema": p.fail, Pacotes: p.pk, Km: +p.km.toFixed(1), "Ganho (R$)": +p.earn.toFixed(2), "Gasolina (R$)": +p.fuel.toFixed(2), "Desgaste+fixos (R$)": +(p.wear + p.fixed).toFixed(2), "Lucro (R$)": +p.net.toFixed(2) });
  const entregas = []; p.list.forEach(d => d.items.forEach(it => entregas.push({ Data: brOf(d.iso), "Nº": it.n, Endereço: it.a, Bairro: it.b || "", Cliente: it.c || "", Código: it.k || "", Pacotes: it.p, Situação: it.st === "delivered" ? "Entregue" : it.st === "failed" ? "Não entregue" : "Pendente", Motivo: it.r || "", Horário: it.t ? new Date(it.t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "" })));
  const name = `DeliveRota-${p.r.slug}`;
  try {
    await loadScript(LIBS.xlsx); const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(resumo); ws["!cols"] = [{ wch: 12 }, { wch: 16 }, { wch: 10 }, { wch: 13 }, { wch: 9 }, { wch: 8 }, { wch: 12 }, { wch: 13 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, "Resumo por dia");
    if (entregas.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entregas), "Entregas");
    return new File([XLSX.write(wb, { bookType: "xlsx", type: "array" })], name + ".xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  } catch (e) {
    const keys = Object.keys(resumo[0]); const csv = [keys.join(";")].concat(resumo.map(r => keys.map(k => `"${String(r[k]).replace(/"/g, '""')}"`).join(";"))).join("\n");
    return new File(["\ufeff" + csv], name + ".csv", { type: "text/csv" });
  }
}
async function sendPeriod(p, via) {
  if (!p.days) { toast("Nenhum dia registrado nesse período"); return false; }
  const text = periodText(p);
  if (via === "xls") { download(await periodFile(p), (await periodFile(p)).name); toast("Planilha baixada"); return true; }
  const file = await periodFile(p);
  // celular: abre o "Compartilhar" com a planilha anexada (escolha WhatsApp ou Gmail)
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], text, title: "Relatório DeliveRota" }); return true; } catch (e) { if (e.name === "AbortError") return false; }
  }
  download(file, file.name);
  if (via === "mail") {
    const to = st.settings.repMail || "";
    openUrl(`mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent("Relatório DeliveRota - " + p.r.label)}&body=${encodeURIComponent(text + "\n\n(A planilha foi baixada no seu computador: anexe o arquivo " + file.name + ")")}`);
  } else {
    const tel = digits(st.settings.repWa); const num = tel ? (tel.length <= 11 ? "55" + tel : tel) : "";
    openUrl(`https://wa.me/${num}?text=${encodeURIComponent(text)}`);
  }
  toast("Planilha baixada. Anexe ela na mensagem se quiser.", 4500);
  return true;
}
/* relatório automático: avisa quando o período fechou */
function dueReport() {
  const k = st.settings.autoRep; if (!k || k === "none") return null;
  const now = new Date(); let ref;
  if (k === "day") ref = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (k === "week") ref = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  if (k === "month") ref = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  const r = rangeOf(k, ref); const key = k + ":" + r.from;
  if ((st.sentReports || []).includes(key)) return null;
  const p = periodData(r); if (!p.days) return null;
  return { key, p, kind: k };
}
function renderDue() {
  const d = dueReport(), box = $("#dueBox"); if (!box) return;
  if (!d) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="due"><div><b>Relatório pronto:</b> ${esc(d.p.r.label)}<br><span class="sub">R$ ${fmt(d.p.earn)} de ganho · ${d.p.done} entregas</span></div>
    <div class="row">${st.settings.repMail ? `<button class="btn ghost sm" data-due="mail">E-mail</button>` : ""}<button class="btn primary sm" data-due="wa">Enviar</button><button class="btn ghost sm" data-due="skip">Dispensar</button></div></div>`;
}
async function handleDue(via) {
  const d = dueReport(); if (!d) return;
  const ok = via === "skip" ? true : await sendPeriod(d.p, via);
  if (ok) { st.sentReports = (st.sentReports || []).concat(d.key).slice(-60); save(); renderDue(); }
}
async function exportPeriod(kind) {
  const now = new Date(); let from, to, label;
  if (kind === "week") { const d = new Date(now); const wd = (d.getDay() + 6) % 7; from = new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd); to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 6); label = `semana-${isoOf(from)}`; }
  else if (kind === "month") { from = new Date(calYear, calMonth, 1); to = new Date(calYear, calMonth + 1, 0); label = `${MESES[calMonth]}-${calYear}`; }
  else { from = new Date(calYear, 0, 1); to = new Date(calYear, 11, 31); label = `ano-${calYear}`; }
  const a = isoOf(from), b = isoOf(to), days = dayTotals();
  const list = Object.values(days).filter(d => d.iso >= a && d.iso <= b).sort((x, y) => x.iso < y.iso ? -1 : 1);
  if (!list.length) { toast("Nenhum dia registrado nesse período"); return; }
  const resumo = list.map(d => ({ Data: brOf(d.iso), "Dia da semana": new Date(d.iso + "T12:00").toLocaleDateString("pt-BR", { weekday: "long" }), Entregas: d.done, "Com problema": d.fail, Pacotes: d.pk, Km: +d.km.toFixed(1), "Ganho (R$)": +d.earn.toFixed(2) }));
  const T = k => list.reduce((s, d) => s + d[k], 0);
  resumo.push({ Data: "TOTAL", "Dia da semana": `${list.length} dias`, Entregas: T("done"), "Com problema": T("fail"), Pacotes: T("pk"), Km: +T("km").toFixed(1), "Ganho (R$)": +T("earn").toFixed(2) });
  const entregas = []; list.forEach(d => d.items.forEach(it => entregas.push({ Data: brOf(d.iso), "Nº": it.n, Endereço: it.a, Bairro: it.b || "", Cliente: it.c || "", Código: it.k || "", Pacotes: it.p, Situação: it.st === "delivered" ? "Entregue" : it.st === "failed" ? "Não entregue" : "Pendente", Motivo: it.r || "", Horário: it.t ? new Date(it.t).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "" })));
  const name = `DeliveRota-${label}`;
  try {
    await loadScript(LIBS.xlsx); const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(resumo); ws["!cols"] = [{ wch: 12 }, { wch: 16 }, { wch: 10 }, { wch: 13 }, { wch: 9 }, { wch: 8 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, "Resumo por dia");
    if (entregas.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entregas), "Entregas");
    download(new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), name + ".xlsx");
  } catch (e) {
    const keys = Object.keys(resumo[0]); const csv = [keys.join(";")].concat(resumo.map(r => keys.map(k => `"${String(r[k]).replace(/"/g, '""')}"`).join(";"))).join("\n");
    download(new Blob(["\ufeff" + csv], { type: "text/csv" }), name + ".csv");
  }
  toast("Planilha baixada");
}

/* ===================== login (e-mail e senha) ===================== */
const FB = window.DELIVEROTA_FIREBASE || null;
const ADMINS = (window.DELIVEROTA_ADMINS || ["delivefoodconsultoria@gmail.com"]).map(e => e.toLowerCase());
let user = null, fbAuth = null, authMode = "login", pendingTemp = null;
const isAdmin = () => user && ADMINS.includes((user.email || "").toLowerCase());
function tempPassword() { const c = "abcdefghjkmnpqrstuvwxyz23456789"; let s = ""; const r = crypto.getRandomValues(new Uint32Array(8)); r.forEach(x => s += c[x % c.length]); return s.slice(0, 4) + "-" + s.slice(4); }
async function sha(txt) {
  try { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(txt)); return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join(""); }
  catch (e) { let h = 5381; for (const ch of txt) h = ((h << 5) + h + ch.charCodeAt(0)) | 0; return "f" + (h >>> 0).toString(16); }
}
const FB_ERR = { "auth/invalid-email": "E-mail inválido.", "auth/user-not-found": "E-mail ou senha incorretos.", "auth/wrong-password": "E-mail ou senha incorretos.", "auth/invalid-credential": "E-mail ou senha incorretos.",
  "auth/invalid-login-credentials": "E-mail ou senha incorretos.", "auth/email-already-in-use": "Já existe uma conta com este e-mail. Use Entrar ou Esqueci minha senha.", "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
  "auth/too-many-requests": "Muitas tentativas. Espere alguns minutos e tente de novo.", "auth/network-request-failed": "Sem internet. Conecte e tente de novo.", "auth/requires-recent-login": "Por segurança, saia e entre de novo para trocar a senha." };
const errMsg = e => FB_ERR[e && e.code] || (e && e.message) || "Não foi possível concluir. Tente de novo.";

/* --- modo teste: contas guardadas só neste aparelho --- */
async function localAccounts() { return (await dbGet("kv", "accounts")) || {}; }
async function localCreate(name, email, pass, mustChange) {
  const acc = await localAccounts(); const k = email.toLowerCase();
  if (acc[k]) throw { code: "auth/email-already-in-use" };
  const salt = uid() + uid(); acc[k] = { uid: "u" + uid() + uid(), name, email, salt, hash: await sha(salt + pass), mustChange: !!mustChange, createdAt: Date.now() };
  await dbSet("kv", "accounts", acc); return acc[k];
}
async function localLogin(email, pass) {
  const acc = await localAccounts(); const a = acc[email.toLowerCase()];
  if (!a || a.hash !== await sha(a.salt + pass)) throw { code: "auth/invalid-credential" };
  return a;
}
async function localSetPass(email, pass) { const acc = await localAccounts(); const a = acc[email.toLowerCase()]; a.salt = uid() + uid(); a.hash = await sha(a.salt + pass); a.mustChange = false; await dbSet("kv", "accounts", acc); return a; }
function setSession(a, remember) {
  const v = JSON.stringify({ uid: a.uid, email: a.email, name: a.name });
  try { localStorage.removeItem("deliverota-sess"); sessionStorage.removeItem("deliverota-sess"); (remember ? localStorage : sessionStorage).setItem("deliverota-sess", v); } catch (e) {}
}
function getSession() { try { return JSON.parse(localStorage.getItem("deliverota-sess") || sessionStorage.getItem("deliverota-sess") || "null"); } catch (e) { return null; } }

/* --- Firebase (login de verdade, mesma conta em qualquer aparelho) --- */
async function fbInit() {
  await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
  await loadScript("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js");
  if (!firebase.apps.length) firebase.initializeApp(FB);
  fbAuth = firebase.auth(); fbAuth.languageCode = "pt";
  return new Promise(ok => { const off = fbAuth.onAuthStateChanged(u => { off(); ok(u); }); });
}
const fbUser = u => ({ uid: u.uid, email: u.email, name: (u.displayName || "").replace(/\|TEMP$/, "") || u.email.split("@")[0], mustChange: /\|TEMP$/.test(u.displayName || "") });
async function fbCreateWithTemp(name, email) {
  // cria a conta com senha provisória numa instância separada, sem deslogar quem está usando
  const tmp = tempPassword(); const app2 = firebase.apps.find(a => a.name === "cadastro") || firebase.initializeApp(FB, "cadastro");
  const cred = await app2.auth().createUserWithEmailAndPassword(email, tmp);
  await cred.user.updateProfile({ displayName: name + "|TEMP" }); await app2.auth().signOut();
  return tmp;
}

/* --- tela --- */
function authView(mode, msg, ok) {
  authMode = mode; const T = { login: "Entrar", signup: "Criar conta", forgot: "Recuperar senha", newpass: "Crie sua senha" };
  $("#authTitle").textContent = T[mode];
  $("#fName").hidden = mode !== "signup";
  $("#fPass").hidden = mode === "signup" || mode === "forgot";
  $("#fPass2").hidden = true;
  $("#fRemember").hidden = mode !== "login";
  $("#aEmail").closest(".field").hidden = mode === "newpass";
  $("#aPass").autocomplete = mode === "newpass" ? "new-password" : "current-password";
  $("label[for=aPass]").textContent = mode === "newpass" ? "Sua senha (mínimo 6 letras ou números)" : "Senha";
  $("#authGo").textContent = { login: "Entrar", signup: "Receber senha provisória", forgot: "Enviar link por e-mail", newpass: "Salvar senha e entrar" }[mode];
  $("#authForgot").hidden = mode !== "login";
  $("#authSwitch").textContent = mode === "login" ? "Primeiro acesso? Criar conta" : "Voltar para Entrar";
  $("#authSwitch").hidden = mode === "newpass";
  const e = $("#authErr"); e.hidden = !msg; e.innerHTML = msg || ""; e.classList.toggle("ok", !!ok);
  // na tela de criar senha o aviso fica em cima do campo; nas outras, perto do botão
  if (mode === "newpass") $("#authTitle").after(e); else $("#authGo").before(e);
  $("#authMode").textContent = FB ? "" : "Modo teste: as contas ficam guardadas só neste aparelho.";
  if (mode === "newpass") { $("#aPass").value = ""; $("#aPass2").value = ""; setTimeout(() => $("#aPass").focus(), 50); }
}
function authInit() {
  return new Promise(async done => {
    const finish = u => { user = u; $("#auth").hidden = true; done(u); };
    window.__authDone = finish;
    if (FB) {
      try { const u = await fbInit(); if (u) { const fu = fbUser(u); if (!fu.mustChange) return finish(fu); user = fu; $("#auth").hidden = false; return authView("newpass", "Falta só um passo: crie a sua senha para entrar.", true); } }
      catch (e) { $("#auth").hidden = false; return authView("login", "Não consegui conectar ao login. Verifique a internet."); }
    } else {
      const s = getSession(); if (s) { const acc = await localAccounts(); const a = acc[(s.email || "").toLowerCase()]; if (a && !a.mustChange) return finish({ uid: a.uid, email: a.email, name: a.name }); }
    }
    $("#auth").hidden = false; authView("login");
    const last = (() => { try { return localStorage.getItem("deliverota-last-email"); } catch (e) { return ""; } })(); if (last) $("#aEmail").value = last;
  });
}
async function authSubmit(e) {
  e.preventDefault();
  const email = $("#aEmail").value.trim(), pass = $("#aPass").value, name = $("#aName").value.trim(), remember = $("#aRemember").checked;
  const go = $("#authGo"); go.disabled = true;
  try {
    if (authMode !== "newpass" && !/^\S+@\S+\.\S+$/.test(email)) throw { code: "auth/invalid-email" };
    if (authMode === "login") {
      try { localStorage.setItem("deliverota-last-email", email); } catch (x) {}
      if (FB) {
        await fbAuth.setPersistence(remember ? firebase.auth.Auth.Persistence.LOCAL : firebase.auth.Auth.Persistence.SESSION);
        const c = await fbAuth.signInWithEmailAndPassword(email, pass); const fu = fbUser(c.user);
        if (fu.mustChange) { user = fu; return authView("newpass", "Falta só um passo: crie a sua senha para entrar.", true); }
        return window.__authDone(fu);
      }
      const a = await localLogin(email, pass); pendingTemp = { a, remember };
      if (a.mustChange) return authView("newpass", "Falta só um passo: crie a sua senha para entrar.", true);
      setSession(a, remember); return window.__authDone({ uid: a.uid, email: a.email, name: a.name });
    }
    if (authMode === "signup") {
      if (name.length < 2) throw { message: "Digite seu nome." };
      if (FB) {
        await fbCreateWithTemp(name, email); await fbAuth.sendPasswordResetEmail(email);
        $("#aPass").value = ""; return authView("login", `Conta criada! Enviamos para <b>${esc(email)}</b> um e-mail para você criar sua senha. Depois é só entrar aqui.`, true);
      }
      const tmp = tempPassword(); const a = await localCreate(name, email, tmp, true);
      pendingTemp = { a, remember: true }; try { localStorage.setItem("deliverota-last-email", email); } catch (x) {}
      return authView("newpass", `Conta criada, ${esc(name.split(" ")[0])}! Agora é só criar a sua senha.`, true);
    }
    if (authMode === "forgot") {
      if (FB) { await fbAuth.sendPasswordResetEmail(email); return authView("login", `Se existir uma conta com <b>${esc(email)}</b>, você vai receber um e-mail com o link para criar uma senha nova. Veja também o spam.`, true); }
      const acc = await localAccounts(); const a = acc[email.toLowerCase()];
      if (!a) throw { code: "auth/user-not-found" };
      const tmp = tempPassword(); await localSetPass(email, tmp); a.mustChange = true; const acc2 = await localAccounts(); acc2[email.toLowerCase()].mustChange = true; await dbSet("kv", "accounts", acc2);
      return authView("login", `Senha provisória nova: <b style="font-family:var(--mono);font-size:18px">${tmp}</b><br>Entre com ela para criar a senha definitiva.<br><small>No app publicado, isso chega por e-mail.</small>`, true);
    }
    if (authMode === "newpass") {
      const p1 = $("#aPass").value;
      if (p1.length < 6) throw { code: "auth/weak-password" };
      if (FB) { const u = fbAuth.currentUser; await u.updatePassword(p1); await u.updateProfile({ displayName: user.name }); return window.__authDone({ ...user, mustChange: false }); }
      const a = await localSetPass(pendingTemp.a.email, p1); setSession(a, pendingTemp.remember);
      return window.__authDone({ uid: a.uid, email: a.email, name: a.name });
    }
  } catch (x) { authView(authMode, esc(errMsg(x))); }
  finally { go.disabled = false; }
}
async function logout() {
  await dbSet("kv", "state:" + user.uid, st);
  try { localStorage.removeItem("deliverota-sess"); sessionStorage.removeItem("deliverota-sess"); } catch (e) {}
  if (fbAuth) try { await fbAuth.signOut(); } catch (e) {}
  location.reload();
}
async function changePassword() {
  if (FB) { await fbAuth.sendPasswordResetEmail(user.email); toast("Enviamos um link para " + user.email + " criar a senha nova", 5000); return; }
  sheet(`<h3>Trocar senha</h3>
    <div class="field"><label for="cpOld">Senha atual</label><input id="cpOld" type="password" autocomplete="current-password"></div>
    <div class="field"><label for="cpNew">Nova senha</label><input id="cpNew" type="password" autocomplete="new-password"></div>
    <div class="field"><label for="cpNew2">Repita a nova senha</label><input id="cpNew2" type="password" autocomplete="new-password"></div>
    <p class="auth-err" id="cpErr" hidden></p>
    <div class="row"><button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="cpGo">Salvar</button></div>`, () => {
    $("#cpGo").addEventListener("click", async () => {
      const er = $("#cpErr");
      try { await localLogin(user.email, $("#cpOld").value); if ($("#cpNew").value.length < 6) throw { code: "auth/weak-password" }; if ($("#cpNew").value !== $("#cpNew2").value) throw { message: "As duas senhas não são iguais." };
        await localSetPass(user.email, $("#cpNew").value); closeSheet(); toast("Senha trocada"); }
      catch (x) { er.hidden = false; er.textContent = errMsg(x); }
    });
  });
}
function adminSheet() {
  sheet(`<h3>Cadastrar entregador</h3><p class="sub">O entregador recebe uma senha provisória e cria a senha definitiva no primeiro acesso.</p>
    <div class="field" style="margin-top:12px"><label for="adName">Nome</label><input id="adName"></div>
    <div class="field"><label for="adEmail">E-mail</label><input id="adEmail" type="email"></div>
    <div class="field"><label for="adWa">WhatsApp (opcional, para enviar o acesso)</label><input id="adWa" inputmode="tel" placeholder="(31) 99999-0000"></div>
    <p class="auth-err" id="adErr" hidden></p><div id="adOut"></div>
    <div class="row"><button class="btn ghost" data-close>Fechar</button><button class="btn primary" id="adGo">Gerar acesso</button></div>`, () => {
    $("#adGo").addEventListener("click", async () => {
      const name = $("#adName").value.trim(), email = $("#adEmail").value.trim(), er = $("#adErr"); er.hidden = true;
      try {
        if (name.length < 2) throw { message: "Digite o nome." }; if (!/^\S+@\S+\.\S+$/.test(email)) throw { code: "auth/invalid-email" };
        let tmp; if (FB) tmp = await fbCreateWithTemp(name, email); else { tmp = tempPassword(); await localCreate(name, email, tmp, true); }
        const msg = `Olá ${name.split(" ")[0]}! Seu acesso ao DeliveRota:\nE-mail: ${email}\nSenha provisória: ${tmp}\nNo primeiro acesso você cria a sua senha definitiva.\nLink: ${location.origin + location.pathname}`;
        const tel = digits($("#adWa").value);
        $("#adOut").innerHTML = `<div class="note" style="flex-direction:column"><b>Acesso criado</b><span>Senha provisória: <b style="font-family:var(--mono);font-size:18px">${tmp}</b></span></div>
          <div class="row wrap" style="margin-bottom:10px"><a class="btn primary" target="_blank" rel="noopener" href="https://wa.me/${tel ? (tel.length <= 11 ? "55" + tel : tel) : ""}?text=${encodeURIComponent(msg)}">Enviar no WhatsApp</a>
          <a class="btn ghost" href="mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent("Seu acesso ao DeliveRota")}&body=${encodeURIComponent(msg)}">Enviar por e-mail</a></div>`;
        $("#adGo").textContent = "Cadastrar outro"; $("#adName").value = ""; $("#adEmail").value = ""; $("#adWa").value = "";
      } catch (x) { er.hidden = false; er.textContent = errMsg(x); }
    });
  });
}

/* ===================== plataformas, custos, metas, manutenção ===================== */
const PLATS = ["Mercado Livre", "Shopee", "Amazon", "Correios", "Loggi", "J&T", "Magalu", "iFood", "Particular", "Outra"];
const rateFor = pl => { const r = (st.settings.platRates || {})[pl]; return r > 0 ? r : st.settings.rate; };
const curRate = () => rateFor(st.platform || "");
const OTHER_KM_DEFAULT = { moto: 0.12, carro: 0.25, bike: 0.02, pe: 0 };
const otherKm = () => st.settings.otherKm ?? OTHER_KM_DEFAULT[st.settings.vehicle] ?? 0;
const fixedDay = () => (st.settings.fixedMonth || 0) / Math.max(1, st.settings.workDays || 26);
function costsOf(km, days) { const fuel = fuelOf(km), wear = km * otherKm(), fixed = days * fixedDay(); return { fuel, wear, fixed, total: fuel + wear + fixed }; }
function dayHours() {
  const t = st.stops.map(s => s.doneAt).filter(Boolean); if (!t.length) return 0;
  const start = Math.min(st.dayStart || Infinity, ...t), end = Math.max(...t);
  return Math.max(0, (end - start) / 3.6e6);
}
function markStart() { if (!st.dayStart || isoOf(new Date(st.dayStart)) !== isoOf(new Date())) st.dayStart = Date.now(); }
/* meta */
function renderGoal() {
  const box = $("#goalBox"); if (!box) return;
  const g = st.settings.goal || 0;
  if (!g) { box.innerHTML = `<button class="goal-set" data-act="goal">Definir meta do dia</button>`; return; }
  const pk = st.stops.filter(s => s.status === "delivered").reduce((a, s) => a + s.pk, 0), earn = pk * curRate();
  const left = Math.max(0, g - earn), pkLeft = curRate() ? Math.ceil(left / curRate()) : 0, pct = Math.min(100, earn / g * 100);
  box.innerHTML = `<div class="goal" data-act="goal"><div class="goal-t"><span>Meta R$ ${Math.round(g)}</span><b>${left ? `faltam R$ ${Math.round(left)} · ~${pkLeft} pct` : "Meta batida!"}</b></div><div class="goal-bar"><i style="width:${pct}%"></i></div></div>`;
}
function goalSheet() {
  sheet(`<h3>Meta do dia</h3><p class="sub">Quanto você quer fazer por dia? O app mostra quanto falta e quantos pacotes ainda precisa.</p>
    <div class="field" style="margin-top:12px"><label for="glVal">Meta (R$)</label><input id="glVal" type="number" step="10" min="0" value="${st.settings.goal || ""}" placeholder="Ex.: 200"></div>
    <div class="row"><button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="glGo">Salvar meta</button></div>`, () => {
    $("#glGo").addEventListener("click", () => { st.settings.goal = Math.max(0, parseFloat($("#glVal").value) || 0); save(); closeSheet(); renderGoal(); toast("Meta salva"); });
  });
}
/* plataforma do dia */
function renderPlat() { const sel = $("#platSel"); if (!sel) return; sel.innerHTML = `<option value="">Plataforma de hoje</option>` + PLATS.map(p => `<option ${st.platform === p ? "selected" : ""}>${p}</option>`).join(""); }
/* manutenção */
const MAINT_DEFAULT = {
  moto: [["Troca de óleo", 1000], ["Relação (corrente, coroa e pinhão)", 15000], ["Pneus", 12000], ["Revisão geral", 6000]],
  carro: [["Troca de óleo", 5000], ["Pneus", 40000], ["Pastilhas de freio", 20000], ["Revisão geral", 10000]],
  bike: [["Revisão da bike", 1500], ["Pneus/câmaras", 3000]], pe: []
};
const appKmTotal = () => st.history.reduce((a, h) => a + (h.km || 0), 0) + routeKm(st.stops.filter(s => hasGeo(s) && s.status !== "pending"), st.start);
const odometer = () => Math.round((st.settings.odo || 0) + appKmTotal() - (st.settings.odoAt || 0));
function maintItems() {
  if (!st.settings.maint || !st.settings.maint.length || st.settings.maintVeh !== st.settings.vehicle) {
    st.settings.maint = (MAINT_DEFAULT[st.settings.vehicle] || []).map(([name, every]) => ({ id: uid(), name, every, last: odometer() }));
    st.settings.maintVeh = st.settings.vehicle;
  }
  return st.settings.maint.map(m => { const used = odometer() - m.last; return { ...m, used, left: m.every - used, pct: Math.min(100, Math.max(0, used / m.every * 100)) }; });
}
function renderMaint() {
  const box = $("#maintBox"); if (!box) return;
  const items = maintItems();
  box.innerHTML = `<div class="sec-h"><h2 class="sec">Manutenção do veículo</h2><button class="btn ghost sm" data-act="odo">Hodômetro: ${odometer().toLocaleString("pt-BR")} km</button></div>
    ${items.length ? items.map(m => `<div class="mt ${m.pct >= 100 ? "late" : m.pct >= 85 ? "soon" : ""}"><div class="mt-h"><b>${esc(m.name)}</b><span>${m.left > 0 ? `faltam ${Math.round(m.left).toLocaleString("pt-BR")} km` : `passou ${Math.round(-m.left).toLocaleString("pt-BR")} km`}</span></div>
      <div class="goal-bar"><i style="width:${m.pct}%"></i></div><div class="mt-f"><span>a cada ${m.every.toLocaleString("pt-BR")} km</span><button class="btn ghost sm" data-maint="${m.id}">Fiz agora</button></div></div>`).join("") : `<p class="sub">A pé não tem manutenção para controlar.</p>`}
    <p class="hint">Os km contam pelas rotas feitas no app. Ajuste o hodômetro de vez em quando para ficar exato.</p>`;
  const due = items.filter(m => m.pct >= 90);
  const ban = $("#maintBanner"); if (ban) ban.innerHTML = due.length ? `<div class="alert" data-go="resumo"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/></svg><span><b>${esc(due[0].name)}</b> ${due[0].left > 0 ? "em " + Math.round(due[0].left) + " km" : "atrasada"}${due.length > 1 ? ` e mais ${due.length - 1}` : ""}</span></div>` : "";
}
function odoSheet() {
  sheet(`<h3>Hodômetro</h3><p class="sub">Quantos km o painel do veículo marca agora?</p>
    <div class="field" style="margin-top:12px"><label for="odVal">Km no painel</label><input id="odVal" type="number" min="0" value="${odometer()}"></div>
    <div class="row"><button class="btn ghost" data-close>Cancelar</button><button class="btn primary" id="odGo">Salvar</button></div>`, () => {
    $("#odGo").addEventListener("click", () => {
      const v = Math.max(0, parseFloat($("#odVal").value) || 0); const diff = v - odometer();
      st.settings.odo = v; st.settings.odoAt = appKmTotal();
      if (st.settings.maint && Math.abs(diff) > 0 && st.settings.maint.every(m => m.last === odometer() - diff)) st.settings.maint.forEach(m => m.last = v);
      save(); closeSheet(); renderMaint(); toast("Hodômetro atualizado");
    });
  });
}
/* endereços difíceis (observação fixa por endereço) */
const addrKey = s => (norm(s.street) + "|" + norm(s.num)).replace(/\s+/g, " ");
const addrNote = s => (st.addrNotes || {})[addrKey(s)] || "";
function setAddrNote(s, txt) { st.addrNotes = st.addrNotes || {}; const k = addrKey(s); if (txt && txt.trim()) st.addrNotes[k] = txt.trim(); else delete st.addrNotes[k]; save(); }
/* GPS no momento da entrega (prova) */
function stampWhere(s) {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(p => { s.where = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), at: Date.now() }; save(); }, () => {}, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
}
/* emergência */
function sosSheet() {
  const S = st.settings;
  sheet(`<h3 style="color:var(--red)">Emergência</h3><p class="sub">Use se estiver em perigo, sofrer acidente ou assalto.</p>
    <div class="stack" style="margin-top:12px">
      <button class="btn big sos-btn" id="sosSend">${S.sosPhone ? `Enviar minha localização para ${esc(S.sosName || "meu contato")}` : "Enviar minha localização pelo WhatsApp"}</button>
      <div class="row"><a class="btn warn" href="tel:190">Polícia 190</a><a class="btn warn" href="tel:192">SAMU 192</a><a class="btn warn" href="tel:193">Bombeiros 193</a></div>
      <p class="sub" id="sosStatus"></p>
      <div class="grid2"><div class="field"><label for="sosName">Contato de confiança</label><input id="sosName" value="${esc(S.sosName || "")}" placeholder="Nome"></div>
        <div class="field"><label for="sosPhone">WhatsApp dele</label><input id="sosPhone" inputmode="tel" value="${esc(S.sosPhone || "")}" placeholder="(31) 99999-0000"></div></div>
      <button class="btn ghost" id="sosSave">Salvar contato</button><button class="btn ghost" data-close>Fechar</button>
    </div>`, () => {
    $("#sosSave").addEventListener("click", () => { S.sosName = $("#sosName").value.trim(); S.sosPhone = $("#sosPhone").value.trim(); save(); toast("Contato de emergência salvo"); });
    $("#sosSend").addEventListener("click", () => sendSos());
  });
}
function sendSos() {
  const S = st.settings; const tel = digits(S.sosPhone); const num = tel ? (tel.length <= 11 ? "55" + tel : tel) : "";
  const s = pending()[0]; const stat = $("#sosStatus"); if (stat) stat.textContent = "Pegando sua localização...";
  const go = loc => {
    const where = loc ? `https://maps.google.com/?q=${loc.lat},${loc.lng}` : "(não consegui a localização)";
    const msg = `EMERGÊNCIA - ${user ? user.name : "entregador"} precisa de ajuda.\nLocalização agora: ${where}\nHorário: ${new Date().toLocaleTimeString("pt-BR")}${s ? `\nIndo para: ${addrFull(s)}` : ""}`;
    openUrl(`https://wa.me/${num}?text=${encodeURIComponent(msg)}`); if (stat) stat.textContent = "WhatsApp aberto com sua localização. Toque em enviar.";
  };
  if (!navigator.geolocation) return go(null);
  navigator.geolocation.getCurrentPosition(p => go({ lat: p.coords.latitude, lng: p.coords.longitude }), () => go(st.start), { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
}
/* comprovante em PDF */
async function proofPdf(s) {
  toast("Gerando comprovante...");
  try {
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
    const doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" }); let y = 18;
    doc.setFillColor(24, 169, 87); doc.rect(0, 0, 210, 12, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(18); doc.text(s.status === "delivered" ? "Comprovante de entrega" : "Comprovante de tentativa de entrega", 14, y + 6); y += 16;
    doc.setFontSize(10); doc.setFont("helvetica", "normal"); doc.setTextColor(90);
    doc.text(`Gerado pelo DeliveRota em ${new Date().toLocaleString("pt-BR")}`, 14, y); y += 10; doc.setTextColor(20);
    const row = (k, v) => { if (!v) return; doc.setFont("helvetica", "bold"); doc.text(k, 14, y); doc.setFont("helvetica", "normal"); const lines = doc.splitTextToSize(String(v), 130); doc.text(lines, 62, y); y += 6 * lines.length + 1; };
    doc.setFontSize(11);
    row("Entregador:", user ? `${user.name} (${user.email})` : "");
    row("Situação:", s.status === "delivered" ? "ENTREGUE" : "NÃO ENTREGUE - " + (s.reason || ""));
    row("Data e hora:", s.doneAt ? new Date(s.doneAt).toLocaleString("pt-BR") : "");
    row("Endereço:", addrFull(s) + (s.comp ? " - " + s.comp : "") + (s.cep ? " - CEP " + s.cep : ""));
    row("Cliente:", s.client); row("Código do pacote:", s.code); row("Plataforma:", st.platform);
    row("Recebido por:", s.status === "delivered" ? s.recv : ""); row("Observação:", s.note);
    if (s.where) {
      const d = hasGeo(s) ? Math.round(hav(s.where, s) / 1.3 * 1000) : null;
      row("Local do registro:", `${s.where.lat.toFixed(6)}, ${s.where.lng.toFixed(6)} (precisão ~${s.where.acc} m)${d != null ? ` - a ${d} m do endereço` : ""}`);
      row("Ver no mapa:", `https://maps.google.com/?q=${s.where.lat},${s.where.lng}`);
    } else row("Local do registro:", "GPS não disponível no momento do registro");
    if (s.photo) {
      const b = await dbGet("photos", s.id);
      if (b) { const url = await new Promise(ok => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(b); });
        const img = await new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.src = url; });
        const w = 120, h = Math.min(130, w * img.height / img.width); y += 4; doc.setFont("helvetica", "bold"); doc.text("Foto registrada:", 14, y); y += 4; doc.addImage(url, "JPEG", 14, y, w, h); y += h + 6; }
    }
    doc.setFontSize(9); doc.setTextColor(120); doc.text("Documento gerado automaticamente no momento do registro, com horário e localização do aparelho do entregador.", 14, 285);
    const file = new File([doc.output("blob")], `comprovante-${(s.code || s.street).replace(/[^\w-]+/g, "-")}-${isoOf(new Date(s.doneAt || Date.now()))}.pdf`, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], title: "Comprovante DeliveRota" }); return; } catch (e) { if (e.name === "AbortError") return; } }
    download(file, file.name); toast("Comprovante baixado");
  } catch (e) { toast("Não consegui gerar o PDF. Verifique a internet na primeira vez."); }
}
/* plataformas: comparação */
function renderPlatCompare(p) {
  const box = $("#platBox"); if (!box) return;
  const g = {};
  p.list.forEach(d => (d.plats && d.plats.length ? d.plats : [{ pl: "Sem plataforma", done: d.done, pk: d.pk, km: d.km, earn: d.earn, hours: d.hours || 0, days: 1 }]).forEach(x => {
    const k = x.pl || "Sem plataforma"; const a = g[k] || (g[k] = { pl: k, days: 0, done: 0, km: 0, earn: 0, hours: 0 });
    a.days += x.days || 1; a.done += x.done || 0; a.km += x.km || 0; a.earn += x.earn || 0; a.hours += x.hours || 0; }));
  const rows = Object.values(g).map(a => { const c = costsOf(a.km, a.days); return { ...a, net: a.earn - c.total, perKm: a.km ? (a.earn - c.total) / a.km : 0, perH: a.hours ? (a.earn - c.total) / a.hours : 0 }; }).sort((a, b) => b.perKm - a.perKm);
  if (!rows.length || (rows.length === 1 && rows[0].pl === "Sem plataforma")) { box.innerHTML = `<h3 class="sub-h">Qual plataforma paga melhor</h3><p class="sub">Escolha a plataforma do dia no cartão da Rota. Depois de alguns dias aparece aqui a comparação.</p>`; return; }
  box.innerHTML = `<h3 class="sub-h">Qual plataforma paga melhor</h3><div class="tbl"><table><thead><tr><th>Plataforma</th><th>Dias</th><th>Lucro</th><th>Lucro/km</th><th>Lucro/hora</th></tr></thead><tbody>
    ${rows.map((r, i) => `<tr${i === 0 ? ' class="top1"' : ""}><td>${esc(r.pl)}</td><td>${r.days}</td><td>R$ ${fmt(r.net)}</td><td>R$ ${fmt(r.perKm)}</td><td>${r.hours ? "R$ " + fmt(r.perH) : "-"}</td></tr>`).join("")}</tbody></table></div>
    <p class="hint">Lucro já descontando gasolina, desgaste e custos fixos.</p>`;
}
/* lembrete do MEI (não bloqueia nada, só avisa) */
function meiCheck() {
  const lim = st.settings.meiLimit || 0, box = $("#meiBanner"); if (!lim) { if (box) box.innerHTML = ""; return; }
  const y = new Date().getFullYear(), rev = Object.values(dayTotals()).filter(d => d.iso.startsWith(y + "-")).reduce((a, d) => a + d.earn, 0), pct = rev / lim * 100;
  const lvl = pct >= 100 ? 100 : pct >= 90 ? 90 : pct >= 80 ? 80 : 0;
  if (box) box.innerHTML = lvl ? `<div class="alert" data-go="resumo"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><path d="M12 7v6M12 17h.01"/></svg><span><b>Lembrete MEI:</b> você já faturou R$ ${fmt(rev)} em ${y}, ${Math.round(pct)}% do limite de R$ ${fmt(lim)}. ${pct >= 100 ? "Fale com seu contador sobre o próximo passo." : "Vale conversar com seu contador."}</span></div>` : "";
  const key = y + ":" + lvl;
  if (lvl && st.meiWarned !== key) { st.meiWarned = key; save(); toast(`Lembrete MEI: ${Math.round(pct)}% do limite anual atingido`, 5000); speak(`Lembrete: você já atingiu ${Math.round(pct)} por cento do limite anual do MEI.`); }
}
/* relatório anual IR / MEI */
async function yearTaxReport() {
  const y = calYear, days = Object.values(dayTotals()).filter(d => d.iso.startsWith(y + "-"));
  if (!days.length) { toast("Nenhum dia registrado em " + y); return; }
  const rows = MESES.map((m, i) => { const ds = days.filter(d => +d.iso.slice(5, 7) === i + 1); const km = ds.reduce((a, d) => a + d.km, 0), earn = ds.reduce((a, d) => a + d.earn, 0), c = costsOf(km, ds.length);
    return { Mês: m.charAt(0).toUpperCase() + m.slice(1), "Dias trabalhados": ds.length, Entregas: ds.reduce((a, d) => a + d.done, 0), Km: +km.toFixed(1), "Receita bruta (R$)": +earn.toFixed(2), "Gasolina (R$)": +c.fuel.toFixed(2), "Desgaste do veículo (R$)": +c.wear.toFixed(2), "Custos fixos (R$)": +c.fixed.toFixed(2), "Lucro (R$)": +(earn - c.total).toFixed(2) }; });
  const T = k => +rows.reduce((a, r) => a + r[k], 0).toFixed(2);
  const total = { Mês: "TOTAL " + y }; Object.keys(rows[0]).slice(1).forEach(k => total[k] = T(k)); rows.push(total);
  const lim = st.settings.meiLimit || 0;
  const info = [{ Item: "Receita bruta no ano", Valor: total["Receita bruta (R$)"] }, { Item: "Lucro no ano", Valor: total["Lucro (R$)"] }]
    .concat(lim > 0 ? [{ Item: "Limite de referência informado", Valor: lim }, { Item: "Percentual da referência", Valor: +(total["Receita bruta (R$)"] / lim * 100).toFixed(1) + "%" }] : [])
    .concat([{ Item: "Atenção", Valor: "Valores estimados pelo app. Confirme com seu contador antes de declarar." }]);
  try {
    await loadScript(LIBS.xlsx); const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows); ws["!cols"] = [{ wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 9 }, { wch: 16 }, { wch: 13 }, { wch: 20 }, { wch: 16 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, "Mês a mês"); const wi = XLSX.utils.json_to_sheet(info); wi["!cols"] = [{ wch: 36 }, { wch: 60 }]; XLSX.utils.book_append_sheet(wb, wi, "MEI e IR");
    download(new Blob([XLSX.write(wb, { bookType: "xlsx", type: "array" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `DeliveRota-IR-MEI-${y}.xlsx`);
    toast("Relatório anual baixado");
  } catch (e) { toast("Não consegui gerar a planilha. Verifique a internet na primeira vez."); }
}

/* ===================== painel: gráficos ===================== */
let grpKind = "day";
function buckets(p) {
  const out = [], days = {}; p.list.forEach(d => days[d.iso] = d);
  const from = new Date(p.r.from + "T12:00"), to = new Date(p.r.to + "T12:00");
  const todayIso = isoOf(new Date()); const end = p.r.to > todayIso && p.r.from <= todayIso ? new Date(todayIso + "T12:00") : to;
  const key = d => grpKind === "month" ? isoOf(d).slice(0, 7) : grpKind === "week" ? isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7)) : isoOf(d);
  const label = (k) => grpKind === "month" ? MESES[+k.slice(5, 7) - 1].slice(0, 3) : grpKind === "week" ? brOf(k).slice(0, 5) : brOf(k).slice(0, 5);
  const map = {};
  for (let d = new Date(from); d <= end; d.setDate(d.getDate() + 1)) {
    const k = key(d); const b = map[k] || (map[k] = { k, label: label(k), earn: 0, km: 0, done: 0, days: 0 }); if (!out.includes(b)) out.push(b);
    const x = days[isoOf(d)]; if (x) { b.earn += x.earn; b.km += x.km; b.done += x.done; b.days += 1; }
  }
  out.forEach(b => { const c = costsOf(b.km, b.days); b.cost = c.total; b.net = b.earn - c.total; });
  return out;
}
function barChart(el, data, val, tip, cls) {
  if (!data.length || data.every(d => !val(d))) { el.innerHTML = `<div class="chart-empty">Sem dados neste período ainda.</div>`; return; }
  const W = Math.max(280, Math.round(el.clientWidth || 600)), H = 200, L = 46, R = 8, T = 12, B = 24, n = data.length;
  const vals = data.map(val), max = Math.max(0, ...vals), min = Math.min(0, ...vals);
  const span = (max - min) || 1, step = niceStep(span / 3), top = Math.ceil(max / step) * step, bot = Math.floor(min / step) * step;
  const y = v => T + (top - v) / ((top - bot) || 1) * (H - T - B);
  const cw = (W - L - R) / n, bw = Math.max(2, Math.min(34, cw * .62));
  let g = `<g class="grid">`; for (let v = bot; v <= top + 1e-9; v += step) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 3}" text-anchor="end">${cls === "done" ? Math.round(v) : (Math.abs(v) >= 1000 ? (v / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mil" : Math.round(v))}</text>`; g += `</g>`;
  const every = Math.ceil(n / 10); let bars = "";
  data.forEach((d, i) => {
    const v = val(d), x = L + i * cw + (cw - bw) / 2, y0 = y(0), y1 = y(v), h = Math.abs(y1 - y0);
    const r = Math.min(4, bw / 2, h);
    const path = v >= 0 ? `M${x},${y0}V${y1 + r}q0,-${r} ${r},-${r}h${bw - 2 * r}q${r},0 ${r},${r}V${y0}Z` : `M${x},${y0}V${y1 - r}q0,${r} ${r},${r}h${bw - 2 * r}q${r},0 ${r},-${r}V${y0}Z`;
    bars += `<rect class="hit" x="${L + i * cw}" y="${T}" width="${cw}" height="${H - T - B}" data-i="${i}"/>${h > .5 ? `<path class="bar ${cls || ""}${v < 0 ? " neg" : ""}" d="${path}" data-b="${i}"/>` : ""}`;
    if (i % every === 0) bars += `<text x="${L + i * cw + cw / 2}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico">${g}<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="var(--muted)" stroke-width="1"/>${bars}</svg><div class="ctip" hidden></div>`;
  const svg = el.querySelector("svg"), tipEl = el.querySelector(".ctip");
  const show = i => { const d = data[i], rect = svg.getBoundingClientRect(), k = rect.width / W; el.querySelectorAll(".bar.on").forEach(b => b.classList.remove("on")); const b = el.querySelector(`[data-b="${i}"]`); if (b) b.classList.add("on");
    tipEl.innerHTML = tip(d); tipEl.hidden = false; tipEl.style.left = Math.min(rect.width - 70, Math.max(70, (L + i * cw + cw / 2) * k)) + "px"; tipEl.style.top = (Math.min(y(val(d)), y(0)) * k - 6) + "px"; };
  svg.querySelectorAll(".hit").forEach(h => { h.addEventListener("mouseenter", () => show(+h.dataset.i)); h.addEventListener("click", () => show(+h.dataset.i)); });
  svg.addEventListener("mouseleave", () => { tipEl.hidden = true; el.querySelectorAll(".bar.on").forEach(b => b.classList.remove("on")); });
}
function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x || 1))), f = x / p; return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p; }
function renderCharts(p) {
  $$("#grpSeg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.grp === grpKind));
  const bs = buckets(p);
  barChart($("#chProfit"), bs, d => d.net, d => `<b>${esc(d.label)}</b><br>Ganho R$ ${fmt(d.earn)}<br>Custos R$ ${fmt(d.cost)}<br><b>Lucro R$ ${fmt(d.net)}</b>`);
  barChart($("#chDone"), bs, d => d.done, d => `<b>${esc(d.label)}</b><br>${d.done} entregas · ${km1(d.km)} km`, "done");
}

/* ===================== assistente de dúvidas (funciona sem internet) ===================== */
const KB = [
  { t: "Como adicionar endereços", k: "adicionar endereco parada colocar incluir cadastrar entrega nova", a: "Toque em <b>Adicionar</b> na barra de baixo. Você pode: digitar com CEP, ler QR code ou código de barras, tirar foto da etiqueta ou print, importar planilha ou PDF, colar texto do WhatsApp, ditar por voz, mandar áudio ou tocar no mapa.", go: "add" },
  { t: "Digitar endereço com CEP", k: "digitar cep rua numero complemento referencia", a: "Em <b>Adicionar → Digitar / CEP</b>, digite o CEP: rua, bairro e cidade são preenchidos sozinhos. Complete o número (ou s/n), complemento e referência e toque em <b>Adicionar parada</b>.", go: "add", mode: "type" },
  { t: "Ler QR code ou código de barras", k: "qr code codigo barras bipar escanear camera etiqueta leitor", a: "Em <b>Adicionar → QR / código</b>, toque em <b>Abrir câmera</b> e aponte para a etiqueta. Se o código tiver endereço, a parada é criada. Se for só o código do pacote, toque em <b>Ligar</b> para juntar com uma parada. O modo contínuo bipa vários pacotes seguidos.", go: "add", mode: "scan" },
  { t: "Achar a parada de um pacote (organizar o veículo)", k: "achar pacote organizar veiculo carro bau numero parada bipar carregar", a: "Na aba <b>Paradas</b>, toque em <b>Bipar pacote</b>. Ao ler o código, o app mostra o <b>número da parada</b> em letras grandes. Escreva o número no pacote e organize na ordem.", go: "paradas" },
  { t: "Foto da etiqueta ou print", k: "foto print imagem etiqueta tela ler texto ocr", a: "Em <b>Adicionar → Foto / print</b>, tire a foto ou escolha o print. O app lê o texto e mostra os endereços encontrados para você confirmar. Use boa luz e foto de perto. Na primeira vez precisa de internet.", go: "add", mode: "photo" },
  { t: "Importar planilha ou PDF", k: "planilha excel xlsx csv pdf romaneio arquivo importar lista", a: "Em <b>Adicionar → Planilha / PDF</b>, escolha o arquivo. O app acha sozinho as colunas de endereço, número, CEP, cliente, telefone e código. PDF escaneado (imagem) não dá: tire print e use Foto.", go: "add", mode: "file" },
  { t: "Colar lista do WhatsApp", k: "colar texto whatsapp lista mensagem compartilhar", a: "Em <b>Adicionar → Colar texto</b>, cole um endereço por linha e toque em <b>Importar</b>. No celular com o app instalado, dá para usar <b>Compartilhar → DeliveRota</b> direto do WhatsApp (texto, print, PDF ou áudio).", go: "add", mode: "paste" },
  { t: "Áudio do WhatsApp com endereço", k: "audio whatsapp mensagem voz cliente gravado transcrever", a: "Em <b>Adicionar → Áudio do WhatsApp</b>, escolha o áudio (ou compartilhe do WhatsApp). O app transcreve e acha rua e número. Na primeira vez baixa o reconhecedor (uns 80 MB).", go: "add", mode: "audio" },
  { t: "Ditar endereço por voz", k: "ditar falar endereco voz microfone", a: "Em <b>Adicionar → Ditar</b>, toque no microfone e fale, por exemplo: \"Rua Harmonia, 456, casa 2\". Confira os campos e toque em Adicionar parada. Ou use o microfone verde e diga \"adicionar rua tal, número tal\".", go: "add", mode: "voice" },
  { t: "Marcar ponto no mapa", k: "mapa tocar ponto marcar alfinete pin local", a: "Toque no botão do <b>alfinete</b> no mapa e depois no local da entrega. O app descobre a rua e o número mais próximos.", go: "rota" },
  { t: "Otimizar a rota", k: "otimizar organizar ordem melhor rota caminho mais curto", a: "É automático: toque em <b>Carregar rota</b>, coloque os endereços e o app já organiza a melhor ordem (prioridades e horário até 12h primeiro). Depois é só tocar em <b>Começar rota</b>. Puxou a rota errada? Toque em <b>Cancelar rota</b> e carregue outra.", go: "rota" },
  { t: "Ponto de partida e cidade", k: "partida inicio localizacao gps cidade onde entrego comeca", a: "Em <b>Configurações → Rota</b>: escreva a cidade (ex.: Belo Horizonte - MG) e toque em <b>Usar minha localização</b> ou <b>Escolher no mapa</b>. O botão de mira no mapa também usa sua localização.", act: "settings" },
  { t: "Marcar entrega feita", k: "entregue entreguei marcar feita concluir comprovante foto recebeu", a: "Na próxima entrega, toque em <b>Entregue</b>. Se quiser, tire foto do comprovante e escolha quem recebeu. O app guarda horário e GPS. Por voz: diga \"entreguei\".", go: "rota" },
  { t: "Não consegui entregar", k: "nao entreguei ausente recusou fechado problema motivo tentativa", a: "Toque em <b>Não consegui entregar</b>, escolha o motivo e, se puder, tire foto do local como prova. A rota segue para a próxima. Para tentar de novo depois, abra a parada e toque em <b>Voltar para pendente</b>.", go: "rota" },
  { t: "Pular ou mudar a ordem", k: "pular depois mudar ordem subir descer mover", a: "Toque em <b>Pular</b> para jogar a parada para o fim. Na aba <b>Paradas</b>, use as setas ▲▼ para mudar a ordem, ou abra a parada e toque em <b>Fazer esta agora</b>.", go: "paradas" },
  { t: "Navegar com Waze ou Google Maps", k: "navegar waze google maps gps caminho ir", a: "Toque em <b>Navegar</b> na próxima entrega. O botão do mapinho abre o outro aplicativo. Escolha o app padrão em <b>Configurações → Rota</b>. O botão de baixo abre as próximas 10 paradas no Google Maps.", go: "rota" },
  { t: "Ligar ou mandar WhatsApp para o cliente", k: "ligar telefone cliente whatsapp mensagem chegando avisar contato", a: "Toque no ícone do <b>telefone</b> na próxima entrega: dá para ligar ou abrir o WhatsApp com a mensagem \"estou chegando\" pronta. A mensagem você muda em <b>Configurações → Clientes</b>.", go: "rota" },
  { t: "Endereço não apareceu no mapa", k: "endereco nao encontrado mapa errado local ajustar localizar", a: "Toque na parada e use <b>Ajustar no mapa</b> (toque no local certo) ou <b>Editar</b> para corrigir rua, número e cidade. Confira se a cidade está certa em Configurações.", go: "paradas" },
  { t: "Observação fixa de um endereço", k: "observacao endereco dificil portaria cachorro anotar lembrar", a: "Abra a parada e escreva em <b>Observação fixa deste endereço</b> (ex.: \"entregar na portaria lateral\"). Sempre que esse endereço voltar, o aviso aparece na entrega.", go: "paradas" },
  { t: "Comprovante em PDF", k: "comprovante pdf prova contestacao plataforma disse que nao fui", a: "Abra uma parada já entregue ou com problema e toque em <b>Gerar comprovante em PDF</b>. Ele traz horário, GPS do momento, distância do endereço e a foto. Dá para enviar para a plataforma.", go: "paradas" },
  { t: "Comandos de voz e mãos livres", k: "voz comando falar microfone maos livres moto sem tocar", a: "Toque no <b>microfone verde</b> no meio da barra e fale: \"entreguei\", \"ninguém em casa\", \"qual a próxima\", \"navegar\", \"ligar\", \"pular\", \"quanto ganhei\", \"quantas faltam\". Diga \"mãos livres\" para o app ficar ouvindo sem tocar, e \"parar de ouvir\" para desligar.", act: "voicehelp" },
  { t: "Painel e gráficos", k: "painel dashboard grafico relatorio periodo filtro semana mes ano diario semanal mensal", a: "Na aba <b>Painel</b>, escolha o período (Hoje, Semana, Mês, Ano ou datas) e veja ganho, custos e lucro real. Os gráficos podem ser Diário, Semanal ou Mensal. Toque numa barra para ver os valores.", go: "resumo" },
  { t: "Enviar relatório e baixar planilha", k: "enviar relatorio whatsapp email planilha baixar exportar", a: "No <b>Painel</b>, escolha o período e toque em <b>Enviar no WhatsApp</b>, <b>Enviar por e-mail</b> ou <b>Baixar planilha</b>. No celular, a planilha já vai anexada.", go: "resumo" },
  { t: "Relatório automático", k: "relatorio automatico todo dia semana mes agendar", a: "Em <b>Configurações → Relatórios</b>, escolha Todo dia, Toda semana ou Todo mês e coloque WhatsApp/e-mail. Quando o período fechar, o app avisa e o relatório sai com um toque.", act: "settings" },
  { t: "Calendário e lançar dia", k: "calendario dia anterior lancar manual trabalhei sem app historico", a: "No fim do <b>Painel</b> fica o calendário do ano. Toque num dia para ver detalhes ou <b>lançar um dia</b> que você trabalhou sem o app.", go: "resumo" },
  { t: "Encerrar o dia", k: "encerrar dia fechar terminar limpar rota fim", a: "No <b>Painel → Hoje</b>, toque em <b>Encerrar o dia</b> (duas vezes para confirmar). O dia vai para o calendário e a rota fica limpa para amanhã.", go: "resumo" },
  { t: "Ganho por pacote e plataformas", k: "ganho pacote valor quanto ganho plataforma mercado livre shopee amazon paga melhor", a: "Escolha a <b>plataforma do dia</b> no cartão da Rota. Em <b>Configurações → Ganhos</b>, coloque quanto cada plataforma paga por pacote. O Painel mostra <b>qual paga melhor</b> por km e por hora.", act: "settings" },
  { t: "Meta do dia", k: "meta objetivo quanto falta bater", a: "Toque em <b>Definir meta do dia</b> no cartão da Rota. O app mostra quanto falta em reais e quantos pacotes. Por voz: \"quanto falta pra meta\".", act: "goal" },
  { t: "Gasolina, desgaste e custo por km", k: "gasolina gasto gasta gastei combustivel consumo litro custo km desgaste oleo pneu fixo parcela seguro lucro real", a: "Em <b>Configurações → Veículo e custos</b>: consumo (km/l), preço da gasolina, desgaste por km e custos fixos do mês. O Painel desconta tudo e mostra o <b>lucro real</b> e o custo por km.", act: "settings" },
  { t: "Manutenção e hodômetro", k: "manutencao oleo troca revisao pneu relacao corrente hodometro km", a: "No <b>Painel → Manutenção</b>, acerte o <b>hodômetro</b> com o painel do veículo. O app conta os km e avisa quando chegar a troca de óleo, revisão e outros. Toque em <b>Fiz agora</b> depois de fazer.", go: "resumo" },
  { t: "MEI e Imposto de Renda", k: "mei imposto renda ir declarar limite faturamento contador", a: "No <b>Painel → Calendário</b>, toque em <b>Relatório anual para IR / MEI</b>: planilha mês a mês com receita, custos e lucro. O app não tem limite. Se quiser um lembrete, preencha o valor em Configurações → Relatórios.", go: "resumo" },
  { t: "Botão de emergência (SOS)", k: "sos emergencia socorro assalto acidente perigo policia ajuda localizacao", a: "Toque no botão vermelho <b>SOS</b> no topo: envia sua localização pelo WhatsApp para seu contato de confiança e tem atalhos para 190, 192 e 193. Por voz: \"socorro\". Cadastre o contato em Configurações.", act: "sos" },
  { t: "Login, senha provisória e primeiro acesso", k: "login entrar conta senha provisoria primeiro acesso criar", a: "No primeiro acesso, toque em <b>Criar conta</b>, coloque nome e e-mail e receba a <b>senha provisória</b>. Entre com ela e crie sua senha definitiva." },
  { t: "Esqueci a senha / trocar senha / sair", k: "esqueci senha trocar mudar sair deslogar conta", a: "Na tela de entrar, toque em <b>Esqueci minha senha</b>. Logado, vá em <b>Configurações</b>: Trocar senha ou Sair da conta. \"Manter conectado\" faz o app entrar direto.", act: "settings" },
  { t: "Mostrar ou esconder a senha", k: "ver senha olho esconder mostrar", a: "No campo de senha, toque no <b>olho</b> para mostrar ou esconder o que digitou." },
  { t: "Cadastrar entregador (administrador)", k: "cadastrar entregador administrador admin acesso equipe", a: "Se você é administrador, em <b>Configurações</b> aparece <b>Cadastrar entregador</b>: gera a senha provisória e envia por WhatsApp ou e-mail.", act: "settings" },
  { t: "Instalar o app", k: "instalar app celular tela inicial icone windows atalho play store", a: "No celular (Chrome): menu → <b>Instalar app</b>. No Windows (Edge/Chrome): ícone de instalar na barra de endereço, ou em Configurações → Instalar o DeliveRota." },
  { t: "Funciona sem internet?", k: "internet offline sem sinal dados funciona", a: "A rota, as entregas e os relatórios funcionam sem internet depois de abertos. Precisam de internet: mapa, achar endereço novo, CEP e, na primeira vez, leitura de foto, PDF, planilha e áudio." },
  { t: "Quantas paradas cabem", k: "limite paradas quantas maximo 100 150", a: "Não tem limite de paradas. Rotas de 100 ou 150 paradas são otimizadas em menos de 1 segundo. Achar muitos endereços novos leva cerca de 1 segundo cada." },
  { t: "Mapa não carrega", k: "mapa nao carrega branco cinza sumiu", a: "O mapa precisa de internet. Confira a conexão (o selo no topo mostra Online/Sem internet). As entregas continuam funcionando mesmo sem o mapa." },
  { t: "Meus dados e privacidade", k: "dados privacidade seguro onde fica salvo apagar", a: "Os dados ficam guardados no seu aparelho. Para apagar a rota: Configurações → Apagar todas as paradas. Desinstalar o app apaga tudo." },
  { t: "Tema escuro", k: "tema escuro claro noite cor", a: "Em <b>Configurações → Aparência</b>, escolha Claro, Escuro ou Igual ao aparelho.", act: "settings" },
  { t: "Videoaula do app", k: "video aula videoaula tutorial aprender ensinar assistir curso", a: "A videoaula ensina a usar o DeliveRota do começo ao fim. O link fica no topo deste assistente e em Configurações." },
  { t: "Rota de exemplo para testar", k: "exemplo teste demonstracao testar", a: "Em <b>Configurações</b>, toque em <b>Carregar rota de exemplo</b> e depois em Otimizar rota.", act: "sample" }
];
const STOP = new Set("a o e de da do das dos um uma para pra pro com como que eu meu minha no na nos nas se faz fazer faco onde qual quais tem ter esta isso quero posso consigo por favor app deliverota quanto quanta quantos muito ja ai la".split(" "));
const stem = w => w.length > 5 ? w.slice(0, 5) : w;
function helpSearch(q) {
  const words = norm(q).split(" ").filter(w => w.length > 1 && !STOP.has(w)).map(stem);
  if (!words.length) return [];
  return KB.map(e => { const pool = new Set(norm(e.t + " " + e.k).split(" ").map(stem)); let sc = 0; words.forEach(w => { if (pool.has(w)) sc += 2; else if ([...pool].some(p => p.startsWith(w) || w.startsWith(p))) sc += 1; }); return { e, sc: sc / Math.sqrt(words.length) }; })
    .filter(x => x.sc >= 1).sort((a, b) => b.sc - a.sc).slice(0, 3).map(x => x.e);
}
let helpLog = [];
const VIDEO_URL = () => (window.DELIVEROTA_VIDEO_URL || "").trim();
function videoBlock() {
  const u = VIDEO_URL();
  return u ? `<a class="video" href="${esc(u)}" target="_blank" rel="noopener"><span class="play"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span><span><b>Videoaula: aprenda a usar tudo</b><small>Passo a passo do DeliveRota, do começo ao fim</small></span></a>`
    : `<div class="video off"><span class="play"><svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span><span><b>Videoaula: em breve</b><small>Aqui vai ficar o vídeo ensinando a usar o app</small></span></div>`;
}
function helpSheet2(initial) {
  const chips = ["Como adicionar endereços", "Otimizar a rota", "Ler QR code ou código de barras", "Comandos de voz e mãos livres", "Painel e gráficos", "Gasolina, desgaste e custo por km"];
  sheet(`<div class="sec-h"><h3>Assistente DeliveRota</h3><button class="iconbtn" data-close aria-label="Fechar">✕</button></div>
    ${videoBlock()}
    <div class="chat" id="chat"><div class="msg bot">Olá${user && user.name ? ", " + esc(user.name.split(" ")[0]) : ""}! Pergunte qualquer coisa sobre o app. Por exemplo: <i>"como bipar os pacotes?"</i> ou <i>"como vejo meu lucro do mês?"</i></div></div>
    <div class="chips" id="hChips">${chips.map(c => `<button data-hq="${esc(c)}">${esc(c)}</button>`).join("")}</div>
    <form class="ask" id="askForm"><input id="askIn" placeholder="Digite sua dúvida..." autocomplete="off" aria-label="Sua dúvida"><button class="btn icon dark" type="button" id="askMic" aria-label="Falar a dúvida"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button><button class="btn primary icon" type="submit" aria-label="Enviar"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/></svg></button></form>`, () => {
    $("#askForm").addEventListener("submit", e => { e.preventDefault(); const v = $("#askIn").value.trim(); if (v) { askHelp(v); $("#askIn").value = ""; } });
    $("#hChips").addEventListener("click", e => { const b = e.target.closest("[data-hq]"); if (b) askHelp(b.dataset.hq); });
    $("#chat").addEventListener("click", e => { const b = e.target.closest("[data-hact]"); if (b) helpAction(KB[+b.dataset.hact]); const r = e.target.closest("[data-hq]"); if (r) askHelp(r.dataset.hq); });
    $("#askMic").addEventListener("click", () => {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) { toast("Voz indisponível neste navegador"); return; }
      const r = new SR(); r.lang = "pt-BR"; r.onresult = ev => askHelp(ev.results[0][0].transcript); r.onerror = () => toast("Não entendi, tente de novo"); r.start(); toast("Pode falar sua dúvida...");
    });
    if (initial) askHelp(initial);
    setTimeout(() => { const i = $("#askIn"); if (i && matchMedia("(min-width:900px)").matches) i.focus(); }, 80);
  });
}
function addMsg(html, who) { const c = $("#chat"); if (!c) return; const d = document.createElement("div"); d.className = "msg " + who; d.innerHTML = html; c.appendChild(d); c.scrollTop = c.scrollHeight; d.scrollIntoView({ block: "nearest" }); }
function askHelp(q) {
  const hc = $("#hChips"); if (hc) hc.hidden = true;
  addMsg(esc(q), "me");
  const exact = KB.find(e => e.t === q); const res = exact ? [exact] : helpSearch(q);
  if (!res.length) {
    addMsg(`Não encontrei isso nas ajudas do app. Tente com outras palavras ou escolha um tema:<div class="chips">${KB.slice(0, 8).map(e => `<button data-hq="${esc(e.t)}">${esc(e.t)}</button>`).join("")}</div>Se ainda precisar, fale com o suporte: <b>delivefoodconsultoria@gmail.com</b>`, "bot");
    return;
  }
  const e = res[0], i = KB.indexOf(e);
  addMsg(`<b>${esc(e.t)}</b><br>${e.a}${(e.go || e.act) ? `<br><button class="btn primary sm" data-hact="${i}" style="margin-top:8px">${e.act === "settings" ? "Abrir Configurações" : e.act === "sos" ? "Abrir SOS" : e.act === "goal" ? "Definir meta" : e.act === "sample" ? "Carregar exemplo" : e.act === "voicehelp" ? "Ver comandos de voz" : "Me leva lá"}</button>` : ""}
    ${res.length > 1 ? `<div class="also">Também pode ser: ${res.slice(1).map(x => `<button class="link" data-hq="${esc(x.t)}">${esc(x.t)}</button>`).join(" · ")}</div>` : ""}`, "bot");
  if (st.settings.speak && /voz|falar|ouvir/.test(norm(q)) === false) {}
}
function helpAction(e) {
  closeSheet();
  if (e.go) { go(e.go); if (e.mode) setMode(e.mode); }
  if (e.act === "settings") settingsSheet();
  if (e.act === "sos") sosSheet();
  if (e.act === "goal") goalSheet();
  if (e.act === "sample") loadSample();
  if (e.act === "voicehelp") helpSheet();
}

/* ===================== eventos ===================== */
document.addEventListener("click", e => {
  const t = e.target.closest("button,[data-go],[data-open]"); if (!t) return;
  const d = t.dataset;
  if (d.s) go(d.s);
  if (d.go) go(d.go);
  if (d.act === "sample") loadSample();
  if (d.act === "start") comecarRota();
  if (d.act === "optall") { const p = pending(); if (p.filter(hasGeo).length >= 2) optimize(); else toast("Rota organizada"); st.otimizada = true; save(); renderAll(true); }
  if (d.act === "addmore") { st.ultimaAdicao = 0; save(); go("add"); }
  if (d.act === "cancelroute") cancelarRota(t);
  if (d.act === "inifim") inicioFimSheet();
  if (d.act === "desistir") desistirEComecar();
  if (d.act === "gasto") gastoSheet();
  if (d.gasto) gastoSheet((st.gastos || []).find(g => g.id === d.gasto));
  if (d.navset) { st.settings.nav = d.navset; st.navAsked = Date.now(); st.navV2 = 1; save(); renderNext(); toast("Navegação pelo " + ({ waze: "Waze", app: "DeliveRota" }[d.navset] || "Google Maps")); if (d.navset === "app" && rotaComecou() && !NV.on) iniciarNavApp(); }
  if (d.act === "navapp") { if (NV.on) { NV.solto = false; if (NV.eu && map) map.setView([NV.eu.lat, NV.eu.lng], 18); } else iniciarNavApp(); }
  if (d.junto) { const x = byId(d.junto), a = pending()[0]; if (x && a) { st.stops.splice(st.stops.indexOf(x), 1); st.stops.splice(st.stops.indexOf(a) + 1, 0, x); save(); renderAll(false); toast("Parada " + stopNumber(x) + " vem logo depois desta"); } }
  if (d.act === "impgo") confirmImport({ fica: true });
  if (d.act === "impstart") { if (confirmImport({ fica: true })) comecarRota(); }
  if (d.act === "impnone") { importList.forEach(a => a.ok = false); $$("[data-imp]").forEach(c => c.checked = false); }
  if (d.act === "impcancel") { $("#importBox").innerHTML = ""; importList = []; $$(".pane .status, #docStatus, #ocrStatus").forEach(x => x.hidden = true); renderAddBar(); }
  if (d.act === "newroute") { st.queroComecar = false; st.stops = []; st.started = false; st.otimizada = false; save(); renderAll(true); go("add"); }
  if (d.act === "goal") goalSheet();
  if (d.act === "odo") odoSheet();
  if (d.act === "sos") sosSheet();
  if (d.act === "help") helpSheet2();
  if (d.act === "irmei") yearTaxReport();
  if (d.maint) { const m = st.settings.maint.find(x => x.id === d.maint); if (m) { m.last = odometer(); save(); renderMaint(); toast(m.name + ": registrado"); } }
  if (d.deliver) deliverSheet(byId(d.deliver));
  if (d.fail) failSheet(byId(d.fail));
  if (d.contact) contactSheet(byId(d.contact));
  if (d.skip) { const s = byId(d.skip); st.stops.splice(st.stops.indexOf(s), 1); st.stops.push(s); save(); renderAll(false); toast("Parada pulada: foi para o fim da rota"); }
  if (d.open) stopSheet(byId(d.open));
  if (d.up || d.down) { const id = d.up || d.down, i = st.stops.findIndex(s => s.id === id), j = i + (d.up ? -1 : 1); if (j >= 0 && j < st.stops.length && st.stops[j].status === "pending") { [st.stops[i], st.stops[j]] = [st.stops[j], st.stops[i]]; save(); renderAll(false); } }
  if (d.f) { st.filter = d.f; save(); renderList(); }
  if (d.m) setMode(d.m);
  if (d.link) linkSheet(+d.link);
  if (d.day) daySheet(d.day);
  if (d.month != null) { calMonth = +d.month; perKind = "month"; renderYear(); renderPeriod(); }
  if (d.xls) exportPeriod(d.xls);
  if (d.per) { perKind = d.per; grpKind = d.per === "year" ? "month" : "day"; renderPeriod(); }
  if (d.grp) { grpKind = d.grp; renderPeriod(); }
  if (d.due) handleDue(d.due);
});
document.addEventListener("change", e => { if (e.target.dataset.imp != null) importList[+e.target.dataset.imp].ok = e.target.checked; });
$("#optBtn").addEventListener("click", () => { optimize(); st.otimizada = true; save(); renderNext(); });
$("#locBtn").addEventListener("click", () => useGps(false));
$("#pinBtn").addEventListener("click", () => setPinMode(pinMode === "new" ? null : "new"));
$("#setBtn").addEventListener("click", settingsSheet);
$("#search").addEventListener("input", e => { searchQ = e.target.value; renderList(); });
$("#scanFindBtn").addEventListener("click", () => openScanner("find"));
$("#openScan").addEventListener("click", () => openScanner("add"));
$("#micBtn").addEventListener("click", startVoice);
$("#voiceFab").addEventListener("click", () => { try { speechSynthesis.cancel(); } catch (e) {} if (listening && rec) { try { rec.stop(); } catch (e) {} return; } listen(); });
$("#vbHelp").addEventListener("click", helpSheet);
$("#audioFile").addEventListener("change", e => { if (e.target.files.length) handleAudio(Array.from(e.target.files)); e.target.value = ""; });
$("#audioForm").addEventListener("submit", e => { e.preventDefault(); const t = $("#audioText").value.replace(/\bnúmero\b/gi, ",").replace(/\.\s+/g, ".\n"); showImport(extractAddresses(t), "áudio"); });
$("#goPin").addEventListener("click", () => { go("rota"); setPinMode("new"); });
$("#ocrFile").addEventListener("change", e => { if (e.target.files.length) handleOcr(Array.from(e.target.files)); e.target.value = ""; });
$("#docFile").addEventListener("change", e => { if (e.target.files[0]) handleDoc(e.target.files[0]); e.target.value = ""; });
$("#cep").addEventListener("input", async e => {
  let v = digits(e.target.value).slice(0, 8); e.target.value = v.length > 5 ? v.slice(0, 5) + "-" + v.slice(5) : v;
  if (v.length === 8) { const r = await viaCep(v); if (r) { $("#street").value = r.logradouro || $("#street").value; $("#bairro").value = r.bairro || ""; $("#city").value = `${r.localidade} - ${r.uf}`; $("#num").focus(); } else toast("CEP não encontrado"); }
});
$("#f-type").addEventListener("submit", e => {
  e.preventDefault(); const g = id => $("#" + id).value.trim();
  if (!g("street") && digits(g("cep")).length !== 8) { toast("Informe a rua ou o CEP"); return; }
  addStops([{ street: g("street"), num: g("num") || "s/n", comp: g("comp"), bairro: g("bairro"), city: g("city"), cep: g("cep"), ref: g("ref"), client: g("client"), phone: g("phone"), code: g("code"), pk: g("pkgs"), win: $("#win").value, prio: $("#prio").checked, src: "digitado" }]);
  if (g("city")) st.settings.city = st.settings.city || g("city");
  e.target.reset(); $("#pkgs").value = 1; toast("Parada adicionada");
});
$("#f-paste").addEventListener("submit", e => { e.preventDefault(); showImport(extractAddresses($("#pasteBox").value), "texto"); });
$("#shareRep").addEventListener("click", async () => { const txt = reportText(); if (navigator.share) { try { await navigator.share({ text: txt }); return; } catch (e) { if (e.name === "AbortError") return; } } window.open("https://wa.me/?text=" + encodeURIComponent(txt), "_blank", "noopener"); });
$("#copyRep").addEventListener("click", () => copyText(reportText(), $("#report")));
$("#xlsRep").addEventListener("click", exportXlsx);
$("#yPrev").addEventListener("click", () => { calYear--; renderYear(); renderPeriod(); });
$("#yNext").addEventListener("click", () => { calYear++; renderYear(); renderPeriod(); });
$("#platSel").addEventListener("change", e => { st.platform = e.target.value; save(); renderAll(false); toast(st.platform ? `Plataforma de hoje: ${st.platform} (R$ ${fmt(curRate())} por pacote)` : "Sem plataforma"); });
$("#perFrom").addEventListener("change", renderPeriod); $("#perTo").addEventListener("change", renderPeriod);
$("#perWa").addEventListener("click", () => sendPeriod(renderPeriod(), "wa"));
$("#perMail").addEventListener("click", () => sendPeriod(renderPeriod(), "mail"));
$("#perXls").addEventListener("click", () => sendPeriod(renderPeriod(), "xls"));
$("#closeDay").addEventListener("click", e => {
  if (!st.stops.length) { toast("Nenhuma parada no dia"); return; }
  twoTap(e.currentTarget, "Toque de novo para encerrar e limpar a rota", async () => {
    const done = st.stops.filter(s => s.status === "delivered"); const pk = done.reduce((a, s) => a + s.pk, 0);
    st.history.push(todayEntry());
    for (const s of st.stops) if (s.photo) await dbDel("photos", s.id);
    st.stops = []; save(); renderAll(true); toast("Dia encerrado. Bom descanso!");
  });
});
function netChip() { const on = navigator.onLine; const c = $("#netChip"); c.classList.toggle("off", !on); $("span", c).textContent = on ? "Online" : "Sem internet"; }
window.addEventListener("online", () => { netChip(); st.stops.filter(s => s.geo === "fail" && !hasGeo(s)).forEach(queueGeocode); });
window.addEventListener("offline", netChip);
window.addEventListener("resize", () => ajustaFolha());
window.addEventListener("dragover", e => e.preventDefault());
window.addEventListener("drop", e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (!f) return; go("add"); if (f.type.startsWith("audio/") || /\.(opus|ogg|m4a|mp3|wav)$/i.test(f.name)) { setMode("audio"); handleAudio(Array.from(e.dataTransfer.files)); } else if (f.type.startsWith("image/")) { setMode("photo"); handleOcr(Array.from(e.dataTransfer.files)); } else { setMode("file"); handleDoc(f); } });
document.addEventListener("paste", e => { if (e.target.closest("input,textarea")) return; const img = Array.from(e.clipboardData.items).find(i => i.type.startsWith("image/")); if (img) { go("add"); setMode("photo"); handleOcr([img.getAsFile()]); } });

/* ===================== plano / assinatura (servidor na Hostinger) ===================== */
const API = (() => { const a = (window.DELIVEROTA_API || "").trim(); return a ? (a.endsWith("/") ? a : a + "/") : ""; })();
const PLANOS_ON = () => !!(FB && API && fbAuth && fbAuth.currentUser);
// aberto pelo app da Play Store? (lá não mostramos botão de compra, regra do Google)
const NA_PLAY = (() => { try { if (document.referrer.startsWith("android-app://")) sessionStorage.setItem("deliverota-play", "1"); return sessionStorage.getItem("deliverota-play") === "1"; } catch (e) { return false; } })();
let plano = null, planoQuando = 0;
function aparelhoId() {
  try { let id = localStorage.getItem("deliverota-aparelho"); if (!id) { id = "ap-" + Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join(""); localStorage.setItem("deliverota-aparelho", id); } return id; }
  catch (e) { return ""; }
}
async function apiCall(arq, corpo) {
  const tk = await fbAuth.currentUser.getIdToken();
  const r = await fetch(API + arq, { method: corpo ? "POST" : "GET", headers: { Authorization: "Bearer " + tk, "X-Aparelho": aparelhoId(), ...(corpo ? { "Content-Type": "application/json" } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw { message: j.erro || "Não consegui falar com o servidor. Tente de novo." };
  return j;
}
const planoCacheKey = () => "deliverota-plano:" + (user && user.uid);
async function conferirPlano(forcar) {
  if (!PLANOS_ON()) return null;
  if (!forcar && plano && Date.now() - planoQuando < 3600e3) return plano;
  try { plano = await apiCall("status.php"); planoQuando = Date.now(); try { localStorage.setItem(planoCacheKey(), JSON.stringify({ t: Date.now(), p: plano })); } catch (e) {} }
  catch (e) {
    // sem internet: usa o último status por até 7 dias; sem nenhum, deixa usar
    try { const c = JSON.parse(localStorage.getItem(planoCacheKey()) || "null"); if (c && Date.now() - c.t < 7 * 864e5) plano = c.p; } catch (x) {}
    if (!plano) return null;
  }
  aplicarPlano();
  return plano;
}
const fmtData = iso => iso ? new Date(iso).toLocaleDateString("pt-BR") : "";
const fmtReal = v => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
function textoPlano(p) {
  if (!p) return "";
  if (p.acesso === "admin") return "Administrador: acesso total";
  if (p.acesso === "ativo") return `Plano ${p.plano ? p.plano.charAt(0).toUpperCase() + p.plano.slice(1) : ""} ativo até ${fmtData(p.ate)}`;
  if (p.acesso === "teste") return `Teste grátis: falta${p.dias_restantes === 1 ? "" : "m"} ${p.dias_restantes} dia${p.dias_restantes === 1 ? "" : "s"}`;
  if (p.acesso === "precisa_cpf") return "Informe o CPF para liberar o teste grátis";
  if (p.acesso === "bloqueado") return "Conta bloqueada";
  return "Teste grátis terminou";
}
function aplicarPlano() {
  const p = plano; const lk = $("#lock");
  if (!p || p.liberado) { lk.hidden = true; if (p && p.acesso === "teste" && p.dias_restantes <= 3 && !sessionStorage.getItem("deliverota-aviso-teste")) { try { sessionStorage.setItem("deliverota-aviso-teste", "1"); } catch (e) {} toast(textoPlano(p) + ". Veja os planos em Configurações.", 6000); } return; }
  const card = $("#lockBody"); lk.hidden = false;
  const sair = `<button class="btn ghost" id="lkOut" type="button">Sair da conta</button>`;
  if (p.acesso === "precisa_cpf") {
    card.innerHTML = `<h2>Libere seus ${p.dias_teste} dias grátis</h2><p class="sub">Informe seu CPF para começar o teste com tudo liberado. Cada CPF tem direito a um teste.</p>
      <div class="field" style="margin-top:12px"><label for="lkCpf">CPF</label><input id="lkCpf" inputmode="numeric" autocomplete="off" placeholder="000.000.000-00" maxlength="14"></div>
      <p class="auth-err" id="lkErr" role="alert" hidden></p>
      <button class="btn primary big" id="lkGo" type="button">Começar teste grátis</button><div class="row" style="margin-top:10px">${sair}</div>`;
    $("#lkCpf").addEventListener("input", e => { const d = digits(e.target.value).slice(0, 11); e.target.value = d.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2"); });
    $("#lkGo").addEventListener("click", async e => {
      const b = e.currentTarget, er = $("#lkErr"); b.disabled = true; er.hidden = true;
      try { plano = await apiCall("cpf.php", { cpf: digits($("#lkCpf").value) }); planoQuando = Date.now(); aplicarPlano(); if (plano.liberado) toast("Pronto! Seu teste grátis começou."); }
      catch (x) { er.hidden = false; er.textContent = errMsg(x); } finally { b.disabled = false; }
    });
  } else if (p.acesso === "bloqueado") {
    const wa = p.suporte ? `<a class="btn primary" target="_blank" rel="noopener" href="https://wa.me/55${digits(p.suporte)}?text=${encodeURIComponent("Olá! Minha conta do DeliveRota (" + (user.email || "") + ") foi bloqueada.")}">Falar com o suporte</a>` : "";
    card.innerHTML = `<h2>Conta bloqueada</h2><p class="sub">${esc(p.motivo || "Fale com o suporte.")}</p><div class="row wrap" style="margin-top:14px">${wa}${sair}</div>`;
  } else {
    const lista = (p.planos || []).map(x => `<li><b>${esc(x.nome)}</b> ${fmtReal(x.valor)}${x.meses > 1 ? ` <span class="sub">(${fmtReal(x.por_mes)}/mês)</span>` : ""}</li>`).join("");
    const comprar = NA_PLAY ? `<p class="sub">Para continuar, renove sua assinatura na sua conta DeliveRota pelo navegador.</p>`
      : `<a class="btn primary big" href="planos.html">Escolher meu plano</a>`;
    card.innerHTML = `<h2>Seu teste grátis terminou</h2><p class="sub">Seus dados continuam salvos. Assine para voltar a usar.</p><ul class="lk-planos">${lista}</ul>${comprar}
      <div class="row" style="margin-top:10px"><button class="btn ghost" id="lkRe" type="button">Já paguei</button>${sair}</div>`;
    $("#lkRe").addEventListener("click", async () => { await conferirPlano(true); if (plano && plano.liberado) toast("Assinatura confirmada. Bom trabalho!"); else toast("Ainda não recebemos a confirmação. Pix confirma em minutos; boleto em até 3 dias úteis.", 6000); });
  }
  $("#lkOut").addEventListener("click", logout);
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && user) conferirPlano(false); });

/* ===================== início ===================== */
$("#authForm").addEventListener("submit", authSubmit);
$("#authSwitch").addEventListener("click", () => authView(authMode === "login" ? "signup" : "login"));
$("#authForgot").addEventListener("click", () => authView("forgot", "Digite seu e-mail. Vamos enviar um link para você criar uma senha nova."));
$("#aEye").addEventListener("click", e => { const b = e.currentTarget, on = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", on); b.setAttribute("aria-label", on ? "Esconder senha" : "Mostrar senha"); $("#aPass").type = on ? "text" : "password"; $("#aPass2").type = on ? "text" : "password"; });
(async function boot() {
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register("sw.js").catch(() => {});
  await authInit();
  $("#whoTop").textContent = user.name || user.email;
  let saved = await dbGet("kv", "state:" + user.uid);
  if (!saved) { const legacy = await dbGet("kv", "state"); if (legacy) { saved = legacy; await dbDel("kv", "state"); } }
  if (saved && saved.stops) st = { ...DEFAULTS, ...saved, settings: { ...DEFAULTS.settings, ...(saved.settings || {}) } };
  applyTheme(); netChip();
  conferirPlano(true);
  $("#today").textContent = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" }).replace(/^./, c => c.toUpperCase());
  initMap(); quickBar(); renderAll(true);
  setTimeout(() => { if (location.hash.startsWith("#rota=")) receberRotaDoLink(); else avisoRotaDoDia(); }, 900);
  const veioComRota = location.hash.startsWith("#rota=");
  if (!st.onboarded) { if (st.settings.city && (st.stops.length || st.history.length)) st.onboarded = true; else if (veioComRota) { st.onboarded = true; st.settings.city = st.settings.city || "Belo Horizonte - MG"; save(); } else setTimeout(onboardSheet, 300); }
  if (st.onboarded && !st.navAsked && !veioComRota) setTimeout(() => { if (!$("#sheetHost").innerHTML) navSheet(); }, 500);
  if (!st.settings.city) st.settings.city = "Belo Horizonte - MG";
  if (map && st.cityCenter && !st.stops.some(hasGeo) && !st.start) map.setView([st.cityCenter.lat, st.cityCenter.lng], 13);
  st.stops.filter(s => !hasGeo(s) && s.geo !== "fail").forEach(queueGeocode);
  // texto compartilhado de outro app (WhatsApp → Compartilhar → DeliveRota)
  const qs = new URLSearchParams(location.search); const shared = [qs.get("title"), qs.get("text"), qs.get("url")].filter(Boolean).join("\n");
  if (shared) { go("add"); setMode("paste"); $("#pasteBox").value = shared; showImport(extractAddresses(shared), "compartilhado"); history.replaceState(null, "", location.pathname); }
  if (qs.has("compartilhado")) { history.replaceState(null, "", location.pathname); receiveShared(); }
  if (qs.has("acao")) { const a = qs.get("acao"); if (a === "bipar") { go("add"); setMode("scan"); } if (a === "adicionar") go("add"); if (a === "voz") setTimeout(listen, 400); }
})();

// para testes automáticos
window.DeliveRota = { handleOcr, map: () => map, previsao, inicioFimSheet, fimPt, comecarRota, trocarAlvoNav, empacotar, desempacotar, receberRotaDoLink, adicionarRapido, lerNotinha, gastoSheet, periodData, acharParadaFalada, iniciarNavApp, pararNavApp, nav: () => NV, refinarPelasRuas, limparEndereco, parseAddressLine, extractAddresses, rowsToAddresses, twoOpt, hav, handleCommand, state: () => st, onScan, helpSearch, dayTotals, periodData, rangeOf, costsOf, odometer, curRate, renderAll, save, user: () => user };
})();
