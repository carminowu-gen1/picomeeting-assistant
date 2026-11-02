// 安裝後歡迎頁：3 步驟（麥克風、AI 金鑰、釘選圖示），每步完成自動打勾
import { applyTheme } from "../ui/theme.js";
import { getConfig } from "../lib/config.js";
import { micState, startMicTest, levelPct, verifyGroqKey, isPinned, saveSettings } from "../ui/setup.js";

const $ = (id) => document.getElementById(id);
const done = { s1: false, s2: false, s3: false };

function mark(id, ok) {
  done[id] = ok;
  $(id).classList.toggle("ok", ok);
  // 步驟 3 偵測不到（舊版 Chrome）時不擋
  $("done").classList.toggle("ready", done.s1 && done.s2);
}
function msg(id, text, cls = "") { $(id).textContent = text; $(id).className = "msg " + cls; }

// ── 1 麥克風 ──
let stopTest = null;
$("micBtn").onclick = async () => {
  if (stopTest) { stopTest(); stopTest = null; }
  try {
    msg("micMsg", "請說幾句話…");
    stopTest = await startMicTest("", (r) => {
      $("micMeter").style.width = levelPct(r) + "%";
      if (r > 0.01 && !done.s1) {
        mark("s1", true);
        msg("micMsg", "✓ 聽到你的聲音了！", "ok");
        setTimeout(() => { stopTest?.(); stopTest = null; $("micMeter").style.width = "0"; }, 1500);
      }
    });
  } catch (e) {
    msg("micMsg", e.name === "NotAllowedError"
      ? "✕ 被封鎖了。請點網址列左邊的圖示 → 麥克風改成「允許」，再按一次按鈕。"
      : "✕ 找不到麥克風，請確認耳機或麥克風有接上。", "err");
  }
};

// ── 2 金鑰 ──
async function checkKey() {
  const key = $("keyInput").value.trim();
  if (!key) return;
  msg("keyMsg", "檢查中…");
  const r = await verifyGroqKey(key);
  if (r.ok) {
    await saveSettings({ apiKey: key });
    mark("s2", true);
    msg("keyMsg", "✓ 已連接，可以使用了！", "ok");
  } else msg("keyMsg", "✕ " + r.msg, "err");
}
$("keyBtn").onclick = checkKey;
$("keyInput").addEventListener("paste", () => setTimeout(checkKey, 50)); // 貼上就自動檢查
$("keyInput").addEventListener("keydown", (e) => e.key === "Enter" && checkKey());

// ── 3 釘選：每秒檢查一次 ──
async function pollPin() {
  const p = await isPinned();
  if (p === null) { msg("pinMsg", "（你的 Chrome 版本無法自動偵測，完成後直接往下即可）"); return; }
  if (p && !done.s3) { mark("s3", true); msg("pinMsg", "✓ 已釘選！", "ok"); }
  if (!p) setTimeout(pollPin, 1000);
}

// ── 完成 ──
$("myName").addEventListener("input", () => saveSettings({ myName: $("myName").value.trim() }));
$("closeBtn").onclick = () => window.close();

(async () => {
  await applyTheme();
  const c = await getConfig();
  const { settings } = await chrome.storage.local.get("settings");
  $("myName").value = settings?.myName || "";
  if (c.proxyUrl) { $("keyBody").hidden = true; $("proxyBody").hidden = false; mark("s2", true); }
  else if (settings?.apiKey) { $("keyInput").value = settings.apiKey; mark("s2", true); msg("keyMsg", "✓ 已經設定過了", "ok"); }
  if ((await micState()) === "granted") { mark("s1", true); msg("micMsg", "✓ 已經允許過了（可以再按一次測試）", "ok"); }
  pollPin();
  if (location.hash === "#key") $("s2").scrollIntoView({ behavior: "smooth", block: "center" });
})();
