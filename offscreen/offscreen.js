// Offscreen document：兩條音訊各自辨識
//   tab 通道 = 分頁播放出來的聲音 = 其他與會者（再用「誰在說話」時間軸標名字）
//   mic 通道 = 你的麥克風 = 你自己
// （service worker 不能用 getUserMedia / MediaRecorder，所以放在這裡）
const sessions = new Map(); // tabId -> session
// 音訊前處理 worker（dsp/dsp-worker.js，和手機版共用）：RNNoise 降噪 + Silero VAD 人聲偵測
// 載入失敗就退回「看音量」判斷，功能照常
const dsp = { worker: null, ready: false, denoise: false, vad: false, chans: new Map() }; // chans: "tabId:name" → ch
const BATCH_SAMPLES = 4800; // 每 0.1 秒（48 kHz）送一次給 worker，不要每 10 ms 一則訊息
const SPEECH_P = 0.5;       // VAD 機率高於這個才算有人在說話
function startDsp() {
  if (dsp.worker) return dsp.readyP;
  dsp.readyP = new Promise((res) => {
    try {
      const w = new Worker(chrome.runtime.getURL("dsp/dsp-worker.js"));
      dsp.worker = w;
      w.onmessage = (e) => {
        const d = e.data;
        if (d.type === "ready") { dsp.ready = true; dsp.denoise = d.denoise; dsp.vad = d.vad; res(); }
        else if (d.type === "out") { const ch = dsp.chans.get(d.ch); if (ch) consume(ch.s, ch, d.pcm, d.speech, d.level); }
      };
      w.onerror = () => { dsp.worker = null; dsp.ready = false; res(); };
      w.postMessage({ type: "init" });
      setTimeout(res, 15000); // 載入太久也先開始（之後 ready 了會自動切換）
    } catch { dsp.worker = null; res(); }
  });
  return dsp.readyP;
}

// 依停頓切段：講完一句（靜音 PAUSE_MS）就切，最長 MAX_MS。
// 多語模式下 Whisper 每段只判斷一種語言，切在句子邊界才不會把同段裡的另一種語言翻過去。
const MIN_MS = 2500;        // 太短的段落辨識不準
const MAX_MS = 9000;        // 一直有聲音時的上限（越短字越快出來；太短會把一句話切斷）
const PAUSE_MS = 600;       // 靜音多久算一句講完
const MIN_VOICE_MS = 500;   // 一段裡「有人在說話」累積不到這麼久，就當成雜音不送（Whisper 聽到雜音會編出 YouTube 開場白）
const SOFT_AGC_TARGET = 0.08; // 瀏覽器沒開自動增益時，軟體增益的目標音量（RMS）
const SOFT_AGC_MAX = 12;      // 最多放大幾倍

// 「有人在說話」= 音量明顯高於這個通道的背景雜音（自動估計），而且至少 0.008
function isVoiced(ch, r) {
  ch.floor ??= 0.01;
  ch.floor = r < ch.floor ? ch.floor * 0.5 + r * 0.5 : ch.floor * 0.998 + r * 0.002; // 往下快、往上慢
  return r >= Math.max(0.008, ch.floor * 3);
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target !== "offscreen") return;
  (async () => {
    if (msg.type === "stt:start") { await start(msg); reply({ ok: true }); }
    else if (msg.type === "stt:stop") { stop(msg.tabId); reply({ ok: true }); }
    else if (msg.type === "stt:status") reply({ active: [...sessions.keys()] });
    else if (msg.type === "stt:addMic") { for (const s of sessions.values()) await addMic(s); reply({ ok: true }); }
    else if (msg.type === "stt:renameSpeaker") { // 使用者把「說話者 A」改成真名：之後的句子也用新名字
      const c = sessions.get(msg.tabId)?.diar?.clusters.find((x) => x.label === msg.from);
      if (c) { c.label = msg.to; c.named = true; }
      reply({ ok: true });
    }
  })().catch((e) => reply({ error: e.message || String(e) }));
  return true;
});

