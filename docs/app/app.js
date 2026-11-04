// 手機版會議摘要助理：錄音 → Groq Whisper → 聲紋分群 → 即時逐字稿 → 摘要 → 複製／Word
import { Recorder } from "./audio.js";
import { Diarizer } from "./diarize.js";
import { filterSegments } from "./filters.js";
import * as store from "./store.js";
import { summarizeTranscript, listModels, pickModels, CHEAP_MODELS } from "./lib/groq.js";
import { toTraditional } from "./lib/s2t.js";
import { meetingToPlainText, fmtTime, setLocale, summaryHtml as recordHtml } from "./lib/format.js";
import { buildDocx } from "./lib/docx.js";
import { t, detectLang, setLang, applyI18n } from "./i18n.js";
import { setLabelFn } from "./diarize.js";

const VERSION = "1.7.2";
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
function toast(msg, error = false, undo = null) {
  const el = $("toast");
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button class="undo" type="button">${t("undo")}</button>` : ""}`;
  el.className = "toast show" + (error ? " error" : "");
  if (undo) el.querySelector(".undo").onclick = () => { el.className = "toast"; undo(); };
  clearTimeout(el._h); el._h = setTimeout(() => (el.className = "toast"), undo ? 7000 : error ? 5000 : 2500);
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
  setLocale(t("locale"), { summary: t("sum_h"), points: t("sum_points"), decisions: t("sum_decisions"), todo: t("sum_todo"), owner: t("sum_owner"), due: t("sum_due"), open: t("x_open"), transcript: t("x_transcript"), sep: t("locale") === "en-US" ? ": " : "：",
    participants: t("sum_people"), work: t("sum_work"), timeline: t("sum_timeline"), risks: t("sum_risks"), names: t("sum_names"), other: t("sum_other"), part: t("sum_part"),
    cols: Object.fromEntries(["no", "task", "owner", "helpers", "due", "note", "when", "item", "status"].map((k) => [k, t("col_" + k)])),
    notes: { summary: t("nt_summary"), participants: t("nt_people"), decisions: t("nt_decisions"), work: t("nt_work"), risks: t("nt_risks") } });
  applyI18n();
  // 說明／隱私權連結帶上目前語言
  const code = { "zh-TW": "zh", "en-US": "en", "ja-JP": "ja" }[t("locale")] || "zh";
  $("guideLink").href = `../?lang=${code}`; $("privacyLink").href = `../privacy.html?lang=${code}`;
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

// ── 語音辨識模型自動切換 ──
// Groq 每個模型的額度分開算：Large v3 用完就先換 Turbo（錯字稍多但不漏）；兩個都用完就等額度回來再送，
// 那段話不會被丟掉（等太久，超過 10 分鐘才放棄）
const STT_MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"];
const sttCool = {}; // model -> 額度恢復的時間
function sttRetryMs(res, detail) {
  const m = String(detail).match(/try again in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*([\d.]+)s/i);
  if (m) return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + parseFloat(m[3])) * 1000;
  const h = +res.headers.get("retry-after");
  return h > 0 ? h * 1000 : 20000;
}
async function sttFetch(url, headers, makeForm, onWait) {
  for (;;) {
    const now = Date.now();
    const model = STT_MODELS.find((m) => !(sttCool[m] > now));
    if (!model) {
      const wait = Math.min(...STT_MODELS.map((m) => sttCool[m])) - now;
      if (wait > 10 * 60e3) { const e = new Error("429 rate limit"); e.status = 429; throw e; }
      onWait?.(wait);
      await new Promise((r) => setTimeout(r, wait + 300));
      continue;
    }
    const res = await fetch(url, { method: "POST", headers, body: makeForm(model) });
    if (res.status !== 429) return res;
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch {}
    sttCool[model] = Date.now() + Math.max(3000, sttRetryMs(res, detail));
  }
}
let waitToastAt = 0;
async function transcribe(wav, forceLang) {
  const fixed = forceLang || (settings.sttLanguage && !settings.sttLanguage.startsWith("auto") ? settings.sttLanguage : "");
  const form = (model) => {
    const fd = new FormData();
    fd.append("file", wav, "chunk.wav");
    fd.append("model", model);
    fd.append("response_format", "verbose_json");
    fd.append("temperature", "0");
    if (fixed) fd.append("language", fixed);
    return fd;
  };
  const r = await sttFetch(`${GROQ}/openai/v1/audio/transcriptions`, hdr(), form, (ms) => {
    setLight("groq", "wait", t("stt_wait", { s: Math.ceil(ms / 1000) }));
    if (Date.now() - waitToastAt > 60e3) { waitToastAt = Date.now(); toast(t("stt_wait", { s: Math.ceil(ms / 1000) })); }
  });
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
  box.innerHTML = meeting.lines.map((l, i) => (l.sep ? `<div class="sepline">${esc(l.text)}</div>` : `<div class="line">${lineHtml(l, i)}</div>`)).join("");
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
let recSince = 0; // 這次按下錄音的時間
function tick() {
  if (!meeting?.startedAt) return;
  const base = meeting.recMs ?? (meeting.lines.length && meeting.endedAt ? meeting.endedAt - meeting.startedAt : 0); // 舊紀錄沒有 recMs
  const s = Math.floor((base + (recording && recSince ? Date.now() - recSince : 0)) / 1000);
  $("timer").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
function updateButtons() {
  const has = !!meeting?.lines.length;
  $("doneBar").hidden = recording || !has;          // 散會後才出現「複製」「存成 Word」
  $("newBtn").hidden = recording || !has;
  $("recBtn").hidden = !!meeting?.combinedFrom; // 合併摘要不能再接著錄
  $("recBtn").className = "rec" + (recording ? " stop" : "");
  $("recLabel").textContent = recording ? t("rec_stop") : has ? t("rec_cont") : t("rec_start");
  $("title").value = meeting?.title || "";
  const fresh = !recording && !has && !meeting?.combinedFrom;
  $("scenes").hidden = !fresh;
  for (const b of $("scenes").querySelectorAll("button")) { const on = b.dataset.s === (settings.scene || "room"); b.classList.toggle("on", on); b.setAttribute("aria-checked", on); }
  setHint(recording ? t("hint_rec") : has ? t("hint_done") : t(settings.scene === "lecture" ? "sc_lecture_hint" : "sc_room_hint"));
}
$("scenes").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-s]"); if (!b) return;
  settings = store.saveSettings({ scene: b.dataset.s });
  updateButtons();
});

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
  if (!meeting.startedAt) { meeting.startedAt = Date.now(); meeting.scenario = settings.scene || "room"; }
  meeting.recMs ??= meeting.lines.length && meeting.endedAt ? meeting.endedAt - meeting.startedAt : 0;
  recSince = Date.now();
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
  meeting.recMs = (meeting.recMs || 0) + (recSince ? Date.now() - recSince : 0); recSince = 0;
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
  return recordHtml(s) + (s.model ? `<p class="small muted">${esc(t("sum_by", { m: s.model }))}</p>` : "")
    + regenHtml(s.lang);
}
const SUM_LANGS = ["繁體中文", "English", "日本語"];
function regenHtml(cur) {
  const sel = SUM_LANGS.map((l) => `<option${l === (cur || sumLang()) ? " selected" : ""}>${l}</option>`).join("");
  return `<div class="regen"><select id="regenLang" aria-label="${t("regen_lang")}">${sel}</select><button class="btn sm" id="regenBtn">${t("regen")}</button></div>`;
}
function bindRegen() {
  const b = $("regenBtn"); if (!b) return;
  b.onclick = () => { if (recording) return; summarize($("regenLang").value); };
}
async function summarize(lang) {
  if (!meeting?.lines.length) return;
  const language = typeof lang === "string" ? lang : meeting.summary?.lang || sumLang();
  const box = $("summary");
  box.hidden = false; box.innerHTML = `<div class="wait"><span class="spin"></span> ${t("sum_wait")}</div>`;
  try {
    const s = await summarizeTranscript(meeting, { apiBase: GROQ, apiHeaders: hdr(), model: settings.model, autoFallback: settings.autoFallback, tokenSaver: settings.tokenSaver, language, toTraditional: settings.toTraditional });
    s.lang = language;
    meeting.summary = s; store.saveMeeting(meeting);
    box.innerHTML = summaryHtml(s); bindRegen();
    toast(t("sum_done"));
  } catch (e) {
    box.innerHTML = `<div class="note"><span>${t("sum_fail")}${esc(friendly(e))}</span><button class="btn sm" id="retrySum">${t("retry")}</button></div>` + regenHtml(language);
    $("retrySum").onclick = () => summarize(language); bindRegen();
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
  $("summary").hidden = !m.summary; if (m.summary) { $("summary").innerHTML = summaryHtml(m.summary); bindRegen(); }
  show("main");
}
let picking = null; // 選取模式：勾選中的會議 id
const fmtDay = (ts) => new Date(ts).toLocaleString(t("locale"), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
// 過去的會議：卡片清單（搜尋、✏️ 改名、🗑 刪除可復原、選取 → 合併摘要／一次刪除）
function renderHistory() {
  if (document.activeElement?.classList.contains("rename")) return; // 正在改名：不要重畫
  const idx = store.listMeetings();
  const q = $("histSearch").value.trim().toLowerCase();
  const shown = q ? idx.filter((x) => x.title.toLowerCase().includes(q)) : idx;
  $("selBar").hidden = !picking;
  $("selStart").hidden = !!picking || !idx.length;
  $("histSearch").hidden = idx.length < 2;
  if (picking) {
    const n = picking.size;
    $("selCount").textContent = t("sel_n", { n });
    $("selDel").disabled = n < 1;
    $("cbGo").disabled = n < 2;
  }
  if (!idx.length) { $("histList").innerHTML = `<div class="empty">${t("hist_empty")}</div>`; return; }
  if (!shown.length) { $("histList").innerHTML = `<div class="empty">${esc(t("hist_none", { q }))}</div>`; return; }
  $("histList").innerHTML = (picking ? `<p class="small muted cbhint">${t("cb_hint")}</p>` : "") + shown.map((x) => {
    const tags = (x.hasSummary ? `<span class="tag ok">${t("tag_sum")}</span>` : "") + (x.combined ? `<span class="tag">${t("tag_comb", { n: x.combined })}</span>` : "");
    return `<div class="item mcard${picking?.has(x.id) ? " on" : ""}" data-id="${esc(x.id)}">
      ${picking ? `<input type="checkbox" class="pick" ${picking.has(x.id) ? "checked" : ""} aria-label="${t("sel")}" />` : ""}
      <div class="grow mc-main"><b class="mc-title">${esc(x.title)}</b><small>${fmtDay(x.startedAt)}・${t("hist_lines", { n: x.lines })}</small>${tags ? `<div class="tags">${tags}</div>` : ""}</div>
      ${picking ? "" : `<button class="icon sm" data-act="rename" title="${t("rename")}">✏️</button><button class="icon sm" data-act="del" title="${t("del")}">🗑</button>`}
    </div>`;
  }).join("");
}
// 刪除不再跳確認：直接刪，提示列上有「復原」可以救回來
function removeWithUndo(ids) {
  const saved = ids.map((id) => store.loadMeeting(id)).filter(Boolean);
  for (const id of ids) store.removeMeeting(id);
  if (meeting && ids.includes(meeting.id)) newMeeting();
  renderHistory();
  toast(ids.length > 1 ? t("deleted_n", { n: ids.length }) : t("deleted"), false, () => {
    for (const m of saved) store.saveMeeting(m);
    toast(t("restored"));
    renderHistory();
  });
}
function startRename(card, x) {
  const b = card.querySelector(".mc-title");
  const input = document.createElement("input");
  input.className = "rename"; input.value = x.title; input.enterKeyHint = "done";
  b.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const title = input.value.trim();
    if (save && title && title !== x.title) {
      const m = store.loadMeeting(x.id);
      if (m) { m.title = title; store.saveMeeting(m); if (meeting?.id === m.id) { meeting.title = title; $("title").value = title; } toast(t("renamed")); }
    }
    input.blur();
    renderHistory();
  };
  input.onkeydown = (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
}
$("histSearch").oninput = renderHistory;
$("selStart").onclick = () => { picking = new Set(); renderHistory(); };
$("cbCancel").onclick = () => { picking = null; renderHistory(); };
$("selDel").onclick = () => { const ids = [...picking]; picking = null; removeWithUndo(ids); };
$("cbGo").onclick = () => {
  const ms = [...picking].map((id) => store.loadMeeting(id)).filter((m) => m?.lines?.length).sort((a, b) => a.startedAt - b.startedAt);
  if (ms.length < 2) return toast(t("cb_pick"), true);
  // 每場的發言者名字先換成那場的標籤（各場的聲紋編號互不相通）
  const lines = [];
  ms.forEach((m, i) => {
    const d = new Diarizer(m.diar);
    lines.push({ t: m.startedAt, speaker: "", text: `${t("sum_part", { n: i + 1 })}：${m.title}（${fmtDay(m.startedAt)}）`, sep: true });
    for (const l of m.lines) if (!l.sep) lines.push({ t: l.t, speaker: d.get(l.speakerId)?.label || l.speaker, speakerId: `p${i}-${l.speakerId ?? ""}`, text: l.text, confidence: "high" });
  });
  const day = (ts) => new Date(ts).toLocaleDateString(t("locale"), { month: "numeric", day: "numeric" });
  const a = day(ms[0].startedAt), b = day(ms[ms.length - 1].startedAt);
  meeting = { id: Date.now().toString(36), title: t("cb_name", { d: a === b ? a : `${a}–${b}`, n: ms.length }), platformName: t("cb_platform", { n: ms.length }),
    startedAt: Date.now(), endedAt: Date.now(), lines, summary: null, diar: null,
    combinedFrom: ms.map((m) => ({ id: m.id, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt, platformName: m.platformName })) };
  diar = new Diarizer();
  store.saveMeeting(meeting);
  picking = null;
  renderLines(); updateButtons(); tick(); setStatus(t("ended"), "done");
  show("main");
  summarize();
};
$("histList").addEventListener("click", (e) => {
  const card = e.target.closest(".item");
  if (!card || e.target.classList.contains("rename")) return;
  const id = card.dataset.id;
  if (picking) {
    e.preventDefault();
    picking.has(id) ? picking.delete(id) : picking.add(id);
    return renderHistory();
  }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "rename") return startRename(card, store.listMeetings().find((x) => x.id === id));
  if (act === "del") return removeWithUndo([id]);
  openMeeting(id);
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
$("histBack").onclick = () => { picking = null; $("histSearch").value = ""; show("main"); };
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

/* ───────── 安裝引導：掃 QR code（?install=1）或第一次用手機打開時，教她放到桌面 ───────── */
const isInApp = () => /Line\/|FBAN|FBAV|Instagram|MicroMessenger|KAKAOTALK/i.test(navigator.userAgent);
const isIOSSafari = () => isIOS() && !/CriOS|FxiOS|EdgiOS|OPiOS/i.test(navigator.userAgent);
function needInstallGuide() {
  if (isStandalone()) return false;
  if (!isIOS() && !/Android/i.test(navigator.userAgent)) return false; // 電腦不用
  try { if (sessionStorage.getItem("pm:skipInstall")) return false; } catch {}
  return new URLSearchParams(location.search).has("install") || !settings.setupDone;
}
function showInstallGuide() {
  const android = /Android/i.test(navigator.userAgent);
  $("igInApp").hidden = !isInApp();
  $("igIOS").hidden = isInApp() || !isIOS();
  $("igArrow").hidden = isInApp() || !isIOSSafari();
  $("igAndroid").hidden = isInApp() || !android;
  $("igAndManual").hidden = !!installEvt;
  $("igInstall").hidden = !installEvt;
  show("installGuide");
}
function leaveInstallGuide() {
  try { sessionStorage.setItem("pm:skipInstall", "1"); } catch {}
  $("igArrow").hidden = true;
  startApp();
}
$("igSkip").onclick = leaveInstallGuide;
$("igCopy").onclick = async () => { try { await navigator.clipboard.writeText(location.origin + location.pathname); toast(t("ig_copied")); } catch { toast(location.origin + location.pathname); } };
$("igInstall").onclick = async () => {
  if (!installEvt) return;
  installEvt.prompt(); const { outcome } = await installEvt.userChoice; installEvt = null;
  if (outcome === "accepted") { $("igAndroid").hidden = true; $("igDone").hidden = false; }
};
window.addEventListener("beforeinstallprompt", () => { if (!$("installGuide").hidden) { $("igInstall").hidden = false; $("igAndManual").hidden = true; } });
window.addEventListener("appinstalled", () => { if (!$("installGuide").hidden) { $("igAndroid").hidden = true; $("igDone").hidden = false; } });

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
if (needInstallGuide()) showInstallGuide(); else startApp();
function startApp() {
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
}
