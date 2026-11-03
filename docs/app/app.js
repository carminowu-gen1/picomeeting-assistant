// 手機版會議摘要助理：錄音 → Groq Whisper → 聲紋分群 → 即時逐字稿 → 摘要 → 複製／Word
import { Recorder } from "./audio.js";
import { Diarizer } from "./diarize.js";
import { filterSegments } from "./filters.js";
import * as store from "./store.js";
import { summarizeTranscript, listModels, pickModels, CHEAP_MODELS } from "./lib/groq.js";
import { toTraditional } from "./lib/s2t.js";
import { meetingToPlainText, fmtTime, setLocale } from "./lib/format.js";
import { buildDocx } from "./lib/docx.js";
import { t, detectLang, setLang, applyI18n } from "./i18n.js";
import { setLabelFn } from "./diarize.js";

const VERSION = "1.3.1";
const GROQ = "https://api.groq.com";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let settings = store.getSettings();
let meeting = null;          // 目前顯示的會議
let diar = new Diarizer();
let rec = null, timerId = null, wakeLock = null, recording = false;
let queue = Promise.resolve(); // 每段音訊依序處理，分群才不會亂
let pending = 0;             // 還在辨識中的段數
let saveTimer = null;

/* ───────── 小工具 ───────── */
function toast(msg, error = false) {
  const t = $("toast"); t.textContent = msg; t.className = "toast show" + (error ? " error" : "");
  clearTimeout(t._h); t._h = setTimeout(() => (t.className = "toast"), error ? 5000 : 2500);
}
function show(id) { for (const s of document.querySelectorAll(".screen")) s.hidden = s.id !== id; }
function hdr() { return { authorization: "Bearer " + settings.apiKey }; }
function friendly(e) {
  const m = e?.message || String(e);
  if (/401|invalid api key|invalid_api_key/i.test(m)) return t("e_key");
  if (/429|rate limit/i.test(m)) return t("e_rate");
  if (/failed to fetch|network/i.test(m)) return t("e_net");
  return m.length > 120 ? m.slice(0, 120) + "…" : m;
}
async function checkKey(key) {
  const r = await fetch(`${GROQ}/openai/v1/models`, { headers: { authorization: "Bearer " + key } });
  if (r.status === 401) throw new Error("401");
  if (!r.ok) throw new Error("HTTP " + r.status);
  return true;
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (meeting) { meeting.diar = diar.toJSON(); store.saveMeeting(meeting); } }, 1500);
}
function applyBig() { document.body.classList.toggle("big", !!settings.bigText); }
// 介面語言：跟著手機（設定可指定）。日期、匯出標題、說話者標籤一起換
function applyLang() {
  setLang(detectLang(settings.uiLang));
  setLabelFn((letter) => t("speaker", { x: letter }));
  setLocale(t("locale"), { summary: t("sum_h"), points: t("sum_points"), decisions: t("sum_decisions"), todo: t("sum_todo"), owner: t("sum_owner"), due: t("sum_due"), open: t("x_open"), transcript: t("x_transcript"), sep: t("locale") === "en-US" ? ": " : "：" });
  applyI18n();
  diar.relabel();
  for (const l of meeting?.lines || []) l.speaker = diar.get(l.speakerId)?.label || l.speaker;
}
const sumLang = () => settings.language || t("sumLang");

/* ───────── 聲紋 worker ───────── */
let worker = null, workerReady = null, reqId = 0;
const waiting = new Map();
function startWorker() {
  if (workerReady) return workerReady;
  worker = new Worker(new URL("./embed-worker.js?v=" + VERSION, import.meta.url)); // 帶版號避免舊快取
  worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (w) { waiting.delete(e.data.id); w(e.data); } };
  worker.onerror = (e) => console.warn("worker", e.message);
  workerReady = call("init", { modelUrl: new URL("./model/campplus.onnx", import.meta.url).href })
    .then((r) => { if (!r.ok) throw new Error(r.error); $("sModel").textContent = t("vp_loaded", { ms: Math.round(r.ms) }); return true; })
    .catch((e) => { $("sModel").textContent = t("vp_err") + e.message; workerReady = null; throw e; });
  return workerReady;
}
function call(type, data) {
  return new Promise((res) => { const id = ++reqId; waiting.set(id, res); worker.postMessage({ id, type, ...data }); });
}
async function embed(pcm) {
  try { await startWorker(); } catch { return null; }
  const r = await call("embed", { pcm });
  return r.ok ? r.emb : null;
}