// micOnly：不在會議網站（例如 LINE、Teams 電腦版開會）→ 只用麥克風錄，不跳任何視窗。
// 對方的聲音要從喇叭出來，麥克風才收得到。
async function start({ tabId, streamId, settings, micOnly }) {
  if (sessions.has(tabId)) return;
  let tabStream = null;
  if (!micOnly) try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
  } catch (e) { throw new Error(`[offscreen 開啟分頁音訊] ${e.name}: ${e.message}`); }
  let s;
  // 這個 AudioContext 只負責把分頁聲音接回喇叭（抓了分頁音訊後原分頁會靜音）；
  // latencyHint "playback" 用比較大的緩衝，音訊執行緒喚醒次數少很多，對低階電腦差很多
  const ctx = new AudioContext({ latencyHint: "playback" });
  // offscreen 沒有使用者手勢，AudioContext 會停在 suspended，聲音不會接回喇叭
  try { await ctx.resume(); } catch {}
  ctx.onstatechange = () => { s.stats.ctxState = ctx.state; report(s); };
  // 分頁音訊要接回喇叭（被擷取的分頁會變靜音）
  if (tabStream) ctx.createMediaStreamSource(tabStream).connect(ctx.destination);

  s = { tabId, settings, ctx, micOnly: !!micOnly, diar: null, stopped: false, channels: {}, prevText: "",
    stats: { chunks: 0, sent: 0, silent: 0, ok: 0, lastPeak: 0, mic: false, lastError: "", ctxState: ctx.state, byChannel: {}, dsp: "載入中" } };
  sessions.set(tabId, s);
  await startDsp();
  s.stats.dsp = dsp.ready ? `${dsp.denoise ? "降噪✓" : "降噪✗"} ${dsp.vad ? "人聲偵測✓" : "人聲偵測✗"}` : "未載入（用音量判斷）";

  if (tabStream) s.channels.tab = makeChannel(s, "tab", tabStream);

  if (micOnly || settings.sttMic !== false) await addMic(s);
  // 即時音量（給 popup 的音量表）
  s.levelTimer = setInterval(() => {
    const levels = {};
    for (const [k, ch] of Object.entries(s.channels)) levels[k] = +(ch.level || 0).toFixed(4); // 用收音時順便算好的值
    chrome.runtime.sendMessage({ type: "stt:levels", tabId: s.tabId, levels, ctxState: ctx.state });
  }, 500);
  report(s);
  notify(tabId, "ok", micOnly ? "語音辨識已啟動：用麥克風錄（對方的聲音請用喇叭播放）" : s.stats.mic ? "語音辨識已啟動：麥克風＝你，分頁聲音＝其他人" : "語音辨識已啟動（只有分頁聲音，收不到你自己）");
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
    // 瀏覽器有沒有真的開自動增益（AGC）？沒有的話麥克風通道自己做軟體增益（Mac／Linux／某些裝置會忽略這個要求）
    const agc = tr?.getSettings?.().autoGainControl === true;
    s.channels.mic.softAgc = !agc;
    s.stats.micInfo = tr ? { label: tr.label, muted: tr.muted, enabled: tr.enabled, state: tr.readyState, agc: agc ? "browser" : "software" } : null;
    if (tr) tr.onmute = tr.onunmute = () => { s.stats.micInfo = { label: tr.label, muted: tr.muted, enabled: tr.enabled, state: tr.readyState }; report(s); };
    report(s);
    notify(s.tabId, "ok", s.channels.tab ? "麥克風已接上：麥克風＝你，分頁聲音＝其他人" : "麥克風已接上");
  } catch (e) {
    chrome.runtime.sendMessage({ type: "stt:micDenied", tabId: s.tabId, reason: e.name });
  }
}

// ── 收音：直接讀原始音訊，降到 16 kHz，存成 WAV ──
// 以前用 MediaRecorder 即時壓成 Opus，再加一組分析器量音量：兩條聲音各一套，在低階電腦上很吃 CPU。
// Whisper 收到檔案本來就會解壓、再降到 16 kHz，所以壓縮是白做的；現在不壓縮，音量也直接從同一份資料算。
const TARGET_SR = 16000;

