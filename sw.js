/* DeliveRota — funciona sem internet depois da primeira abertura */
const VERSION = "deliverota-v15";
const SHELL = ["./", "index.html", "app.css", "app.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];
const LIB_HOSTS = ["unpkg.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "cdn.sheetjs.com", "fonts.googleapis.com", "fonts.gstatic.com", "www.gstatic.com"];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== "deliverota-tiles" && k !== "deliverota-share").map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const req = e.request;
  // arquivos e textos enviados pelo "Compartilhar" do celular (WhatsApp, galeria, arquivos)
  if (req.method === "POST" && new URL(req.url).pathname.endsWith("/__share")) {
    e.respondWith((async () => {
      const form = await req.formData(); const c = await caches.open("deliverota-share"); let i = 0;
      const text = [form.get("title"), form.get("text"), form.get("url")].filter(Boolean).join("\n");
      if (text) await c.put(new Request("./__share/text?i=" + (i++)), new Response(text));
      for (const f of form.getAll("files")) await c.put(new Request("./__share/file?i=" + (i++) + "&n=" + encodeURIComponent(f.name)), new Response(f, { headers: { "content-type": f.type || "application/octet-stream" } }));
      return Response.redirect("./?compartilhado=1", 303);
    })());
    return;
  }
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // servidor de pagamento: nunca guardar (sempre a resposta na hora)
  if (url.pathname.endsWith(".php") || url.pathname.includes("/api/")) return;
  // app: rede primeiro (pega atualizações), cache se estiver sem internet
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return r; })
      .catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("index.html"))));
    return;
  }
  // bibliotecas e fontes: cache primeiro
  if (LIB_HOSTS.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return r; })));
    return;
  }
  // mapa: guarda os pedaços já vistos para usar sem internet
  if (url.hostname.endsWith("tile.openstreetmap.org")) {
    e.respondWith(caches.open("deliverota-tiles").then(c => c.match(req).then(hit => {
      const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit);
      return hit || net;
    })));
  }
});
