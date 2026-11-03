// 資料只存在手機的瀏覽器裡（localStorage）：設定、會議索引、每場會議各一個 key
const KEY_SETTINGS = "pm:settings", KEY_INDEX = "pm:index", MAX = 30;
const mkey = (id) => `pm:m:${id}`;

export const DEFAULTS = {
  apiKey: "", model: "llama-3.3-70b-versatile", language: "繁體中文", sttLanguage: "auto", toTraditional: true,
  autoFallback: true, tokenSaver: true, bigText: false, theme: "auto", setupDone: false,
};

export function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY_SETTINGS) || "{}") }; } catch { return { ...DEFAULTS }; }
}
export function saveSettings(patch) {
  const s = { ...getSettings(), ...patch };
  localStorage.setItem(KEY_SETTINGS, JSON.stringify(s));
  return s;
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
