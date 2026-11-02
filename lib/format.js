export const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "llama-3.3-70b-versatile",
  autoFallback: true,
  tokenSaver: true,
  sttMode: "stt",      // captions | stt | both（預設語音辨識：Meet 內建字幕不夠準）
  sttLanguage: "auto", // Whisper 語言碼；auto = 每段自動偵測（中英夾雜也可）
  sttMic: true,
  sttMicDeviceId: "",  // 指定麥克風裝置；空 = 系統預設        // 混入自己的麥克風（分頁音訊沒有自己的聲音）
  sttSpeaker: "遠端",
  toTraditional: true, // 把簡體輸出轉成繁體
  myName: "",          // 你在逐字稿裡的名字（自己的 tile 會用這個）
  language: "繁體中文",
  autoStart: false,
  autoCaptions: true,
  autoSummarize: true,
  includeTranscript: true,
  theme: "auto", // auto | light | dark
};

export const fmtTime = (t) => new Date(t).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
export const fmtDate = (t) => new Date(t).toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" });

export function transcriptText(m) {
  return m.lines.map((l) => `[${fmtTime(l.t)}] ${l.speaker}：${l.text}`).join("\n");
}

// 把會議轉成統一的「段落清單」，Word / Google Docs / Markdown 都從這裡產生
// 每段：{ style: "title"|"h1"|"h2"|"p"|"bullet"|"meta", text }
export function meetingToBlocks(m, settings) {
  const b = [];
  const s = m.summary;
  b.push({ style: "title", text: m.title });
  b.push({ style: "meta", text: `${m.platformName || ""}　${fmtDate(m.startedAt)}${m.endedAt ? " – " + fmtTime(m.endedAt) : ""}` });

  if (s) {
    b.push({ style: "h1", text: "會議摘要" });
    b.push({ style: "p", text: s.summary });
    const section = (title, items) => {
      if (!items?.length) return;
      b.push({ style: "h1", text: title });
      items.forEach((x) => b.push({ style: "bullet", text: x }));
    };
    section("重點整理", s.key_points);
    section("決議事項", s.decisions);
    if (s.action_items?.length) {
      b.push({ style: "h1", text: "待辦事項" });
      s.action_items.forEach((a) =>
        b.push({ style: "bullet", text: `${a.task}${a.owner ? `（負責：${a.owner}）` : ""}${a.due ? `，期限：${a.due}` : ""}` })
      );
    }
    section("後續追蹤 / 未決問題", s.open_questions);
  }

  if (settings.includeTranscript !== false && m.lines.length) {
    b.push({ style: "h1", text: "會議逐字稿" });
    m.lines.forEach((l) => b.push({ style: "p", text: `[${fmtTime(l.t)}] ${l.speaker}：${l.text}` }));
  }
  return b;
}

export function meetingToMarkdown(m, settings) {
  return meetingToBlocks(m, settings)
    .map((x) => {
      switch (x.style) {
        case "title": return `# ${x.text}\n`;
        case "meta": return `_${x.text}_\n`;
        case "h1": return `\n## ${x.text}\n`;
        case "h2": return `\n### ${x.text}\n`;
        case "bullet": return `- ${x.text}`;
        default: return `${x.text}\n`;
      }
    })
    .join("\n");
}

export function meetingToPlainText(m, settings) {
  return meetingToBlocks(m, settings)
    .map((x) => (x.style === "bullet" ? `• ${x.text}` : x.style.startsWith("h") || x.style === "title" ? `\n${x.text}\n${"─".repeat(20)}` : x.text))
    .join("\n");
}