function makeChannel(s, name, stream) {
  const track = stream.getAudioTracks()[0];
  const ch = { s, name, key: `${s.tabId}:${name}`, stream, track, level: 0, peak: 0, chunks: [], samples: 0, startedAt: 0, hadVoice: false, lastVoiceAt: 0, voicedMs: 0, carry: 0, f32: null, softAgc: false, gain: 1,
    lastSpeech: false, batch: new Float32Array(BATCH_SAMPLES), batchN: 0, batchSr: 0 };
  dsp.chans.set(ch.key, ch);
  dsp.worker?.postMessage({ type: "reset", ch: ch.key });
  const processor = new MediaStreamTrackProcessor({ track });
  ch.reader = processor.readable.getReader();
  (async () => {
    try {
      while (!s.stopped) {
        const { value: frame, done } = await ch.reader.read();
        if (done) break;
        try { ingest(s, ch, frame); } finally { frame.close(); }
      }
    } catch (e) { if (!s.stopped) { s.stats.lastError = "收音中斷：" + e.message; report(s); } }
  })();
  return ch;
}

// 把一個音訊 frame（通常 10 ms）轉成單聲道浮點樣本
function monoFloat(frame, ch) {
  const n = frame.numberOfFrames, c = frame.numberOfChannels || 1;
  if (!ch.f32 || ch.f32.length < n) ch.f32 = new Float32Array(n);
  const out = ch.f32.subarray(0, n);
  try {
    frame.copyTo(out, { planeIndex: 0, format: "f32-planar" }); // 新版 Chrome 會幫忙轉格式
    return out;
  } catch {}
  // 舊版：依原始格式自己轉
  const fmt = frame.format || "f32";
  const planar = fmt.endsWith("-planar");
  const count = planar ? n : n * c;
  let buf;
  if (fmt.startsWith("f32")) buf = new Float32Array(count);
  else if (fmt.startsWith("s16")) buf = new Int16Array(count);
  else if (fmt.startsWith("s32")) buf = new Int32Array(count);
  else buf = new Uint8Array(count);
  frame.copyTo(buf, { planeIndex: 0 });
  const scale = fmt.startsWith("f32") ? 1 : fmt.startsWith("s16") ? 1 / 32768 : fmt.startsWith("s32") ? 1 / 2147483648 : 1 / 128;
  const off = fmt.startsWith("u8") ? 128 : 0;
  for (let i = 0; i < n; i++) out[i] = (buf[planar ? i : i * c] - off) * scale;
  return out;
}

// 收到一個 frame（通常 10 ms）：軟體增益 → 湊滿 0.1 秒丟給 DSP worker；worker 不在就自己降到 16 kHz
function ingest(s, ch, frame) {
  const sr = frame.sampleRate || 48000;
  const x = monoFloat(frame, ch);
  const n = x.length;
  if (!n) return;

  // 音量（RMS）
  let sum = 0;
  for (let i = 0; i < n; i++) sum += x[i] * x[i];
  let r = Math.sqrt(sum / n);
  const voiced = dsp.vad ? ch.lastSpeech : isVoiced(ch, r); // 用原始音量／上一塊的 VAD 判斷，免得把放大後的雜音當成說話
  if (ch.softAgc) {
    // 軟體 AGC：有人說話時把音量慢慢拉到目標大小，安靜時不動；變小要快（避免爆音）、變大要慢
    if (voiced && r > 0) { const want = Math.min(SOFT_AGC_MAX, Math.max(1, SOFT_AGC_TARGET / r)); ch.gain += (want - ch.gain) * (want < ch.gain ? 0.5 : 0.08); }
    if (ch.gain > 1.001) { for (let i = 0; i < n; i++) { const v = x[i] * ch.gain; x[i] = v > 1 ? 1 : v < -1 ? -1 : v; } r = Math.min(1, r * ch.gain); }
  }

  if (dsp.ready) {
    if (ch.batchSr && ch.batchSr !== sr) { ch.batchN = 0; } // 取樣率變了就重來
    ch.batchSr = sr;
    let i = 0;
    while (i < n) {
      const take = Math.min(BATCH_SAMPLES - ch.batchN, n - i);
      ch.batch.set(x.subarray(i, i + take), ch.batchN); ch.batchN += take; i += take;
      if (ch.batchN === BATCH_SAMPLES) { const out = ch.batch; ch.batch = new Float32Array(BATCH_SAMPLES); ch.batchN = 0; dsp.worker.postMessage({ type: "process", ch: ch.key, sr, x: out }, [out.buffer]); }
    }
    return;
  }

  // 備案：降到 16 kHz：每 step 個原始樣本平均成一個（48k → 3:1；其他取樣率用小數步進）
  const step = sr / TARGET_SR;
  const outN = Math.floor((n + ch.carry) / step);
  const pcm = new Int16Array(outN);
  let pos = -ch.carry;
  for (let i = 0; i < outN; i++) {
    const a = Math.max(0, Math.round(pos)), b = Math.min(n, Math.round(pos + step));
    let acc = 0, cnt = 0;
    for (let j = a; j < b; j++) { acc += x[j]; cnt++; }
    const v = cnt ? acc / cnt : 0;
    pcm[i] = v <= -1 ? -32768 : v >= 1 ? 32767 : (v * 32767) | 0;
    pos += step;
  }
  ch.carry = n - pos;
  consume(s, ch, pcm, -1, r);
}

