// Cloudflare Worker：會議摘要助理的 Groq 代理
// 讓同事不用申請金鑰——金鑰只存在這台伺服器上，擴充功能用「存取碼」呼叫。
//
// 需要設定的變數（Cloudflare 後台 → Worker → 設定 → 變數）：
//   GROQ_API_KEY   （秘密）你的 Groq 金鑰
//   ACCESS_CODES   （秘密）存取碼，可多組用逗號分隔；建議一人一組，要停用某人就刪掉他那組
//   EXTENSION_IDS  （選填）只接受這些擴充功能 ID 的瀏覽器請求。注意：這只擋得住「別的網站」，
//                  擋不住有存取碼的人用程式直接呼叫，所以存取碼仍然要保密
//   RATE_LIMITER   （選填）Cloudflare「Rate Limiting」綁定；有設定的話，每組存取碼會各自限流
const ALLOWED_PATHS = new Set([
  "/openai/v1/chat/completions",
  "/openai/v1/audio/transcriptions",
  "/openai/v1/models",
]);
// 只允許這個擴充功能用到的模型，且限制輸出長度：存取碼外流時，別人也拿不去做其他昂貴的事
const CHAT_MODELS = new Set(["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"]);
const STT_MODELS = new Set(["whisper-large-v3"]);
const MAX_TOKENS = 4096;
const MAX_BODY = 25 * 1024 * 1024; // Groq 語音檔上限也是 25 MB

const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

// 只對擴充功能的來源開放 CORS（一般網站的網頁不能呼叫）
function cors(req) {
  const origin = req.headers.get("origin") || "";
  return origin.startsWith("chrome-extension://")
    ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, x-access-code", "access-control-max-age": "86400", vary: "origin" }
    : {};
}
const json = (req, body, status) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors(req) } });

// 固定時間比對，避免從回應時間猜出存取碼
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const ua = new Uint8Array(x), ub = new Uint8Array(y);
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(ua, ub);
  let d = 0;
  for (let i = 0; i < ua.length; i++) d |= ua[i] ^ ub[i];
  return d === 0;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: cors(req) });

    const url = new URL(req.url);
    if (url.pathname === "/") return json(req, { ok: true, service: "meeting-assistant-proxy" }, 200);
    if (!ALLOWED_PATHS.has(url.pathname)) return json(req, { error: { message: "not found" } }, 404);

    const code = req.headers.get("x-access-code") || "";
    let ok = false;
    for (const c of list(env.ACCESS_CODES)) if (await sameSecret(code, c)) ok = true; // 每組都比完，不提早結束
    if (!ok) return json(req, { error: { message: "invalid access code" } }, 401);

    const ids = list(env.EXTENSION_IDS);
    const origin = req.headers.get("origin") || "";
    if (ids.length && !ids.some((id) => origin === `chrome-extension://${id}`)) {
      return json(req, { error: { message: "origin not allowed" } }, 403);
    }

    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: code });
      if (!success) return json(req, { error: { message: "rate limit exceeded" } }, 429);
    }

    if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return json(req, { error: { message: "request too large" } }, 413);
    if (!env.GROQ_API_KEY) return json(req, { error: { message: "server not configured" } }, 500);

    const headers = new Headers({ authorization: `Bearer ${env.GROQ_API_KEY}` });
    let body;
    if (url.pathname === "/openai/v1/chat/completions") {
      let j;
      try { j = await req.json(); } catch { return json(req, { error: { message: "invalid json" } }, 400); }
      if (!CHAT_MODELS.has(j.model)) return json(req, { error: { message: "model not allowed" } }, 400);
      j.max_tokens = Math.min(Number(j.max_tokens) || MAX_TOKENS, MAX_TOKENS);
      delete j.max_completion_tokens;
      body = JSON.stringify(j);
      headers.set("content-type", "application/json");
    } else if (url.pathname === "/openai/v1/audio/transcriptions") {
      let form;
      try { form = await req.formData(); } catch { return json(req, { error: { message: "invalid form" } }, 400); }
      if (!STT_MODELS.has(form.get("model"))) return json(req, { error: { message: "model not allowed" } }, 400);
      body = form; // 重新送出時會自動產生新的 multipart 邊界，不要自己設 content-type
    }

    const upstream = await fetch("https://api.groq.com" + url.pathname, { method: req.method, headers, body });
    const res = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(cors(req))) res.headers.set(k, v);
    return res;
  },
};
