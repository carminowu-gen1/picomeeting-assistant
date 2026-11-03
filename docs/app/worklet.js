// AudioWorklet：把麥克風的聲音每 0.1 秒打包一次送回主執行緒（iPhone Safari 和 Android Chrome 都支援）
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.parts = [];
    this.len = 0;
    this.every = Math.round(sampleRate / 10);
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      this.parts.push(Float32Array.from(ch));
      this.len += ch.length;
      if (this.len >= this.every) {
        const out = new Float32Array(this.len);
        let o = 0;
        for (const p of this.parts) { out.set(p, o); o += p.length; }
        this.port.postMessage({ sr: sampleRate, data: out }, [out.buffer]);
        this.parts = [];
        this.len = 0;
      }
    }
    return true;
  }
}
registerProcessor("capture", CaptureProcessor);
