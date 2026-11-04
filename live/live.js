// 會議紀錄頁（側邊欄或分頁）
//   第一層「所有會議」：卡片清單、改名、刪除（可復原）、選取 → 合併摘要／一次刪除
//   第二層「單場會議」：← 回上一步、點標題改名、摘要／逐字稿兩個分頁、複製、Word
import { applyTheme } from "../ui/theme.js";
import { fmtTime, fmtDate, meetingToPlainText, summaryHtml, summaryToPlainText } from "../lib/format.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const params = new URLSearchParams(location.search);
let view = params.get("meeting") ? "detail" : "list";
let meetingId = params.get("meeting") || null;
let meeting = null;
let myName = "我";
let tab = null; // "summary" | "transcript"
const rendered = new Map(); // line id -> element（只增量更新，不打斷正在編輯的句子）

// ── 提示（可以帶「復原」按鈕）──
function toast(msg, isErr = false, undo = null) {
  const t = $("toast");
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button class="undo" type="button">復原</button>` : ""}`;
  t.className = "toast show" + (isErr ? " error" : "");
  if (undo) t.querySelector(".undo").onclick = () => { t.className = "toast"; undo(); };
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = "toast"), undo ? 7000 : isErr ? 5000 : 1800);
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(`已複製${label}`); }
  catch { toast("複製失敗", true); }
}

// 刪除前先把整份拿回來，按「復原」就存回去
async function deleteWithUndo(ids) {
  const saved = [];
  for (const id of ids) {
    const r = await send({ type: "getMeeting", meetingId: id });
    if (r?.meeting) saved.push(r.meeting);
    await send({ type: "deleteMeeting", meetingId: id });
  }
  toast(ids.length > 1 ? `已刪除 ${ids.length} 場` : "已刪除", false, async () => {
    for (const m of saved) await send({ type: "restoreMeeting", meeting: m });
    toast("已復原");
    if (view === "list") renderList(true);
  });
}

// ═════════════ 第一層：所有會議 ═════════════
let list = [];
let selecting = null; // Set<id>：選取模式
let listSig = "";

async function renderList(force = false) {
  const r = await send({ type: "listMeetings" });
  list = r?.meetings || [];
  const q = $("listSearch").value.trim().toLowerCase();
  const shown = q ? list.filter((x) => x.title.toLowerCase().includes(q)) : list;
  const sig = JSON.stringify([shown, selecting && [...selecting]]);
  if (!force && sig === listSig) return; // 沒變就不重畫（正在改名時也不會被打斷）
  if (document.activeElement?.classList.contains("rename")) return;
  listSig = sig;
  $("selBtn").hidden = !!selecting || list.length === 0;
  $("selBar").hidden = !selecting;
  if (selecting) {
    const n = selecting.size;
    $("selCount").textContent = `已選 ${n} 場`;
    $("selDelete").disabled = n < 1;
    $("selCombine").disabled = n < 2;
    $("selCombine").title = n < 2 ? "勾選兩場以上才能合併" : `把這 ${n} 場合成一份摘要`;
  }
  if (!list.length) {
    $("mlist").innerHTML = `<div class="empty">還沒有會議紀錄。<br>進入會議後，點工具列的小伐按「開始記錄」。</div>`;
    return;
  }
  if (!shown.length) { $("mlist").innerHTML = `<div class="empty">找不到符合「${esc(q)}」的會議</div>`; return; }
  $("mlist").innerHTML = shown.map((x) => {
    const tags = [
      x.recording ? `<span class="tag rec">● 記錄中</span>` : "",
      x.summarizing ? `<span class="tag">摘要中…</span>` : x.hasSummary ? `<span class="tag ok">✓ 有摘要</span>` : "",
      x.combined ? `<span class="tag">📚 合併 ${x.combined} 場</span>` : "",
    ].join("");
    const meta = `${fmtDate(x.startedAt)}${x.lineCount != null ? ` · ${x.lineCount} 句` : ""}`;
    return `<div class="mcard${selecting?.has(x.id) ? " on" : ""}" data-id="${esc(x.id)}">
      ${selecting ? `<input type="checkbox" class="pick" ${selecting.has(x.id) ? "checked" : ""} ${x.recording ? "disabled" : ""} aria-label="選取" />` : ""}
      <div class="mc-main"><b class="mc-title">${esc(x.title)}</b><small>${meta}</small>${tags ? `<div class="tags">${tags}</div>` : ""}</div>
      ${selecting ? "" : `<div class="mc-acts"><button class="icon" data-act="rename" title="改標題">✏️</button>${x.recording ? "" : `<button class="icon" data-act="del" title="刪除">🗑</button>`}</div>`}
    </div>`;
  }).join("");
}

