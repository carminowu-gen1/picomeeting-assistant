// 會議紀錄頁（側邊欄或分頁）：即時逐字稿、可修改、可複製、可停止記錄
import { applyTheme } from "../ui/theme.js";
import { fmtTime, fmtDate, meetingToPlainText, summaryHtml, summaryToPlainText } from "../lib/format.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let meetingId = new URLSearchParams(location.search).get("meeting") || "current";
let meeting = null;
let myName = "我";
const rendered = new Map(); // line id -> element（只增量更新，不打斷正在編輯的句子）

function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " error" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = "toast"), isErr ? 5000 : 1800);
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`已複製${label}`); }
  catch { toast("複製失敗", true); }
}
const summaryText = (s) => summaryToPlainText(s);

// ── 逐字稿 ──
function lineEl(l) {
  const el = document.createElement("div");
  el.className = "line new";
  el.innerHTML = `<div class="lh"><span class="sp" title="點一下改名（整場）"></span><span class="t">${fmtTime(l.t)}</span><button class="del" title="刪除這句">✕</button></div><div class="tx" contenteditable="true" spellcheck="false"></div>`;
  el.querySelector(".sp").onclick = () => renameSpeaker(el._line.speaker);
  const tx = el.querySelector(".tx");
  tx.onblur = async () => {
    const line = el._line, text = tx.textContent.trim();
    if (text === line.text) return;
    if (!text) { tx.textContent = line.text; return; }
    line.text = text;
    const r = await send({ type: "editLine", meetingId: meeting.id, id: line.id, text });
    r?.error ? toast(r.error, true) : toast("已儲存");
  };
  tx.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); tx.blur(); }
    if (e.key === "Escape") { tx.textContent = el._line.text; tx.blur(); }
  };
  el.querySelector(".del").onclick = async () => {
    const r = await send({ type: "deleteLine", meetingId: meeting.id, id: el._line.id });
    if (r?.error) return toast(r.error, true);
    el.remove(); rendered.delete(el._line.id);
    meeting.lines = meeting.lines.filter((x) => x.id !== el._line.id);
  };
  return el;
}

function renderTranscript(m) {
  const box = $("transcript");
  const scroller = $("transcript").closest(".tr-wrap").scrollHeight > $("transcript").closest(".tr-wrap").clientHeight
    ? $("transcript").closest(".tr-wrap") : document.querySelector(".content");
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  if (!m.lines.length) {
    rendered.clear();
    box.innerHTML = `<div class="empty">${m.recording ? "正在聽…說話後幾秒內會出現文字" : "這場沒有記錄到內容"}</div>`;
    return;
  }
  box.querySelector(".empty")?.remove();
  const ids = new Set();
  let added = false;
  for (const l of m.lines) {
    ids.add(l.id);
    let el = rendered.get(l.id);
    if (!el && l.sep) { el = document.createElement("div"); el.className = "sepline"; el.textContent = l.text; el._line = l; rendered.set(l.id, el); box.appendChild(el); added = true; }
    if (l.sep) continue;
    if (!el) { el = lineEl(l); rendered.set(l.id, el); box.appendChild(el); added = true; }
    el._line = l;
    const sp = el.querySelector(".sp");
    sp.textContent = l.speaker;
    sp.classList.toggle("me", l.speaker === myName || l.speaker === "我");
    const tx = el.querySelector(".tx");
    if (document.activeElement !== tx) tx.textContent = l.text;
  }
  for (const [id, el] of rendered) if (!ids.has(id)) { el.remove(); rendered.delete(id); }
  // 依時間排序（語音段落可能晚到）
  if (added) m.lines.forEach((l) => box.appendChild(rendered.get(l.id)));
  applySearch();
  if (added && nearBottom) scroller.scrollTop = scroller.scrollHeight; // 使用者往上翻時不要硬捲
}

