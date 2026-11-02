import { applyTheme, bindThemeSeg } from "../ui/theme.js";
import { DEFAULT_SETTINGS } from "../lib/format.js";
import { getConfig } from "../lib/config.js";
import { startMicTest, levelPct, verifyGroqKey, saveSettings } from "../ui/setup.js";

const $ = (id) => document.getElementById(id);
const FIELDS = ["apiKey", "myName", "model", "language", "autoFallback", "tokenSaver", "autoSummarize",
  "sttMode", "sttLanguage", "sttMicDeviceId", "sttSpeaker", "toTraditional", "sttMic",
  "autoStart", "autoCaptions", "includeTranscript"];

function toast(msg, isErr = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast show" + (isErr ? " error" : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = "toast"), 2500);
}

// ── 自動儲存（不需要按儲存）──
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const patch = { sttModeChosen: true, sttLangMigrated: true };
    for (const f of FIELDS) { const el = $(f); patch[f] = el.type === "checkbox" ? el.checked : el.value.trim(); }
    await saveSettings(patch);
    $("saved").textContent = "✓ 已自動儲存";
  }, 400);
}
FIELDS.forEach((f) => { const el = $(f); el.addEventListener(el.type === "checkbox" || el.tagName === "SELECT" ? "change" : "input", scheduleSave); });

// ── 金鑰 ──
$("checkKey").onclick = async () => {
  $("keyMsg").className = ""; $("keyMsg").textContent = "檢查中…";
  const r = await verifyGroqKey($("apiKey").value);
  $("keyMsg").className = r.ok ? "ok" : "err";
  $("keyMsg").textContent = (r.ok ? "✓ " : "✕ ") + r.msg + "。";
};

// ── 麥克風測試（同時取得授權）──
let stopTest = null;
$("micTest").onclick = async () => {
  if (stopTest) { stopTest(); stopTest = null; $("micTest").textContent = "🎤 測試麥克風"; $("micMeter").style.width = "0"; return; }
  try {
    let heard = false;
    stopTest = await startMicTest($("sttMicDeviceId").value, (r) => {
      $("micMeter").style.width = levelPct(r) + "%";
      if (r > 0.01 && !heard) { heard = true; $("micMsg").textContent = "✓ 有收到你的聲音，麥克風正常。"; }
    });
    $("micTest").textContent = "停止測試";
    $("micMsg").textContent = "請說幾句話…";
    loadMics();
  } catch (e) {
    $("micMsg").textContent = e.name === "NotAllowedError"
      ? "✕ 麥克風被封鎖了：點網址列左邊的圖示 → 麥克風 → 允許，再按一次測試。"
      : "✕ 找不到麥克風，請確認有接上。";
  }
};
async function loadMics() {
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && d.deviceId);
    const sel = $("sttMicDeviceId"), cur = sel.value;
    sel.replaceChildren(new Option("系統預設", ""), ...devs.map((d) => new Option(d.label || "麥克風", d.deviceId)));
    sel.value = cur;
  } catch {}
}

// ── Google（只有部署時設定了 OAuth 才顯示）──
$("gTest").onclick = () => {
  $("gStatus").textContent = "授權中…";
  chrome.identity.getAuthToken({ interactive: true }, (token) => {
    $("gStatus").textContent = chrome.runtime.lastError || !token ? "✕ 未完成授權" : "✓ 已連結";
  });
};

// ── 診斷：找開著的會議分頁 ──
$("diag").onclick = async () => {
  const tabs = await chrome.tabs.query({ url: ["https://meet.google.com/*", "https://*.teams.microsoft.com/*", "https://teams.live.com/*", "https://*.zoom.us/*", "https://meet.jit.si/*", "https://*.jitsi.net/*"] });
  const { settings } = await chrome.storage.local.get("settings");
  const safe = { ...(settings || {}), apiKey: settings?.apiKey ? "(已設定)" : "(未設定)", myName: settings?.myName ? "(已設定)" : "" }; // 不外洩金鑰和名字
  const d = tabs[0] ? await chrome.runtime.sendMessage({ type: "diagnose", tabId: tabs[0].id }).catch((e) => ({ error: e.message })) : { error: "沒有開著的會議分頁" };
  const report = { version: chrome.runtime.getManifest().version, ua: navigator.userAgent, settings: safe, diagnose: d };
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  toast("已複製診斷資料");
};

// ── 載入 ──
(async () => {
  const { settings } = await chrome.storage.local.get("settings");
  const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  await loadMics();
  for (const f of FIELDS) { const el = $(f); if (el.type === "checkbox") el.checked = !!s[f]; else el.value = s[f] ?? ""; }
  bindThemeSeg($("themeSeg"), await applyTheme(s.theme));
  const c = await getConfig();
  $("keyField").hidden = !!c.proxyUrl;
  $("proxyField").hidden = !c.proxyUrl;
  const cid = chrome.runtime.getManifest().oauth2?.client_id || "";
  $("gField").hidden = !cid || cid.startsWith("YOUR_");
  if (location.hash === "#advanced") document.querySelector(".adv").open = true;
})();