/* ───────── 語音辨識 ───────── */
// 「說話的語言」設定 → 允許的語言；auto 時 Whisper 偶爾會把含糊的中文聽成俄文、韓文之類，
// 偵測到不在清單裡的語言就用第一個語言（中文）重新辨識一次
const LANG_SETS = { auto: ["zh", "en"], "auto-ja": ["zh", "en", "ja"], "auto-all": null };
function allowedLangs() { const v = settings.sttLanguage || "auto"; return v in LANG_SETS ? LANG_SETS[v] : [v]; }
async function transcribe(wav, forceLang) {
  const fd = new FormData();
  fd.append("file", wav, "chunk.wav");
  fd.append("model", "whisper-large-v3");
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  const fixed = forceLang || (settings.sttLanguage && !settings.sttLanguage.startsWith("auto") ? settings.sttLanguage : "");
  if (fixed) fd.append("language", fixed);
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(`${GROQ}/openai/v1/audio/transcriptions`, { method: "POST", headers: hdr(), body: fd });
    if (r.status === 429 && attempt < 2) { await new Promise((z) => setTimeout(z, 2500 * (attempt + 1))); continue; }
    break;
  }
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 100)}`);
  const j = await r.json();
  return { segments: j.segments || (j.text ? [{ start: 0, end: 0, text: j.text }] : []), language: j.language || fixed || "" };
}

// 一段錄音：辨識 → 過濾 → 每句算聲紋 → 歸到說話者 → 加到逐字稿
async function handleChunk({ wav, pcm, startedAt }) {
  if (!meeting) return;
  let segs;
  try {
    let r = await transcribe(wav);
    const allow = allowedLangs();
    if (allow && r.language && !allow.includes(r.language)) r = await transcribe(wav, allow[0]); // 聽成不相干的語言 → 用中文再辨識一次
    segs = r.segments; setLight("groq", "ok");
  } catch (e) { toast(t("stt_fail") + friendly(e), true); setLight("groq", "bad", t("groq_err") + friendly(e)); return; }
  const { kept } = filterSegments(segs);
  if (!kept.length) return;
  // 整段的聲紋（當句子太短時的備援）
  let chunkEmb = null;
  for (const g of kept) {
    let text = g.text;
    if (settings.toTraditional) text = toTraditional(text); // 一律轉（只有一個簡體字也要轉）
    const a = Math.max(0, Math.floor(g.start * 16000)), b = Math.min(pcm.length, Math.ceil(g.end * 16000));
    let emb = null, conf = "low";
    if (b - a >= 16000) emb = await embed(pcm.subarray(a, b));
    if (!emb) { chunkEmb ??= await embed(pcm); emb = chunkEmb; }
    let who = { id: "", label: "？", confidence: "low" };
    if (emb) {
      // 不到 3 秒的句子聲紋不穩：不開新的人，寧可標成「不確定」讓使用者事後改
      const len = emb === chunkEmb ? pcm.length : b - a;
      who = diar.assign(emb, { allowNew: len >= 3 * 16000 });
      conf = emb === chunkEmb && b - a < 16000 ? (who.confidence === "high" ? "medium" : "low") : who.confidence;
    }
    const line = { t: startedAt + g.start * 1000, speakerId: who.id, speaker: who.label, confidence: conf, text };
    meeting.lines.push(line);
    appendLine(line, true);
  }
  // 同一個人不小心被分成兩群時，中心會越來越像 → 自動併回來
  const merged = diar.autoMerge();
  if (merged.length) {
    for (const { from, to } of merged) for (const l of meeting.lines) if (l.speakerId === from) l.speakerId = to;
    for (const l of meeting.lines) l.speaker = diar.get(l.speakerId)?.label || l.speaker;
    refreshChips();
  }
  scheduleSave();
}

/* ───────── 畫面：逐字稿 ───────── */
function chipFor(line) {
  const c = diar.get(line.speakerId);
  const color = c?.color || "#888";
  const mark = line.confidence === "high" ? "" : line.confidence === "medium" ? "" : " ?";
  return `<button class="chip ${line.confidence}" style="--c:${color}" data-id="${esc(line.speakerId)}" title="${t("chip_title")}">${esc(c?.label || line.speaker)}${mark}</button>`;
}
function lineHtml(line, i) {
  const tr = settings.translate && line.tr?.lang === trTarget() ? line.tr.text : "";
  return `<div class="lh">${chipFor(line)}<span class="t">${fmtTime(line.t)}</span></div><div class="tx" contenteditable="true" data-i="${i}">${esc(line.text)}</div><div class="trx" data-i="${i}">${esc(tr)}</div>`;
}
function appendLine(line, fresh) {
  const box = $("lines");
  box.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = "line" + (fresh ? " new" : "");
  el.innerHTML = lineHtml(line, meeting.lines.length - 1);
  box.appendChild(el);
  if (fresh) box.scrollTop = box.scrollHeight;
  if (settings.translate) scheduleTranslate();
}
function renderLines() {
  const box = $("lines");
  if (!meeting?.lines.length) {
    box.innerHTML = recording
      ? `<div class="empty"><div class="ill">👂</div><h3>${t("empty_listen_h")}</h3>${t("empty_listen_p")}</div>`
      : `<div class="empty"><div class="ill"><img src="icons/icon192.png" alt="" /></div><h3>${t("empty_h")}</h3><div class="steps"><div><span>📱</span>${t("empty_1")}</div><div><span>🎙️</span>${t("empty_2")}</div><div><span>📝</span>${t("empty_3")}</div></div></div>`;
    return;
  }
  box.innerHTML = meeting.lines.map((l, i) => `<div class="line">${lineHtml(l, i)}</div>`).join("");
  box.scrollTop = box.scrollHeight;
}
function refreshChips() { // 改名／合併後只換小標籤，不重畫整頁（避免輸入中的文字跑掉）
  for (const el of document.querySelectorAll("#lines .line")) {
    const i = +el.querySelector(".tx").dataset.i;
    el.querySelector(".lh").innerHTML = chipFor(meeting.lines[i]) + `<span class="t">${fmtTime(meeting.lines[i].t)}</span>`;
  }
}
$("lines").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip || !chip.dataset.id) return;
  const c = diar.get(chip.dataset.id);
  if (!c) return;
  const name = prompt(t("who"), c.named ? c.label : "");
  if (name === null) return;
  const nm = name.trim();
  if (!nm) return;
  const other = diar.clusters.find((x) => x !== c && x.label === nm);
  if (other) {
    diar.merge(other.id, c.id);
    for (const l of meeting.lines) if (l.speakerId === c.id) l.speakerId = other.id;
  } else diar.rename(c.id, nm);
  for (const l of meeting.lines) l.speaker = diar.get(l.speakerId)?.label || l.speaker;
  refreshChips(); scheduleSave();
});
$("lines").addEventListener("input", (e) => {
  const tx = e.target.closest(".tx");
  if (!tx || !meeting) return;
  meeting.lines[+tx.dataset.i].text = tx.textContent;
  scheduleSave();
});

/* ───────── 畫面：狀態 ───────── */
function setStatus(text, cls = "") { const b = $("badge"); b.textContent = text; b.className = "badge " + cls; }
function setHint(t) { $("hint").textContent = t; }
function tick() {
  if (!meeting?.startedAt) return;
  const s = Math.floor(((recording ? Date.now() : meeting.endedAt || Date.now()) - meeting.startedAt) / 1000);
  $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function updateButtons() {
  const has = !!meeting?.lines.length;
  $("doneBar").hidden = recording || !has;          // 散會後才出現「複製」「存成 Word」
  $("newBtn").hidden = recording || !has;
  $("recBtn").className = "rec" + (recording ? " stop" : "");
  $("recLabel").textContent = recording ? t("rec_stop") : has ? t("rec_cont") : t("rec_start");
  $("title").value = meeting?.title || "";
  setHint(recording ? t("hint_rec") : has ? t("hint_done") : "");
}

/* ───────── 錄音流程 ───────── */
function newMeeting() {
  meeting = { id: Date.now().toString(36), title: t("meeting_title", { d: new Date().toLocaleDateString(t("locale")) }), platformName: t("platform"), startedAt: 0, endedAt: 0, lines: [], summary: null, diar: null };
  diar = new Diarizer();
  $("summary").hidden = true; $("summary").innerHTML = "";
  $("timer").textContent = "00:00";
  renderLines(); updateButtons(); setStatus(t("ready"));
}
async function startRecording() {
  if (!settings.apiKey) { toast(t("need_key"), true); show("settings"); return; }
  if (!meeting || meeting.summary) newMeeting();
  if (!meeting.startedAt) meeting.startedAt = Date.now();
  meeting.endedAt = 0;
  $("recBtn").disabled = true;
  try {
    rec = new Recorder({
      onChunk: (c) => { pending++; queue = queue.then(() => handleChunk(c)).catch((e) => console.warn(e)).finally(() => { pending--; setStatus(recording ? (pending ? t("recognizing") : t("listening")) : pending ? t("finishing") : t("ended"), recording ? "rec" : "busy"); }); },
      onLevel: (r, voiced) => { const f = $("meter"); f.style.width = Math.min(100, r * 400) + "%"; f.classList.toggle("off", !voiced); },
      onError: (e) => toast(t("rec_err") + friendly(e), true),
      onDsp: (d) => { $("sDsp").textContent = d.ready ? `${d.denoise ? t("dsp_dn_ok") : t("dsp_dn_no")}　${d.vad ? t("dsp_vad_ok") : t("dsp_vad_no")}` : t("dsp_fail"); },
    });
    await rec.start();
  } catch (e) {
    $("recBtn").disabled = false;
    const denied = /NotAllowed|Permission/i.test(e.name + e.message);
    toast(denied ? t("mic_denied_start") : t("cant_start") + friendly(e), true);
    if (denied) setLight("mic", "bad", t("mic_off"));
    return;
  }
  startWorker().catch(() => toast(t("vp_fail"), true));
  recording = true;
  $("recBtn").disabled = false;
  setLight("mic", "ok");
  $("sAgc").textContent = rec.browserAgc ? t("agc_browser") : t("agc_soft");
  setStatus(t("listening"), "rec");
  renderLines(); updateButtons();
  clearInterval(timerId); timerId = setInterval(tick, 1000);
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  store.saveMeeting(meeting);
}
async function stopRecording() {
  if (!recording) return;
  recording = false;
  $("recBtn").disabled = true;
  await rec.stop(); rec = null;
  $("meter").style.width = "0";
  clearInterval(timerId);
  meeting.endedAt = Date.now(); tick();
  try { await wakeLock?.release(); } catch {} wakeLock = null;
  setStatus(pending ? t("finishing") : t("ended"), "busy");
  await queue;
  setStatus(t("ended"), "done");
  $("recBtn").disabled = false;
  updateButtons();
  meeting.diar = diar.toJSON(); store.saveMeeting(meeting);
  if (settings.autoSummarize !== false && meeting.lines.length) summarize();
}
document.addEventListener("visibilitychange", async () => { if (recording && document.visibilityState === "visible" && !wakeLock) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} } });

/* ───────── 翻譯：原文照記，另外在每句下面顯示翻譯（翻成介面語言） ───────── */
const trTarget = () => t("sumLang"); // 翻成介面語言
let trTimer = null, trBusy = false;
function scheduleTranslate() { clearTimeout(trTimer); trTimer = setTimeout(runTranslate, 1500); }
async function runTranslate() {
  if (trBusy || !settings.translate || !meeting) return;
  const target = trTarget();
  const todo = meeting.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.text.trim() && l.tr?.lang !== target).slice(0, 25);
  if (!todo.length) return;
  trBusy = true;
  try {
    const api = { apiBase: GROQ, apiHeaders: hdr() };
    const models = pickModels(await listModels(api), CHEAP_MODELS).slice(0, 4); // 現有的便宜模型，壞了換下一個
    const messages = [
      { role: "system", content: `You translate meeting transcript lines into ${target}. Keep numbers, names and meaning; do not add anything. If a line is already in ${target}, return it unchanged. Output JSON: {"t": [string, ...]} with exactly one item per input line, same order.` },
      { role: "user", content: JSON.stringify(todo.map(({ l }) => l.text)) },
    ];
    let out = null, lastErr = "";
    for (const model of models) {
      const r = await fetch(`${GROQ}/openai/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...hdr() }, body: JSON.stringify({ model, temperature: 0, response_format: { type: "json_object" }, messages }) });
      if (r.ok) { out = JSON.parse((await r.json()).choices?.[0]?.message?.content || "{}").t || []; break; }
      lastErr = `${r.status} ${(await r.text()).slice(0, 80)}`;
      if (r.status === 401 || r.status === 403) break;
    }
    if (!out) throw new Error(lastErr || "no model");
    todo.forEach(({ l, i }, k) => {
      let txt = typeof out[k] === "string" ? out[k].trim() : "";
      if (settings.toTraditional && target === "繁體中文") txt = toTraditional(txt);
      if (txt.replace(/\s/g, "") === l.text.replace(/\s/g, "")) txt = ""; // 本來就是目標語言：不重複顯示
      l.tr = { lang: target, text: txt };
      const el = document.querySelector(`#lines .trx[data-i="${i}"]`); if (el) el.textContent = txt;
    });
    scheduleSave();
    if (meeting.lines.some((l) => l.text.trim() && l.tr?.lang !== target)) scheduleTranslate(); // 還有沒翻的，繼續
  } catch (e) { toast(t("tr_fail") + friendly(e), true); }
  finally { trBusy = false; }
}
$("trBtn").onclick = () => {
  settings = store.saveSettings({ translate: !settings.translate });
  $("trBtn").dataset.state = settings.translate ? "on" : "off";
  toast(settings.translate ? t("tr_on") : t("tr_off"));
  renderLines();
  if (settings.translate) runTranslate();
};

