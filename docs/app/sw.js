// Service worker：
//   App 本身（小檔案）：有網路就拿最新的，沒網路才用快取 → 推新版後手機重開就是新版
//   onnxruntime、模型（大檔案、改版才會換網址）：有快取就直接用，第二次打開不用再下載
const CACHE = "pm-app-v20";
const SHELL = ["./", "./index.html", "./app.css", "./app.js", "./audio.js", "./worklet.js", "./diarize.js", "./filters.js", "./store.js", "./embed-worker.js", "./dsp-worker.js", "./i18n.js",
  "./manifest.json", "./icons/icon48.png", "./icons/icon128.png", "./icons/icon192.png",
  "./lib/groq.js", "./lib/compact.js", "./lib/s2t.js", "./lib/format.js", "./lib/docx.js"];
const BIG = ["./vendor/ort.min.js", "./vendor/ort-wasm-simd-threaded.mjs", "./vendor/ort-wasm-simd-threaded.wasm", "./vendor/rnnoise.js", "./model/silero_vad.onnx"];
const isBig = (p) => /\/(vendor|model)\//.test(p);

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(async (c) => {
    await Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "no-cache" })).catch(() => {}))); // 跳過瀏覽器的 HTTP 快取，拿真的最新版
    await c.addAll(BIG).catch(() => {});
  }).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Groq、GitHub API 一律走網路
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const req = new Request(url.origin + url.pathname); // 快取 key 不含 ?v=，同一檔案只存一份
    if (isBig(url.pathname)) {
      const hit = await c.match(req);
      if (hit) return hit;
      const r = await fetch(e.request); if (r.ok) c.put(req, r.clone()); return r;
    }
    try {
      const r = await fetch(e.request, { cache: "no-cache" }); // 有網路：最新版
      if (r.ok) c.put(req, r.clone());
      return r;
    } catch {
      return (await c.match(req)) || (await c.match("./index.html")) || Response.error(); // 沒網路：快取
    }
  }));
});