// 16 kHz 的樣本 + 人聲機率（-1 = 沒有 VAD，用音量判斷）→ 切段
const ECHO_HOLD_MS = 700; // 對方講完後，麥克風再多靜音一下（喇叭回音、房間殘響）

function consume(s, ch, pcm, speech, level) {
  if (s.stopped || !pcm.length) return;
  const now = Date.now();
  if (!ch.startedAt) { ch.startedAt = now; ch.peak = 0; ch.hadVoice = false; ch.lastVoiceAt = now; ch.voicedMs = 0; }
  let voiced = speech >= 0 ? speech >= SPEECH_P : isVoiced(ch, level);
  if (ch.name === "tab" && voiced) s.tabVoiceAt = now;
  // 線上會議：對方（分頁聲音）正在說話時，麥克風收到的多半是喇叭的回音 → 這段麥克風當成靜音
  // （代價：兩邊同時開口時，你那句會漏掉；戴耳機就不會有回音）
  if (ch.name === "mic" && s.channels.tab && s.tabVoiceAt && now - s.tabVoiceAt < ECHO_HOLD_MS) {
    pcm = new Int16Array(pcm.length); voiced = false; level = 0;
    s.stats.echoGatedMs = (s.stats.echoGatedMs || 0) + Math.round((pcm.length / TARGET_SR) * 1000);
  }
  ch.lastSpeech = voiced;
  ch.level = level;
  if (level > ch.peak) ch.peak = level;
  if (voiced) { ch.hadVoice = true; ch.lastVoiceAt = now; ch.voicedMs += (pcm.length / TARGET_SR) * 1000; }
  ch.chunks.push(pcm);
  ch.samples += pcm.length;

  // 還沒有人說話：只保留最後 0.5 秒當前置音，前面的靜音丟掉（檔案小、也少給 Whisper 編故事的空間）
  if (!ch.hadVoice) {
    const keep = TARGET_SR * 0.5;
    while (ch.chunks.length > 1 && ch.samples - ch.chunks[0].length >= keep) ch.samples -= ch.chunks.shift().length;
    ch.startedAt = now - (ch.samples / TARGET_SR) * 1000;
  }

  // 切段：講完一句（靜音 PAUSE_MS）就切，最長 MAX_MS
  const elapsed = now - ch.startedAt;
  if (elapsed >= MAX_MS || (ch.hadVoice && elapsed >= MIN_MS && now - ch.lastVoiceAt >= PAUSE_MS)) flush(s, ch);
}