function renderSummary(m) {
  const box = $("summaryCard");
  if (m.recording) { box.innerHTML = ""; return; }
  if (m.summarizing) { box.innerHTML = `<div class="wait"><span class="spin"></span> 正在產生摘要…</div>`; return; }
  const s = m.summary;
  if (!s) {
    box.innerHTML = m.lines.length ? `<div class="wait">${m.summaryError ? "摘要失敗。" : "還沒有摘要。"}<a href="#" id="mk">產生摘要</a></div>` : "";
    $("mk")?.addEventListener("click", (e) => { e.preventDefault(); summarize(); });
    return;
  }
  box.innerHTML = summaryHtml(s);
}

function renderHeader(m) {
  $("statusBadge").className = "badge " + (m.recording ? "rec" : "ok");
  $("statusText").textContent = m.recording ? "記錄中" : `${m.lines.length} 句`;
  $("stopBtn").hidden = !m.recording;
  if (document.activeElement !== $("title")) $("title").value = m.title;
  document.title = `${m.recording ? "● " : ""}${m.title} – 會議紀錄`;
}

async function renderHistory() {
  const r = await send({ type: "listMeetings" });
  const list = r?.meetings || [];
  $("history").innerHTML = list.map((x) => `<option value="${x.id}" ${x.id === meeting?.id ? "selected" : ""}>${x.recording ? "● " : ""}${esc(x.title)} · ${fmtDate(x.startedAt)}</option>`).join("");
}

// ── 搜尋 ──
function applySearch() {
  const q = $("search").value.trim().toLowerCase();
  for (const [, el] of rendered) el.style.display = !q || el.textContent.toLowerCase().includes(q) ? "" : "none";
}
$("search").oninput = applySearch;

// ── 編輯 ──
async function renameSpeaker(from) {
  const to = prompt(`把「${from}」整場改名為：`, from);
  if (!to || to.trim() === from) return;
  const r = await send({ type: "renameSpeaker", meetingId: meeting.id, from, to: to.trim() });
  if (r?.error) return toast(r.error, true);
  meeting.lines.forEach((l) => { if (l.speaker === from) l.speaker = to.trim(); });
  renderTranscript(meeting);
  toast("已改名");
}
$("title").onchange = async () => {
  const r = await send({ type: "setTitle", meetingId: meeting.id, title: $("title").value });
  r?.error ? toast(r.error, true) : (toast("標題已更新"), renderHistory());
};

// ── 按鈕 ──
$("stopBtn").onclick = async () => {
  $("stopBtn").disabled = true;
  const r = await send({ type: "stop", tabId: meeting.tabId, meetingId: meeting.id });
  $("stopBtn").disabled = false;
  r?.error ? toast(r.error, true) : toast("已停止，正在產生摘要…");
  load();
};
$("copyAll").onclick = () => meeting && copy(meetingToPlainText(meeting, { includeTranscript: true }), "全文，可以貼到任何地方");
$("exportDocx").onclick = () => exportAs("docx");

async function exportAs(target) {
  const r = await send({ type: "export", meetingId: meeting.id, target });
  r?.error ? toast(r.error, true) : toast(target === "gdoc" ? "已建立 Google 文件" : "已下載");
}
async function summarize() {
  meeting.summarizing = true; renderSummary(meeting);
  const r = await send({ type: "summarize", meetingId: meeting.id });
  if (r?.error) toast(r.error, true);
  load();
}

