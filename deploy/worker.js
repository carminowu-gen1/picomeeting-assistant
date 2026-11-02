// Cloudflare Worker：會議摘要助理的 Groq 代理
// 讓同事不用申請金鑰——金鑰只存在這台伺服器上，擴充功能用「存取碼」呼叫。
//
// 需要設定的變數（Cloudflare 後台 → Worker → 設定 → 變數）：
//   GROQ_API_KEY   （秘密）你的 Groq 金鑰
//   ACCESS_CODES   （秘密）存取碼，可多組用逗號分隔；要停用某組就把它刪掉
//   EXTENSION_IDS  （選填）只允許這些擴充功能 ID 呼叫，例如商店上架後的 ID
const ALLOWED_PATHS = new Set([
  "/openai/v1/chat/completions",
  "/openai/v1/audio/transcriptions",
  "/openai/v1/models",
]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-access-code",
  "access-control-max-age": "86400",
};

const json = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });

const list = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    if (url.pathname === "/") return json({ ok: true, service: "meeting-assistant-proxy" }, 200);
    if (!ALLOWED_PATHS.has(url.pathname)) return json({ error: { message: "not found" } }, 404);

    const codes = list(env.ACCESS_CODES);
    if (!codes.length || !codes.includes(req.headers.get("x-access-code") || "")) {
      return json({ error: { message: "invalid access code" } }, 401);
    }

    const ids = list(env.EXTENSION_IDS);
    const origin = req.headers.get("origin") || "";
    if (ids.length && !ids.some((id) => origin === `chrome-extension://${id}`)) {
      return json({ error: { message: "origin not allowed" } }, 403);
    }

    if (!env.GROQ_API_KEY) return json({ error: { message: "server not configured" } }, 500);

    const headers = new Headers({ authorization: `Bearer ${env.GROQ_API_KEY}` });
    const ct = req.headers.get("content-type");
    if (ct) headers.set("content-type", ct); // multipart 的 boundary 要原樣帶過去

    const upstream = await fetch("https://api.groq.com" + url.pathname, {
      method: req.method,
      headers,
      body: req.method === "GET" ? undefined : req.body,
    });

    const res = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  },
};
