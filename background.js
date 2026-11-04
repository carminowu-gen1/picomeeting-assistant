// Service worker：集中管理錄製狀態、逐字稿儲存、摘要與匯出
import { summarizeTranscript, listModels } from "./lib/groq.js";
import { buildDocx } from "./lib/docx.js";
import { exportToGoogleDoc, googleStatus, googleConnect, googleDisconnect } from "./lib/gdocs.js";
import { DEFAULT_SETTINGS, meetingToMarkdown, meetingToPlainText, fmtDate } from "./lib/format.js";
import { pushSpeakerEvent, attributeSegments, dropUnspokenShort, mainLanguage } from "./lib/speakers.js";
import { toTraditional } from "./lib/s2t.js";
import { withApi } from "./lib/config.js";

const speakerLogs = new Map(); // tabId -> [{ t, names }]（只在記憶體，錄完就丟）

const active = new Map(); // tabId -> meeting (錄製中)

// ── 儲存：每場會議存在自己的 key（m:<id>），另外一份輕量索引（meetingIndex）──
// 以前 50 場全塞在同一個 key：錄音時每 1.5 秒整包讀寫、popup 每 0.5 秒整包傳過去，越用越慢
const MAX_MEETINGS = 50;
const mkey = (id) => `m:${id}`;
const metaOf = (m) => ({ id: m.id, title: m.title, startedAt: m.startedAt, recording: !!m.recording, summarizing: !!m.summarizing,
  lineCount: (m.lines || []).filter((l) => !l.sep).length, hasSummary: !!m.summary, combined: m.combinedFrom?.length || 0 });

async function migrateStorage() {
  const { meetings, meetingIndex } = await chrome.storage.local.get(["meetings", "meetingIndex"]);
  if (!Array.isArray(meetings)) return;
  if (!meetingIndex) {
    const data = { meetingIndex: meetings.slice(0, MAX_MEETINGS).map(metaOf) };
    for (const m of meetings.slice(0, MAX_MEETINGS)) data[mkey(m.id)] = m;
    await chrome.storage.local.set(data);
  }
  await chrome.storage.local.remove("meetings");
}

// 只有索引（id、標題、時間、狀態），很輕
async function listMeetings() {
  const { meetingIndex } = await chrome.storage.local.get("meetingIndex");
  return meetingIndex || [];
}
async function loadMeeting(id) {
  const k = mkey(id);
  return (await chrome.storage.local.get(k))[k] || null;
}
// 索引的「讀→改→寫」要排隊，避免兩次存檔同時進行互相覆蓋
let indexQueue = Promise.resolve();
function updateIndex(fn) {
  indexQueue = indexQueue.then(async () => {
    const next = fn(await listMeetings());
    if (next) await chrome.storage.local.set({ meetingIndex: next });
  }).catch((e) => console.warn("index update failed", e));
  return indexQueue;
}
async function saveMeeting(m, { bump = true } = {}) {
  if (bump) m.rev = (m.rev || 0) + 1;
  await chrome.storage.local.set({ [mkey(m.id)]: m });
  const meta = metaOf(m);
  await updateIndex((idx) => {
    const i = idx.findIndex((x) => x.id === m.id);
    if (i >= 0 && JSON.stringify(idx[i]) === JSON.stringify(meta)) return null; // 沒變就不寫
    if (i >= 0) idx[i] = meta; else idx.unshift(meta);
    idx.sort((a, b) => b.startedAt - a.startedAt);
    const drop = idx.splice(MAX_MEETINGS);
    if (drop.length) chrome.storage.local.remove(drop.map((x) => mkey(x.id)));
    return idx;
  });
}
async function removeMeeting(id) {
  await chrome.storage.local.remove(mkey(id));
  await updateIndex((idx) => idx.filter((x) => x.id !== id));
}
// 錄製中的會議以記憶體為準（最新），其餘從 storage 讀
async function findMeeting(id) {
  return [...active.values()].find((x) => x.id === id) || (await loadMeeting(id));
}
async function latestMeeting() {
  const [rec] = active.values();
  if (rec) return rec;
  const [first] = await listMeetings();
  return first ? loadMeeting(first.id) : null;
}

