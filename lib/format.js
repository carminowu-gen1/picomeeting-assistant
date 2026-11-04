export const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "auto",         // auto = 依 Groq 現有模型自動挑
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

export let LABELS = { summary: "會議摘要", points: "重點整理", decisions: "決議事項", todo: "待辦事項", owner: "（負責：{x}）", due: "，期限：{x}", open: "後續追蹤 / 未決問題", transcript: "會議逐字稿", sep: "：",
  notes: { summary: "重點筆記", participants: "講者", decisions: "主要結論", work: "可以採取的行動", risks: "值得注意" },
  participants: "與會者", work: "工作分工表", timeline: "時程表", risks: "待確認與風險提醒", names: "語音辨識可能誤植的名稱", other: "其他", part: "第 {n} 場",
  cols: { no: "項次", task: "工作項目", owner: "負責人", helpers: "協辦", due: "期限", note: "備註／進度", when: "日期", item: "事項", status: "狀態" } };
export function setLocale(_locale, labels) { if (labels) LABELS = { ...LABELS, ...labels, cols: { ...LABELS.cols, ...(labels.cols || {}) } }; }
export const fmtTime = (t) => new Date(t).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
export const fmtDate = (t) => new Date(t).toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" });

export function transcriptText(m) {
  return m.lines.map((l) => (l.sep ? `\n=== ${l.text} ===` : `[${fmtTime(l.t)}] ${l.speaker}：${l.text}`)).join("\n");
}

// 把會議轉成統一的「段落清單」，Word / Google Docs / Markdown 都從這裡產生
// 每段：{ style: "title"|"h1"|"h2"|"p"|"bullet"|"meta"|"table", text | head+rows }
export function meetingToBlocks(m, settings) {
  const b = [];
  b.push({ style: "title", text: m.title });
  b.push({ style: "meta", text: m.combinedFrom?.length
    ? m.combinedFrom.map((p) => `${p.title}　${fmtDate(p.startedAt)}`).join("\n")
    : `${m.platformName || ""}　${fmtDate(m.startedAt)}${m.endedAt ? " – " + fmtTime(m.endedAt) : ""}` });
  b.push(...summaryBlocks(m.summary));
  if (settings.includeTranscript !== false && m.lines.length) {
    b.push({ style: "h1", text: LABELS.transcript });
    m.lines.forEach((l) => b.push(l.sep ? { style: "h2", text: l.text } : { style: "p", text: `[${fmtTime(l.t)}] ${l.speaker}${LABELS.sep}${l.text}` }));
  }
  return b;
}

// 摘要 → 段落清單（新版有主題、分工表、時程表；舊版摘要照舊顯示）
export function summaryBlocks(s, L = LABELS) {
  const b = [];
  if (!s) return b;
  if (s.kind === "notes") L = { ...L, ...(L.notes || {}) }; // 網頁／影片的重點筆記
  const section = (title, items) => {
    if (!items?.length) return;
    b.push({ style: "h1", text: title });
    items.forEach((x) => b.push({ style: "bullet", text: x }));
  };
  // 只留「至少有一列有內容」的欄位，空格補「—」
  const table = (items, cols, pool = items) => { // pool：決定要顯示哪些欄位（分組時用全部的工作，各組欄位才會一致）
    const used = cols.filter((c) => c.always || pool.some((a, i) => String(c.f(a, i) || "").trim()));
    return { style: "table", head: used.map((c) => L.cols[c.k]), rows: items.map((a, i) => used.map((c) => String(c.f(a, i) || "").trim() || "—")) };
  };
  b.push({ style: "h1", text: L.summary });
  if (s.participants?.length) b.push({ style: "p", text: L.participants + L.sep + s.participants.map((p) => (p.role ? `${p.name}（${p.role}）` : p.name)).join("、") });
  String(s.summary || "").split(/\n+/).filter((t) => t.trim()).forEach((t) => b.push({ style: "p", text: t.trim() }));
  if (s.topics?.length) s.topics.forEach((t, i) => { b.push({ style: "h2", text: `${i + 1}. ${t.title}` }); t.points.forEach((x) => b.push({ style: "bullet", text: x })); });
  else section(L.points, s.key_points);
  section(L.decisions, s.decisions);
  const todo = s.action_items || [];
  if (todo.length && s.kind === "notes") {
    b.push({ style: "h1", text: L.work });
    todo.forEach((a) => b.push({ style: "bullet", text: a.task + (a.note ? `（${a.note}）` : "") }));
  } else if (todo.length && s.v >= 2) {
    b.push({ style: "h1", text: L.work });
    const groups = [];
    for (const a of todo) { let g = groups.find((x) => x.name === a.group); if (!g) groups.push((g = { name: a.group, items: [] })); g.items.push(a); }
    const many = groups.length > 1;
    groups.forEach((g, gi) => {
      const letter = many ? String.fromCharCode(65 + (gi % 26)) : "";
      if (many) b.push({ style: "h2", text: `${letter}. ${g.name || L.other}` });
      b.push(table(g.items, [
        { k: "no", always: true, f: (_, i) => `${letter}${i + 1}` }, { k: "task", always: true, f: (a) => a.task }, { k: "owner", always: true, f: (a) => a.owner },
        { k: "helpers", f: (a) => a.helpers }, { k: "due", f: (a) => a.due }, { k: "note", f: (a) => a.note },
      ], todo));
    });
  } else if (todo.length) {
    b.push({ style: "h1", text: L.todo });
    todo.forEach((a) => b.push({ style: "bullet", text: `${a.task}${a.owner ? L.owner.replace("{x}", a.owner) : ""}${a.due ? L.due.replace("{x}", a.due) : ""}` }));
  }
  if (s.timeline?.length) {
    b.push({ style: "h1", text: L.timeline });
    b.push(table(s.timeline, [{ k: "when", always: true, f: (x) => x.when }, { k: "item", always: true, f: (x) => x.item }, { k: "owner", f: (x) => x.owner }, { k: "status", f: (x) => x.status }]));
  }
  section(s.v >= 2 ? L.risks : L.open, s.open_questions);
  section(L.names, s.name_notes);
  return b;
}