function flush(s, ch) {
  const { chunks, samples, startedAt, voicedMs, peak } = ch;
  ch.chunks = []; ch.samples = 0; ch.startedAt = 0;
  if (!samples) return;
  const blob = toWav(chunks, samples);
  // 只用麥克風（實體會議、LINE）：留一份原始聲音給聲紋分辨說話的人
  let pcm = null;
  if (s.micOnly) { pcm = new Int16Array(samples); let o = 0; for (const c of chunks) { pcm.set(c, o); o += c.length; } }
  s.stats.chunks++; s.stats.lastPeak = +peak.toFixed(4);
  const bc = s.stats.byChannel[ch.name] || (s.stats.byChannel[ch.name] = { chunks: 0, sent: 0, silent: 0, peak: 0, bytes: 0 });
  bc.chunks++; bc.peak = +peak.toFixed(4); bc.bytes = blob.size; bc.voicedMs = Math.round(voicedMs);
  if (voicedMs < MIN_VOICE_MS) { s.stats.silent++; bc.silent++; report(s); return; } // 只有雜音：跳過
  s.stats.sent++; bc.sent++;
  transcribe(s, ch, blob, startedAt, Math.round(voicedMs), pcm)
    .then(() => { s.stats.ok++; report(s); })
    .catch((e) => { s.stats.lastError = e.message; report(s); notify(s.tabId, "error", "語音辨識失敗：" + e.message); });
}

// 16 kHz、單聲道、16-bit 的 WAV
function toWav(chunks, samples) {
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, TARGET_SR, true); v.setUint32(28, TARGET_SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples * 2, true);
  const out = new Int16Array(buf, 44);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return new Blob([buf], { type: "audio/wav" });
}


// ── 語音辨識模型自動切換 ──
// Groq 每個模型的額度分開算：Large v3 用完就先換 Turbo（錯字稍多但不漏）；兩個都用完就等額度回來再送，
// 那段話不會被丟掉（等太久，超過 10 分鐘才放棄）
const STT_MODELS = ["whisper-large-v3", "whisper-large-v3-turbo"];
const sttCool = {}; // model -> 額度恢復的時間
function sttRetryMs(res, detail) {
  const m = String(detail).match(/try again in\s*(?:(\d+)h)?\s*(?:(\d+)m)?\s*([\d.]+)s/i);
  if (m) return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + parseFloat(m[3])) * 1000;
  const h = +res.headers.get("retry-after");
  return h > 0 ? h * 1000 : 20000;
}
async function sttFetch(url, headers, makeForm, onWait) {
  for (;;) {
    const now = Date.now();
    const model = STT_MODELS.find((m) => !(sttCool[m] > now));
    if (!model) {
      const wait = Math.min(...STT_MODELS.map((m) => sttCool[m])) - now;
      if (wait > 10 * 60e3) { const e = new Error("429 rate limit"); e.status = 429; throw e; }
      onWait?.(wait);
      await new Promise((r) => setTimeout(r, wait + 300));
      continue;
    }
    const res = await fetch(url, { method: "POST", headers, body: makeForm(model) });
    if (res.status !== 429) return res;
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch {}
    sttCool[model] = Date.now() + Math.max(3000, sttRetryMs(res, detail));
  }
}

// ── 語言誤判：Whisper 把整段判成別的語言時，會把中文「翻譯」成英文（不是照錄）──
// 記住這場會議主要講什麼語言；某段被判成別的語言 → 用主要語言再辨識一次，兩個結果比「把握度」，留可信的那個
const LANG_CODE = { chinese: "zh", mandarin: "zh", cantonese: "zh", english: "en", japanese: "ja", korean: "ko", russian: "ru", german: "de", french: "fr", spanish: "es", portuguese: "pt", italian: "it", indonesian: "id", malay: "ms", thai: "th", vietnamese: "vi", hindi: "hi", urdu: "ur", arabic: "ar", tagalog: "tl" };
function langCode(l) { const s = String(l || "").toLowerCase().trim(); return LANG_CODE[s] || (s.length <= 3 ? s : ""); }
// 把握度：各句 avg_logprob 依長度加權平均（越接近 0 越可信）
function sttScore(segs) {
  let w = 0, sum = 0;
  for (const g of segs || []) { if (g.avg_logprob == null) continue; const d = Math.max(0.3, (g.end || 0) - (g.start || 0)); sum += g.avg_logprob * d; w += d; }
  return w ? sum / w : -Infinity;
}
// 主要語言：累積夠多字（≥40）且某語言佔 65% 以上才算
function mainLangOf(counts) {
  let best = "", n = 0, total = 0;
  for (const [k, v] of Object.entries(counts || {})) { total += v; if (v > n) { best = k; n = v; } }
  return total >= 40 && n / total >= 0.65 ? best : "";
}

