// 資料只存在手機的瀏覽器裡（localStorage）：設定、會議索引、每場會議各一個 key
const KEY_SETTINGS = "pm:settings", KEY_INDEX = "pm:index", MAX = 30;
const mkey = (id) => `pm:m:${id}`;

export const DEFAULTS = {
  apiKey: "", model: "llama-3.3-70b-versatile", language: "", uiLang: "auto", sttLanguage: "auto", toTraditional: true, translate: false, // language 空 = 跟著介面語言
  autoFallback: true, tokenSaver: true, bigText: false, theme: "auto", setupDone: false,
};

export function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY_SETTINGS) || "{}") }; } catch { return { ...DEFAULTS }; }
}
export function saveSettings(patch) {
  const s = { ...getSettings(), ...patch };
  localStorage.setItem(KEY_SETTINGS, JSON.stringify(s));
  idbPut(s).catch(() => {});
  return s;
}

// 多存一份在 IndexedDB：localStorage 被清掉時（某些瀏覽器會）還能把設定找回來
const DB = "pm", STORE_NAME = "kv";
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE_NAME);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function idbPut(s) {
  return idb().then((db) => new Promise((res, rej) => { const t = db.transaction(STORE_NAME, "readwrite"); t.objectStore(STORE_NAME).put(s, "settings"); t.oncomplete = res; t.onerror = () => rej(t.error); }));
}
function idbGet() {
  return idb().then((db) => new Promise((res, rej) => { const r = db.transaction(STORE_NAME).objectStore(STORE_NAME).get("settings"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }));
}
/** 啟動時呼叫：localStorage 沒有金鑰但 IndexedDB 有 → 還原；並請瀏覽器永久保留資料 */
export async function restoreSettings() {
  try { await navigator.storage?.persist?.(); } catch {}
  const cur = getSettings();
  if (cur.apiKey) return cur;
  try { const b = await idbGet(); if (b?.apiKey) { localStorage.setItem(KEY_SETTINGS, JSON.stringify({ ...cur, ...b })); return getSettings(); } } catch {}
  return cur;
}

export function listMeetings() {
  try { return JSON.parse(localStorage.getItem(KEY_INDEX) || "[]"); } catch { return []; }
}
export function loadMeeting(id) {
  try { return JSON.parse(localStorage.getItem(mkey(id)) || "null"); } catch { return null; }
}
export function saveMeeting(m) {
  try {
    localStorage.setItem(mkey(m.id), JSON.stringify(m));
  } catch (e) {
    // 空間不夠：把最舊的會議刪掉再試一次
    const idx = listMeetings();
    const old = idx.filter((x) => x.id !== m.id).pop();
    if (!old) throw e;
    removeMeeting(old.id);
    localStorage.setItem(mkey(m.id), JSON.stringify(m));
  }
  const idx = listMeetings().filter((x) => x.id !== m.id);
  idx.unshift({ id: m.id, title: m.title, startedAt: m.startedAt, lines: m.lines.length, hasSummary: !!m.summary });
  idx.sort((a, b) => b.startedAt - a.startedAt);
  for (const x of idx.splice(MAX)) localStorage.removeItem(mkey(x.id));
  localStorage.setItem(KEY_INDEX, JSON.stringify(idx));
}
export function removeMeeting(id) {
  localStorage.removeItem(mkey(id));
  localStorage.setItem(KEY_INDEX, JSON.stringify(listMeetings().filter((x) => x.id !== id)));
}
