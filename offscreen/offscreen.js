// Offscreen document：兩條音訊各自辨識
//   tab 通道 = 分頁播放出來的聲音 = 其他與會者（再用「誰在說話」時間軸標名字）
//   mic 通道 = 你的麥克風 = 你自己
// （service worker 不能用 getUserMedia / MediaRecorder，所以放在這裡）
const sessions = new Map(); // tabId -> session

// 依停頓切段：講完一句（靜音 PAUSE_MS）就切，最長 MAX_MS。
// 多語模式下 Whisper 每段只判斷一種語言，切在句子邊界才不會把同段裡的另一種語言翻過去。
const MIN_MS = 2500;        // 太短的段落辨識不準
const MAX_MS = 15000;       // 一直有聲音時的上限
const PAUSE_MS = 700;       // 靜音多久算一句講完
const SILENCE_RMS = 0.004;  // 低於此音量視為靜音，不送 API

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== "offscreen") return;
  (async () => {
    if (msg.type === "stt:start") { await start(msg); reply({ ok: true }); }
    else if (msg.type === "stt:stop") { stop(msg.tabId); reply({ ok: true }); }
    else if (msg.type === "stt:status") reply({ active: [...sessions.keys()] });
    else if (msg.type === "stt:addMic") { for (const s of sessions.values()) await addMic(s); reply({ ok: true }); }
  })().catch((e) => reply({ error: e.message || String(e) }));
  return true;
});

async function start({ tabId, streamId, settings }) {
  if (sessions.has(tabId)) return;
  let tabStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
  } catch (e) { throw new Error(`[offscreen 開啟分頁音訊] ${e.name}: ${e.message}`); }
  let s;
  const ctx = new AudioContext();
  // offscreen 沒有使用者手勢，AudioContext 會停在 suspended：分析器讀到 0、聲音也不會接回喇叭
  try { await ctx.resume(); } catch {}
  ctx.onstatechange = () => { s.stats.ctxState = ctx.state; report(s); };
  // 抓了分頁音訊後，原分頁會靜音，要接回喇叭
  ctx.createMediaStreamSource(tabStream).connect(ctx.destination);

  s = { tabId, settings, ctx, stopped: false, channels: {}, prevText: "",
    stats: { chunks: 0, sent: 0, silent: 0, ok: 0, lastPeak: 0, mic: false, lastError: "", ctxState: ctx.state, byChannel: {} } };
  sessions.set(tabId, s);

  s.channels.tab = makeChannel(s, "tab", tabStream);

  if (settings.sttMic !== false) await addMic(s);
  // 即時音量（給 popup 的音量表）
  s.levelTimer = setInterval(() => {
    const levels = {};
    for (const [k, ch] of Object.entries(s.channels)) levels[k] = +rms(ch.analyser).toFixed(4);
    chrome.runtime.sendMessage({ type: "stt:levels", tabId: s.tabId, levels, ctxState: ctx.state });
  }, 400);
  report(s);
  notify(tabId, "ok", s.stats.mic ? "語音辨識已啟動：麥克風＝你，分頁聲音＝其他人" : "語音辨識已啟動（只有分頁聲音，收不到你自己）");
}

// 接上麥克風通道；未授權時回報 micDenied，background 會開授權視窗，授權後再呼叫一次
async function addMic(s) {
  if (s.channels.mic || s.stopped) return;
  try {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (s.settings.sttMicDeviceId) audio.deviceId = { exact: s.settings.sttMicDeviceId };
    let micStream;
    try { micStream = await navigator.mediaDevices.getUserMedia({ audio }); }
    catch (e) {
      if (e.name === "OverconstrainedError" || e.name === "NotFoundError") micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } }); // 指定裝置不在了 → 用預設
      else throw e;
    }
    s.channels.mic = makeChannel(s, "mic", micStream);
    s.stats.mic = true;
    const tr = micStream.getAudioTracks()[0];
    s.stats.micInfo = tr ? { label: tr.label, muted: tr.muted, enabled: tr.enabled, state: tr.readyState } : null;
    if (tr) tr.onmute = tr.onunmute = () => { s.stats.micInfo = { label: tr.label, muted: tr.muted, enabled: tr.enabled, state: tr.readyState }; report(s); };
    report(s);
    notify(s.tabId, "ok", "麥克風已接上：麥克風＝你，分頁聲音＝其他人");
  } catch (e) {
    chrome.runtime.sendMessage({ type: "stt:micDenied", tabId: s.tabId, reason: e.name });
  }
}