// MV3 service worker 閒置 30 秒會被關掉、記憶體歸零；錄製中的 tabId→meetingId 存到 session storage，
// 醒來時從 storage.local（每 1.5 秒存一次）把會議拉回 active。
async function persistActive() {
  const map = {};
  for (const [tabId, m] of active) map[tabId] = m.id;
  await chrome.storage.session.set({ activeMap: map });
}
const rehydrated = (async () => {
  await migrateStorage();
  const { activeMap } = await chrome.storage.session.get("activeMap");
  const keep = new Set(Object.values(activeMap || {}));
  for (const meta of await listMeetings()) {
    if (!((meta.recording && !keep.has(meta.id)) || meta.summarizing)) continue; // 只讀需要修正的那幾場
    const m = await loadMeeting(meta.id);
    if (!m) continue;
    if (m.recording && !keep.has(m.id)) { m.recording = false; m.endedAt = m.endedAt || Date.now(); } // 殘留的錄製標記
    if (m.summarizing) { m.summarizing = false; m.summaryError = m.summaryError || "摘要中斷，請再按一次產生摘要"; } // SW 重啟中斷的摘要
    await saveMeeting(m);
  }
  for (const [tabId, id] of Object.entries(activeMap || {})) {
    const m = await loadMeeting(id);
    if (m && m.recording) { active.set(Number(tabId), m); speakerLogs.set(Number(tabId), []); }
  }
  if (![...active.values()].some((m) => m.sttMode && m.sttMode !== "captions")) await closeOffscreen(); // 殘留的 offscreen 會抓著分頁串流
  // 一次性：清掉以前留下的空紀錄（例如錄音沒成功的那幾場）
  const { emptyCleaned } = await chrome.storage.local.get("emptyCleaned");
  if (!emptyCleaned) {
    const busy = new Set([...active.values()].map((m) => m.id));
    for (const meta of await listMeetings()) {
      if (busy.has(meta.id)) continue;
      const m = await loadMeeting(meta.id);
      if (m && !m.recording && !m.lines?.length) await removeMeeting(m.id);
    }
    await chrome.storage.local.set({ emptyCleaned: true });
  }
})();

// 設定放在記憶體，改設定時才重讀（以前每一則字幕更新都讀一次 storage）
let settingsCache = null;
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.settings) settingsCache = null; });
async function getSettings() {
  if (!settingsCache) {
    const { settings } = await chrome.storage.local.get("settings");
    settingsCache = await withApi({ ...DEFAULT_SETTINGS, ...(settings || {}) });
  }
  return settingsCache;
}

// 一次性遷移：舊版預設是「字幕」，改成預設「語音辨識」（使用者手動選過的不動）
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // 第一次安裝：打開歡迎頁（3 步驟設定）
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
  if (reason === "update") await chrome.storage.local.set({ update: null }); // 剛更新完，清掉提醒
  checkForUpdate(true);
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) return;
  const next = { ...settings };
  if (!settings.sttModeChosen) next.sttMode = "stt";
  // 舊預設是固定中文：Whisper 指定 zh 時會把英文「翻譯」成中文。一律改成自動偵測一次（之後使用者要改回固定中文可以）
  if (!settings.sttLangMigrated) { if (settings.sttLanguage === "zh") next.sttLanguage = "auto"; next.sttLangMigrated = true; }
  await chrome.storage.local.set({ settings: next });
});

function newMeeting(tabId, info) {
  return {
    id: `m-${Date.now()}`,
    tabId,
    platform: info.platform,
    platformName: info.platformName,
    title: (info.title || "會議").replace(/\s*[-|]\s*(Google Meet|Microsoft Teams|Zoom|Jitsi Meet|YouTube).*$/i, "").trim() || "會議",
    startedAt: Date.now(),
    endedAt: null,
    lines: [],
    summary: null,
    recording: true,
  };
}

async function setBadge(tabId, on) {
  try {
    await chrome.action.setBadgeText({ tabId, text: on ? "REC" : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#e5484d" });
  } catch {}
}

// 只有一般網頁能錄（chrome://、擴充功能商店等系統頁面 Chrome 不允許擷取）
const recordable = (url) => /^https?:/i.test(url || "") && !/^https:\/\/chrome(webstore)?\.google\.com\/webstore/i.test(url);

// 問分頁是哪種會議；沒有 content script（不在清單上的網站）就當場注入一次
async function pageInfo(tab, inject = true) {
  if (!tab || !recordable(tab.url)) return null;
  let info = await chrome.tabs.sendMessage(tab.id, { type: "ping" }).catch(() => null);
  if (!info && inject) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/capture.js"] });
      info = await chrome.tabs.sendMessage(tab.id, { type: "ping" }).catch(() => null);
    } catch {}
  }
  // 注入不了也照樣能錄聲音（只是沒有發言者名字）
  return info || { platform: "web", platformName: new URL(tab.url).hostname.replace(/^www\./, "") };
}