const hEsc = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** 摘要的 HTML（側邊欄、手機版共用）；表格外面包一層可左右捲動 */
export function summaryHtml(s, L = LABELS) {
  let html = "", ul = false;
  for (const x of summaryBlocks(s, L)) {
    if (x.style !== "bullet" && ul) { html += "</ul>"; ul = false; }
    if (x.style === "h1") html += `<h3>${hEsc(x.text)}</h3>`;
    else if (x.style === "h2") html += `<h4>${hEsc(x.text)}</h4>`;
    else if (x.style === "bullet") { if (!ul) { html += "<ul>"; ul = true; } html += `<li>${hEsc(x.text)}</li>`; }
    else if (x.style === "table") html += `<div class="tbl"><table><thead><tr>${x.head.map((h) => `<th>${hEsc(h)}</th>`).join("")}</tr></thead><tbody>${x.rows.map((r) => `<tr>${r.map((c) => `<td>${hEsc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    else html += `<p>${hEsc(x.text)}</p>`;
  }
  return html + (ul ? "</ul>" : "");
}

/** 只有摘要的純文字（複製摘要用） */
export function summaryToPlainText(s, L = LABELS) { return blocksToPlain(summaryBlocks(s, L)).trim(); }

// 會議裡的人可以控制自己的名字和說的話：跳脫 Markdown 符號，避免貼到 Notion／GitHub 時變成連結、圖片或標題
const mdEscape = (t) => String(t).replace(/[\\`*_[\]()<>!#|~]/g, "\\$&");

export function meetingToMarkdown(m, settings) {
  return meetingToBlocks(m, settings)
    .map((x) => {
      const t = x.style === "table" ? "" : mdEscape(x.text);
      switch (x.style) {
        case "title": return `# ${t}\n`;
        case "meta": return `_${t}_\n`;
        case "h1": return `\n## ${t}\n`;
        case "h2": return `\n### ${t}\n`;
        case "bullet": return `- ${t}`;
        case "table": return `\n| ${x.head.map(mdEscape).join(" | ")} |\n|${x.head.map(() => " --- ").join("|")}|\n` + x.rows.map((r) => `| ${r.map((c) => mdEscape(c).replace(/\n/g, " ")).join(" | ")} |`).join("\n") + "\n";
        default: return `${t}\n`;
      }
    })
    .join("\n");
}

function blocksToPlain(blocks) {
  return blocks
    .map((x) => x.style === "table" ? [x.head.join("｜"), ...x.rows.map((r) => r.join("｜"))].join("\n")
      : x.style === "bullet" ? `• ${x.text}` : x.style === "h2" ? `\n【${x.text}】` : x.style.startsWith("h") || x.style === "title" ? `\n${x.text}\n${"─".repeat(20)}` : x.text)
    .join("\n");
}
export function meetingToPlainText(m, settings) { return blocksToPlain(meetingToBlocks(m, settings)); }
