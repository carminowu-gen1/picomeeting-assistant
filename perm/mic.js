import { applyTheme } from "../ui/theme.js";
applyTheme();
const $ = (id) => document.getElementById(id);
async function ask() {
  $("status").textContent = "等待你按「允許」…";
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    $("status").innerHTML = '<span class="ok">✓ 已授權，麥克風已接上，這個視窗會自動關閉。</span>';
    chrome.runtime.sendMessage({ type: "micGranted" });
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    $("status").innerHTML = `<span class="err">✕ 授權失敗：${e.name}</span>`;
    $("retry").hidden = false; $("help").hidden = false;
  }
}
$("retry").onclick = ask;
ask();