$("mlist").addEventListener("click", async (e) => {
  const card = e.target.closest(".mcard");
  if (!card || e.target.classList.contains("rename")) return;
  const id = card.dataset.id;
  const x = list.find((m) => m.id === id);
  if (selecting) {
    if (x?.recording) return;
    selecting.has(id) ? selecting.delete(id) : selecting.add(id);
    return renderList(true);
  }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "rename") return startRename(card, x);
  if (act === "del") return deleteWithUndo([id]).then(() => renderList(true));
  openDetail(id);
});

// 卡片上直接改標題：Enter 或點別處就儲存，Esc 取消
function startRename(card, x) {
  const b = card.querySelector(".mc-title");
  const input = document.createElement("input");
  input.className = "rename"; input.value = x.title;
  b.replaceWith(input);
  input.focus(); input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const title = input.value.trim();
    if (save && title && title !== x.title) {
      const r = await send({ type: "setTitle", meetingId: x.id, title });
      r?.error ? toast(r.error, true) : toast("標題已更新");
    }
    input.blur();
    renderList(true);
  };
  input.onkeydown = (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
}

$("listSearch").oninput = () => renderList(true);
$("selBtn").onclick = () => { selecting = new Set(); renderList(true); };
$("selCancel").onclick = () => { selecting = null; renderList(true); };
$("selDelete").onclick = async () => {
  const ids = [...selecting];
  selecting = null;
  await deleteWithUndo(ids);
  renderList(true);
};
$("selCombine").onclick = async () => {
  const ids = [...selecting];
  $("selCombine").disabled = true;
  const r = await send({ type: "combineMeetings", ids });
  if (r?.error) { $("selCombine").disabled = false; return toast(r.error, true); }
  selecting = null;
  toast("已合併，正在產生摘要…");
  openDetail(r.meeting.id);
};

// ═════════════ 第二層：單場會議 ═════════════
function showView(v) {
  view = v;
  $("listView").hidden = v !== "list";
  $("detailView").hidden = v !== "detail";
}
function openDetail(id, push = true) {
  meetingId = id; meeting = null; tab = null; lastSig = "";
  rendered.clear(); $("transcript").innerHTML = ""; $("summaryPane").innerHTML = ""; $("search").value = "";
  showView("detail");
  if (push) history.pushState({ id }, "", `?meeting=${encodeURIComponent(id)}`);
  load();
}
function backToList(push = true) {
  meeting = null; meetingId = null;
  showView("list");
  document.title = "會議紀錄";
  if (push) history.pushState({}, "", "?");
  renderList(true);
}
$("backBtn").onclick = () => backToList();
window.addEventListener("popstate", (e) => (e.state?.id ? openDetail(e.state.id, false) : backToList(false)));

function setTab(t) {
  tab = t;
  for (const b of document.querySelectorAll(".tab")) b.classList.toggle("active", b.dataset.tab === t);
  $("summaryPane").hidden = t !== "summary";
  $("trPane").hidden = t !== "transcript";
  if (t === "transcript") $("trPane").scrollTop = $("trPane").scrollHeight;
}
for (const b of document.querySelectorAll(".tab")) b.onclick = () => setTab(b.dataset.tab);

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
  const box = $("transcript"), scroller = $("trPane");
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
  if (added) m.lines.forEach((l) => box.appendChild(rendered.get(l.id))); // 依時間排序（語音段落可能晚到）
  applySearch();
  if (added && nearBottom) scroller.scrollTop = scroller.scrollHeight; // 使用者往上翻時不要硬捲
}

function renderSummary(m) {
  const box = $("summaryPane");
  if (m.recording) { box.innerHTML = `<div class="empty">會議結束後會自動產生摘要。<br>現在可以到「逐字稿」看即時內容。</div>`; return; }
  if (m.summarizing) { box.innerHTML = `<div class="wait"><span class="spin"></span> 正在產生摘要…</div>`; return; }
  const s = m.summary;
  if (!s) {
    box.innerHTML = m.lines.length
      ? `<div class="empty">${m.summaryError ? "摘要失敗了。" : "還沒有摘要。"}<br><button class="btn primary" id="mk" type="button">✨ 產生摘要</button></div>`
      : `<div class="empty">這場沒有記錄到內容</div>`;
    $("mk")?.addEventListener("click", summarize);
    return;
  }
  box.innerHTML = summaryHtml(s);
}