// 自動決定錄哪裡（不用設定）：
//   會議網站（Meet / Teams / Zoom / Jitsi）→ 錄那個分頁（不跳視窗，還抓得到發言者名字）
//   其他地方（開著 LINE、Teams 電腦版時隨便哪個分頁）→ 錄整台電腦的聲音
//   Mac 大多錄不到系統聲音：一般網頁還是錄分頁
const MEETING_SITES = new Set(["meet", "teams", "zoom", "jitsi"]);
const IS_MAC = /Mac/i.test(navigator.userAgent);
async function decideSource(tab) {
  const page = tab && recordable(tab.url) ? await pageInfo(tab) : null;
  if (page && MEETING_SITES.has(page.platform)) return { sys: false, info: page };
  if (IS_MAC && page) return { sys: false, info: page };
  return { sys: true, info: { platform: "system", platformName: "麥克風" } };
}

async function startRecording(tabId) {
  const settings = await getSettings();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const { sys, info: found } = await decideSource(tab);
  if (sys && [...active.values()].some((x) => x.source === "system")) throw new Error("已經在錄音了，請先停止上一場。");
  const info = sys
    ? { ...found, title: `會議 ${new Date().toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}` }
    : found;
  if (!info.title) info.title = tab.title;
  const m = newMeeting(tabId, info);
  m.url = sys ? "" : tab.url;
  m.source = sys ? "system" : "tab";
  // 一般網頁、整台電腦都沒有字幕可抓：一律用語音辨識
  const mode = info.platform === "web" || sys ? "stt" : settings.sttMode || "stt";
  m.sttMode = mode;
  active.set(tabId, m);
  speakerLogs.set(tabId, []);
  const tell = (msg) => chrome.tabs.sendMessage(tabId, msg).catch(() => null); // 沒有 content script 也不影響錄音
  if (sys) { /* 不碰目前分頁 */ }
  else if (mode !== "stt") await tell({ type: "start", autoCaptions: settings.autoCaptions, watchSpeakers: mode === "both", myName: settings.myName });
  else await tell({ type: "startSpeakerWatch", myName: settings.myName });
  if (mode !== "captions") {
    try { await startStt(tabId, settings, sys); m.stt = "on"; }
    catch (e) {
      m.stt = "error"; m.sttError = e.message;
      await stopStt(tabId); // 失敗也要把可能已開的串流放掉，否則下次會 "active stream"
      if (mode === "stt") { active.delete(tabId); await persistActive(); throw new Error("無法啟動語音辨識：" + e.message); }
    }
  }
  await saveMeeting(m);
  await persistActive();
  await setBadge(tabId, true);
  return m;
}

// ── 語音辨識（offscreen + Groq Whisper）──
async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "擷取會議分頁音訊並轉成逐字稿",
  });
}

async function startStt(tabId, settings, sys = false) {
  if (!settings.ready) throw new Error("尚未完成設定：請先在設定頁貼上 Groq 金鑰。");
  if (sys) {
    // 不在會議網站：直接用麥克風錄，不跳任何視窗
    await ensureOffscreen();
    const r = await chrome.runtime.sendMessage({ target: "offscreen", type: "stt:start", micOnly: true, tabId, settings }).catch((e) => ({ error: e.message }));
    if (!r) throw new Error("錄音程式沒有回應，請再按一次開始");
    if (r.error) throw new Error(r.error);
    return;
  }
  const step = async (name, fn) => { try { return await fn(); } catch (e) { throw new Error(`[${name}] ${e?.message || e}`); } };
  // 需要使用者剛在這個分頁按過擴充功能（popup 按「開始記錄」即符合）
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (e) {
    if (/active stream/i.test(e?.message || "")) {
      // 上一次的串流還被舊的 offscreen 抓著：整個關掉（會釋放所有串流）再試
      await closeOffscreen();
      await new Promise((r) => setTimeout(r, 300));
    } else {
      // 常見：分頁不是前景、或 Chrome 認為擴充功能沒在這個分頁被叫用 → 切到該分頁再試一次
      await chrome.tabs.update(tabId, { active: true }).catch(() => {});
    }
    streamId = await step("取得分頁音訊 tabCapture", () => chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }));
  }
  await step("建立 offscreen 文件", ensureOffscreen);
  const r = await step("傳送啟動訊息給 offscreen", () => chrome.runtime.sendMessage({ target: "offscreen", type: "stt:start", tabId, streamId, settings }));
  if (!r) throw new Error("[offscreen 沒有回應] 請重新載入擴充功能再試");
  if (r.error) throw new Error(r.error);
}

