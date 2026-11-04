// Whisper 幻覺過濾（和電腦版 offscreen/offscreen.js 相同的規則）
const HALLUCINATION = new RegExp([
  "welcome (back )?to (my|our|the) channel", "subscribe to (my|our|the) channel", "like and subscribe", "hit the (bell|subscribe|like)",
  "bell icon", "notification bell", "thanks? (you )?for watching", "see you (in the )?next (video|time|episode)", "don'?t forget to subscribe",
  "amara\\.org", "subtitles? by", "captions? by", "transcribed by",
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
export function isShortHallucination(t) {
  const n = String(t).toLowerCase().replace(/[\s.,!?。！？、，…~～"'「」()（）-]+/g, " ").trim();
  return !!n && SHORT_HALLU.test(n);
}

export function isHallucination(t) {
  if (/^※/.test(t) || HALLUCINATION.test(t) || isSelfRepeat(t) || isShortHallucination(t)) return true;
  return /^(請不吝點贊|請看|请看|謝謝(大家)?(觀看|收看)|谢谢(大家)?(观看|收看)|字幕由|subtitles? by|thank you for watching|thanks for watching|thank you\.?$|you\.?$|bye\.?$)/i.test(t)
    || /^(.)\1{5,}$/.test(t) || /^(.{1,4})\1{2,}$/.test(t);
}

// 同一句重複兩次以上（「I love it. I love it.」）
export function isSelfRepeat(t) {
  const parts = t.split(/[.!?。！？]+/)
    .map((p) => p.toLowerCase().replace(/^\s*(?:(?:so|and|yeah|oh|well|ok|okay)\b|然後|所以|就是)[,，\s]*/i, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim())
    .filter(Boolean);
  return parts.length >= 2 && parts[0].length >= 2 && parts.every((p) => p === parts[0]);
}

// 整句只有附和聲
export function isFiller(t) {
  return /^((m+-?h+m+|m+h+m+|uh+-?huh|u+h+|u+m+|h+m+|e+r+m*|嗯+|呃+|啊+|喔+|哦+|欸+|唔+|額+)[\s,.!?，。！？…~～〜、-]*)+$/i.test(t.trim());
}

/** 依 Whisper 的信心值過濾 segments，回傳 { kept, reasons } */
export function filterSegments(segments) {
  const kept = [], reasons = [];
  for (const g of segments) {
    const t = (g.text || "").trim();
    const why = !t ? "空白" : isHallucination(t) ? "幻覺句" : isFiller(t) ? "附和聲"
      : g.no_speech_prob > 0.6 ? "沒有語音"
      : g.no_speech_prob > 0.4 && g.avg_logprob < -0.8 ? "信心偏低"
      : g.avg_logprob < -1.2 ? "信心太低"
      : g.compression_ratio > 2.4 ? "重複字串" : "";
    if (why) reasons.push({ text: t.slice(0, 40), why }); else kept.push({ start: g.start, end: g.end, text: t });
  }
  return { kept, reasons };
}