/* ───────── 摘要／匯出 ───────── */
function summaryHtml(s) {
  const list = (t, items) => items?.length ? `<h3>${t}</h3><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  return `<h3>${t("sum_h")}</h3><p>${esc(s.summary)}</p>` + list(t("sum_points"), s.key_points) + list(t("sum_decisions"), s.decisions)
    + list(t("sum_todo"), s.action_items?.map((a) => `${a.task}${a.owner ? t("sum_owner", { x: a.owner }) : ""}${a.due ? t("sum_due", { x: a.due }) : ""}`))
    + list(t("sum_open"), s.open_questions) + (s.model ? `<p class="small muted">${esc(t("sum_by", { m: s.model }))}</p>` : "");
}
async function summarize() {
  if (!meeting?.lines.length) return;
  const box = $("summary");
  box.hidden = false; box.innerHTML = `<div class="wait"><span class="spin"></span> ${t("sum_wait")}</div>`;
  try {
    const s = await summarizeTranscript(meeting, { apiBase: GROQ, apiHeaders: hdr(), model: settings.model, autoFallback: settings.autoFallback, tokenSaver: settings.tokenSaver, language: sumLang(), toTraditional: settings.toTraditional });
    meeting.summary = s; store.saveMeeting(meeting);
    box.innerHTML = summaryHtml(s);
    toast(t("sum_done"));
  } catch (e) {
    box.innerHTML = `<div class="note"><span>${t("sum_fail")}${esc(friendly(e))}</span><button class="btn sm" id="retrySum">${t("retry")}</button></div>`;
    $("retrySum").onclick = summarize;
  }
}
async function copyAll() {
  let text = meetingToPlainText(meeting, { includeTranscript: true });
  if (settings.translate) text += "\n\n" + meeting.lines.map((l) => `[${fmtTime(l.t)}] ${l.speaker}: ${l.text}${l.tr?.text ? `\n　→ ${l.tr.text}` : ""}`).join("\n");
  try { await navigator.clipboard.writeText(text); toast(t("copied")); }
  catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast(t("copied2")); }
}
async function exportWord() {
  const blob = buildDocx(meeting, { includeTranscript: true });
  const name = `${meeting.title.replace(/[\\/:*?"<>|]/g, "_")}.docx`;
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: meeting.title }); return; } catch (e) { if (e.name === "AbortError") return; } }
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

