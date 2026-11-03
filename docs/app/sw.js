// Service worker：把 App 本身、onnxruntime 和聲紋模型存在手機裡，第二次打開不用再下載
const CACHE = "pm-app-v7";
const CORE = ["./", "./index.html", "./app.css", "./app.js", "./audio.js", "./worklet.js", "./diarize.js", "./filters.js", "./store.js", "./embed-worker.js", "./dsp-worker.js", "./vendor/rnnoise.js", "./model/silero_vad.onnx",
  "./manifest.json", "./icons/icon48.png", "./icons/icon128.png",
  "./lib/groq.js", "./lib/compact.js", "./lib/s2t.js", "./lib/format.js", "./lib/docx.js",
  "./vendor/ort.min.js", "./vendor/ort-wasm-simd-threaded.mjs", "./vendor/ort-wasm-simd-threaded.wasm"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Groq、GitHub API 一律走網路
  // 模型檔很大、不會變：有快取就直接用。其他檔案：先用快取、背景更新（下次打開就是新版）
  const isModel = url.pathname.endsWith(".onnx");
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      const fetchAndPut = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
      if (hit) { if (!isModel) fetchAndPut.catch(() => {}); return hit; }
      return fetchAndPut;
    })
  );
});