let micWinId = null;
async function openMicPermWindow() {
  if (micWinId != null) { try { await chrome.windows.update(micWinId, { focused: true }); return; } catch {} }
  const w = await chrome.windows.create({ url: chrome.runtime.getURL("perm/mic.html"), type: "popup", width: 460, height: 360 });
  micWinId = w.id;
}
chrome.windows.onRemoved.addListener((id) => { if (id === micWinId) micWinId = null; });

async function closeOffscreen() {
  try { if (await chrome.offscreen.hasDocument?.()) await chrome.offscreen.closeDocument(); } catch {}
}

async function stopStt(tabId) {
  try { await chrome.runtime.sendMessage({ target: "offscreen", type: "stt:stop", tabId }); } catch {}
  try {
    const st = await chrome.runtime.sendMessage({ target: "offscreen", type: "stt:status" });
    if (!st || !st.active?.length) await closeOffscreen();
  } catch { await closeOffscreen(); }
}

async function stopRecording(tabId) {
  const m = active.get(tabId);
  if (!m) return null;
  m.recording = false;
  m.endedAt = Date.now();
  active.delete(tabId);
  await persistActive();
  await chrome.tabs.sendMessage(tabId, { type: "stop" }).catch(() => {});
  if (m.sttMode && m.sttMode !== "captions") await stopStt(tabId);
  speakerLogs.delete(tabId);
  await setBadge(tabId, false);
  if (!m.lines.length) { await removeMeeting(m.id); return m; } // 什麼都沒錄到：不留空紀錄
  await saveMeeting(m);
  const settings = await getSettings();
  if (settings.autoSummarize && m.lines.length) {
    summarize(m.id).catch((e) => console.warn("auto summarize failed", e));
  }
  return m;
}

// 錄音中的存檔：最多每 3 秒存一次。以前每來一則就把計時重設，字幕一直來就一直不存（背景程式被關掉會掉資料）
let saveTimer = null;
const pendingSave = new Set();
function scheduleSave(m) {
  m.rev = (m.rev || 0) + 1; // 全文頁靠 rev 判斷有沒有變
  pendingSave.add(m);
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const list = [...pendingSave];
    pendingSave.clear();
    for (const x of list) await saveMeeting(x, { bump: false });
  }, 3000);
}

// 把幾場會議合成一份新的紀錄（原本的會議不動），接著自動產生合併摘要
async function combineMeetings(ids) {
  const ms = (await Promise.all([...new Set(ids)].map(findMeeting))).filter((m) => m && !m.recording && m.lines?.length).sort((a, b) => a.startedAt - b.startedAt);
  if (ms.length < 2) throw new Error("請至少勾選兩場有內容的會議。");
  const md = (t) => new Date(t).toLocaleDateString("zh-TW", { month: "numeric", day: "numeric" });
  const lines = [];
  ms.forEach((m, i) => {
    lines.push({ id: `sep-${i}`, t: m.startedAt, speaker: "", text: `第 ${i + 1} 場：${m.title}（${fmtDate(m.startedAt)}）`, sep: true });
    for (const l of m.lines) if (!l.sep) lines.push({ ...l, id: `p${i}-${l.id}` });
  });
  const first = md(ms[0].startedAt), last = md(ms[ms.length - 1].startedAt);
  const c = {
    id: `m-${Date.now()}`,
    title: `合併摘要 ${first === last ? first : `${first}–${last}`}（${ms.length} 場）`,
    platformName: `合併 ${ms.length} 場`,
    startedAt: Date.now(), // 排在清單最上面
    endedAt: null,
    lines,
    summary: null,
    recording: false,
    combinedFrom: ms.map((m) => ({ id: m.id, title: m.title, startedAt: m.startedAt, endedAt: m.endedAt, platformName: m.platformName })),
  };
  await saveMeeting(c);
  summarize(c.id).catch((e) => console.warn("combined summary failed", e));
  return { id: c.id, title: c.title };
}

async function summarize(meetingId) {
  const m = await findMeeting(meetingId);
  if (!m) throw new Error("找不到會議");
  if (!m.lines.length) throw new Error("逐字稿是空的，無法產生摘要。");
  const settings = await getSettings();
  if (!settings.ready) throw new Error("尚未完成設定：請先在設定頁貼上 Groq 金鑰。");
  // summarizing / summaryError 給 popup 顯示「產生摘要中…」或錯誤
  m.summarizing = true; m.summaryError = null;
  await saveMeeting(m);
  try {
    m.summary = await summarizeTranscript(m, settings);
    m.summarizedAt = Date.now();
    return m.summary;
  } catch (e) {
    m.summaryError = e.message || String(e);
    throw e;
  } finally {
    m.summarizing = false;
    await saveMeeting(m);
  }
}