/* ───────── 歷史／設定 ───────── */
function openMeeting(id) {
  const m = store.loadMeeting(id);
  if (!m) return;
  meeting = m; diar = new Diarizer(m.diar);
  renderLines(); updateButtons(); tick(); setStatus(m.endedAt ? t("ended") : t("ready"), m.endedAt ? "done" : "");
  $("summary").hidden = !m.summary; if (m.summary) $("summary").innerHTML = summaryHtml(m.summary);
  show("main");
}
function renderHistory() {
  const idx = store.listMeetings();
  $("histList").innerHTML = idx.length ? idx.map((x) => `<div class="item" data-id="${x.id}"><div><b>${esc(x.title)}</b><small>${fmtTime(x.startedAt)}・${t("hist_lines", { n: x.lines })}${x.hasSummary ? t("hist_sum") : ""}</small></div><button class="icon del" data-id="${x.id}" title="${t("del")}">🗑</button></div>`).join("")
    : `<div class="empty">${t("hist_empty")}</div>`;
}
$("histList").addEventListener("click", (e) => {
  const del = e.target.closest(".del");
  if (del) { if (confirm(t("del_q"))) { store.removeMeeting(del.dataset.id); if (meeting?.id === del.dataset.id) newMeeting(); renderHistory(); } return; }
  const it = e.target.closest(".item"); if (it) openMeeting(it.dataset.id);
});
function fillSettings() {
  $("sKey").value = settings.apiKey; $("sLang").value = settings.sttLanguage; $("sSumLang").value = settings.language || ""; $("sUiLang").value = settings.uiLang || "auto";
  $("sS2T").checked = settings.toTraditional; $("sBig").checked = settings.bigText; $("sAuto").checked = settings.autoSummarize !== false;
  $("sVer").textContent = VERSION;
}
function readSettings() {
  const uiChanged = ($("sUiLang").value || "auto") !== (settings.uiLang || "auto");
  settings = store.saveSettings({ apiKey: $("sKey").value.trim(), sttLanguage: $("sLang").value, language: $("sSumLang").value, uiLang: $("sUiLang").value, toTraditional: $("sS2T").checked, bigText: $("sBig").checked, autoSummarize: $("sAuto").checked });
  applyBig();
  if (uiChanged) { applyLang(); fillSettings(); renderLines(); updateButtons(); if (settings.translate) scheduleTranslate(); }
}
for (const id of ["sKey", "sLang", "sSumLang", "sUiLang", "sS2T", "sBig", "sAuto"]) $(id).addEventListener("change", readSettings);
$("sKeyCheck").onclick = async () => { const m = $("sKeyMsg"); m.textContent = t("checking"); m.className = "msg small"; try { await checkKey($("sKey").value.trim()); m.textContent = t("key_ok"); m.className = "msg small ok"; } catch (e) { m.textContent = "✗ " + friendly(e); m.className = "msg small err"; } };