async function transcribe(s, ch, blob, startedAt, voicedMs = 0, pcm = null) {
  const fd = new FormData();
  fd.append("file", blob, "chunk.wav");
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

  // 平常用 Large v3（Turbo 錯字較多），額度用完才換 Turbo；都用完就等
  const form = (model) => { const f = new FormData(); for (const [k, v] of fd) f.append(k, v); f.append("model", model); return f; };
  const res = await sttFetch(`${s.settings.apiBase}/openai/v1/audio/transcriptions`, s.settings.apiHeaders, form,
    (ms) => notify(s.tabId, "warn", `Groq 語音額度暫時用完，錄音先存著，約 ${Math.ceil(ms / 1000)} 秒後自動補上`));
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch {}
    if (res.status === 429) { notify(s.tabId, "warn", "Groq 語音額度用完了，這段沒辦法辨識"); return; }
    throw new Error(`(${res.status}) ${detail}`);
  }
  let data = await res.json();
  // 語言誤判（例如中文被判成英文、翻成英文）→ 用這場的主要語言再辨識一次，留把握度高的
  const fixedLang = lang && lang !== "auto";
  const main = fixedLang ? "" : mainLangOf(s.langCounts);
  if (main && langCode(data.language) && langCode(data.language) !== main) {
    const res2 = await sttFetch(`${s.settings.apiBase}/openai/v1/audio/transcriptions`, s.settings.apiHeaders, (model) => { const f = form(model); f.append("language", main); return f; });
    if (res2.ok) {
      const d2 = await res2.json();
      if (sttScore(d2.segments) > sttScore(data.segments)) { d2.language = d2.language || main; data = d2; s.stats.langRetried = (s.stats.langRetried || 0) + 1; }
    }
  }
  s.stats.lastLang = data.language || (lang && lang !== "auto" ? lang + "(固定)" : "?"); // Whisper 偵測到的語言（診斷用）
  const text = (data.text || "").trim();
  // 最近 10 段的辨識結果和分數放進診斷資料（有漏網之魚時，可以拿真實數據調門檻）
  const note = (t, why, g = {}) => {
    s.stats.recent = [{ ch: ch.name, text: t.slice(0, 50), why, lang: data.language, voicedMs, nsp: g.no_speech_prob != null ? +g.no_speech_prob.toFixed(2) : null, lp: g.avg_logprob != null ? +g.avg_logprob.toFixed(2) : null }, ...(s.stats.recent || [])].slice(0, 10);
  };
  if (!text) return;
  if (isHallucination(text)) return note(text, "幻覺句");
  // 同一通道整段和上一段一模一樣 → 幻覺（每個通道各自比，避免你和對方剛好說同一句被誤刪）
  if (text === ch.lastText) return note(text, "和上一段相同");
  ch.lastText = text;
  const segments = (data.segments || [{ start: 0, end: (Date.now() - startedAt) / 1000, text }])
    .filter((g) => {
      const t = (g.text || "").trim();
      const why = !t ? "空白" : isHallucination(t) ? "幻覺句" : isFiller(t) ? "附和聲"
        // Whisper 自己的信心指標：幾乎沒語音、平均 logprob 很低、或重複字串 → 丟
        : g.no_speech_prob > 0.6 ? "沒有語音"
        : g.no_speech_prob > 0.4 && g.avg_logprob < -0.8 ? "信心偏低"
        : g.avg_logprob < -1.2 ? "信心太低"
        : g.compression_ratio > 2.4 ? "重複字串" : "";
      if (t) note(t, why || "保留", g);
      return !why;
    })
    .map((g) => ({ start: g.start, end: g.end, text: g.text }));
  if (!segments.length) return;
  const lc = langCode(data.language);
  if (lc) { s.langCounts ??= {}; s.langCounts[lc] = (s.langCounts[lc] || 0) + segments.reduce((n, g) => n + (g.text || "").trim().length, 0); }
  if (pcm) await diarize(s, pcm, segments);
  s.prevText = segments.map((g) => g.text.trim()).join(" ");
  chrome.runtime.sendMessage({ type: "stt:segments", tabId: s.tabId, channel: ch.name, chunkStart: startedAt, language: data.language || "", segments });
}

