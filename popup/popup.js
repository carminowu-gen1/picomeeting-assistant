// Popup：只有一顆主要按鈕（開始 / 停止），加上最近一場會議的摘要與三個動作
import { applyTheme } from "../ui/theme.js";
import { fmtTime, fmtDate, meetingToPlainText } from "../lib/format.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let state = null;
let busy = false;

function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " error" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = "toast"), isErr ? 6000 : 2000);
}

// 把技術性錯誤翻成一般人看得懂的話
function friendly(err) {
  const e = String(err || "");
  if (/active stream/i.test(e)) return "上一次的錄音還沒結束，請重新整理會議頁面後再試一次。";
  if (/尚未完成設定|金鑰|API Key/i.test(e)) return "還沒完成設定，請按右上角 ⚙ 完成設定。";
  if (/存取碼/.test(e)) return "組織服務無法使用，請聯絡管理員。";
  if (/不是支援的會議頁面|尚未載入/.test(e)) return "請先進入會議，再按開始記錄。";
  if (/麥克風/.test(e)) return "無法使用麥克風，請在跳出的視窗按「允許」。";
  if (/額度|429/.test(e)) return "使用量暫時達到上限，請稍後再試。";
  return e.replace(/^無法啟動語音辨識：/, "").slice(0, 120);
}

const elapsed = (t) => {
  const s = Math.floor((Date.now() - t) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function level(v) {
  return v == null ? 0 : Math.min(100, Math.max(0, (Math.log10(Math.max(v, 1e-4)) + 4) / 2.7 * 100));
}

async function refresh() {
  state = await send({ type: "getState" });
  if (!state || state.error) return;
  const { info, current, latest: last, settings, lastStartError } = state;

  $("update").hidden = !state.update;
  if (state.update) {
    $("update").textContent = `🎁 有新版本 ${state.update.version}，點這裡看怎麼更新`;
    $("update").onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: state.update.url }); window.close(); };
  }

  $("where").textContent = current ? `正在記錄 ${current.platformName || "會議"}` : info ? `已連上 ${info.platformName}` : "目前不在會議頁面";

  // ── 主按鈕 ──
  const btn = $("mainBtn"), st = $("status");
  st.classList.remove("err");
  btn.classList.remove("stop");
  $("meters").hidden = true;
  if (!settings.ready) {
    btn.disabled = false;
    $("mainLabel").textContent = "完成設定";
    st.textContent = "第一次使用，需要先花 1 分鐘設定";
  } else if (current) {
    btn.disabled = false;
    btn.classList.add("stop");
    $("mainLabel").textContent = "停止記錄";
    st.textContent = `記錄中 ${elapsed(current.startedAt)} · ${current.lines.length} 句 · 離開會議會自動停止`;
    if (current.sttMode !== "captions" && current.stt === "on") {
      const fresh = current.levelsAt && Date.now() - current.levelsAt < 3000;
      $("meters").hidden = false;
      $("lvlMic").style.width = (fresh ? level(current.levels?.mic) : 0) + "%";
      $("lvlTab").style.width = (fresh ? level(current.levels?.tab) : 0) + "%";
    }
    if (current.stt === "error") { st.textContent = friendly(current.sttError || current.sttNotice); st.classList.add("err"); }
  } else {
    btn.disabled = !info;
    $("mainLabel").textContent = "開始記錄";
    if (lastStartError && info) { st.textContent = friendly(lastStartError.text); st.classList.add("err"); }
    else st.textContent = info ? "離開會議時會自動停止並產生摘要" : "請先進入 Google Meet、Teams、Zoom 或 Jitsi 會議";
  }

  // ── 最近一場會議 ──
  const m = current || last;
  $("result").hidden = !m;
  if (m) renderResult(m);
}

function renderResult(m) {
  $("mTitle").textContent = m.title;
  $("mMeta").textContent = `${fmtDate(m.startedAt)} · ${m.lines.length} 句`;
  const box = $("summary");
  const s = m.summary;
  const has = m.lines.length > 0;
  ["copyAll", "saveWord", "openLive"].forEach((id) => ($(id).disabled = !has && !m.recording));

  if (m.recording) { box.innerHTML = `<div class="wait">● 記錄中…會議結束後會自動產生摘要</div>`; return; }
  if (m.summarizing) { box.innerHTML = `<div class="wait"><span class="spin"></span> 正在產生摘要…</div>`; return; }
  if (!s) {
    box.innerHTML = has
      ? `<div class="wait">${m.summaryError ? esc(friendly(m.summaryError)) : "還沒有摘要"} <a href="#" id="retry">產生摘要</a></div>`
      : `<div class="wait">這場沒有記錄到內容</div>`;
    $("retry")?.addEventListener("click", async (e) => { e.preventDefault(); await send({ type: "summarize", meetingId: m.id }).then((r) => r?.error && toast(friendly(r.error), true)); refresh(); });
    return;
  }
  const li = (a) => (a?.length ? `<ul>${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "");
  const todo = s.action_items?.map((a) => `${a.task}${a.owner ? `（${a.owner}）` : ""}${a.due ? ` ${a.due}` : ""}`);
  box.innerHTML = `<p>${esc(s.summary)}</p>`
    + (s.key_points?.length ? `<h4>重點</h4>${li(s.key_points)}` : "")
    + (todo?.length ? `<h4>待辦</h4>${li(todo)}` : "");
}

// ── 主按鈕 ──
$("mainBtn").onclick = async () => {
  if (busy) return;
  if (!state.settings.ready) { chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") }); window.close(); return; }
  busy = true;
  $("mainBtn").disabled = true;
  $("mainLabel").innerHTML = `<span class="spin"></span>`;
  const r = state.current ? await send({ type: "stop", tabId: state.tabId }) : await send({ type: "start", tabId: state.tabId });
  busy = false;
  if (r?.error) toast(friendly(r.error), true);
  await refresh();
};

// ── 三個動作 ──
const latest = () => state?.current || state?.latest;

$("openLive").onclick = async () => {
  const m = latest();
  const path = `live/live.html?meeting=${encodeURIComponent(m?.id || "current")}`;
  try {
    await chrome.sidePanel.setOptions({ path, enabled: true });
    await chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id });
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL(path) });
  }
  window.close();
};

$("copyAll").onclick = async () => {
  const m = latest();
  if (!m) return;
  try {
    await navigator.clipboard.writeText(meetingToPlainText(m, { includeTranscript: true }));
    toast("已複製，可以貼到任何地方");
  } catch { toast("複製失敗", true); }
};

$("saveWord").onclick = async () => {
  const m = latest();
  if (!m) return;
  const r = await send({ type: "export", meetingId: m.id, target: "docx" });
  r?.error ? toast(friendly(r.error), true) : toast("已下載 Word 檔");
};

$("openOptions").onclick = () => chrome.runtime.openOptionsPage();

// ── 啟動：錄製或摘要進行中時每 0.5 秒更新，否則 3 秒 ──
(async () => {
  await applyTheme();
  await refresh();
  const tick = async () => {
    const live = state?.current || state?.latest?.summarizing;
    if (!busy) await refresh();
    setTimeout(tick, live ? 500 : 3000);
  };
  setTimeout(tick, 500);
})();
