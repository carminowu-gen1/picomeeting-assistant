// Service worker：集中管理錄製狀態、逐字稿儲存、摘要與匯出
import { summarizeTranscript } from "./lib/groq.js";
import { buildDocx } from "./lib/docx.js";
import { exportToGoogleDoc, googleStatus, googleConnect, googleDisconnect } from "./lib/gdocs.js";
import { DEFAULT_SETTINGS, meetingToMarkdown, meetingToPlainText } from "./lib/format.js";
import { pushSpeakerEvent, attributeSegments } from "./lib/speakers.js";
import { toTraditional } from "./lib/s2t.js";
import { withApi } from "./lib/config.js";

const speakerLogs = new Map(); // tabId -> [{ t, names }]（只在記憶體，錄完就丟）

const active = new Map(); // tabId -> meeting (錄製中)

// MV3 service worker 閒置 30 秒會被關掉、記憶體歸零；錄製中的 tabId→meetingId 存到 session storage，
// 醒來時從 storage.local（每 1.5 秒存一次）把會議拉回 active。
async function persistActive() {
  const map = {};
  for (const [tabId, m] of active) map[tabId] = m.id;
  await chrome.storage.session.set({ activeMap: map });
}
const rehydrated = (async () => {
  const { activeMap } = await chrome.storage.session.get("activeMap");
  const all = await listMeetings();
  const keep = new Set(Object.values(activeMap || {}));
  let dirty = false;
  for (const m of all) {
    if (m.recording && !keep.has(m.id)) { m.recording = false; m.endedAt = m.endedAt || Date.now(); dirty = true; } // 殘留的錄製標記
    if (m.summarizing) { m.summarizing = false; m.summaryError = m.summaryError || "摘要中斷，請再按一次產生摘要"; dirty = true; } // SW 重啟中斷的摘要
  }
  if (dirty) await chrome.storage.local.set({ meetings: all });
  for (const [tabId, id] of Object.entries(activeMap || {})) {
    const m = all.find((x) => x.id === id);
    if (m && m.recording) { active.set(Number(tabId), m); speakerLogs.set(Number(tabId), []); }
  }
  if (![...active.values()].some((m) => m.sttMode && m.sttMode !== "captions")) await closeOffscreen(); // 殘留的 offscreen 會抓著分頁串流
})();

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return withApi({ ...DEFAULT_SETTINGS, ...(settings || {}) });
}

// 一次性遷移：舊版預設是「字幕」，改成預設「語音辨識」（使用者手動選過的不動）
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  // 第一次安裝：打開歡迎頁（3 步驟設定）
  if (reason === "install") chrome.tabs.create({ url: chrome.runtime.getURL("welcome/welcome.html") });
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) return;
  const next = { ...settings };
  if (!settings.sttModeChosen) next.sttMode = "stt";
  // 舊預設是固定中文：Whisper 指定 zh 時會把英文「翻譯」成中文。一律改成自動偵測一次（之後使用者要改回固定中文可以）
  if (!settings.sttLangMigrated) { if (settings.sttLanguage === "zh") next.sttLanguage = "auto"; next.sttLangMigrated = true; }
  await chrome.storage.local.set({ settings: next });
});

async function listMeetings() {
  const { meetings } = await chrome.storage.local.get("meetings");
  return meetings || [];
}

async function saveMeeting(m) {
  const all = await listMeetings();
  const i = all.findIndex((x) => x.id === m.id);
  if (i >= 0) all[i] = m; else all.unshift(m);
  await chrome.storage.local.set({ meetings: all.slice(0, 50) });
}

// 錄製中的會議以記憶體為準（最新），其餘從 storage 讀
async function findMeeting(id) {
  return [...active.values()].find((x) => x.id === id) || (await listMeetings()).find((x) => x.id === id) || null;
}