// ── 聲紋分辨說話的人（和手機版同一套：CAM++ 聲紋 + 依相似度分群）──
// 只在「只用麥克風」時用：會議網站本來就抓得到真名
let embedWorker = null, embedReady = null, embedSeq = 0, DiarMod = null;
const embedWait = new Map();
function startEmbed() {
  if (embedReady) return embedReady;
  embedWorker = new Worker(chrome.runtime.getURL("dsp/embed-worker.js"));
  embedWorker.onmessage = (e) => { const w = embedWait.get(e.data.id); if (w) { embedWait.delete(e.data.id); w(e.data); } };
  embedReady = embedCall("init", { modelUrl: chrome.runtime.getURL("dsp/model/campplus.onnx") })
    .then((r) => { if (!r.ok) throw new Error(r.error); return true; })
    .catch((e) => { console.warn("voiceprint", e); embedReady = null; embedWorker = null; throw e; });
  return embedReady;
}
function embedCall(type, data) {
  return new Promise((res) => { const id = ++embedSeq; embedWait.set(id, res); embedWorker.postMessage({ id, type, ...data }); });
}
async function embedOf(pcm16) {
  try { await startEmbed(); } catch { return null; }
  const r = await embedCall("embed", { pcm: pcm16 });
  return r.ok ? r.emb : null;
}
async function diarize(s, pcm, segments) {
  try {
    DiarMod ??= await import(chrome.runtime.getURL("dsp/diarize.js"));
    s.diar ??= new DiarMod.Diarizer();
  } catch (e) { console.warn("diarize load", e); return; }
  let chunkEmb;
  for (const g of segments) {
    const a = Math.max(0, Math.floor(g.start * TARGET_SR)), b = Math.min(pcm.length, Math.ceil(g.end * TARGET_SR));
    let emb = b - a >= TARGET_SR ? await embedOf(pcm.slice(a, b)) : null;
    if (!emb) { if (chunkEmb === undefined) chunkEmb = await embedOf(pcm); emb = chunkEmb; }
    if (!emb) return; // 模型載不起來：照舊不分人
    // 不到 3 秒的句子聲紋不穩：不開新的人
    const len = emb === chunkEmb ? pcm.length : b - a;
    g.speaker = s.diar.assign(emb, { allowNew: len >= 3 * TARGET_SR }).label;
  }
  // 同一個人被分成兩群 → 自動併回來，並請背景把舊句子改名
  const before = new Map(s.diar.clusters.map((c) => [c.id, c.label]));
  const merged = s.diar.autoMerge();
  if (merged.length) {
    const map = merged.map(({ from, to }) => ({ from: before.get(from), to: s.diar.get(to)?.label })).filter((x) => x.from && x.to && x.from !== x.to);
    for (const g of segments) for (const x of map) if (g.speaker === x.from) g.speaker = x.to;
    if (map.length) chrome.runtime.sendMessage({ type: "stt:relabel", tabId: s.tabId, map });
  }
}

