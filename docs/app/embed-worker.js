// 聲紋 Worker：收到 16 kHz 的樣本 → 算 fbank 特徵 → 跑 CAM++ 模型 → 回傳 192 維聲紋向量
// 放在 Worker 裡跑，算的時候畫面不會卡
importScripts("./vendor/ort.min.js");
ort.env.wasm.wasmPaths = new URL("./vendor/", self.location.href).href; // 絕對路徑，否則會相對於 ort.min.js 變成 vendor/vendor/
ort.env.wasm.numThreads = 1; // GitHub Pages 沒有 cross-origin isolation，多執行緒用不了

const SR = 16000, FRAME = 400, SHIFT = 160, NFFT = 512, NMEL = 80;

// ── Kaldi 風格 fbank（與 sherpa-onnx 同參數：dither 0、preemph 0.97、Povey 窗、去直流、snip_edges）──
const mel = (f) => 1127 * Math.log(1 + f / 700);
const BANKS = (() => {
  const nyq = SR / 2, lo = mel(20), hi = mel(nyq), d = (hi - lo) / (NMEL + 1), nb = NFFT / 2 + 1, banks = [];
  for (let m = 0; m < NMEL; m++) {
    const L = lo + m * d, C = L + d, R = L + 2 * d, w = new Float32Array(nb);
    let first = -1, last = -1;
    for (let k = 0; k < nb; k++) {
      const mk = mel(k * SR / NFFT);
      if (mk > L && mk < R) { w[k] = mk <= C ? (mk - L) / (C - L) : (R - mk) / (R - C); if (first < 0) first = k; last = k; }
    }
    banks.push({ w, first, last });
  }
  return banks;
})();
const WIN = Float32Array.from({ length: FRAME }, (_, i) => Math.pow(0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1)), 0.85));
const re = new Float32Array(NFFT), im = new Float32Array(NFFT), fr = new Float32Array(FRAME);

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function fbank(x) {
  const T = Math.max(0, 1 + Math.floor((x.length - FRAME) / SHIFT));
  const feats = new Float32Array(T * NMEL);
  for (let t = 0; t < T; t++) {
    const off = t * SHIFT;
    let mean = 0; for (let i = 0; i < FRAME; i++) mean += x[off + i]; mean /= FRAME;
    for (let i = 0; i < FRAME; i++) fr[i] = x[off + i] - mean;
    for (let i = FRAME - 1; i > 0; i--) fr[i] -= 0.97 * fr[i - 1]; fr[0] -= 0.97 * fr[0];
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME; i++) re[i] = fr[i] * WIN[i];
    fft(re, im);
    for (let m = 0; m < NMEL; m++) {
      const { w, first, last } = BANKS[m]; let e = 0;
      for (let k = first; k <= last; k++) e += w[k] * (re[k] * re[k] + im[k] * im[k]);
      feats[t * NMEL + m] = Math.log(Math.max(e, 1.1920929e-7));
    }
  }
  for (let m = 0; m < NMEL; m++) { let s = 0; for (let t = 0; t < T; t++) s += feats[t * NMEL + m]; s /= T || 1; for (let t = 0; t < T; t++) feats[t * NMEL + m] -= s; } // global-mean
  return { feats, T };
}

let session = null, ready = null;
function init(modelUrl) {
  ready ??= ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] }).then((s) => { session = s; return true; });
  return ready;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === "init") { const t0 = performance.now(); await init(e.data.modelUrl); self.postMessage({ id, ok: true, ms: performance.now() - t0 }); return; }
    if (type === "embed") {
      await ready;
      const x = e.data.pcm instanceof Float32Array ? e.data.pcm : Float32Array.from(e.data.pcm, (v) => v / 32768);
      const t0 = performance.now();
      const { feats, T } = fbank(x);
      if (T < 20) { self.postMessage({ id, ok: false, error: "too short" }); return; }
      const r = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", feats, [1, T, NMEL]) });
      const emb = Float32Array.from(r[session.outputNames[0]].data);
      let n = 0; for (const v of emb) n += v * v; n = Math.sqrt(n) || 1;
      for (let i = 0; i < emb.length; i++) emb[i] /= n; // 正規化，之後用內積就是 cosine
      self.postMessage({ id, ok: true, emb, ms: performance.now() - t0 }, [emb.buffer]);
    }
  } catch (err) { self.postMessage({ id, ok: false, error: err.message || String(err) }); }
};