function renderHeader(m) {
  $("statusBadge").className = "badge " + (m.recording ? "rec" : "ok");
  $("statusText").textContent = m.recording ? "記錄中" : m.combinedFrom ? `合併 ${m.combinedFrom.length} 場` : fmtDate(m.startedAt);
  $("stopBtn").hidden = !m.recording;
  $("lineCount").textContent = m.lines.length ? `(${m.lines.filter((l) => !l.sep).length})` : "";
  if (document.activeElement !== $("title")) $("title").value = m.title;
  const has = m.lines.length > 0;
  $("copyAll").disabled = !has; $("exportDocx").disabled = !has;
  document.title = `${m.recording ? "● " : ""}${m.title} – 會議紀錄`;
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
$("title").onkeydown = (e) => { if (e.key === "Enter") $("title").blur(); if (e.key === "Escape") { $("title").value = meeting?.title || ""; $("title").blur(); } };
$("title").onchange = async () => {
  if (!meeting) return;
  const r = await send({ type: "setTitle", meetingId: meeting.id, title: $("title").value });
  r?.error ? toast(r.error, true) : toast("標題已更新");
};

// ── 按鈕 ──
$("stopBtn").onclick = async () => {
  $("stopBtn").disabled = true;
  const r = await send({ type: "stop", tabId: meeting.tabId, meetingId: meeting.id });
  $("stopBtn").disabled = false;
  r?.error ? toast(r.error, true) : toast("已停止，正在產生摘要…");
  setTab("summary");
  load();
};
$("copyAll").onclick = () => meeting && copy(meetingToPlainText(meeting, { includeTranscript: true }), "摘要和逐字稿，可以貼到任何地方");
$("exportDocx").onclick = () => exportAs("docx");

async function exportAs(target) {
  const r = await send({ type: "export", meetingId: meeting.id, target });
  r?.error ? toast(r.error, true) : toast(target === "gdoc" ? "已建立 Google 文件" : "已下載");
}
async function summarize() {
  if (!meeting?.lines.length) return;
  meeting.summarizing = true; setTab("summary"); renderSummary(meeting);
  const r = await send({ type: "summarize", meetingId: meeting.id });
  if (r?.error) toast(r.error, true);
  load();
}

// ⋯ 選單
$("menu").addEventListener("click", async (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;
  $("menu").open = false;
  if (!meeting) return;
  if (act === "copyText") copy(meeting.lines.filter((l) => !l.sep).map((l) => `${l.speaker}：${l.text}`).join("\n"), "逐字稿");
  if (act === "copySummary") meeting.summary ? copy(summaryToPlainText(meeting.summary), "摘要") : toast("還沒有摘要", true);
  if (act === "resummarize") summarize();
  if (["md", "txt", "gdoc"].includes(act)) exportAs(act);
  if (act === "delete") { const id = meeting.id; backToList(); await deleteWithUndo([id]); renderList(true); }
});
document.addEventListener("click", (e) => { if (!$("menu").contains(e.target)) $("menu").open = false; });

// ── 載入 / 輪詢 ──
let lastSig = "";
async function load() {
  if (view !== "detail") return;
  const want = meetingId;
  // 帶上手上這份的版本號：沒變的話背景只回「沒變」，不用整份逐字稿再傳一次
  const r = await send({ type: "getMeeting", meetingId: want, rev: meeting && meeting.id === want ? meeting.rev : undefined });
  if (view !== "detail" || want !== meetingId) return; // 等待中使用者已經切走
  if (!r || r.error) return r?.error && toast(r.error, true);
  if (r.unchanged) return;
  if (!r.meeting) { backToList(); return; } // 這場已被刪除
  const m = r.meeting, last = m.lines[m.lines.length - 1];
  const sig = [m.id, m.title, m.recording, m.summarizing, !!m.summary, m.summarizedAt, m.lines.length, last?.id, last?.text, last?.speaker].join("|");
  if (sig === lastSig) return; // 內容沒變就不重畫
  lastSig = sig;
  meeting = m;
  if (meetingId === "current") { meetingId = m.id; history.replaceState({ id: m.id }, "", `?meeting=${encodeURIComponent(m.id)}`); }
  if (!tab) setTab(m.recording || (!m.summary && !m.summarizing && !m.lines.length) ? "transcript" : "summary");
  renderHeader(m);
  renderTranscript(m);
  renderSummary(m);
}

(async () => {
  await applyTheme();
  const { settings } = await chrome.storage.local.get("settings");
  myName = settings?.myName || "我";
  send({ type: "googleStatus" }).then((g) => { $("gdocItem").hidden = !g?.configured; });
  history.replaceState(meetingId ? { id: meetingId } : {}, "", location.search);
  if (view === "detail") { showView("detail"); await load(); }
  else { showView("list"); await renderList(true); }
  const tick = async () => {
    if (view === "detail") await load(); else if (!selecting) await renderList();
    setTimeout(tick, meeting?.recording || meeting?.summarizing ? 1200 : 3000);
  };
  setTimeout(tick, 1200);
})();