async function exportMeeting(meetingId, target) {
  const m = await findMeeting(meetingId);
  if (!m) throw new Error("找不到會議");
  const settings = await getSettings();
  const base = `${m.title}_${new Date(m.startedAt).toISOString().slice(0, 10)}`.replace(/[\\/:*?"<>|]/g, "_");

  if (target === "gdoc") {
    const url = await exportToGoogleDoc(m, settings);
    await chrome.tabs.create({ url });
    return { url };
  }
  let blob, filename;
  if (target === "docx") {
    blob = buildDocx(m, settings);
    filename = `${base}.docx`;
  } else if (target === "md") {
    blob = new Blob([meetingToMarkdown(m, settings)], { type: "text/markdown" });
    filename = `${base}.md`;
  } else {
    blob = new Blob([meetingToPlainText(m, settings)], { type: "text/plain" });
    filename = `${base}.txt`;
  }
  // MV3 service worker 不能用 URL.createObjectURL，改用 data URL
  const dataUrl = await blobToDataUrl(blob);
  try {
    await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
  } catch (e) {
    // 下載 API 被政策擋住時，退而開新分頁讓瀏覽器自己存檔
    console.warn("downloads.download failed, opening tab", e);
    await chrome.tabs.create({ url: dataUrl });
  }
  return { filename };
}

function blobToDataUrl(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(blob);
  });
}

// ── 回音去重：沒戴耳機時，對方的聲音從喇叭出來又被麥克風收到，同一句會出現兩次 ──
// 規則：時間差 8 秒內、內容相似度 ≥ 0.6 → 留電腦／分頁那一份（音質較好、是對方本人），麥克風那份丟掉
const ECHO_MS = 8000, ECHO_SIM = 0.6;
function bigrams(s) {
  const t = String(s || "").toLowerCase().replace(/[\s\p{P}]/gu, "");
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
  return { out, n: Math.max(0, t.length - 1) };
}
function similar(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (A.n < 2 || B.n < 2) return a.trim() === b.trim() && a.trim().length > 0 ? 1 : 0;
  let hit = 0;
  for (const [g, c] of A.out) hit += Math.min(c, B.out.get(g) || 0);
  return (2 * hit) / (A.n + B.n);
}
function dropEcho(m, lines, channel) {
  const near = (l) => m.lines.filter((x) => x.src === "stt" && Math.abs(x.t - l.t) < ECHO_MS);
  if (channel === "mic") {
    // 麥克風的句子：如果電腦／分頁那邊已經有一樣的 → 是回音，不要
    return lines.filter((l) => !near(l).some((x) => !x.id.startsWith("stt-mic-") && similar(x.text, l.text) >= ECHO_SIM));
  }
  // 電腦／分頁的句子比較晚到：把先前麥克風收到的回音拿掉
  for (const l of lines) {
    const echo = near(l).filter((x) => x.id.startsWith("stt-mic-") && similar(x.text, l.text) >= ECHO_SIM);
    if (echo.length) m.lines = m.lines.filter((x) => !echo.includes(x));
  }
  return lines;
}