/* ───────── 歡迎頁 ───────── */
let micOk = false, keyOk = false;
function welcomeCheck() { $("wDone").disabled = !(micOk && keyOk); }
$("wMic").onclick = async () => {
  const msg = $("wMicMsg");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ctx = new AudioContext(); await ctx.resume();
    const an = ctx.createAnalyser(); an.fftSize = 512; ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize); let peak = 0; const t0 = Date.now();
    msg.textContent = t("w_say"); msg.className = "msg";
    await new Promise((done) => { const f = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; const r = Math.sqrt(s / buf.length); peak = Math.max(peak, r); $("wMeter").style.width = Math.min(100, r * 400) + "%"; if (Date.now() - t0 < 4000 && peak < 0.05) requestAnimationFrame(f); else done(); }; f(); });
    stream.getTracks().forEach((t) => t.stop()); ctx.close();
    micOk = peak > 0.005;
    msg.textContent = micOk ? t("w_heard") : t("w_notheard"); msg.className = "msg " + (micOk ? "ok" : "err");
    $("w1").classList.toggle("ok", micOk);
  } catch (e) { msg.textContent = t("w_micdenied"); msg.className = "msg err"; }
  welcomeCheck();
};
$("wKeyBtn").onclick = async () => {
  const key = $("wKey").value.trim(), msg = $("wKeyMsg");
  if (!key) { msg.textContent = t("w_nokey"); msg.className = "msg err"; return; }
  msg.textContent = t("checking"); msg.className = "msg";
  try { await checkKey(key); settings = store.saveSettings({ apiKey: key }); keyOk = true; msg.textContent = t("w_connected"); msg.className = "msg ok"; $("w2").classList.add("ok"); }
  catch (e) { keyOk = false; msg.textContent = "✗ " + friendly(e); msg.className = "msg err"; }
  welcomeCheck();
};
$("wPaste").onclick = async () => {
  try { const t = (await navigator.clipboard.readText()).trim(); if (t) { $("wKey").value = t; $("wKeyBtn").click(); } else toast(t("clip_empty"), true); }
  catch { toast(t("clip_denied"), true); }
};
$("wDone").onclick = () => { settings = store.saveSettings({ setupDone: true }); newMeeting(); show("main"); startWorker().catch(() => {}); offerInstall(); checkLights(); };

