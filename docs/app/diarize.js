// 說話者分群：把每句的聲紋向量歸到最像的群，太不像就開新群
// 可行性測試（三個合成語音）：同人相似度 0.86～0.95、不同人 0.08～0.34，門檻 0.6 中間有很寬的安全區
export const THRESHOLD = 0.5;   // 低於這個就是新的人（不同人實測最高 0.34，同一人偶爾會掉到 0.5 左右）
export const SURE = 0.72;       // 高於這個、而且比第二像的群高出 0.1 以上 → 很確定
const PALETTE = ["#2f6df6", "#1f9d55", "#c2410c", "#7c3aed", "#0e7490", "#be185d", "#4d7c0f", "#b45309"];
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

export class Diarizer {
  constructor(data) {
    this.clusters = []; // { id, label, named, centroid: Float32Array, n, color }
    if (data?.clusters) for (const c of data.clusters) this.clusters.push({ ...c, centroid: Float32Array.from(c.centroid) });
  }

  /** 回傳 { id, label, named, confidence: "high"|"medium"|"low", sim }
   *  allowNew=false（句子太短、聲紋不穩）：不開新群，歸到最像的那群但標成「不確定」 */
  assign(emb, { update = true, allowNew = true } = {}) {
    let best = null, bs = -1, second = -1;
    for (const c of this.clusters) {
      const s = dot(emb, c.centroid);
      if (s > bs) { second = bs; bs = s; best = c; } else if (s > second) second = s;
    }
    if (best && bs >= THRESHOLD) {
      if (update) {
        const n = best.n + 1, w = 1 / n;
        for (let i = 0; i < emb.length; i++) best.centroid[i] = best.centroid[i] * (1 - w) + emb[i] * w;
        let norm = 0; for (const v of best.centroid) norm += v * v; norm = Math.sqrt(norm) || 1;
        for (let i = 0; i < emb.length; i++) best.centroid[i] /= norm;
        best.n = n;
      }
      const confidence = bs >= SURE && bs - second >= 0.1 ? "high" : bs >= THRESHOLD + 0.05 ? "medium" : "low";
      return { id: best.id, label: best.label, named: best.named, confidence, sim: bs };
    }
    if (best && !allowNew && bs >= THRESHOLD - 0.2) return { id: best.id, label: best.label, named: best.named, confidence: "low", sim: bs };
    const c = this.create();
    c.centroid = Float32Array.from(emb); c.n = 1;
    return { id: c.id, label: c.label, named: false, confidence: "medium", sim: bs };
  }

  create() {
    const i = this.clusters.length;
    const c = { id: `s${Date.now().toString(36)}${i}`, label: `說話者 ${LETTERS[i % LETTERS.length]}`, named: false, centroid: null, n: 0, color: PALETTE[i % PALETTE.length] };
    this.clusters.push(c);
    return c;
  }
  get(id) { return this.clusters.find((c) => c.id === id); }
  rename(id, name) { const c = this.get(id); if (c) { c.label = name; c.named = true; } }
  /** 把 b 併進 a（使用者說「這兩個其實是同一個人」）*/
  merge(aId, bId) {
    const a = this.get(aId), b = this.get(bId);
    if (!a || !b || a === b) return;
    const n = a.n + b.n;
    for (let i = 0; i < a.centroid.length; i++) a.centroid[i] = (a.centroid[i] * a.n + b.centroid[i] * b.n) / n;
    let norm = 0; for (const v of a.centroid) norm += v * v; norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < a.centroid.length; i++) a.centroid[i] /= norm;
    a.n = n;
    this.clusters = this.clusters.filter((c) => c !== b);
  }
  /** 兩群的中心夠像（同一個人被分成兩群）就自動併起來；回傳 [{from,to}] 讓呼叫端更新舊句子 */
  autoMerge(minSim = 0.62) {
    const merged = [];
    for (let i = 0; i < this.clusters.length; i++) for (let j = i + 1; j < this.clusters.length; j++) {
      const a = this.clusters[i], b = this.clusters[j];
      if (a.named && b.named && a.label !== b.label) continue; // 使用者明確取了不同名字就別動
      if (dot(a.centroid, b.centroid) >= minSim) { const keep = b.named && !a.named ? b : a, drop = keep === a ? b : a; this.merge(keep.id, drop.id); merged.push({ from: drop.id, to: keep.id }); return merged.concat(this.autoMerge(minSim)); }
    }
    return merged;
  }
  toJSON() { return { clusters: this.clusters.map((c) => ({ ...c, centroid: Array.from(c.centroid) })) }; }
}