function newMeeting(tabId, info) {
  return {
    id: `m-${Date.now()}`,
    tabId,
    platform: info.platform,
    platformName: info.platformName,
    title: (info.title || "會議").replace(/\s*[-|]\s*(Google Meet|Microsoft Teams|Zoom|Jitsi Meet).*$/i, "").trim() || "會議",
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

async function startRecording(tabId) {
  const settings = await getSettings();
  const info = await chrome.tabs.sendMessage(tabId, { type: "ping" }).catch(() => null);
  if (!info) throw new Error("這個分頁不是支援的會議頁面，或頁面尚未載入完成。");
  const m = newMeeting(tabId, info);
  try { const t = await chrome.tabs.get(tabId); m.url = t.url; } catch {}
  const mode = settings.sttMode || "stt";
  m.sttMode = mode;
  active.set(tabId, m);
  speakerLogs.set(tabId, []);
  if (mode !== "stt") await chrome.tabs.sendMessage(tabId, { type: "start", autoCaptions: settings.autoCaptions, watchSpeakers: mode === "both", myName: settings.myName });
  else await chrome.tabs.sendMessage(tabId, { type: "startSpeakerWatch", myName: settings.myName });
  if (mode !== "captions") {
    try { await startStt(tabId, settings); m.stt = "on"; }
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

async function startStt(tabId, settings) {
  if (!settings.ready) throw new Error("尚未完成設定：請先在設定頁貼上 Groq 金鑰。");
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
  await saveMeeting(m);
  await setBadge(tabId, false);
  const settings = await getSettings();
  if (settings.autoSummarize && m.lines.length) {
    summarize(m.id).catch((e) => console.warn("auto summarize failed", e));
  }
  return m;
}

let saveTimer = null;
function scheduleSave(m) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveMeeting(m), 1500);
}

async function summarize(meetingId) {
  const all = await listMeetings();
  const m = active.get([...active.values()].find((x) => x.id === meetingId)?.tabId) || all.find((x) => x.id === meetingId);
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
  const all = await listMeetings();
  const m = [...active.values()].find((x) => x.id === meetingId) || all.find((x) => x.id === meetingId);
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

// ── 來自 content script 的訊息 ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === "offscreen") return; // 給 offscreen 的訊息，這裡不處理
  // 字幕來自 content script（sender.tab）；語音辨識來自 offscreen（msg.tabId）
  const tabId = sender.tab?.id ?? (/^stt:/.test(msg.type) ? msg.tabId : undefined);
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
      if (msg.channel === "mic") {
        // 麥克風通道一定是你自己
        lines = attributeSegments([], msg.segments, msg.chunkStart, me);
      } else {
        // 分頁通道是其他人：時間軸裡把「我」排除，剩下的才是候選
        const log = (speakerLogs.get(tabId) || []).map((e) => ({ t: e.t, names: e.names.filter((n) => n !== me && n !== "我") }));
        lines = attributeSegments(log, msg.segments, msg.chunkStart, settings.sttSpeaker || "語音");
      }
      if (settings.toTraditional !== false) lines.forEach((l) => { l.text = toTraditional(l.text); });
      lines.forEach((l, i) => m.lines.push({ id: `stt-${msg.channel || "tab"}-${msg.chunkStart}-${i}`, ...l, src: "stt" }));
      m.lines.sort((a, b) => a.t - b.t); // 語音段落可能晚到
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

    // ── 來自 popup / options 的指令 ──
    switch (msg.type) {
      case "getState": {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const info = tab ? await chrome.tabs.sendMessage(tab.id, { type: "ping" }).catch(() => null) : null;
        const current = tab ? active.get(tab.id) : null;
        const { lastStartError } = await chrome.storage.session.get("lastStartError");
        return reply({ tabId: tab?.id, info, current, meetings: await listMeetings(), settings: await getSettings(), lastStartError });
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
      case "listMeetings":
        return reply({ meetings: [...[...active.values()], ...(await listMeetings()).filter((x) => ![...active.values()].some((a) => a.id === x.id))]
          .map(({ id, title, startedAt, recording }) => ({ id, title, startedAt, recording })) });
      case "summarize": return reply({ summary: await summarize(msg.meetingId) });
      case "export": return reply(await exportMeeting(msg.meetingId, msg.target));
      case "googleStatus": return reply(await googleStatus());
      case "googleConnect": return reply(await googleConnect());
      case "googleDisconnect": return reply(await googleDisconnect());
      case "deleteMeeting": {
        const all = (await listMeetings()).filter((x) => x.id !== msg.meetingId);
        await chrome.storage.local.set({ meetings: all });
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
        else m = [...active.values()][0] || (await listMeetings())[0] || null;
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

chrome.tabs.onRemoved.addListener(async (tabId) => { await rehydrated; if (active.has(tabId)) stopRecording(tabId); });

// 會議分頁換到別的網址（例如離開後回到 Meet 首頁）→ 停止
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (!info.url) return;
  await rehydrated;
  const m = active.get(tabId);
  if (!m?.url) return;
  try {
    const a = new URL(m.url), b = new URL(info.url);
    if (a.host !== b.host || a.pathname !== b.pathname) stopRecording(tabId);
  } catch {}
});