// ── 來自 content script 的訊息 ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === "offscreen") return; // 給 offscreen 的訊息，這裡不處理
  // 字幕來自 content script（sender.tab）；語音辨識來自 offscreen（msg.tabId）
  const fromExt = sender.id === chrome.runtime.id && sender.url?.startsWith(chrome.runtime.getURL(""));
  const tabId = /^stt:/.test(msg.type) && fromExt && msg.tabId != null ? msg.tabId : sender.tab?.id ?? (/^stt:/.test(msg.type) ? msg.tabId : undefined);
  (async () => {
    await rehydrated; // 確保 SW 重啟後 active 已復原再處理任何訊息
    if (msg.type === "caption" && tabId != null) {
      const m = active.get(tabId);
      if (!m) return;
      m.received = (m.received || 0) + 1;
      m.lastEventAt = Date.now();
      // 字幕有名字：也當作「此刻誰在說話」的證據
      if (msg.mode === "append" && msg.speaker && speakerLogs.has(tabId)) pushSpeakerEvent(speakerLogs.get(tabId), Date.now(), [msg.speaker]);
      if (msg.mode === "replace") {
        const line = m.lines.find((l) => l.id === msg.id);
        if (line) { line.text = (await getSettings()).toTraditional !== false ? toTraditional(msg.text) : msg.text; scheduleSave(m); return; }
      }
      const s2t = (await getSettings()).toTraditional !== false;
      m.lines.push({ id: msg.id, t: Date.now(), speaker: msg.speaker, text: s2t ? toTraditional(msg.text) : msg.text });
      scheduleSave(m);
      return;
    }
    if (msg.type === "speaker" && tabId != null) {
      const log = speakerLogs.get(tabId);
      if (log) pushSpeakerEvent(log, msg.t, msg.names);
      const m = active.get(tabId);
      if (m) m.speakerDetect = true;
      return;
    }
    if (msg.type === "stt:segments" && tabId != null) {
      const m = active.get(tabId);
      if (!m) return;
      const settings = await getSettings();
      const me = settings.myName || "我";
      let lines;
      if (msg.channel === "mic" && m.source === "system") {
        // 只用麥克風（實體會議、LINE）：說話的人由聲紋分出來（說話者 A、B…），連續同一人合成一句
        lines = [];
        for (const g of msg.segments) {
          const text = (g.text || "").trim(); if (!text) continue;
          const t = msg.chunkStart + Math.round((g.start || 0) * 1000), speaker = g.speaker || "發言", last = lines[lines.length - 1];
          if (last && last.speaker === speaker && t - last.t < 15000) last.text += (/[。！？!?.]$/.test(last.text) ? "" : "，") + text;
          else lines.push({ t, speaker, text });
        }
      } else if (msg.channel === "mic") {
        // 麥克風通道一定是你自己
        lines = attributeSegments([], msg.segments, msg.chunkStart, me);
      } else {
        // 分頁通道是其他人：時間軸裡把「我」排除，剩下的才是候選
        const log = (speakerLogs.get(tabId) || []).map((e) => ({ t: e.t, names: e.names.filter((n) => n !== me && n !== "我") }));
        // 畫面上沒有對方在說話時冒出的短句、或和會議主要語言不同的句子，多半是雜音被編成句子
        const kept = dropUnspokenShort(log, msg.segments, msg.chunkStart, { lang: msg.language, mainLang: mainLanguage(m.langCounts) });
        lines = attributeSegments(log, kept, msg.chunkStart, settings.sttSpeaker || "語音");
      }
      // 累計每種語言的字數，用來判斷這場會議的主要語言
      if (msg.language) {
        m.langCounts ??= {};
        m.langCounts[msg.language] = (m.langCounts[msg.language] || 0) + lines.reduce((n, l) => n + l.text.length, 0);
      }
      if (settings.toTraditional !== false) lines.forEach((l) => { l.text = toTraditional(l.text); });
      lines = dropEcho(m, lines, msg.channel === "mic" ? "mic" : "tab");
      lines.forEach((l, i) => m.lines.push({ id: `stt-${msg.channel || "tab"}-${msg.chunkStart}-${i}`, ...l, src: "stt" }));
      m.lines.sort((a, b) => a.t - b.t); // 語音段落可能晚到
      scheduleSave(m);
      return;
    }
    if (msg.type === "stt:relabel" && tabId != null) {
      // 聲紋發現兩群其實是同一人：舊句子跟著改
      const m = active.get(tabId);
      if (!m) return;
      for (const { from, to } of msg.map || []) for (const l of m.lines) if (l.speaker === from) l.speaker = to;
      scheduleSave(m);
      return;
    }
    if (msg.type === "stt:micDenied" && tabId != null) {
      // 麥克風未授權：開一個小視窗要權限（offscreen 自己不能跳詢問）
      const m = active.get(tabId);
      if (m) { m.stt = "on"; m.sttNotice = "麥克風未授權，請在跳出的視窗按「允許」"; }
      await openMicPermWindow();
      return;
    }
    if (msg.type === "micGranted") {
      // 授權視窗回報成功：把麥克風通道接到所有進行中的語音辨識
      try { await chrome.runtime.sendMessage({ target: "offscreen", type: "stt:addMic" }); } catch {}
      return;
    }
    if (msg.type === "stt:levels" && tabId != null) {
      const m = active.get(tabId);
      if (m) { m.levels = msg.levels; m.levelsAt = Date.now(); }
      return;
    }
    if (msg.type === "stt:stats" && tabId != null) {
      const m = active.get(tabId);
      if (m) m.sttStats = msg.stats;
      return;
    }
    if (msg.type === "stt:notice" && tabId != null) {
      const m = active.get(tabId);
      if (m) { m.stt = msg.level === "error" ? "error" : "on"; m.sttNotice = msg.text; }
      return;
    }
    if (msg.type === "pageReady" && tabId != null) {
      const settings = await getSettings();
      if (settings.autoStart && !active.has(tabId)) {
        // 等會議 UI 載入
        setTimeout(() => startRecording(tabId).catch(() => {}), 8000);
      }
      return;
    }
    if ((msg.type === "meetingEnded" || (msg.type === "stopped" && msg.reason === "unload")) && tabId != null) {
      if (active.has(tabId)) await stopRecording(tabId); // 離開會議 → 自動停止（會自動摘要）
      return;
    }
    if (msg.type === "status" && tabId != null) {
      const m = active.get(tabId);
      if (m) m.captionsFound = msg.captionsFound;
      return;
    }

    // ── 來自 popup / options 等擴充功能自己頁面的指令 ──
    // 會議網頁上的 content script 不能下這些指令（就算會議網頁被攻破也一樣）
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return;
    switch (msg.type) {
      case "getState": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const info = (await decideSource(tab)).info;
        const current = (tab ? active.get(tab.id) : null) || [...active.values()].find((x) => x.source === "system") || null;
        const { lastStartError } = await chrome.storage.session.get("lastStartError");
        checkForUpdate(); // 不等結果；下次打開 popup 就會看到
        const { update } = await chrome.storage.local.get("update");
        const s = await getSettings();
        const settings = { ready: s.ready, sttMode: s.sttMode, autoSummarize: s.autoSummarize }; // 不把金鑰傳出去
        // 只回最近一場（popup 只顯示這一場），不再把所有會議的逐字稿都傳過去
        // popup 只顯示狀態、句數和摘要：不傳整份逐字稿（錄音中它每 0.5 秒問一次）
        const lite = (m) => (m ? { ...m, lines: undefined, lineCount: m.lines.length } : null);
        return reply({ tabId: tab?.id, info, current: lite(current), latest: lite(current || (await latestMeeting())), settings, lastStartError, update });
      }
      case "start": {
        try { const meeting = await startRecording(msg.tabId); await chrome.storage.session.set({ lastStartError: null }); return reply({ meeting }); }
        catch (e) { await chrome.storage.session.set({ lastStartError: { at: Date.now(), text: e.message || String(e) } }); throw e; }
      }
      case "stop": {
        // 側邊欄傳來的 tabId 可能過期：用 meetingId 找回正在錄的分頁
        let tabId = msg.tabId;
        if (!active.has(tabId) && msg.meetingId) for (const [t, m] of active) if (m.id === msg.meetingId) tabId = t;
        if (active.has(tabId)) return reply({ meeting: await stopRecording(tabId) });
        // 找不到正在錄的分頁（例如分頁已關）：把殘留的「記錄中」標記關掉
        const m = msg.meetingId && (await findMeeting(msg.meetingId));
        if (m?.recording) { m.recording = false; m.endedAt = Date.now(); await saveMeeting(m); }
        return reply({ meeting: m || null });
      }
      case "listMeetings": {
        // 舊版索引沒有句數：補一次
        const idx = await listMeetings();
        if (idx.some((x) => x.lineCount == null)) {
          const fixed = [];
          for (const x of idx) { const m = x.lineCount == null ? await loadMeeting(x.id) : null; fixed.push(m ? metaOf(m) : x); }
          await updateIndex(() => fixed);
        }
        return reply({ meetings: [...[...active.values()].map(metaOf), ...(await listMeetings()).filter((x) => ![...active.values()].some((a) => a.id === x.id))] });
      }
      case "restoreMeeting": {
        // 「復原」：把剛刪掉的那場原封不動存回去
        const m = msg.meeting;
        if (!m?.id || !Array.isArray(m.lines)) throw new Error("無法復原");
        m.recording = false; m.summarizing = false;
        await saveMeeting(m);
        return reply({ ok: true });
      }
      case "summarize": return reply({ summary: await summarize(msg.meetingId) });
      case "combineMeetings": return reply({ meeting: await combineMeetings(msg.ids || []) });
      case "listModels": { const s = await getSettings(); return reply({ models: s.ready ? await listModels(s) : [] }); }
      case "export": return reply(await exportMeeting(msg.meetingId, msg.target));
      case "googleStatus": return reply(await googleStatus());
      case "googleConnect": return reply(await googleConnect());
      case "googleDisconnect": return reply(await googleDisconnect());
      case "deleteMeeting": {
        // 還在錄的話先停掉、且不存檔，否則下一句字幕又會把它存回來
        for (const [tabId, m] of active) {
          if (m.id !== msg.meetingId) continue;
          active.delete(tabId);
          speakerLogs.delete(tabId);
          await persistActive();
          await chrome.tabs.sendMessage(tabId, { type: "stop" }).catch(() => {});
          if (m.sttMode && m.sttMode !== "captions") await stopStt(tabId);
          await setBadge(tabId, false);
        }
        for (const x of pendingSave) if (x.id === msg.meetingId) pendingSave.delete(x);
        await removeMeeting(msg.meetingId);
        return reply({ ok: true });
      }
      case "enableCaptions": return reply(await chrome.tabs.sendMessage(msg.tabId, { type: "enableCaptions" }));
      case "diagnose": {
        const d = await chrome.tabs.sendMessage(msg.tabId, { type: "diagnose", myName: (await getSettings()).myName });
        const m = active.get(msg.tabId);
        return reply({ ...d, received: m ? m.received || 0 : "未在記錄中", lines: m?.lines.length ?? null, stt: m ? { mode: m.sttMode, state: m.stt, notice: m.sttNotice, stats: m.sttStats } : null });
      }

      // ── 即時整理頁 ──
      case "getMeeting": {
        // "current"：正在錄的那場；否則最近一場
        let m = null;
        if (msg.meetingId && msg.meetingId !== "current") m = await findMeeting(msg.meetingId);
        else m = await latestMeeting();
        if (m && msg.rev != null && m.rev === msg.rev) return reply({ unchanged: true });
        return reply({ meeting: m, activeCount: active.size });
      }
      case "editLine": {
        const m = await findMeeting(msg.meetingId);
        const line = m?.lines.find((l) => l.id === msg.id);
        if (!line) throw new Error("找不到這一句");
        if (msg.text != null) line.text = msg.text;
        if (msg.speaker != null) line.speaker = msg.speaker;
        await saveMeeting(m);
        return reply({ ok: true });
      }
      case "deleteLine": {
        const m = await findMeeting(msg.meetingId);
        if (!m) throw new Error("找不到會議");
        m.lines = m.lines.filter((l) => l.id !== msg.id);
        await saveMeeting(m);
        return reply({ ok: true });
      }
      case "renameSpeaker": {
        const m = await findMeeting(msg.meetingId);
        if (!m) throw new Error("找不到會議");
        m.lines.forEach((l) => { if (l.speaker === msg.from) l.speaker = msg.to; });
        await saveMeeting(m);
        // 錄音中：讓聲紋也記住新名字，之後同一個人的句子直接用真名
        for (const [tabId, a] of active) if (a.id === m.id) chrome.runtime.sendMessage({ target: "offscreen", type: "stt:renameSpeaker", tabId, from: msg.from, to: msg.to }).catch(() => {});
        return reply({ ok: true });
      }
      case "setTitle": {
        const m = await findMeeting(msg.meetingId);
        if (!m) throw new Error("找不到會議");
        m.title = msg.title.trim() || m.title;
        await saveMeeting(m);
        return reply({ ok: true });
      }
      case "openLivePage": {
        const url = chrome.runtime.getURL(`live/live.html?meeting=${encodeURIComponent(msg.meetingId || "current")}`);
        if (msg.mode === "window") await chrome.windows.create({ url, type: "popup", width: 520, height: 760 });
        else await chrome.tabs.create({ url });
        return reply({ ok: true });
      }
    }
  })().catch((e) => reply({ error: e.message || String(e) }));
  return true;
});

