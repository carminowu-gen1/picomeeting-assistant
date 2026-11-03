// 手機版會議摘要助理：錄音 → Groq Whisper → 聲紋分群 → 即時逐字稿 → 摘要 → 複製／Word
import { Recorder } from "./audio.js";
import { Diarizer } from "./diarize.js";
import { filterSegments } from "./filters.js";
import * as store from "./store.js";
import { summarizeTranscript } from "./lib/groq.js";
import { toTraditional, looksSimplified } from "./lib/s2t.js";
import { meetingToPlainText, fmtTime } from "./lib/format.js";
import { buildDocx } from "./lib/docx.js";

const VERSION = "1.0.0";
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
  if (/401|invalid api key|invalid_api_key/i.test(m)) return "Groq 金鑰不對，請到設定重新貼上";
  if (/429|rate limit/i.test(m)) return "Groq 免費額度暫時用完，等一下會自動再試";
  if (/failed to fetch|network/i.test(m)) return "連不上網路";
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

/* ───────── 聲紋 worker ───────── */
let worker = null, workerReady = null, reqId = 0;
const waiting = new Map();
function startWorker() {
  if (workerReady) return workerReady;
  worker = new Worker(new URL("./embed-worker.js?v=" + VERSION, import.meta.url)); // 帶版號避免舊快取
  worker.onmessage = (e) => { const w = waiting.get(e.data.id); if (w) { waiting.delete(e.data.id); w(e.data); } };
  worker.onerror = (e) => console.warn("worker", e.message);
  workerReady = call("init", { modelUrl: new URL("./model/campplus.onnx", import.meta.url).href })
    .then((r) => { if (!r.ok) throw new Error(r.error); $("sModel").textContent = `已載入（${Math.round(r.ms)} ms）`; return true; })
    .catch((e) => { $("sModel").textContent = "載入失敗：" + e.message; workerReady = null; throw e; });
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
async function transcribe(wav) {
  const fd = new FormData();
  fd.append("file", wav, "chunk.wav");
  fd.append("model", "whisper-large-v3");
  fd.append("response_format", "verbose_json");
  fd.append("temperature", "0");
  if (settings.sttLanguage && settings.sttLanguage !== "auto") fd.append("language", settings.sttLanguage);
  let r;
  for (let attempt = 0; ; attempt++) {
    r = await fetch(`${GROQ}/openai/v1/audio/transcriptions`, { method: "POST", headers: hdr(), body: fd });
    if (r.status === 429 && attempt < 2) { await new Promise((z) => setTimeout(z, 2500 * (attempt + 1))); continue; }
    break;
  }
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 100)}`);
  const j = await r.json();
  return j.segments || (j.text ? [{ start: 0, end: 0, text: j.text }] : []);
}

// 一段錄音：辨識 → 過濾 → 每句算聲紋 → 歸到說話者 → 加到逐字稿
async function handleChunk({ wav, pcm, startedAt }) {
  if (!meeting) return;
  let segs;
  try { segs = await transcribe(wav); } catch (e) { toast("辨識失敗：" + friendly(e), true); return; }
  const { kept } = filterSegments(segs);
  if (!kept.length) return;
  // 整段的聲紋（當句子太短時的備援）
  let chunkEmb = null;
  for (const g of kept) {
    let text = g.text;
    if (settings.toTraditional && looksSimplified(text)) text = toTraditional(text);
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
  return `<button class="chip ${line.confidence}" style="--c:${color}" data-id="${esc(line.speakerId)}" title="點一下改名字">${esc(c?.label || line.speaker)}${mark}</button>`;
}
function lineHtml(line, i) {
  return `<div class="lh">${chipFor(line)}<span class="t">${fmtTime(line.t)}</span></div><div class="tx" contenteditable="true" data-i="${i}">${esc(line.text)}</div>`;
}
function appendLine(line, fresh) {
  const box = $("lines");
  box.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = "line" + (fresh ? " new" : "");
  el.innerHTML = lineHtml(line, meeting.lines.length - 1);
  box.appendChild(el);
  if (fresh) box.scrollTop = box.scrollHeight;
}
function renderLines() {
  const box = $("lines");
  if (!meeting?.lines.length) {
    box.innerHTML = recording
      ? `<div class="empty"><div class="ill">👂</div><h3>正在聽…</h3>有人說話後，文字會一句一句出現在這裡</div>`
      : `<div class="empty"><div class="ill">✦</div><h3>開會就交給它記</h3><div class="steps"><div><span>📱</span>把手機放桌上</div><div><span>🎙️</span>按下面「開始記錄」</div><div><span>📝</span>散會自動整理摘要</div></div></div>`;
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
  const name = prompt(`這位是誰？\n（輸入已經有的名字，就會把兩個人合併成同一人）`, c.named ? c.label : "");
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
  $("recLabel").textContent = recording ? "結束會議" : has ? "繼續記錄" : "開始記錄";
  $("title").value = meeting?.title || "";
  setHint(recording ? "把手機放在桌子中間、螢幕保持開著。點說話者的名字可以改。" : has ? "要開下一場會，按右上角的 ＋" : "");
}

/* ───────── 錄音流程 ───────── */
function newMeeting() {
  meeting = { id: Date.now().toString(36), title: `會議 ${new Date().toLocaleDateString("zh-TW")}`, platformName: "現場錄音", startedAt: 0, endedAt: 0, lines: [], summary: null, diar: null };
  diar = new Diarizer();
  $("summary").hidden = true; $("summary").innerHTML = "";
  $("timer").textContent = "00:00";
  renderLines(); updateButtons(); setStatus("準備好了");
}
async function startRecording() {
  if (!settings.apiKey) { toast("請先到設定貼上 Groq 金鑰", true); show("settings"); return; }
  if (!meeting || meeting.summary) newMeeting();
  if (!meeting.startedAt) meeting.startedAt = Date.now();
  meeting.endedAt = 0;
  $("recBtn").disabled = true;
  try {
    rec = new Recorder({
      onChunk: (c) => { pending++; queue = queue.then(() => handleChunk(c)).catch((e) => console.warn(e)).finally(() => { pending--; setStatus(recording ? (pending ? "辨識中…" : "聆聽中") : pending ? "整理最後幾句…" : "已結束", recording ? "rec" : "busy"); }); },
      onLevel: (r, voiced) => { const f = $("meter"); f.style.width = Math.min(100, r * 400) + "%"; f.classList.toggle("off", !voiced); },
      onError: (e) => toast("錄音錯誤：" + friendly(e), true),
    });
    await rec.start();
  } catch (e) {
    $("recBtn").disabled = false;
    toast(/NotAllowed|Permission/i.test(e.name + e.message) ? "沒有麥克風權限：請到手機設定允許這個網站使用麥克風" : "無法開始錄音：" + friendly(e), true);
    return;
  }
  startWorker().catch(() => toast("聲紋模型載入失敗，仍會記錄但無法分辨說話者", true));
  recording = true;
  $("recBtn").disabled = false;
  setStatus("聆聽中", "rec");
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
  setStatus(pending ? "整理最後幾句…" : "已結束", "busy");
  await queue;
  setStatus("已結束", "done");
  $("recBtn").disabled = false;
  updateButtons();
  meeting.diar = diar.toJSON(); store.saveMeeting(meeting);
  if (settings.autoSummarize !== false && meeting.lines.length) summarize();
}
document.addEventListener("visibilitychange", async () => { if (recording && document.visibilityState === "visible" && !wakeLock) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {} } });

/* ───────── 摘要／匯出 ───────── */
function summaryHtml(s) {
  const list = (t, items) => items?.length ? `<h3>${t}</h3><ul>${items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  return `<h3>會議摘要</h3><p>${esc(s.summary)}</p>` + list("重點整理", s.key_points) + list("決議事項", s.decisions)
    + list("待辦事項", s.action_items?.map((a) => `${a.task}${a.owner ? `（負責：${a.owner}）` : ""}${a.due ? `，期限：${a.due}` : ""}`))
    + list("後續追蹤", s.open_questions) + (s.model ? `<p class="small muted">由 ${esc(s.model)} 產生</p>` : "");
}
async function summarize() {
  if (!meeting?.lines.length) return;
  const box = $("summary");
  box.hidden = false; box.innerHTML = `<div class="wait"><span class="spin"></span> AI 正在整理摘要…</div>`;
  try {
    const s = await summarizeTranscript(meeting, { apiBase: GROQ, apiHeaders: hdr(), model: settings.model, autoFallback: settings.autoFallback, tokenSaver: settings.tokenSaver, language: settings.language, toTraditional: settings.toTraditional });
    meeting.summary = s; store.saveMeeting(meeting);
    box.innerHTML = summaryHtml(s);
    toast("摘要完成");
  } catch (e) {
    box.innerHTML = `<div class="note"><span>摘要失敗：${esc(friendly(e))}</span><button class="btn sm" id="retrySum">再試一次</button></div>`;
    $("retrySum").onclick = summarize;
  }
}
async function copyAll() {
  const text = meetingToPlainText(meeting, { includeTranscript: true });
  try { await navigator.clipboard.writeText(text); toast("已複製，可以貼到 LINE 或 Email"); }
  catch { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); toast("已複製"); }
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
  renderLines(); updateButtons(); tick(); setStatus(m.endedAt ? "已結束" : "準備好了", m.endedAt ? "done" : "");
  $("summary").hidden = !m.summary; if (m.summary) $("summary").innerHTML = summaryHtml(m.summary);
  show("main");
}
function renderHistory() {
  const idx = store.listMeetings();
  $("histList").innerHTML = idx.length ? idx.map((x) => `<div class="item" data-id="${x.id}"><div><b>${esc(x.title)}</b><small>${fmtTime(x.startedAt)}・${x.lines} 句${x.hasSummary ? "・有摘要" : ""}</small></div><button class="icon del" data-id="${x.id}" title="刪除">🗑</button></div>`).join("")
    : `<div class="empty">還沒有會議紀錄</div>`;
}
$("histList").addEventListener("click", (e) => {
  const del = e.target.closest(".del");
  if (del) { if (confirm("刪除這場會議？")) { store.removeMeeting(del.dataset.id); if (meeting?.id === del.dataset.id) newMeeting(); renderHistory(); } return; }
  const it = e.target.closest(".item"); if (it) openMeeting(it.dataset.id);
});
function fillSettings() {
  $("sKey").value = settings.apiKey; $("sLang").value = settings.sttLanguage; $("sSumLang").value = settings.language;
  $("sS2T").checked = settings.toTraditional; $("sBig").checked = settings.bigText; $("sAuto").checked = settings.autoSummarize !== false;
  $("sVer").textContent = VERSION;
}
function readSettings() {
  settings = store.saveSettings({ apiKey: $("sKey").value.trim(), sttLanguage: $("sLang").value, language: $("sSumLang").value, toTraditional: $("sS2T").checked, bigText: $("sBig").checked, autoSummarize: $("sAuto").checked });
  applyBig();
}
for (const id of ["sKey", "sLang", "sSumLang", "sS2T", "sBig", "sAuto"]) $(id).addEventListener("change", readSettings);
$("sKeyCheck").onclick = async () => { const m = $("sKeyMsg"); m.textContent = "檢查中…"; m.className = "msg small"; try { await checkKey($("sKey").value.trim()); m.textContent = "✓ 金鑰可以用"; m.className = "msg small ok"; } catch (e) { m.textContent = "✗ " + friendly(e); m.className = "msg small err"; } };

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
    msg.textContent = "請說幾句話…"; msg.className = "msg";
    await new Promise((done) => { const f = () => { an.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) s += v * v; const r = Math.sqrt(s / buf.length); peak = Math.max(peak, r); $("wMeter").style.width = Math.min(100, r * 400) + "%"; if (Date.now() - t0 < 4000 && peak < 0.05) requestAnimationFrame(f); else done(); }; f(); });
    stream.getTracks().forEach((t) => t.stop()); ctx.close();
    micOk = peak > 0.005;
    msg.textContent = micOk ? "✓ 聽到你的聲音了" : "沒聽到聲音，請再試一次（靠近一點說話）"; msg.className = "msg " + (micOk ? "ok" : "err");
    $("w1").classList.toggle("ok", micOk);
  } catch (e) { msg.textContent = "沒有取得麥克風權限：請在手機的瀏覽器設定裡允許"; msg.className = "msg err"; }
  welcomeCheck();
};
$("wKeyBtn").onclick = async () => {
  const key = $("wKey").value.trim(), msg = $("wKeyMsg");
  if (!key) { msg.textContent = "還沒貼上"; msg.className = "msg err"; return; }
  msg.textContent = "檢查中…"; msg.className = "msg";
  try { await checkKey(key); settings = store.saveSettings({ apiKey: key }); keyOk = true; msg.textContent = "✓ 連上了"; msg.className = "msg ok"; $("w2").classList.add("ok"); }
  catch (e) { keyOk = false; msg.textContent = "✗ " + friendly(e); msg.className = "msg err"; }
  welcomeCheck();
};
$("wDone").onclick = () => { settings = store.saveSettings({ setupDone: true }); newMeeting(); show("main"); startWorker().catch(() => {}); };

