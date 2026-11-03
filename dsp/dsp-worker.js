// 音訊前處理 worker（手機版和擴充功能共用同一份）：
//   1. RNNoise 降噪（48 kHz、每 10 ms 一幀）——把冷氣、鍵盤、街聲壓掉，Whisper 聽得更清楚
//   2. 降到 16 kHz 的 Int16（給 Whisper／聲紋）
//   3. Silero VAD——每 32 ms 判斷「是不是人在說話」，音樂、雜音都不算（實測：人聲中位數 1.0，音樂最高 0.09，雜音最高 0.04）
// 訊息：{type:"init", denoise, vad} → {type:"ready", denoise, vad}
//       {type:"process", ch, sr, x:Float32Array} → {type:"out", ch, pcm:Int16Array(16k), speech:0~1, level}
//       {type:"reset", ch}（一個通道重新開始時清掉它的狀態）
importScripts("./vendor/ort.min.js", "./vendor/rnnoise.js");
ort.env.wasm.wasmPaths = new URL("./vendor/", self.location.href).href; // 絕對路徑，否則會相對於 ort.min.js
ort.env.wasm.numThreads = 1;

const TARGET_SR = 16000, RN_SR = 48000, RN_FRAME = 480, VAD_WIN = 512, VAD_CTX = 64;
let rn = null, rnPtr = 0, vad = null, srTensor = null;
const chans = new Map(); // ch → { rnState, rnCarry:Float32Array, rnN, carry, vadState, vadCtx, vadCarry:Float32Array, vadN }

function chan(name) {
  let c = chans.get(name);
  if (!c) {
    c = { rnState: rn ? rn._rnnoise_create(0) : 0, rnCarry: new Float32Array(RN_FRAME), rnN: 0, carry: 0,
      vadState: null, vadCtx: new Float32Array(VAD_CTX), vadCarry: new Float32Array(VAD_WIN), vadN: 0, lastProb: 0 };
    chans.set(name, c);
  }
  return c;
}

// RNNoise：只在 48 kHz 時做（其他取樣率直接略過，不影響後面流程）。輸入是 ±1 的浮點，RNNoise 要 ±32768
function denoise(c, x) {
  const out = new Float32Array(x.length);
  let o = 0;
  const heap = rn.HEAPF32, base = rnPtr >> 2;
  // 先把上次剩的湊滿一幀
  let i = 0;
  while (i < x.length) {
    const take = Math.min(RN_FRAME - c.rnN, x.length - i);
    c.rnCarry.set(x.subarray(i, i + take), c.rnN); c.rnN += take; i += take;
    if (c.rnN < RN_FRAME) break;
    for (let k = 0; k < RN_FRAME; k++) heap[base + k] = c.rnCarry[k] * 32768;
    rn._rnnoise_process_frame(c.rnState, rnPtr, rnPtr);
    for (let k = 0; k < RN_FRAME; k++) out[o++] = heap[base + k] / 32768;
    c.rnN = 0;
  }
  return out.subarray(0, o); // 長度可能比輸入短最多 479 個樣本（下一次補回來）
}

function downsample(c, x, sr) {
  const step = sr / TARGET_SR, n = x.length;
  const outN = Math.floor((n + c.carry) / step);
  const pcm = new Int16Array(outN), f32 = new Float32Array(outN);
  let pos = -c.carry;
  for (let i = 0; i < outN; i++) {
    const a = Math.max(0, Math.round(pos)), b = Math.min(n, Math.round(pos + step));
    let acc = 0, cnt = 0;
    for (let j = a; j < b; j++) { acc += x[j]; cnt++; }
    const v = cnt ? acc / cnt : 0;
    f32[i] = v;
    pcm[i] = v <= -1 ? -32768 : v >= 1 ? 32767 : (v * 32767) | 0;
    pos += step;
  }
  c.carry = n - pos;
  return { pcm, f32 };
}

// Silero VAD v5：每 512 個樣本（32 ms）一個機率，前面接上上一窗的最後 64 個樣本當 context
async function speechProb(c, f32) {
  let i = 0, maxP = 0, ran = false;
  while (i < f32.length) {
    const take = Math.min(VAD_WIN - c.vadN, f32.length - i);
    c.vadCarry.set(f32.subarray(i, i + take), c.vadN); c.vadN += take; i += take;
    if (c.vadN < VAD_WIN) break;
    const inp = new Float32Array(VAD_CTX + VAD_WIN);
    inp.set(c.vadCtx); inp.set(c.vadCarry, VAD_CTX);
    c.vadCtx.set(c.vadCarry.subarray(VAD_WIN - VAD_CTX));
    c.vadState ??= new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    const r = await vad.run({ input: new ort.Tensor("float32", inp, [1, VAD_CTX + VAD_WIN]), state: c.vadState, sr: srTensor });
    c.vadState = r.stateN;
    const p = r.output.data[0];
    if (p > maxP) maxP = p;
    ran = true; c.vadN = 0;
  }
  if (ran) c.lastProb = maxP;
  return c.lastProb; // 這一塊沒湊滿一窗就沿用上一次的
}

self.onmessage = async (e) => {
  const d = e.data;
  try {
    if (d.type === "init") {
      let hasRn = false, hasVad = false;
      if (d.denoise !== false) {
        try { rn = createRNNWasmModuleSync(); if (rn.ready) await rn.ready; rnPtr = rn._malloc(RN_FRAME * 4); hasRn = true; } catch (err) { rn = null; console.warn("rnnoise", err); }
      }
      if (d.vad !== false) {
        try {
          vad = await ort.InferenceSession.create(new URL("./model/silero_vad.onnx", self.location.href).href, { executionProviders: ["wasm"] });
          srTensor = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
          hasVad = true;
        } catch (err) { vad = null; console.warn("vad", err); }
      }
      self.postMessage({ type: "ready", denoise: hasRn, vad: hasVad });
      return;
    }
    if (d.type === "reset") { const c = chans.get(d.ch); if (c) { if (rn && c.rnState) rn._rnnoise_destroy(c.rnState); chans.delete(d.ch); } return; }
    if (d.type === "process") {
      const c = chan(d.ch);
      let x = d.x;
      if (rn && d.sr === RN_SR) x = denoise(c, x);
      const { pcm, f32 } = downsample(c, x, d.sr);
      let sum = 0; for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
      const level = f32.length ? Math.sqrt(sum / f32.length) : 0;
      const speech = vad ? await speechProb(c, f32) : -1; // -1 = 沒有 VAD，呼叫端改用音量判斷
      self.postMessage({ type: "out", ch: d.ch, pcm, speech, level }, [pcm.buffer]);
    }
  } catch (err) { self.postMessage({ type: "error", ch: d.ch, error: err.message || String(err) }); }
};