function makeChannel(s, name, stream) {
  const analyser = s.ctx.createAnalyser();
  analyser.fftSize = 2048;
  s.ctx.createMediaStreamSource(stream).connect(analyser);
  const ch = { name, stream, analyser, peak: 0, recorder: null, timer: null };
  ch.meter = setInterval(() => { ch.peak = Math.max(ch.peak, rms(analyser)); }, 200);
  cycle(s, ch);
  return ch;
}

function rms(analyser) {
  const buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.sqrt(sum / buf.length);
}

// 每段重新 start/stop 一個 MediaRecorder，確保每個 blob 都是完整可解碼的檔案
function cycle(s, ch) {
  if (s.stopped) return;
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  const rec = new MediaRecorder(ch.stream, { mimeType: mime, audioBitsPerSecond: 32000 });
  const parts = [];
  const startedAt = Date.now();
  ch.peak = 0;
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  rec.onstop = () => {
    const peak = ch.peak;
    const blob = new Blob(parts, { type: mime });
    if (!s.stopped) cycle(s, ch); // 先接著錄，不要漏音
    s.stats.chunks++; s.stats.lastPeak = +peak.toFixed(4);
    const bc = s.stats.byChannel[ch.name] || (s.stats.byChannel[ch.name] = { chunks: 0, sent: 0, silent: 0, peak: 0, bytes: 0 });
    bc.chunks++; bc.peak = +peak.toFixed(4); bc.bytes = blob.size;
    // 靜音判斷只在 AudioContext 真的在跑時才可信；否則一律送（寧可多花一點額度也不要漏）
    const canGate = s.ctx.state === "running";
    if (blob.size < 2000 || (canGate && peak < SILENCE_RMS)) { s.stats.silent++; bc.silent++; report(s); return; } // 靜音段跳過
    s.stats.sent++; bc.sent++;
    transcribe(s, ch, blob, startedAt)
      .then(() => { s.stats.ok++; report(s); })
      .catch((e) => { s.stats.lastError = e.message; report(s); notify(s.tabId, "error", "語音辨識失敗：" + e.message); });
  };
  rec.start();
  ch.recorder = rec;
  let hadVoice = false, lastVoiceAt = startedAt;
  ch.timer = setInterval(() => {
    if (rec.state !== "recording") { clearInterval(ch.timer); return; }
    const now = Date.now();
    if (rms(ch.analyser) >= SILENCE_RMS) { hadVoice = true; lastVoiceAt = now; }
    const elapsed = now - startedAt;
    // AudioContext 沒在跑時 rms 永遠是 0 → 只會走 MAX_MS，等同固定切段
    if (elapsed >= MAX_MS || (hadVoice && elapsed >= MIN_MS && now - lastVoiceAt >= PAUSE_MS)) {
      clearInterval(ch.timer);
      rec.stop();
    }
  }, 100);
}