/* ───────── 按鈕 ───────── */
$("recBtn").onclick = () => (recording ? stopRecording() : startRecording());
$("copyBtn").onclick = copyAll;
$("wordBtn").onclick = exportWord;
$("newBtn").onclick = () => { newMeeting(); };
$("title").addEventListener("change", () => { if (meeting) { meeting.title = $("title").value.trim() || meeting.title; $("title").value = meeting.title; scheduleSave(); } });
$("toHistory").onclick = () => { renderHistory(); show("history"); };
$("histBack").onclick = () => show("main");
$("toSettings").onclick = () => { fillSettings(); show("settings"); };
$("setBack").onclick = () => { readSettings(); show("main"); if (!settings.apiKey) toast("還沒有 Groq 金鑰，無法辨識", true); };
window.addEventListener("beforeunload", (e) => { if (recording) { e.preventDefault(); e.returnValue = ""; } });

/* ───────── 啟動 ───────── */
applyBig();
if ("serviceWorker" in navigator) navigator.serviceWorker.register(new URL("./sw.js", import.meta.url)).catch(() => {});
if (!settings.setupDone || !settings.apiKey) show("welcome");
else {
  const last = store.listMeetings()[0];
  if (last && !store.loadMeeting(last.id)?.endedAt) openMeeting(last.id); else newMeeting();
  show("main");
  startWorker().catch(() => {});
}
