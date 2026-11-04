// Popup：只有一顆主要按鈕（開始 / 停止），加上最近一場會議的摘要與三個動作
import { applyTheme } from "../ui/theme.js";
import { fmtTime, fmtDate, meetingToPlainText } from "../lib/format.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// 依螢幕自適應：大螢幕整體放大（字、按鈕、圖示一起），可用高度不夠時壓縮「最近一場會議」卡片
(() => {
  const scale = Math.min(1.25, Math.max(1, screen.width / 1700));          // 1440 以下 1 倍、1920 約 1.13 倍、2560 以上 1.25 倍
  const limit = Math.min(600, Math.max(420, (screen.availHeight || 800) - 160)); // Chrome 小視窗最高 600，小螢幕再扣掉瀏覽器上方
  document.documentElement.style.zoom = scale;
  document.documentElement.style.setProperty("--max-h", Math.floor(limit / scale) + "px");
})();

let state = null;
let busy = false;
let scene = null; // 使用者手動選的情境（沒選就用自動判斷的）
const SCENE_HINT = {
  online: (st) => (st.scene?.meetingSite ? "錄會議聲音和你的麥克風，離開會議會自動停止" : "錄這個網頁的聲音和你的麥克風"),
  room: () => "用麥克風錄，自動分出不同的人。LINE 通話請開喇叭",
  web: () => "只錄這個網頁的聲音，整理成重點筆記",
};
const curScene = () => (scene && (scene === "room" || state?.scene?.canTab) ? scene : state?.scene?.auto || "room");
$("scenes").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-s]");
  if (!b || b.disabled) return;
  scene = b.dataset.s;
  refresh();
});

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
  if (/不能錄網頁的聲音/.test(e)) return "這個頁面不能錄網頁的聲音：請改選「實體會議」，或切到要錄的網頁。";
  if (/不能錄音|不是支援的會議頁面|尚未載入/.test(e)) return "這個頁面不能錄，請切到會議或影片的網頁再按開始。";
  if (/message channel closed|Receiving end does not exist|沒有回應/i.test(e)) return "錄音沒有開始，請再按一次「開始記錄」。";
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

  const sc = state.scene || {};
  $("where").textContent = current ? `正在記錄 ${current.platformName || "會議"}` : sc.page ? (sc.meetingSite ? `已連上 ${sc.page.platformName}` : sc.page.platformName) : "這個頁面只能用麥克風錄";

  // ── 情境 ──
  const now = curScene();
  $("scenes").hidden = !settings.ready || !!current;
  for (const b of $("scenes").querySelectorAll("button")) {
    b.classList.toggle("on", b.dataset.s === now);
    b.setAttribute("aria-checked", b.dataset.s === now);
    b.disabled = b.dataset.s !== "room" && !sc.canTab;
    b.title = b.disabled ? "這個頁面不能錄網頁聲音" : "";
  }

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
    st.textContent = `記錄中 ${elapsed(current.startedAt)} · ${current.lineCount} 句 · ` + (current.platform === "web" || current.platform === "system" ? "按停止就會產生摘要" : "離開會議會自動停止");
    if (current.sttMode !== "captions" && current.stt === "on") {
      const fresh = current.levelsAt && Date.now() - current.levelsAt < 3000;
      $("meters").hidden = false;
      $("lvlMic").style.width = (fresh ? level(current.levels?.mic) : 0) + "%";
      $("lvlTab").style.width = (fresh ? level(current.levels?.tab) : 0) + "%";
    }
    if (current.stt === "error") { st.textContent = friendly(current.sttError || current.sttNotice); st.classList.add("err"); }
  } else {
    btn.disabled = false;
    $("mainLabel").textContent = "開始記錄";
    if (lastStartError && Date.now() - lastStartError.at < 60e3) { st.textContent = friendly(lastStartError.text); st.classList.add("err"); }
    else st.textContent = SCENE_HINT[now](state);
  }

  // ── 最近一場會議 ──
  const m = current || last;
  $("result").hidden = !m;
  if (m) renderResult(m);
}

function renderResult(m) {
  $("mTitle").textContent = m.title;
  $("mMeta").textContent = `${new Date(m.startedAt).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} · ${m.lineCount} 句`;
  const box = $("summary");
  const s = m.summary;
  const has = m.lineCount > 0;
  ["copyAll", "saveWord"].forEach((id) => ($(id).disabled = !has && !m.recording));

  if (m.recording) { box.innerHTML = `<div class="wait">● 記錄中…會議結束後會自動產生摘要</div>`; return; }
  if (m.summarizing) { box.innerHTML = `<div class="wait"><span class="spin"></span> 正在產生摘要…</div>`; return; }
  if (!s) {
    box.innerHTML = has
      ? `<div class="wait">${m.summaryError ? esc(friendly(m.summaryError)) : "還沒有摘要"} <a href="#" id="retry">產生摘要</a></div>`
      : `<div class="wait">這場沒有記錄到內容</div>`;
    $("retry")?.addEventListener("click", async (e) => { e.preventDefault(); await send({ type: "summarize", meetingId: m.id }).then((r) => r?.error && toast(friendly(r.error), true)); refresh(); });
    return;
  }
  // 小伐視窗不能有捲軸（下面的按鈕會被藏起來）：摘要最多三行，待辦只說幾項
  const n = s.action_items?.length || 0;
  box.innerHTML = `<p class="clamp">${esc(String(s.summary || "").split(/\n+/)[0])}</p>`
    + `<p class="small muted">${n ? `📝 待辦 ${n} 項・` : ""}完整內容在「📚 所有會議紀錄」</p>`;
}

// ── 主按鈕 ──
$("mainBtn").onclick = async () => {
  if (busy) return;
  if (!state.settings.ready) { chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") }); window.close(); return; }
  busy = true;
  $("mainBtn").disabled = true;
  $("mainLabel").innerHTML = `<span class="spin"></span>`;
  const r = state.current ? await send({ type: "stop", tabId: state.current.tabId ?? state.tabId, meetingId: state.current.id }) : await send({ type: "start", tabId: state.tabId, scenario: curScene() });
  busy = false;
  if (r?.error) toast(friendly(r.error), true);
  await refresh();
};

// ── 三個動作 ──
const latest = () => state?.current || state?.latest;

$("openLive").onclick = async () => {
  const path = state?.current ? `live/live.html?meeting=${encodeURIComponent(state.current.id)}` : "live/live.html";
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
  // popup 平常只拿輕量資料，複製時才向背景要完整逐字稿
  const r = await send({ type: "getMeeting", meetingId: m.id });
  if (!r?.meeting) return toast("找不到這場會議", true);
  try {
    await navigator.clipboard.writeText(meetingToPlainText(r.meeting, { includeTranscript: true }));
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
