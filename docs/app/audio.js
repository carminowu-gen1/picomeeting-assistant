// 錄音：麥克風 → AudioWorklet → DSP worker（RNNoise 降噪 → 16 kHz → Silero VAD 人聲偵測）→ 依停頓切段
//       → 每段給一個 WAV（給 Whisper）和原始樣本（給聲紋）
// 邏輯和電腦版 offscreen/offscreen.js 相同，只是聲音來源換成 AudioWorklet（手機瀏覽器通用）
export const TARGET_SR = 16000;
const MIN_MS = 2500;        // 太短的段落辨識不準
const MAX_MS = 9000;        // 一直有聲音時的上限
const PAUSE_MS = 600;       // 靜音多久算一句講完
const MIN_VOICE_MS = 500;   // 一段裡「有人在說話」不到這麼久就當雜音不送
const PREROLL_S = 0.5;      // 說話前保留的前置音
const SOFT_AGC_TARGET = 0.08; // 軟體增益的目標音量（RMS）
const SOFT_AGC_MAX = 12;      // 最多放大幾倍
const SPEECH_P = 0.5;         // Silero VAD 機率高於這個才算有人在說話

export class Recorder {
  constructor({ onChunk, onLevel, onError, onDsp } = {}) {
    this.onChunk = onChunk; this.onLevel = onLevel; this.onError = onError; this.onDsp = onDsp;
    this.running = false;
    this.dsp = { worker: null, ready: false, denoise: false, vad: false };
    this.reset();
  }
  reset() {
    this.chunks = []; this.samples = 0; this.startedAt = 0; this.hadVoice = false; this.lastVoiceAt = 0;
    this.voicedMs = 0; this.carry = 0; this.floor = undefined; this.peak = 0; this.level = 0; this.gain = 1; this.lastSpeech = false;
  }