/* ───────── 按鈕 ───────── */
$("recBtn").onclick = () => (recording ? stopRecording() : startRecording());
$("copyBtn").onclick = copyAll;
$("wordBtn").onclick = exportWord;
$("newBtn").onclick = () => { newMeeting(); };
$("title").addEventListener("change", () => { if (meeting) { meeting.title = $("title").value.trim() || meeting.title; $("title").value = meeting.title; scheduleSave(); } });
$("toHistory").onclick = () => { renderHistory(); show("history"); };
$("histBack").onclick = () => show("main");
$("toSettings").onclick = () => { fillSettings(); show("settings"); };
$("setBack").onclick = () => { readSettings(); show("main"); if (!settings.apiKey) toast(t("no_key_yet"), true); checkGroq(); };
window.addEventListener("beforeunload", (e) => { if (recording) { e.preventDefault(); e.returnValue = ""; } });

/* ───────── 燈號：麥克風權限、Groq 連線 ───────── */
const lightMsg = { mic: "", groq: "" };
function setLight(which, state, msg = "") { $(which === "mic" ? "lMic" : "lGroq").dataset.state = state; lightMsg[which] = msg; }
async function checkMic() {
  if (recording) { setLight("mic", "ok"); return; }
  setLight("mic", "wait");
  try {
    const p = await navigator.permissions?.query({ name: "microphone" });
    if (p?.state === "granted") { setLight("mic", "ok"); return; }
    if (p?.state === "denied") { setLight("mic", "bad", t("mic_off")); return; }
  } catch {}
  // Safari 沒有 permissions API：實際打開一下麥克風再馬上關掉
  try { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach((t) => t.stop()); setLight("mic", "ok"); }
  catch (e) { setLight("mic", "bad", /NotAllowed|Permission/i.test(e.name + e.message) ? t("mic_retry") : t("mic_none") + friendly(e)); }
}
async function checkGroq() {
  setLight("groq", "wait");
  if (!settings.apiKey) { setLight("groq", "bad", t("groq_nokey")); return; }
  if (!navigator.onLine) { setLight("groq", "bad", t("offline")); return; }
  try { await checkKey(settings.apiKey); setLight("groq", "ok"); }
  catch (e) { setLight("groq", "bad", /401/.test(e.message) ? t("groq_401") : t("groq_down") + friendly(e)); }
}
function checkLights() { if ($("main").hidden) return; checkMic(); checkGroq(); }
$("lMic").onclick = async () => { await checkMic(); toast(lightMsg.mic || t("mic_ok")); };
$("lGroq").onclick = async () => { await checkGroq(); toast(lightMsg.groq || t("groq_ok")); };
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkLights(); });
window.addEventListener("online", checkLights); window.addEventListener("offline", () => setLight("groq", "bad", t("offline")));
setInterval(() => { if (document.visibilityState === "visible" && !recording) checkGroq(); }, 5 * 60 * 1000);