// ── 新版本提醒：只對手動安裝（開發人員模式）的人；商店安裝會自己更新 ──
const UPDATE_REPO = "carminowu-gen1/picomeeting-assistant";
const UPDATE_PAGE = "https://carminowu-gen1.github.io/picomeeting-assistant/#update";
const newerThan = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};
async function checkForUpdate(force = false) {
  try {
    if ((await chrome.management.getSelf()).installType !== "development") return;
    const { updateCheckedAt = 0 } = await chrome.storage.local.get("updateCheckedAt");
    if (!force && Date.now() - updateCheckedAt < 12 * 3600e3) return; // 最多 12 小時查一次
    await chrome.storage.local.set({ updateCheckedAt: Date.now() });
    const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
    if (!r.ok) return; // repo 是私人或還沒有 release：不提醒
    const latest = String((await r.json()).tag_name || "").replace(/^v/, "");
    const has = latest && newerThan(latest, chrome.runtime.getManifest().version);
    await chrome.storage.local.set({ update: has ? { version: latest, url: UPDATE_PAGE } : null });
  } catch {}
}
chrome.runtime.onStartup.addListener(() => checkForUpdate());

chrome.tabs.onRemoved.addListener(async (tabId) => { await rehydrated; if (active.has(tabId) && active.get(tabId).source !== "system") stopRecording(tabId); });

// 會議分頁換到別的網址（例如離開後回到 Meet 首頁）→ 停止
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  await rehydrated;
  const m = active.get(tabId);
  if (!m?.url || m.source === "system") return;
  try {
    const a = new URL(m.url), b = new URL(info.url);
    if (a.host !== b.host || a.pathname !== b.pathname) stopRecording(tabId);
  } catch {}
});
