// 設定頁與歡迎頁共用：麥克風授權 / 測試、金鑰驗證、是否已釘選到工具列
export async function micState() {
  try { return (await navigator.permissions.query({ name: "microphone" })).state; } // granted | denied | prompt
  catch { return "prompt"; }
}

// 要求麥克風權限並開始測音量；onLevel(rms) 每幀呼叫。回傳停止函式
export async function startMicTest(deviceId, onLevel) {
  const audio = { echoCancellation: true };
  if (deviceId) audio.deviceId = { exact: deviceId };
  const stream = await navigator.mediaDevices.getUserMedia({ audio });
  chrome.runtime.sendMessage({ type: "micGranted" }); // 錄製中的話，立刻把麥克風接上
  const ctx = new AudioContext();
  await ctx.resume();
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Float32Array(an.fftSize);
  let on = true;
  const tick = () => {
    if (!on) return;
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    onLevel(Math.sqrt(sum / buf.length));
    requestAnimationFrame(tick);
  };
  tick();
  return () => { on = false; stream.getTracks().forEach((t) => t.stop()); ctx.close().catch(() => {}); };
}

export const levelPct = (r) => Math.min(100, Math.max(0, (Math.log10(Math.max(r, 1e-4)) + 4) / 2.7 * 100));

// 用「列出模型」驗證 Groq 金鑰（不花額度）
export async function verifyGroqKey(key) {
  key = (key || "").trim();
  if (!/^gsk_/.test(key)) return { ok: false, msg: "金鑰應該是 gsk_ 開頭，請確認有完整複製" };
  try {
    const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${key}` } });
    if (r.ok) return { ok: true, msg: "金鑰可以使用" };
    if (r.status === 401) return { ok: false, msg: "金鑰無效，請重新複製一次" };
    return { ok: false, msg: `Groq 回應錯誤（${r.status}），請稍後再試` };
  } catch { return { ok: false, msg: "連不上 Groq，請檢查網路" }; }
}

export async function isPinned() {
  try { return (await chrome.action.getUserSettings()).isOnToolbar; } catch { return null; }
}

export async function saveSettings(patch) {
  const { settings } = await chrome.storage.local.get("settings");
  await chrome.storage.local.set({ settings: { ...(settings || {}), ...patch } });
}