/* ───────── 放到手機桌面 ───────── */
// Android Chrome 會丟 beforeinstallprompt，可以真的跳出安裝；iPhone Safari 沒有 API，只能教她按分享
let installEvt = null;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function offerInstall() {
  if (isStandalone() || localStorage.getItem("pm:installDismissed")) return;
  const box = $("install");
  if (installEvt) { $("installHow").textContent = t("inst_android"); $("installBtn").textContent = t("inst_install"); $("installBtn").hidden = false; box.hidden = false; }
  else if (isIOS()) {
    // Safari 和桌面 App 分開存資料：先把金鑰複製起來，從桌面打開時按「貼上」就好
    $("installHow").textContent = t("inst_ios");
    $("installBtn").textContent = t("inst_copykey"); $("installBtn").hidden = false; box.hidden = false;
  }
  else if (/Android/i.test(navigator.userAgent)) { $("installHow").textContent = t("inst_other"); $("installBtn").hidden = true; box.hidden = false; }
}
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; if (!$("main").hidden) offerInstall(); });
window.addEventListener("appinstalled", () => { $("install").hidden = true; toast(t("inst_done")); });
$("installBtn").onclick = async () => {
  if (!installEvt) { try { await navigator.clipboard.writeText(settings.apiKey); toast(t("key_copied")); } catch { toast(t("key_copyfail"), true); } return; }
  installEvt.prompt(); const { outcome } = await installEvt.userChoice; installEvt = null; if (outcome === "accepted") $("install").hidden = true; };
