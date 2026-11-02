// 上傳新版本到 Chrome 線上應用程式商店並送審（Chrome Web Store API v2，服務帳戶驗證）
// 用法：node scripts/publish-cws.mjs dist/meeting-assistant-1.0.1.zip
// 環境變數：
//   CWS_SERVICE_ACCOUNT_JSON  服務帳戶金鑰 JSON 全文
//   CWS_PUBLISHER_ID          開發人員資訊主頁 → 發布者 → 設定 裡的 ID
//   CWS_EXTENSION_ID          商店項目的 ID（32 個英文字母）
//   CWS_PUBLISH_TYPE          選填：DEFAULT_PUBLISH（審核通過自動上線，預設）或 STAGED_PUBLISH（通過後等你手動上線）
import { readFileSync } from "node:fs";
import { sign } from "node:crypto";

const zipPath = process.argv[2];
const { CWS_SERVICE_ACCOUNT_JSON, CWS_PUBLISHER_ID, CWS_EXTENSION_ID } = process.env;
const publishType = process.env.CWS_PUBLISH_TYPE || "DEFAULT_PUBLISH";
if (!zipPath || !CWS_SERVICE_ACCOUNT_JSON || !CWS_PUBLISHER_ID || !CWS_EXTENSION_ID) {
  console.error("缺少參數：zip 路徑、CWS_SERVICE_ACCOUNT_JSON、CWS_PUBLISHER_ID、CWS_EXTENSION_ID");
  process.exit(1);
}

const SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const item = `publishers/${CWS_PUBLISHER_ID}/items/${CWS_EXTENSION_ID}`;

// 1. 用服務帳戶私鑰簽 JWT，換 access token
async function getToken() {
  const sa = JSON.parse(CWS_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 })}`;
  const jwt = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), sa.private_key).toString("base64url")}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`取得 token 失敗（${r.status}）：${JSON.stringify(j)}`);
  return j.access_token;
}

async function call(token, method, url, body) {
  const r = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, ...(body && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}) }, body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j; try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok) throw new Error(`${method} ${url} 失敗（${r.status}）：${text.slice(0, 800)}`);
  return j;
}

const state = (j) => j.uploadState || j.lastAsyncUploadState || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const token = await getToken();
console.log("✓ 已取得授權");

// 2. 上傳 zip（文件範例是 curl -T，送原始檔案內容）
let up = await call(token, "POST", `https://chromewebstore.googleapis.com/upload/v2/${item}:upload`, new Uint8Array(readFileSync(zipPath)));
console.log("上傳結果：", JSON.stringify(up));

// 3. 還在處理就輪詢（文件裡 IN_PROGRESS / UPLOAD_IN_PROGRESS 兩種寫法都有）
for (let i = 0; i < 30 && /IN_PROGRESS/.test(state(up)); i++) {
  await sleep(5000);
  up = await call(token, "GET", `https://chromewebstore.googleapis.com/v2/${item}:fetchStatus`);
  console.log("處理中…", state(up));
}
if (state(up) !== "SUCCEEDED") throw new Error(`上傳沒有成功：${JSON.stringify(up)}`);
console.log(`✓ 上傳成功${up.crxVersion ? "，版本 " + up.crxVersion : ""}`);

// 4. 送審
const pub = await call(token, "POST", `https://chromewebstore.googleapis.com/v2/${item}:publish`, { publishType });
console.log("送審結果：", JSON.stringify(pub));
console.log(publishType === "STAGED_PUBLISH" ? "✓ 已送審，通過後請到資訊主頁按「發布」" : "✓ 已送審，通過後會自動上線，使用者的 Chrome 會自動更新");
