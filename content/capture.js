// 會議字幕擷取 content script
// 在 Meet / Teams / Zoom / Jitsi 頁面上監看「即時字幕」DOM，把每句話傳給 background。
(() => {
  if (window.__meetingNotesCaptureLoaded) return;
  window.__meetingNotesCaptureLoaded = true;

  const host = location.hostname;
  const PLATFORMS = {
    meet: {
      name: "Google Meet",
      match: () => host === "meet.google.com",
      // 2026-10 已知結構：region[aria-label=Captions] > .nMcdL(一輪發言) > img 頭像 + .NWpY1d 名字 + .ygicle 文字
      // class 常改版，所以另有「頭像 img → 旁邊是名字、父層的下一個是文字」的結構式備援（見 meetRows）
      region: [
        '[role="region"][aria-label="Captions"]', '[role="region"][aria-label="字幕"]', '[role="region"][aria-label="即時字幕"]',
        '[role="region"][aria-label*="aption"]', 'div[aria-label="Captions"]', 'div[aria-label="字幕"]', "div.a4cQT",
      ],
      item: ".nMcdL, div[data-message-id], div[data-sender-name]",
      speaker: [".NWpY1d", ".zs7s8d", "[data-sender-name]", "[data-self-name]", ".KcIKyf"],
      text: [".ygicle", ".bh44bd", ".VbkSUe", ".iTTPOb"],
      ccButton: ['button[aria-label*="字幕"]', 'button[aria-label*="aption" i]', 'button[aria-label*="ubtitle" i]'],
    },
    teams: {
      name: "Microsoft Teams",
      match: () => /teams\.(microsoft|live)\.com$/.test(host),
      region: ['[data-tid="closed-caption-renderer-wrapper"]', '[data-tid="closed-captions-renderer"]', ".closed-captions-renderer"],
      item: '[data-tid="closed-caption-message"], .fui-ChatMessageCompact, .ui-chat__item',
      speaker: ['[data-tid="author"]', ".fui-ChatMessageCompact__author", ".ui-chat__message__author"],
      text: ['[data-tid="closed-caption-text"]', ".fui-ChatMessageCompact__body", ".ui-chat__message__content"],
      ccButton: ['button[aria-label*="字幕"]', 'button[aria-label*="aption"]'],
    },
    zoom: {
      name: "Zoom",
      match: () => /zoom\.us$/.test(host),
      region: ["#live-transcription-subtitle", ".live-transcription-subtitle", '[class*="live-transcription-subtitle"]'],
      item: '[class*="live-transcription-subtitle__item"], [class*="subtitle__item"], div',
      speaker: ['[class*="speaker"]', '[class*="name"]'],
      text: ['[class*="text"]', "span"],
      ccButton: ['button[aria-label*="字幕"]', 'button[aria-label*="aption"]'],
    },
    jitsi: {
      name: "Jitsi Meet",
      match: () => host === "meet.jit.si" || host.endsWith(".jitsi.net") || !!document.querySelector("#largeVideoContainer"),
      region: [".transcription-subtitles", "#subtitles", '[class*="subtitles"]'],
      item: "span, div",
      speaker: [],
      text: [],
      ccButton: ['[aria-label*="字幕"]', '[aria-label*="ubtitle"]', '[aria-label*="aption"]'],
    },
  };

  // 「誰正在說話」偵測（給語音辨識用來標發言者）：每個平台的 tile / 名字 / 說話中指示
  const SPEAKING = {
    meet: {
      // tile 根節點帶 data-participant-id；名字在 span.notranslate
      tile: ["[data-participant-id]", "[data-requested-participant-id]", "div[data-self-name]"],
      name: ["[data-self-name]", "span.notranslate", ".zWGUib", ".XEazBc"],
      // 「說話中」三種已回報的位置（不同 Meet 版本不一致，全部都查）：
      //  a) tile 根節點 class BlxGDf（持續）/ Oaajhc（瞬間）  b) 子節點 [jsname=QgSmzd] 加上 sxlEM  c) 通用 aria-label
      speaking: [
        "[data-participant-id].BlxGDf", "[data-participant-id].Oaajhc", '[jsname="QgSmzd"].sxlEM',
        '[aria-label*="正在說話"]', '[aria-label*="is speaking" i]', '[data-is-speaking="true"]',
      ],
      // 自己的 tile：有「視覺效果」按鈕（圖示 ligature 不會被在地化）
      self: (tile) => !!tile.querySelector("[data-self-name]") || [...tile.querySelectorAll("i")].some((i) => /^visual_effects$/.test(i.textContent.trim())),
      skip: (name) => /\(?(presenting|簡報|正在分享|分享螢幕|screen)\)?/i.test(name),
    },
    teams: {
      tile: ['[data-tid="participant-tile"]', '[data-tid*="participant"]', '[data-cid="calling-participant-stream"]', ".calling-participant-stream"],
      name: ['[data-tid="participant-name"]', '[data-tid*="name"]', ".participant-name", "span"],
      speaking: ['[data-tid="voice-level-stream-outline"]', '[class*="speaking"]', '[data-is-speaking="true"]', '[aria-label*="speaking"]', '[aria-label*="正在說話"]'],
    },
    zoom: {
      tile: [".video-avatar__avatar", ".gallery-video-container__video-frame", '[class*="video-frame"]', '[class*="participant"]'],
      name: [".video-avatar__avatar-name", '[class*="avatar-name"]', '[class*="display-name"]', '[class*="name"]'],
      speaking: ['[class*="speaking"]', '[class*="active-speaker"]', '[class*="audio-animation"]'],
    },
    jitsi: {
      tile: ["#filmstripRemoteVideos .videocontainer", "#localVideoContainer", ".videocontainer", '[id^="participant_"]'],
      name: [".displayname", ".displayName", '[class*="displayname"]'],
      speaking: ["#dominantSpeaker", ".dominant-speaker", '[class*="dominant"]', '[class*="speaking"]', ".audioLevelDot[style*='opacity: 1']"],
    },
  };

  const key = Object.keys(PLATFORMS).find((k) => PLATFORMS[k].match());
  if (!key) return;
  const P = PLATFORMS[key];
  const S = SPEAKING[key];

  // 從 tile 取名字：優先 data 屬性，否則找最短的合理文字
  let myName = ""; // 設定頁填的「你的名字」，由 background 在 start 時帶進來
  const tidyName = (n) => clean(n).replace(/\s*[（(]\s*(你|您|You|我|主持人|Host|簡報中|Presenting|已靜音|Muted)\s*[）)]\s*/gi, "").trim();

  function tileName(tile) {
    if (S.self?.(tile)) {
      if (myName) return myName;
      // 沒填名字：用 tile 上的顯示名稱，純「你 / You」就標「我」
      for (const sel of S.name) {
        const n = tidyName(tile.querySelector(sel)?.textContent || "");
        if (n && !/^(你|您|You|Me)$/i.test(n)) return n;
      }
      return "我";
    }
    for (const sel of S.name) {
      const el = tile.matches(sel) ? tile : tile.querySelector(sel);
      const v = el?.getAttribute?.("data-self-name") || el?.textContent;
      const n = tidyName(v || "");
      if (n && n.length <= 40 && !/^\d+$/.test(n)) return /^(你|您|You|Me)$/i.test(n) ? (myName || "我") : n;
    }
    return "";
  }

  // 診斷用：每個 tile 的名字、根節點 class、QgSmzd 子節點 class（說話 / 安靜各按一次就能比對）
  function tileDump() {
    const tiles = [...document.querySelectorAll(S.tile[0])].slice(0, 8);
    return tiles.map((t) => ({
      name: maskName(tileName(t)),
      rootClass: (t.className || "").toString().trim(),
      qg: [...t.querySelectorAll('[jsname="QgSmzd"]')].map((q) => (q.className || "").toString().trim()),
      audioAttrs: [...t.querySelectorAll("[data-audio-level], [aria-label*='麥克風'], [aria-label*='icrophone']")].map((e) => e.getAttribute("data-audio-level") ?? e.getAttribute("aria-label")),
    }));
  }

  let globalAt = 0, globalNames = [];
  function speakingNow() {
    const names = new Set();
    // 1) 先只在參加者的 tile 裡找「說話中」指示（每 0.5 秒跑一次，不能掃整個會議頁面）
    const tiles = document.querySelectorAll(S.tile.join(","));
    for (const tile of tiles) {
      for (const sel of S.speaking) {
        const ind = tile.matches(sel) ? tile : tile.querySelector(sel);
        if (!ind || ind.closest("button")) continue;
        const n = tileName(tile);
        if (n && !S.skip?.(n)) { names.add(n); speakingHit = sel; }
        break;
      }
    }
    // 2) 找不到 tile（平台改版）才掃整頁，而且最多每 2 秒一次
    if (!tiles.length) {
      if (Date.now() - globalAt < 2000) return globalNames;
      globalAt = Date.now();
      for (const sel of S.speaking) {
        document.querySelectorAll(sel).forEach((ind) => {
          if (ind.closest("button")) return;
          const tile = ind.parentElement?.parentElement;
          const n = tile && tileName(tile);
          if (n && !S.skip?.(n)) { names.add(n); speakingHit = sel; }
        });
      }
      globalNames = [...names];
    }
    // 2) Jitsi：dominant speaker 是加在 tile 本身的 class / id
    if (!names.size && key === "jitsi") {
      const t = document.querySelector("#dominantSpeaker, .dominant-speaker") || document.querySelector('.videocontainer[class*="speaking"]');
      const n = t && tileName(t);
      if (n) names.add(n);
    }
    return [...names];
  }

  let lastSpeakers = "";
  let speakerTimer = null;
  let speakingHit = ""; // 哪一個 selector 命中（診斷用）
  function startSpeakerWatch() {
    clearInterval(speakerTimer);
    speakerTimer = setInterval(() => {
      const now = speakingNow();
      const k = now.join("|");
      if (k !== lastSpeakers) {
        lastSpeakers = k;
        send({ type: "speaker", names: now, t: Date.now() });
      }
    }, 500);
  }
  function stopSpeakerWatch() { clearInterval(speakerTimer); speakerTimer = null; lastSpeakers = ""; }

  let recording = false;
  let observer = null;
  // 字幕會「邊講邊長」，用 speaker 當 key 保留最後一句，長出來就覆蓋、換句就新增
  const lastBySpeaker = new Map();

  const q = (root, sels) => sels.map((s) => root.querySelector(s)).find(Boolean) || null;
  const qAll = (root, sels) => sels.map((s) => root.querySelector(s)).filter(Boolean);
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  let sentCount = 0;
  function send(msg) {
    if (msg.type === "caption") sentCount++;
    try { chrome.runtime.sendMessage({ ...msg, platform: key, platformName: P.name, title: document.title }); } catch {}
  }

  function emit(speaker, text) {
    text = clean(text);
    speaker = clean(speaker) || "發言者";
    if (!text) return;
    const prev = lastBySpeaker.get(speaker);
    if (prev && prev.text === text) return;
    // 同一句還在長：覆蓋（傳 replace）
    if (prev && (text.startsWith(prev.text) || prev.text.startsWith(text) || similar(prev.text, text))) {
      prev.text = text;
      send({ type: "caption", mode: "replace", id: prev.id, speaker, text });
      return;
    }
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    lastBySpeaker.set(speaker, { id, text });
    send({ type: "caption", mode: "append", id, speaker, text });
  }

  // 字幕引擎有時會改前面幾個字（修正辨識），用前綴相似度判斷是否同一句
  function similar(a, b) {
    const n = Math.min(a.length, b.length, 12);
    if (n < 6) return false;
    let same = 0;
    for (let i = 0; i < n; i++) if (a[i] === b[i]) same++;
    return same / n > 0.7;
  }

  // Meet 結構式備援：頭像 img → nextElementSibling 是名字，img 的父層的 nextElementSibling 是文字
  function meetRows(region) {
    const rows = [];
    region.querySelectorAll('img[src^="http"], img[src^="data:"]').forEach((img) => {
      const sp = img.nextElementSibling, tx = img.parentElement?.nextElementSibling;
      if (sp && tx && clean(tx.textContent)) rows.push({ speaker: sp.textContent, text: tx.textContent });
    });
    return rows;
  }

  function scanRegion(region) {
    if (key === "jitsi") {
      // Jitsi 字幕是純文字，格式常為 "名字: 內容"
      const raw = clean(region.textContent);
      const m = raw.match(/^([^:：]{1,30})[:：]\s*(.+)$/);
      if (m) emit(m[1], m[2]); else emit("", raw);
      return;
    }
    const items = region.querySelectorAll(P.item);
    const seen = new Set();
    if (key === "meet" && !items.length) {
      // class 全沒中：走結構式
      for (const r of meetRows(region)) {
        const k = r.speaker + "|" + r.text;
        if (seen.has(k)) continue;
        seen.add(k);
        emit(r.speaker, r.text);
      }
      return;
    }
    items.forEach((it) => {
      const sp = q(it, P.speaker);
      const tx = q(it, P.text);
      if (!tx || !tx.textContent) return;
      if (tx.closest("button")) return;
      const speaker = sp ? sp.textContent : "";
      const text = tx.textContent;
      const k = speaker + "|" + text;
      if (seen.has(k)) return;
      seen.add(k);
      if (clean(text).length < 2) return;
      emit(speaker, text);
    });
  }

  function findRegion() {
    const r = q(document, P.region);
    if (r || key !== "meet") return r;
    // Meet：aria-label 被在地化時，只認標籤含「字幕 / caption」的 region
    //（不能用「含頭像 img」判斷：「通話功能通知和動作」區也有頭像）
    return [...document.querySelectorAll('[role="region"]')].find(
      (x) => /caption|subtitle|transcript|字幕/i.test(x.getAttribute("aria-label") || "")
    ) || null;
  }

  function regionLabels() {
    return [...document.querySelectorAll('[role="region"]')].map((x) => x.getAttribute("aria-label") || `(無標籤 .${(x.className || "").toString().slice(0, 20)})`);
  }

  // 診斷：popup 按「診斷」時回報目前抓到什麼，方便調 selector
  // 診斷資料會被貼給別人看：參加者名字一律遮掉，只看得出有沒有抓到
  const maskName = (n) => (!n ? null : n === "我" || n === myName ? "(我)" : `(參加者・${[...n].length} 字)`);

  function diagnose() {
    const region = findRegion();
    const items = region ? region.querySelectorAll(P.item).length : 0;
    const structural = region && key === "meet" ? meetRows(region).length : 0;
    const tiles = S.tile.map((t) => document.querySelectorAll(t).length);
    const tileEl = q(document, S.tile);
    return {
      platform: P.name, url: location.origin, // 只留網域：完整網址可能含會議密碼
      captions: { regionFound: !!region, regionLabel: region?.getAttribute("aria-label") || region?.className?.slice(0, 40) || null, itemsByClass: items, itemsStructural: structural, allRegions: regionLabels() },
      sent: sentCount, // 這個分頁已送出的字幕訊息數
      ccButton: !!q(document, P.ccButton),
      speakers: { tilesBySelector: tiles, sampleTileName: tileEl ? maskName(tileName(tileEl)) : null, speakingNow: speakingNow().map(maskName), speakingSelectorHit: speakingHit || null, tiles: tileDump() },
      recording,
    };
  }

  function start() {
    if (recording) return;
    recording = true;
    lastBySpeaker.clear();
    let region = null;
    const tick = () => {
      if (!recording) return;
      const r = findRegion();
      if (r && r !== region) {
        region = r;
        observer?.disconnect();
        observer = new MutationObserver(() => scanRegion(region));
        observer.observe(region, { childList: true, subtree: true, characterData: true });
        scanRegion(region);
        send({ type: "status", captionsFound: true });
      } else if (!r) {
        region = null;
        send({ type: "status", captionsFound: false });
      }
    };
    tick();
    window.__mnTimer = setInterval(tick, 2000);
    send({ type: "started" });
  }

  function stop() {
    recording = false;
    observer?.disconnect();
    observer = null;
    clearInterval(window.__mnTimer);
    send({ type: "stopped" });
  }

  function enableCaptions() {
    if (findRegion()) return true; // 已經開著
    let btn = q(document, P.ccButton);
    // Meet：aria-label 在地化時，用圖示 ligature 找 closed_caption 按鈕
    if (!btn && key === "meet") {
      const icon = [...document.querySelectorAll("button i, [role='button'] i")].find((i) => /^closed_caption(_off)?$/.test(i.textContent.trim()));
      btn = icon?.closest("button, [role='button']") || null;
    }
    if (!btn) return false;
    const pressed = btn.getAttribute("aria-pressed");
    const label = (btn.getAttribute("aria-label") || "").toLowerCase();
    if (pressed === "true" || /關閉|turn off|hide/.test(label)) return true; // 已開啟
    btn.click();
    return true;
  }

  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg.type === "ping") reply({ platform: key, platformName: P.name, recording, captionsFound: !!findRegion() });
    if (msg.myName != null) myName = clean(msg.myName);
    if (msg.type === "start") { if (msg.autoCaptions) enableCaptions(); start(); if (msg.watchSpeakers) startSpeakerWatch(); startEndWatch(); reply({ ok: true }); }
    if (msg.type === "startSpeakerWatch") { startSpeakerWatch(); startEndWatch(); reply({ ok: true }); }
    if (msg.type === "stop") { stop(); stopSpeakerWatch(); stopEndWatch(); reply({ ok: true }); }
    if (msg.type === "enableCaptions") reply({ ok: enableCaptions() });
    if (msg.type === "diagnose") reply(diagnose());
    return true;
  });

  // 自動開始：由 background 依設定決定
  send({ type: "pageReady" });
  // ── 偵測離開會議：通話控制列（離開按鈕）消失，或出現「你已離開」畫面 → 通知 background 自動停止 ──
  const HANGUP = {
    meet: ['button[aria-label*="Leave call" i]', 'button[aria-label*="離開通話"]', 'button[aria-label*="退出通話"]', 'button[aria-label*="結束通話"]', '[jsname="CQylAd"]'],
    teams: ["#hangup-button", 'button[data-tid="hangup-main-btn"]', 'button[data-tid*="hangup"]', 'button[aria-label*="Leave" i]', 'button[aria-label*="離開"]'],
    zoom: [".footer__leave-btn", 'button[aria-label*="Leave" i]', 'button[aria-label*="離開"]', 'button[aria-label*="End" i]'],
    jitsi: [".hangup-button", '[aria-label*="Leave" i]', '[aria-label*="離開"]', '[aria-label*="掛斷"]'],
  };
  const LEFT_TEXT = /你已離開(這場)?會議|你已離開通話|You left the meeting|You've left the (call|meeting)|You have left the meeting|The meeting has ended|會議已結束|通話已結束|You left the call/i;
  let endTimer = null, seenInCall = false, missing = 0;
  function inCall() { return !!q(document, HANGUP[key] || []); }
  function startEndWatch() {
    clearInterval(endTimer);
    seenInCall = inCall(); missing = 0;
    endTimer = setInterval(() => {
      // 還在通話中就不讀整頁文字（innerText 會讓瀏覽器重新排版整個會議畫面，很耗效能）
      if (inCall()) { seenInCall = true; missing = 0; return; }
      if (seenInCall) missing++;
      const leftScreen = LEFT_TEXT.test(document.body?.innerText?.slice(0, 4000) || "");
      // 出現「已離開」畫面、或曾在通話中而離開按鈕連續 3 次（約 6 秒）都不見 → 會議結束
      if (leftScreen || missing >= 3) {
        clearInterval(endTimer); endTimer = null;
        send({ type: "meetingEnded", reason: leftScreen ? "left-screen" : "controls-gone" });
      }
    }, 2000);
  }
  function stopEndWatch() { clearInterval(endTimer); endTimer = null; }

  window.addEventListener("beforeunload", () => { send({ type: "meetingEnded", reason: "unload" }); });
})();