// Whisper 在靜音/雜訊時常吐出固定幻覺句（訓練資料裡大量 YouTube 影片的開場白、片尾、字幕署名）
const HALLUCINATION = new RegExp([
  // 英文 YouTube 套話
  "welcome (back )?to (my|our|the) channel", "subscribe to (my|our|the) channel", "like and subscribe", "hit the (bell|subscribe|like)",
  "bell icon", "notification bell", "thanks? (you )?for watching", "see you (in the )?next (video|time|episode)", "don'?t forget to subscribe",
  "amara\\.org", "subtitles? by", "captions? by", "transcribed by",
  // 中文影片套話（只抓組合，避免誤刪會議裡正常的「訂閱制」「字幕」）
  "(訂閱|订阅).{0,6}(頻道|频道|按讚|点赞|點贊|小鈴鐺|小铃铛|鈴鐺|铃铛)", "(按讚|點贊|点赞).{0,4}(訂閱|订阅|分享)", "請不吝|请不吝",
  "(謝謝|谢谢|感謝|感谢)(大家)?(的)?(觀看|收看|收聽|观看|收听)", "下(次|期)(見|见|再見|再见)", "字幕(由|提供|組|组|志願|志愿)",
  "請勿模仿|请勿模仿", "明鏡與點點|明镜与点点",
].join("|"), "i");

// 整句只有這些（不分大小寫、去掉標點）→ 多半是 Whisper 在雜音／回音上編出來的
const SHORT_HALLU = new RegExp("^(" + [
  "thank you( so much| all| very much| everyone)?", "thanks( a lot)?", "bye( bye)?", "goodbye", "peace", "i love you", "you", "okay bye", "see you",
  "gracias", "adi[oó]s", "hola", "obrigad[oa]", "tchau", "grazie", "ciao", "buonanotte", "merci", "au revoir", "danke( sch[oö]n)?", "tsch[uü]ss", "hallo( hallo)?",
  "terima kasih", "salamat", "c[aả]m [oơ]n", "спасибо", "все", "до свидания", "감사합니다", "안녕히 계세요",
  "お疲れ様でした", "おつかれさまでした", "ありがとうございました", "ご視聴ありがとうございました", "ごちそうさまでした", "以上です", "失礼します",
  "謝謝(大家)?", "谢谢(大家)?", "再見", "再见", "拜拜", "धन्यवाद", "शुक्रिया", "شکریہ", "شكرا",
].join("|") + ")$", "i");
function isShortHallucination(t) {
  const n = String(t).toLowerCase().replace(/[\s.,!?。！？、，…~～"'「」()（）-]+/g, " ").trim();
  return !!n && SHORT_HALLU.test(n);
}

function isHallucination(t) {
  if (/^※/.test(t) || HALLUCINATION.test(t) || isSelfRepeat(t) || isShortHallucination(t)) return true;
  return /^(請不吝點贊|請看|请看|謝謝(大家)?(觀看|收看)|谢谢(大家)?(观看|收看)|字幕由|subtitles? by|thank you for watching|thanks for watching|thank you\.?$|you\.?$|bye\.?$)/i.test(t)
    || /^(.)\1{5,}$/.test(t) || /^(.{1,4})\1{2,}$/.test(t);
}

// 同一句話重複兩次以上（「I love it. I love it.」「She can do it. So, she can do it.」）是 Whisper 幻覺的典型樣子
function isSelfRepeat(t) {
  const parts = t.split(/[.!?。！？]+/)
    .map((p) => p.toLowerCase().replace(/^\s*(?:(?:so|and|yeah|oh|well|ok|okay)\b|然後|所以|就是)[,，\s]*/i, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim())
    .filter(Boolean);
  return parts.length >= 2 && parts[0].length >= 2 && parts.every((p) => p === parts[0]);
}

// 整句只有附和聲（Mm-hmm、嗯…）就不記錄；「好」「Yes」「OK」這類有意義的回答保留
function isFiller(t) {
  return /^((m+-?h+m+|m+h+m+|uh+-?huh|u+h+|u+m+|h+m+|e+r+m*|嗯+|呃+|啊+|喔+|哦+|欸+|唔+|額+)[\s,.!?，。！？…~～〜、-]*)+$/i.test(t.trim());
}

function stop(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  s.stopped = true;
  clearInterval(s.levelTimer);
  for (const ch of Object.values(s.channels)) {
    try { ch.reader?.cancel(); } catch {}
    ch.stream.getTracks().forEach((t) => t.stop());
    dsp.chans.delete(ch.key);
    dsp.worker?.postMessage({ type: "reset", ch: ch.key });
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