// ── 合併幾場會議一起摘要：勾選 → 產生一份新的合併紀錄 ──
$("combineBtn").onclick = async () => {
  const r = await send({ type: "listMeetings" });
  const list = (r?.meetings || []).filter((x) => !x.recording);
  if (list.length < 2) return toast("至少要有兩場會議才能合併", true);
  $("cbList").innerHTML = list.map((x) => `<label class="cb"><input type="checkbox" value="${esc(x.id)}" ${x.id === meeting?.id ? "checked" : ""}/><span><b>${esc(x.title)}</b><small>${fmtDate(x.startedAt)}</small></span></label>`).join("");
  const sync = () => {
    const n = $("cbList").querySelectorAll("input:checked").length;
    $("cbGo").disabled = n < 2;
    $("cbGo").textContent = n < 2 ? "請勾選兩場以上" : `合併這 ${n} 場，產生摘要`;
  };
  $("cbList").onchange = sync; sync();
  $("combineDlg").showModal();
};
$("cbCancel").onclick = () => $("combineDlg").close();
$("cbGo").onclick = async () => {
  const ids = [...$("cbList").querySelectorAll("input:checked")].map((x) => x.value);
  $("cbGo").disabled = true;
  const r = await send({ type: "combineMeetings", ids });
  $("combineDlg").close();
  if (r?.error) return toast(r.error, true);
  meetingId = r.meeting.id; meeting = null; rendered.clear(); $("transcript").innerHTML = "";
  toast("已合併，正在產生摘要…");
  load();
};

// ⋯ 選單
$("menu").addEventListener("click", async (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;
  $("menu").open = false;
  if (!meeting) return;
  if (act === "copyText") copy(meeting.lines.map((l) => `${l.speaker}：${l.text}`).join("\n"), "逐字稿");
  if (act === "copySummary") meeting.summary ? copy(summaryText(meeting.summary), "摘要") : toast("還沒有摘要", true);
  if (act === "resummarize") summarize();
  if (["md", "txt", "gdoc"].includes(act)) exportAs(act);
  if (act === "delete" && confirm(`確定刪除「${meeting.title}」？刪除後無法復原。`)) {
    await send({ type: "deleteMeeting", meetingId: meeting.id });
    meetingId = "current"; meeting = null; rendered.clear(); $("transcript").innerHTML = "";
    toast("已刪除"); load();
  }
});
document.addEventListener("click", (e) => { if (!$("menu").contains(e.target)) $("menu").open = false; });
$("history").onchange = () => { meetingId = $("history").value; meeting = null; rendered.clear(); $("transcript").innerHTML = ""; load(); };

// ── 載入 / 輪詢 ──
async function load() {
  // 帶上手上這份的版本號：沒變的話背景只回「沒變」，不用整份逐字稿再傳一次
  const r = await send({ type: "getMeeting", meetingId, rev: meeting && meeting.id === meetingId ? meeting.rev : undefined });
  if (!r || r.error) return r?.error && toast(r.error, true);
  if (r.unchanged) return;
  if (!r.meeting) {
    $("statusText").textContent = "尚無會議";
    $("transcript").innerHTML = `<div class="empty">還沒有會議記錄。<br>進入會議後，點工具列的圖示按「開始記錄」。</div>`;
    return;
  }
  const changed = meeting?.id !== r.meeting.id;
  // 內容沒變就不重畫（以前每 1.2 秒整份逐字稿重跑一次）
  const m = r.meeting, last = m.lines[m.lines.length - 1];
  const sig = [m.id, m.title, m.recording, m.summarizing, !!m.summary, m.summarizedAt, m.lines.length, last?.id, last?.text, last?.speaker].join("|");
  if (!changed && sig === lastSig) return;
  lastSig = sig;
  meeting = m;
  if (meetingId === "current") meetingId = meeting.id; // 鎖定這一場
  renderHeader(meeting);
  renderTranscript(meeting);
  renderSummary(meeting);
  if (changed) renderHistory();
}
let lastSig = "";

(async () => {
  await applyTheme();
  const { settings } = await chrome.storage.local.get("settings");
  myName = settings?.myName || "我";
  send({ type: "googleStatus" }).then((g) => { $("gdocItem").hidden = !g?.configured; });
  await load();
  const tick = async () => {
    await load();
    setTimeout(tick, meeting?.recording || meeting?.summarizing ? 1200 : 4000);
  };
  setTimeout(tick, 1200);
})();