$("installClose").onclick = () => { $("install").hidden = true; localStorage.setItem("pm:installDismissed", "1"); };

/* ───────── 啟動 ───────── */
applyBig();
if ("serviceWorker" in navigator) {
  // 新版推上去後：service worker 會換新 → 只跳一張「有新版本」卡，按「更新」才重載（錄音中不打擾）
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (hadController) $("update").hidden = false; hadController = true; });
  navigator.serviceWorker.register(new URL("./sw.js", import.meta.url), { updateViaCache: "none" }).then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && !recording) reg.update().catch(() => {}); }); // 每次切回來都看一下有沒有新版
  }).catch(() => {});
}
$("updateBtn").onclick = () => { if (recording) { toast(t("upd_rec"), true); return; } location.reload(); };
settings = await store.restoreSettings(); // localStorage 被清掉時從 IndexedDB 找回金鑰
applyLang();
$("trBtn").dataset.state = settings.translate ? "on" : "off";
if (!settings.setupDone || !settings.apiKey) {
  // iPhone 的 Safari 和桌面 App 分開存資料：在 Safari 裡就先教她放到桌面，從桌面打開再設定
  if (isIOS() && !isStandalone()) { $("w0").hidden = false; $("w1").querySelector(".num").textContent = "2"; $("w2").querySelector(".num").textContent = "3"; $("wFoot").hidden = true; }
  show("welcome");
} else {
  const last = store.listMeetings()[0];
  if (last && !store.loadMeeting(last.id)?.endedAt) openMeeting(last.id); else newMeeting();
  show("main");
  startWorker().catch(() => {});
  setTimeout(offerInstall, 800); // beforeinstallprompt 通常在載入後才來，晚一點再問
  checkLights();
}