  // DSP worker 載入失敗（很舊的瀏覽器）就退回「看音量」的做法，功能照常
  async startDsp() {
    if (this.dsp.worker) return;
    try {
      const w = new Worker(new URL("./dsp-worker.js?v=2", import.meta.url));
      this.dsp.worker = w;
      const ready = new Promise((res, rej) => {
        w.onmessage = (e) => {
          const d = e.data;
          if (d.type === "ready") { this.dsp.ready = true; this.dsp.denoise = d.denoise; this.dsp.vad = d.vad; this.onDsp?.(this.dsp); res(); }
          else if (d.type === "out") this.consume(d.pcm, d.speech, d.level);
          else if (d.type === "error") this.onError?.(new Error(d.error));
        };
        w.onerror = (e) => rej(new Error(e.message));
      });
      w.postMessage({ type: "init" });
      await ready;
    } catch (e) { this.dsp.worker?.terminate(); this.dsp.worker = null; this.dsp.ready = false; this.onDsp?.(this.dsp); }
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    // 瀏覽器有沒有真的開自動增益（AGC）？沒有的話就自己做軟體增益，放桌子中間遠一點也收得到
    const st = this.stream.getAudioTracks()[0]?.getSettings?.() || {};
    this.browserAgc = st.autoGainControl === true;
    this.softAgc = !this.browserAgc;
    await this.startDsp();
    this.ctx = new AudioContext();
    await this.ctx.resume();
    await this.ctx.audioWorklet.addModule(new URL("./worklet.js", import.meta.url));
    this.src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.mute = this.ctx.createGain(); this.mute.gain.value = 0;
    this.src.connect(this.node); this.node.connect(this.mute); this.mute.connect(this.ctx.destination); // 接到輸出 worklet 才會跑，但音量 0 不會回放
    this.node.port.onmessage = (e) => { try { this.ingest(e.data.sr, e.data.data); } catch (err) { this.onError?.(err); } };
    this.running = true;
    this.reset();
    this.dsp.worker?.postMessage({ type: "reset", ch: "mic" });
    this.startedWall = Date.now();
    // 手機切到背景再回來，AudioContext 可能被暫停
    this._vis = () => { if (this.running && this.ctx?.state === "suspended") this.ctx.resume().catch(() => {}); };
    document.addEventListener("visibilitychange", this._vis);
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    document.removeEventListener("visibilitychange", this._vis);
    this.flush(true);
    try { this.node?.port.close(); this.node?.disconnect(); this.src?.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
    await this.ctx?.close().catch(() => {});
  }

  // 「有人在說話」（沒有 VAD 時的備案）= 明顯高於背景雜音（自動估計），且至少 0.008
  isVoiced(r) {
    this.floor ??= 0.01;
    this.floor = r < this.floor ? this.floor * 0.5 + r * 0.5 : this.floor * 0.998 + r * 0.002;
    return r >= Math.max(0.008, this.floor * 3);
  }

  // 收到一塊原始聲音（約 0.1 秒）：軟體增益 → 丟給 DSP worker；沒有 worker 就自己降到 16 kHz
  ingest(sr, x) {
    const n = x.length;
    if (!n || !this.running) return;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += x[i] * x[i];
    const r = Math.sqrt(sum / n);
    const rawVoiced = this.dsp.vad ? this.lastSpeech : this.isVoiced(r);
    if (this.softAgc) {
      // 軟體 AGC：有人說話時把音量慢慢拉到目標大小（上限 12 倍），安靜時不動，避免把雜音放大
      if (rawVoiced && r > 0) { const want = Math.min(SOFT_AGC_MAX, Math.max(1, SOFT_AGC_TARGET / r)); this.gain += (want - this.gain) * (want < this.gain ? 0.5 : 0.08); }
      if (this.gain > 1.001) for (let i = 0; i < n; i++) { const v = x[i] * this.gain; x[i] = v > 1 ? 1 : v < -1 ? -1 : v; }
    }
    if (this.dsp.ready) { this.dsp.worker.postMessage({ type: "process", ch: "mic", sr, x }, [x.buffer]); return; }

    // 備案：自己降到 16 kHz，用音量判斷
    const step = sr / TARGET_SR;
    const outN = Math.floor((n + this.carry) / step);
    const pcm = new Int16Array(outN);
    let pos = -this.carry;
    for (let i = 0; i < outN; i++) {
      const a = Math.max(0, Math.round(pos)), b = Math.min(n, Math.round(pos + step));
      let acc = 0, cnt = 0;
      for (let j = a; j < b; j++) { acc += x[j]; cnt++; }
      const v = cnt ? acc / cnt : 0;
      pcm[i] = v <= -1 ? -32768 : v >= 1 ? 32767 : (v * 32767) | 0;
      pos += step;
    }
    this.carry = n - pos;
    this.consume(pcm, -1, Math.min(1, r * this.gain));
  }

  // 16 kHz 的樣本 + 人聲機率（-1 = 沒有 VAD）→ 切段
  consume(pcm, speech, level) {
    if (!this.running || !pcm.length) return;
    const now = Date.now();
    if (!this.startedAt) { this.startedAt = now; this.peak = 0; this.hadVoice = false; this.lastVoiceAt = now; this.voicedMs = 0; }
    const voiced = speech >= 0 ? speech >= SPEECH_P : this.isVoiced(level);
    this.lastSpeech = voiced;
    this.level = level;
    if (level > this.peak) this.peak = level;
    const frameMs = (pcm.length / TARGET_SR) * 1000;
    if (voiced) { this.hadVoice = true; this.lastVoiceAt = now; this.voicedMs += frameMs; }
    this.onLevel?.(level, voiced);

    this.chunks.push(pcm);
    this.samples += pcm.length;

    // 還沒有人說話：只留最後 0.5 秒當前置音
    if (!this.hadVoice) {
      const keep = TARGET_SR * PREROLL_S;
      while (this.chunks.length > 1 && this.samples - this.chunks[0].length >= keep) this.samples -= this.chunks.shift().length;
      this.startedAt = now - (this.samples / TARGET_SR) * 1000;
    }

    const elapsed = now - this.startedAt;
    if (elapsed >= MAX_MS || (this.hadVoice && elapsed >= MIN_MS && now - this.lastVoiceAt >= PAUSE_MS)) this.flush();
  }

  flush(final = false) {
    const { chunks, samples, startedAt, voicedMs, peak } = this;
    this.chunks = []; this.samples = 0; this.startedAt = 0;
    if (!samples) return;
    if (voicedMs < MIN_VOICE_MS) return; // 只有雜音／音樂：跳過，不送 Whisper
    const pcm = new Int16Array(samples);
    let o = 0;
    for (const c of chunks) { pcm.set(c, o); o += c.length; }
    this.onChunk?.({ wav: toWav(pcm), pcm, startedAt, voicedMs: Math.round(voicedMs), peak, final });
  }
}

// 16 kHz、單聲道、16-bit 的 WAV
export function toWav(pcm) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, TARGET_SR, true); v.setUint32(28, TARGET_SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}
