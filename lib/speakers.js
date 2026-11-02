// 發言者時間軸：把語音辨識的句子對回「當時誰在說話」
// log: [{ t, names: [..] }]（names 空陣列 = 沒人在說話）

const MAX_LOG = 4000;

export function pushSpeakerEvent(log, t, names) {
  log.push({ t, names });
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
}

/**
 * 找出 [start, end] 這段時間裡講最久的人。
 * 沒有資料時回傳 null。
 */
export function speakerFor(log, start, end, { tolerance = 1500 } = {}) {
  if (!log?.length) return null;
  const dur = new Map();
  // 把時間軸切成區段：每個事件持續到下一個事件
  for (let i = 0; i < log.length; i++) {
    const a = log[i].t, b = i + 1 < log.length ? log[i + 1].t : Infinity;
    const s = Math.max(a, start - tolerance), e = Math.min(b, end + tolerance);
    if (e <= s) continue;
    for (const n of log[i].names) dur.set(n, (dur.get(n) || 0) + (e - s));
  }
  if (!dur.size) {
    // 這段沒人被標記為說話中：用最近一次在說話的人（字幕/指示常慢半拍）
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i].t <= end + tolerance && log[i].names.length) return log[i].names[0];
    }
    return null;
  }
  return [...dur.entries()].sort((x, y) => y[1] - x[1])[0][0];
}

/**
 * 把 Whisper 的 segments（相對秒數）轉成逐字稿行，並標上發言者；連續同一人合併。
 * @param {number} chunkStart 這段音訊開始的時間（ms）
 */
export function attributeSegments(log, segments, chunkStart, fallback = "語音") {
  const lines = [];
  for (const seg of segments) {
    const text = (seg.text || "").trim();
    if (!text) continue;
    const start = chunkStart + Math.round((seg.start || 0) * 1000);
    const end = chunkStart + Math.round((seg.end || seg.start || 0) * 1000);
    const speaker = speakerFor(log, start, end) || fallback;
    const last = lines[lines.length - 1];
    if (last && last.speaker === speaker && start - last.end < 4000) {
      last.text += (/[。！？!?.]$/.test(last.text) || /^[a-zA-Z]/.test(text) ? " " : "") + text;
      last.end = end;
    } else {
      lines.push({ t: start, end, speaker, text });
    }
  }
  return lines.map(({ t, speaker, text }) => ({ t, speaker, text: text.replace(/\s+/g, " ").trim() }));
}
