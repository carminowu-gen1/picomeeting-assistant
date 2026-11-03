// 錄音：麥克風 → AudioWorklet → 降到 16 kHz → 依停頓切段 → 每段給一個 WAV（給 Whisper）和原始樣本（給聲紋）
// 邏輯和電腦版 offscreen/offscreen.js 相同，只是聲音來源換成 AudioWorklet（手機瀏覽器通用）
export const TARGET_SR = 16000;
const MIN_MS = 2500;        // 太短的段落辨識不準
const MAX_MS = 9000;        // 一直有聲音時的上限
const PAUSE_MS = 600;       // 靜音多久算一句講完
const MIN_VOICE_MS = 500;   // 一段裡「有人在說話」不到這麼久就當雜音不送
const PREROLL_S = 0.5;      // 說話前保留的前置音

export class Recorder {
  constructor({ onChunk, onLevel, onError } = {}) {
    this.onChunk = onChunk; this.onLevel = onLevel; this.onError = onError;
    this.running = false;
    this.reset();
  }
  reset() {
    this.chunks = []; this.samples = 0; this.startedAt = 0; this.hadVoice = false; this.lastVoiceAt = 0;
    this.voicedMs = 0; this.carry = 0; this.floor = undefined; this.peak = 0; this.level = 0;
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
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

  // 「有人在說話」= 明顯高於背景雜音（自動估計），且至少 0.008
  isVoiced(r) {
    this.floor ??= 0.01;
    this.floor = r < this.floor ? this.floor * 0.5 + r * 0.5 : this.floor * 0.998 + r * 0.002;
    return r >= Math.max(0.008, this.floor * 3);
  }

  ingest(sr, x) {
    const n = x.length;
    if (!n || !this.running) return;
    const now = Date.now();
    if (!this.startedAt) { this.startedAt = now; this.peak = 0; this.hadVoice = false; this.lastVoiceAt = now; this.voicedMs = 0; }

    let sum = 0;
    for (let i = 0; i < n; i++) sum += x[i] * x[i];
    const r = Math.sqrt(sum / n);
    this.level = r;
    if (r > this.peak) this.peak = r;
    const frameMs = (n / sr) * 1000;
    const voiced = this.isVoiced(r);
    if (voiced) { this.hadVoice = true; this.lastVoiceAt = now; this.voicedMs += frameMs; }
    this.onLevel?.(r, voiced);

    // 降到 16 kHz：每 step 個原始樣本平均成一個
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
    this.chunks.push(pcm);
    this.samples += outN;

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
    if (voicedMs < MIN_VOICE_MS) return; // 只有雜音：跳過
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