async function transcribe(s, ch, blob, startedAt) {
  const fd = new FormData();
  fd.append("file", blob, "chunk.webm");
  fd.append("model", "whisper-large-v3"); // Turbo 錯字太多，固定用 Large v3
  fd.append("response_format", "verbose_json"); // 要句子時間戳，才能對回發言者
  fd.append("temperature", "0");
  if (s.settings.sttLanguage && s.settings.sttLanguage !== "auto") fd.append("language", s.settings.sttLanguage);
  // prompt 是「文字範例」不是指令，會影響 Whisper 判斷語言：
  //  多語模式完全不送（上一段是中文就會把這段英文拉成中文翻譯）；
  //  固定語言時才用範例＋上一段結尾讓用字與斷句連貫。
  const lang = s.settings.sttLanguage;
  if (lang && lang !== "auto") {
    const seed = lang === "zh" && s.settings.toTraditional !== false ? "以下是會議的逐字稿，使用繁體中文。" : "";
    const tail = s.prevText && s.prevText.length >= 12 ? s.prevText.slice(-180) : "";
    const prompt = (seed + " " + tail).trim();
    if (prompt) fd.append("prompt", prompt);
  }

  const res = await fetch(`${s.settings.apiBase}/openai/v1/audio/transcriptions`, {
    method: "POST",
    headers: s.settings.apiHeaders,
    body: fd,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch {}
    if (res.status === 429) { notify(s.tabId, "warn", "Groq 語音額度暫時用完，這段略過，下一段會再試"); return; }
    throw new Error(`(${res.status}) ${detail}`);
  }
  const data = await res.json();
  s.stats.lastLang = data.language || (lang && lang !== "auto" ? lang + "(固定)" : "?"); // Whisper 偵測到的語言（診斷用）
  const text = (data.text || "").trim();
  if (!text || isHallucination(text)) return;
  // 同一通道整段和上一段一模一樣 → 幻覺（每個通道各自比，避免你和對方剛好說同一句被誤刪）
  if (text === ch.lastText) return;
  ch.lastText = text;
  const segments = (data.segments || [{ start: 0, end: (Date.now() - startedAt) / 1000, text }])
    .filter((g) => {
      const t = (g.text || "").trim();
      if (!t || isHallucination(t)) return false;
      // Whisper 自己的信心指標：幾乎沒語音、平均 logprob 很低、或重複字串 → 丟
      if (g.no_speech_prob != null && g.no_speech_prob > 0.6) return false;
      if (g.avg_logprob != null && g.avg_logprob < -1.2) return false;
      if (g.compression_ratio != null && g.compression_ratio > 2.4) return false;
      return true;
    })
    .map((g) => ({ start: g.start, end: g.end, text: g.text }));
  if (!segments.length) return;
  s.prevText = segments.map((g) => g.text.trim()).join(" ");
  chrome.runtime.sendMessage({ type: "stt:segments", tabId: s.tabId, channel: ch.name, chunkStart: startedAt, segments });
}

// Whisper 在靜音/雜訊時常吐出固定幻覺句
function isHallucination(t) {
  if (/^※/.test(t) || /請勿模仿|请勿模仿|字幕組|字幕组|訂閱|订阅|點贊|点赞|明鏡與點點|明镜与点点/.test(t)) return true; // 影片警語、字幕組署名類幻覺
  return /^(請不吝點贊|請看|请看|謝謝(大家)?(觀看|收看)|谢谢(大家)?(观看|收看)|字幕由|subtitles? by|thank you for watching|thanks for watching|thank you\.?$|you\.?$|bye\.?$)/i.test(t)
    || /^(.)\1{5,}$/.test(t) || /^(.{1,4})\1{2,}$/.test(t);
}

function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.stopped = true;
  clearInterval(s.levelTimer);
  for (const ch of Object.values(s.channels)) {
    clearTimeout(ch.timer);
    clearInterval(ch.meter);
    try { ch.recorder?.state === "recording" && ch.recorder.stop(); } catch {}
    ch.stream.getTracks().forEach((t) => t.stop());
  }
  s.ctx.close().catch(() => {});
  sessions.delete(tabId);
}

function report(s) {
  chrome.runtime.sendMessage({ type: "stt:stats", tabId: s.tabId, stats: s.stats });
}

function notify(tabId, level, text) {
  chrome.runtime.sendMessage({ type: "stt:notice", tabId, level, text });
}
