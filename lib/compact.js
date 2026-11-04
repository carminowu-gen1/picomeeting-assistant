// 逐字稿壓縮：在送進 LLM 前盡量少用 token，但保留語意
// 手段：合併同一人連續發言、時間戳改成每 10 分鐘一個標記、發言者改短代號、去填充詞、去重複句

const FILLERS = [
  /(?:^|\s)(嗯+|呃+|啊+|欸+|喔+|哦+|唉+)(?=[\s，,。]|$)/g,
  /(?:那個|就是說|就是|然後呢|然後|基本上|其實|對對對|對啊|對不對|好的|OK|ok|okay|呃呃)[，,]?\s*/g,
  /\b(um+|uh+|hmm+|like|you know|I mean|sort of|kind of|basically|actually)\b[,]?\s*/gi,
];

export function cleanText(text) {
  let t = text;
  for (const re of FILLERS) t = t.replace(re, " ");
  return t
    .replace(/([，,。．.！!？?])\1+/g, "$1") // 重複標點
    .replace(/(.{2,8}?)\1{2,}/g, "$1")      // 同一片語重複三次以上（字幕常見）
    .replace(/\s+/g, " ")
    .replace(/\s*([，,。！？])\s*/g, "$1")
    .trim();
}

const CODES = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * @returns {{ text: string, legend: string, stats: { before: number, after: number } }}
 */
export function compactTranscript(lines, { markerMinutes = 10 } = {}) {
  const before = lines.reduce((n, l) => n + l.speaker.length + l.text.length + 12, 0);
  if (!lines.length) return { text: "", legend: "", stats: { before, after: 0 } };

  // 發言者 → 代號（只有一位發言者就不用代號）
  const speakers = [...new Set(lines.filter((l) => !l.sep).map((l) => l.speaker))];
  const code = new Map(speakers.map((s, i) => [s, speakers.length > 1 ? CODES[i % 26] + (i >= 26 ? Math.floor(i / 26) : "") : ""]));
  const legend = speakers.length > 1 ? speakers.map((s) => `${code.get(s)}=${s}`).join("，") : "";

  const out = [];
  let cur = null;
  let lastMarker = -Infinity;
  let t0 = null;
  const seen = new Set();

  for (const l of lines) {
    if (l.sep) { // 合併多場會議：場次分隔，時間重新起算
      if (cur) { out.push(cur); cur = null; }
      out.push(`=== ${l.text} ===`);
      t0 = null; lastMarker = -Infinity;
      continue;
    }
    if (t0 == null) t0 = l.t;
    const text = cleanText(l.text);
    if (text.length < 2) continue;
    const key = l.speaker + "|" + text;
    if (seen.has(key)) continue; // 字幕引擎重送的同一句
    seen.add(key);

    const min = Math.floor((l.t - t0) / 60000);
    if (min - lastMarker >= markerMinutes) {
      if (cur) { out.push(cur); cur = null; }
      out.push(`[+${min}分]`);
      lastMarker = min;
    }
    if (cur && cur.speaker === l.speaker) {
      cur.parts.push(text);
    } else {
      if (cur) out.push(cur);
      cur = { speaker: l.speaker, parts: [text] };
    }
  }
  if (cur) out.push(cur);

  const text = out
    .map((x) => (typeof x === "string" ? x : `${code.get(x.speaker) ? code.get(x.speaker) + ":" : ""}${joinParts(x.parts)}`))
    .join("\n");
  return { text, legend, stats: { before, after: text.length + legend.length } };
}

// 片段之間若沒有結尾標點就補「，」，避免句子黏在一起
function joinParts(parts) {
  return parts.reduce((acc, p) => (acc ? acc + (/[。！？!?.]$/.test(acc) ? "" : "，") + p : p), "");
}

// 粗略估 token：中文約 1 字 ≈ 1 token，英文約 4 字元 ≈ 1 token
export function estimateTokens(text) {
  const cjk = (text.match(/[　-鿿＀-￯]/g) || []).length;
  return Math.round(cjk + (text.length - cjk) / 4);
}

// 依字元長度切段，盡量在換行處切
export function splitChunks(text, maxChars) {
  const chunks = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}
