// 部署設定（config.json，由 build.ps1 寫入）：
//   proxyUrl 空白 → 使用者自己填 Groq API Key
//   proxyUrl 有值 → 走組織的代理伺服器（金鑰在伺服器上），使用者什麼都不用填
let cached = null;

export async function getConfig() {
  if (cached) return cached;
  try { cached = await (await fetch(chrome.runtime.getURL("config.json"))).json(); }
  catch { cached = {}; }
  return cached;
}

// 把部署設定合併進使用者設定：apiBase / apiHeaders / ready
export async function withApi(settings) {
  const c = await getConfig();
  const proxy = !!c.proxyUrl;
  return {
    ...settings,
    proxy,
    apiBase: (c.proxyUrl || "https://api.groq.com").replace(/\/+$/, ""),
    apiHeaders: proxy ? { "x-access-code": c.accessCode || "" } : { authorization: `Bearer ${settings.apiKey || ""}` },
    ready: proxy || !!settings.apiKey,
  };
}
