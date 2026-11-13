import { readFile, readGoogleSheet, parseSheetUrl, EMAIL_RE } from "./sheet.js";
import { buildMime, fileToAttachment } from "./mime.js";

const $ = (id) => document.getElementById(id);
const ext = typeof chrome !== "undefined" && chrome.identity ? chrome : null; // 不在外掛裡（本機預覽）時為 null
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const MAX_ATTACH = 20 * 1024 * 1024;
const DEFAULT_BODY = "<div>{{姓名}} {{稱謂}} 您好：</div><div><br></div><div><br></div>";

const state = {
  source: "", headers: [], rows: [], map: { title: -1, name: -1, email: -1 },
  sheetUrl: "", // 名單來自 Google 試算表時記住網址，「更新名單」才能直接重讀
  sender: "", replyTo: "", subject: "", body: DEFAULT_BODY,
  receipt: false,
  status: {}, // 列號 → "ok" 或錯誤訊息
  off: {}, // 列號 → 1 表示沒打勾（不寄）
  custom: {}, // 列號 → { subject, html }：在預覽裡為這一位單獨改過的版本
  sentAt: {}, // 列號 → 寄出時間
  alias: {}, // 列號 → 名單上原本的 Email（在預覽改過收件 Email 的人；更新名單時靠它認回同一位）
  prev: {}, // 列號 → { email, at }：按「再寄一次」之前，上一次寄到哪個信箱、何時寄
  caseDate: "", // 會議日期（yyyy-mm-dd，可空）
  caseId: null, caseName: "", // 目前這一案在案件紀錄裡的編號和名字（暫存過才有）
  sort: null, // 列表排序 { key: "title"|"name"|"email", dir: 1|-1 }；null 是名單原本的順序
  rules: null, // 稱謂自動轉換 [{ from: "教授、副教授", to: "老師" }]；null 表示還沒設定過（第一次會放一條範例）
};
const DEFAULT_RULES = [{ from: "教授、副教授、助理教授", to: "老師" }];
let attachments = [];
let current = 0;
let sending = false;
let stopFlag = false;
let myEmail = "";
let showMap = false; // 欄位都自動認出來時，不顯示欄位選單

// ---------- 儲存（關掉再開，名單和信件都還在） ----------

const store = {
  async load() {
    if (ext) return (await chrome.storage.local.get("vip")).vip;
    try { return JSON.parse(localStorage.getItem("vip")); } catch { return null; }
  },
  save() {
    clearTimeout(store.t);
    store.t = setTimeout(() => {
      if (ext) chrome.storage.local.set({ vip: state });
      else localStorage.setItem("vip", JSON.stringify(state));
    }, 300);
  },
};

// ---------- Google 授權 ----------
// 用戶端 ID 由使用者在設定畫面貼上，存在外掛裡；不用改任何檔案

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");
const CLIENT_RE = /^[\w-]+\.apps\.googleusercontent\.com$/;
let clientId = "";
let auth = null; // { token, exp }

function webAuth(interactive, choose) {
  const params = { client_id: clientId, response_type: "token", redirect_uri: chrome.identity.getRedirectURL(), scope: SCOPES };
  if (!interactive) params.prompt = "none";
  if (choose) params.prompt = "select_account";
  if (myEmail) params.login_hint = myEmail;
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams(params);
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (back) => {
      const p = new URLSearchParams((back || "").split("#")[1] || "");
      const token = p.get("access_token");
      if (chrome.runtime.lastError || !token) {
        return reject(new Error("沒有完成 Google 授權。如果視窗裡出現錯誤，請確認用戶端 ID 和重新導向 URI 都照設定畫面填了。"));
      }
      resolve({ token, exp: Date.now() + (+p.get("expires_in") || 3600) * 1000 - 60000 });
    });
  });
}

async function getToken() {
  if (!ext) throw new Error("要在 Chrome 外掛裡才能連 Google。");
  if (!clientId) { openSetup(); throw new Error("還沒完成第一次設定，請先在上方貼上用戶端 ID。"); }
  if (auth && auth.exp > Date.now()) return auth.token;
  try { auth = await webAuth(false); } // 先試不跳視窗
  catch { auth = await webAuth(true); }
  chrome.storage.session?.set({ vipAuth: auth });
  return auth.token;
}

// 連結帳號並查出是哪個 Gmail（測試信寄到這裡）
async function connect() {
  const me = await gfetch("https://www.googleapis.com/oauth2/v3/userinfo");
  myEmail = me.email || "";
  chrome.storage.local.set({ vipEmail: myEmail });
  showAccount();
}

function showAccount() {
  $("account").textContent = myEmail ? "寄件帳號：" + myEmail : clientId ? "重新設定授權" : "";
}

function openSetup() {
  $("redirect").textContent = chrome.identity.getRedirectURL();
  $("clientId").value = clientId;
  $("setup").hidden = false;
  $("setup").scrollIntoView({ block: "start", behavior: "smooth" });
}

async function saveSetup() {
  const id = $("clientId").value.trim();
  if (!CLIENT_RE.test(id)) return showMsg("setupMsg", "這不像用戶端 ID。它的結尾應該是 .apps.googleusercontent.com", "bad");
  clientId = id; auth = null; myEmail = "";
  await chrome.storage.local.set({ vipClientId: id });
  $("connectBtn").disabled = true;
  showMsg("setupMsg", "請在跳出的視窗選擇要用來寄信的 Google 帳號…");
  try {
    auth = await webAuth(true, true); // 一定跳出選帳號視窗
    chrome.storage.session?.set({ vipAuth: auth });
    await connect();
    showMsg("setupMsg", "");
    $("setup").hidden = true;
  } catch (e) { showMsg("setupMsg", e.message, "bad"); }
  $("connectBtn").disabled = false;
}

async function gfetch(url, opts = {}) {
  let res;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken();
    res = await fetch(url, { ...opts, headers: { ...opts.headers, Authorization: "Bearer " + token } });
    if (res.status !== 401) break;
    auth = null; // 授權過期，換新的再試一次
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(friendly(res.status, data.error?.message || ""));
    err.status = res.status;
    throw err;
  }
  return data;
}

function friendly(status, message) {
  if (/not supported for this document/i.test(message)) return "這份是放在雲端硬碟的 Excel 檔，不是 Google 試算表。請下載後把檔案拖進來。";
  if (status === 404) return "找不到這份試算表，請確認網址正確。";
  if (status === 403 && /has not been used|disabled/i.test(message)) return "Google 專案還沒啟用 Gmail API／Sheets API，請看 README.md 的第一次設定。";
  if (status === 403 && /permission/i.test(message)) return "這個 Google 帳號沒有權限看這份試算表。";
  if (status === 429 || /limit/i.test(message)) return "Gmail 今天的寄信量到上限了，請明天再寄剩下的。";
  return message || "發生錯誤（" + status + "）";
}

// ---------- 名單 ----------

const raw = (row, key, c = state) => (c.map[key] >= 0 ? row[c.map[key]] || "" : "");
// 稱謂會先經過「稱謂自動轉換」（教授 → 老師）
const col = (row, key, c = state) => (key === "title" ? convertTitle(raw(row, key, c), c) : raw(row, key, c));
const splitFrom = (s) => String(s).split(/[、,，;；/／|｜\s]+/).map((x) => x.trim()).filter(Boolean);
function convertTitle(v, c = state) {
  const t = String(v).trim().toLowerCase();
  if (!t) return v;
  for (const r of c.rules || []) {
    if (r.to.trim() && splitFrom(r.from).some((f) => f.toLowerCase() === t)) return r.to.trim();
  }
  return v;
}
const validRow = (row) => EMAIL_RE.test(col(row, "email"));

// {{稱謂}} {{姓名}} {{Email}} 走對應欄位，其他用 Excel 的欄位名稱
function lookup(row, key, c = state) {
  const fixed = { 稱謂: "title", 姓名: "name", Email: "email" }[key] || (key.toLowerCase() === "email" ? "email" : null);
  if (fixed && c.map[fixed] >= 0) return col(row, fixed, c);
  const i = c.headers.indexOf(key);
  return i >= 0 ? row[i] || "" : undefined;
}

function fill(template, row, html, c = state) {
  return template.replace(TOKEN, (whole, key) => {
    const v = lookup(row, key, c);
    if (v === undefined) return html ? "<mark>" + esc(whole) + "</mark>" : whole;
    return html ? esc(v) : v;
  });
}

// 收信確認：信末放一顆按鈕，對方點了會開啟一封寫好的回覆信
function subjectFor(i) {
  return state.custom[i] ? state.custom[i].subject : fill(state.subject, state.rows[i], false);
}

function receiptHtml(i) {
  const row = state.rows[i];
  const to = (state.replyTo || "").trim() || myEmail;
  const who = (col(row, "name") + " " + col(row, "title")).trim();
  const href = to
    ? "mailto:" + to + "?subject=" + encodeURIComponent("已收到：" + subjectFor(i)) +
      "&body=" + encodeURIComponent((who ? who + " " : "") + "已收到這封信。")
    : "#";
  return '<div style="margin-top:28px"><a href="' + esc(href) + '" style="display:inline-block;padding:10px 24px;background:#1f2a44;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:bold">✓ 我已收到</a>' +
    '<div style="margin-top:8px;font-size:12px;color:#888888">點一下按鈕會開啟一封已寫好的回覆信，按傳送即可。</div></div>';
}

function mailHtml(i) {
  const body = state.custom[i] ? state.custom[i].html : fill(state.body, state.rows[i], true).replace(/<\/?mark>/g, "");
  return body + (state.receipt ? receiptHtml(i) : "");
}

function usedKeys() {
  const keys = new Set();
  for (const m of (state.subject + " " + state.body).matchAll(TOKEN)) keys.add(m[1]);
  return [...keys];
}

function setTable(table, source) {
  Object.assign(state, { headers: table.headers, rows: table.rows, map: table.map, source: table.source || source, status: {}, off: {}, custom: {}, sentAt: {}, alias: {}, prev: {} });
  current = firstCurrent();
  showMsg("listMsg", "");
  store.save();
  render();
}

// 名單有新人：重讀 Excel／試算表，用 Email 對照舊名單。
// 舊名單裡的人保留寄過／沒寄、打勾、個別修改；個別修改過的人連稱謂姓名都不動；新人加在後面。
// 已寄過但新名單裡不見的人，留在最後面當紀錄。
function mergeTable(table) {
  const emailOf = (row, c) => (col(row, "email", c) || "").trim().toLowerCase();
  const nameOf = (row, c) => (raw(row, "name", c) || "").trim().toLowerCase();
  const sameHeaders = JSON.stringify(table.headers) === JSON.stringify(state.headers);
  const map = sameHeaders ? state.map : table.map;
  const next = { headers: table.headers, map };
  const old = new Map();
  state.rows.forEach((row, i) => { for (const k of [emailOf(row, state), (state.alias[i] || "").toLowerCase()]) if (k && !old.has(k)) old.set(k, i); });
  // 舊的一列換成新名單的欄位順序（欄位名稱一樣的照搬）
  const relayout = (row) => sameHeaders ? row : table.headers.map((h) => { const i = state.headers.indexOf(h); return i >= 0 ? row[i] || "" : ""; });
  // 第一輪：用 Email 對
  const match = table.rows.map((row) => { const k = emailOf(row, next); return k ? old.get(k) : undefined; });
  const used = new Set(match.filter((x) => x !== undefined));
  // 第二輪：Email 對不到的（多半是在 Excel 裡改了 Email）用姓名對；同名不只一位就不猜
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const oldNames = new Map(), newNames = new Map(), oldByName = new Map(), byName = new Set();
  state.rows.forEach((row, i) => { const n = nameOf(row, state); if (n && !used.has(i)) { bump(oldNames, n); oldByName.set(n, i); } });
  table.rows.forEach((row, j) => { const n = nameOf(row, next); if (n && match[j] === undefined) bump(newNames, n); });
  table.rows.forEach((row, j) => {
    const n = nameOf(row, next);
    if (match[j] !== undefined || !n || oldNames.get(n) !== 1 || newNames.get(n) !== 1 || !EMAIL_RE.test(col(row, "email", next))) return;
    match[j] = oldByName.get(n); used.add(match[j]); byName.add(j);
  });

  const rows = [], status = {}, off = {}, custom = {}, sentAt = {}, alias = {}, prev = {};
  const carry = (ni, oi) => {
    for (const [k, o] of [["status", status], ["off", off], ["custom", custom], ["sentAt", sentAt], ["alias", alias], ["prev", prev]]) if (state[k][oi] !== undefined) o[ni] = state[k][oi];
  };
  const seen = new Set();
  let added = 0, edited = 0, changed = 0, again = 0;
  table.rows.forEach((row, j) => {
    const oi = match[j];
    if (oi === undefined) { rows.push(row); added++; return; }
    if (byName.has(j)) { // Excel 裡這一位換了 Email：照 Excel；寄過的自動變回打勾，準備再寄
      const ni = rows.push(row) - 1;
      carry(ni, oi); delete alias[ni]; changed++;
      if (status[ni] === "ok") {
        prev[ni] = { email: col(state.rows[oi], "email"), at: sentAt[ni] || 0 };
        delete status[ni]; delete sentAt[ni]; delete off[ni]; again++;
      }
      return;
    }
    seen.add(emailOf(row, next));
    const keepOld = state.custom[oi] !== undefined || state.alias[oi] !== undefined; // 個別修改過（信或 Email）的人：整列都不動
    if (keepOld) edited++;
    carry(rows.push(keepOld ? relayout(state.rows[oi]) : row) - 1, oi);
  });
  let kept = 0;
  state.rows.forEach((row, oi) => {
    const k = emailOf(row, state);
    if (state.status[oi] === "ok" && !used.has(oi) && !(k && seen.has(k))) { carry(rows.push(relayout(row)) - 1, oi); kept++; }
  });
  Object.assign(state, next, { rows, status, off, custom, sentAt, alias, prev });
  current = firstCurrent();
  store.save();
  render();
  showMsg("listMsg", "名單更新好了：新增 " + added + " 位" +
    (changed ? "，" + changed + " 位的 Email 照 Excel 改了" + (again ? "（其中 " + again + " 位寄過，已自動打勾準備再寄）" : "") : "") +
    (edited ? "，個別修改過的 " + edited + " 位沒動" : "") +
    (kept ? "，已寄過但新名單裡沒有的 " + kept + " 位留在最後面" : "") + "。", "good");
}

async function importFile(file, merge) {
  if (!file) return;
  try {
    const table = await readFile(file);
    if (merge) mergeTable(table); else setTable(table, file.name);
  } catch (e) { showMsg("listMsg", e.message, "bad"); }
}

async function importSheet(url, merge) {
  if (!parseSheetUrl(url)) return showMsg("listMsg", "這不像 Google 試算表的網址。請從試算表的網址列整段複製。", "bad");
  showMsg("listMsg", "讀取中…");
  try {
    const table = await readGoogleSheet(url, gfetch);
    if (merge) mergeTable(table); else setTable(table, "Google 試算表");
    state.sheetUrl = url; store.save();
  } catch (e) { showMsg("listMsg", e.message, "bad"); }
}

// ---------- 畫面 ----------

function showMsg(id, text, kind = "") {
  const el = $(id);
  el.textContent = text;
  el.className = "msg " + kind;
  el.hidden = !text;
}

function render() {
  const has = state.rows.length > 0;
  $("importBox").hidden = has;
  $("listBox").hidden = !has;
  $("previewEmpty").hidden = has;
  $("previewBox").hidden = !has;
  renderChips();
  if (!has) return;

  for (const [id, key] of [["mapTitle", "title"], ["mapName", "name"], ["mapEmail", "email"]]) {
    $(id).innerHTML = '<option value="-1">（沒有）</option>' + state.headers.map((h, i) => '<option value="' + i + '">' + esc(h) + "</option>").join("");
    $(id).value = state.map[key];
  }
  const unsure = Object.values(state.map).some((i) => i < 0);
  $("mapping").hidden = !(showMap || unsure);
  $("fixCols").hidden = showMap || unsure;
  renderRules(false);
  renderPeople();
  renderPreview();
}

// 稱謂自動轉換：列表下方一行摘要，按「修改」展開規則
function renderRules(rebuild) {
  const rules = state.rules;
  const n = state.rows.filter((row) => raw(row, "title") && col(row, "title") !== raw(row, "title")).length;
  const text = rules.filter((r) => splitFrom(r.from).length && r.to.trim()).map((r) => splitFrom(r.from).join("、") + " → " + r.to.trim()).join("；");
  $("rulesSummary").textContent = "稱謂自動轉換：" + (text || "（沒有）") + (n ? "　名單裡 " + n + " 位會轉換" : "");
  if (!rebuild) return;
  $("ruleRows").innerHTML = rules.map((r, i) =>
    '<div class="rule" data-i="' + i + '"><input type="text" class="rFrom" placeholder="名單裡的稱謂，例如 教授、副教授" value="' + esc(r.from) + '">' +
    '<span>改成</span><input type="text" class="rTo" placeholder="例如 老師" value="' + esc(r.to) + '">' +
    '<button type="button" class="rdel" title="刪除這條">×</button></div>').join("");
}

function renderPeople() {
  const can = state.rows.map((r, i) => i).filter((i) => validRow(state.rows[i]) && state.status[i] !== "ok");
  const allOn = can.length > 0 && can.every((i) => !state.off[i]);
  const lock = sending ? " disabled" : "";
  const bad = state.rows.filter((r) => !validRow(r)).length;
  const sent = Object.values(state.status).filter((v) => v === "ok").length;
  $("listSummary").textContent = state.source + "　已勾選 " + pending().length + " 位" +
    (sent ? "，已寄 " + sent + " 位" : "") + (bad ? "（" + bad + " 列 Email 有問題，不會寄）" : "");

  const sortName = { st: "寄送狀態", title: "稱謂", name: "姓名", email: "Email" }[state.sort?.key];
  $("sortNote").hidden = !sortName;
  $("sortText").textContent = sortName ? "目前照「" + sortName + "」排序 " + (state.sort.dir > 0 ? "▲" : "▼") : "";
  const head = '<thead><tr><th class="st" data-sort="st" title="點箭頭照寄送狀態排序：要寄的在前、已寄的在後；再點一下反過來，第三下回到原本順序"><input type="checkbox" id="checkAll" title="全選／全不選"' +
    (allOn ? " checked" : "") + (can.length ? lock : " disabled") + '><span class="arrow' + (state.sort?.key === "st" ? "" : " idle") + '">' +
    (state.sort?.key === "st" ? (state.sort.dir > 0 ? "▲" : "▼") : "⇅") + "</span></th>" +
    [["title", "稱謂"], ["name", "姓名"], ["email", "Email"]].map(([k, t]) => '<th data-sort="' + k + '" title="點一下照「' + t + '」排序，再點一下反過來，第三下回到原本順序">' + t +
      (state.sort?.key === k ? '<span class="arrow">' + (state.sort.dir > 0 ? "▲" : "▼") + "</span>" : "") + "</th>").join("") + "<th></th></tr></thead>";
  $("people").innerHTML = head + "<tbody>" + order().map((i) => {
    const row = state.rows[i];
    const st = state.status[i];
    const ok = validRow(row);
    const mark = st === "ok" ? '<td class="st ok" title="已寄出。想再寄一次，點這一位後看右邊">✓</td>'
      : st === "sending" ? '<td class="st">…</td>'
      : '<td class="st"><input type="checkbox" class="pick"' + (ok && !state.off[i] ? " checked" : "") + (ok ? lock : " disabled") + "></td>";
    const err = st && st !== "ok" && st !== "sending" ? '<span class="err" title="' + esc(st) + '">✗</span>' : "";
    return '<tr data-i="' + i + '" class="' + (i === current ? "current " : "") + (ok ? "" : "bad") + '">' + mark +
      "<td>" + esc(col(row, "title")) + (col(row, "title") !== raw(row, "title") ? '<span class="raw" title="名單原本寫的">' + esc(raw(row, "title")) + "</span>" : "") + "</td><td>" + esc(col(row, "name")) + "</td><td>" + esc(col(row, "email") || "（沒有 Email）") + "</td>" +
      '<td class="act">' + (state.custom[i] ? '<span class="edited" title="這一位的信個別修改過">✎</span>' : "") +
      (state.prev[i] && st !== "ok" ? '<span class="edited" title="之前寄過，這次會再寄一次">↻</span>' : "") + err + '<button type="button" class="del" title="從列表刪除"' + lock + ">×</button></td></tr>";
  }).join("") + "</tbody>";
}

// 改某一位的收件 Email（不會動到原本的 Excel）。記住名單上原本寫的，更新名單時才認得出是同一位
function setEmail(i, v) {
  const row = state.rows[i], at = state.map.email;
  if (!row || at < 0) return;
  const was = String(row[at] || "").trim();
  if (state.alias[i] === undefined && was && was.toLowerCase() !== v.toLowerCase()) state.alias[i] = was;
  row[at] = v;
  if (state.alias[i] !== undefined && state.alias[i].toLowerCase() === v.toLowerCase()) delete state.alias[i];
}

// 從列表刪掉一位（不會動到原本的 Excel）
function removeRow(i) {
  state.rows.splice(i, 1);
  for (const key of ["status", "off", "custom", "sentAt", "alias", "prev"]) {
    const next = {};
    for (const k in state[key]) {
      if (+k < i) next[k] = state[key][k];
      else if (+k > i) next[k - 1] = state[key][k];
    }
    state[key] = next;
  }
  if (current > i || current >= state.rows.length) current = Math.max(0, current - 1);
  store.save();
  render();
}

function renderChips() {
  const keys = ["稱謂", "姓名"];
  const mapped = new Set(Object.values(state.map));
  state.headers.forEach((h, i) => { if (!mapped.has(i) && !keys.includes(h)) keys.push(h); });
  $("chips").innerHTML = keys.map((k) => '<button type="button" class="chip" data-key="' + esc(k) + '">' + esc(k) + "</button>").join("");
}

// 列表顯示的順序（列號）：點欄位標題排序；預覽翻頁、寄出都照這個順序
const collator = new Intl.Collator("zh-Hant", { numeric: true, sensitivity: "base" });
function order() {
  const idx = state.rows.map((row, i) => i), s = state.sort;
  if (!s) return idx;
  if (s.key === "st") return idx.sort((a, b) => (stRank(a) - stRank(b)) * s.dir || a - b);
  return idx.sort((a, b) => collator.compare(col(state.rows[a], s.key), col(state.rows[b], s.key)) * s.dir || a - b);
}

// 寄送狀態排序用：沒寄成功 → 打勾要寄 → 沒打勾 → 已寄出 → Email 有問題
function stRank(i) {
  const st = state.status[i];
  if (!validRow(state.rows[i])) return 4;
  if (st === "ok") return 3;
  if (st && st !== "sending") return 0;
  return state.off[i] ? 2 : 1;
}

// 要寄的信（打勾、還沒寄、Email 沒問題），照列表順序
function pending() {
  return order().filter((i) => validRow(state.rows[i]) && state.status[i] !== "ok" && !state.off[i]);
}
function firstCurrent() {
  return pending()[0] ?? Math.max(0, state.rows.findIndex(validRow));
}

function renderPreview() {
  if (!state.rows.length) return;
  const row = state.rows[current] || state.rows[0];
  const todo = pending(), at = todo.indexOf(current);
  $("navLabel").textContent = at >= 0 ? "第 " + (at + 1) + " 封，共 " + todo.length + " 封"
    : (state.status[current] === "ok" ? "已寄出" : "沒有勾選") + (todo.length ? "　要寄的共 " + todo.length + " 封" : "");
  const name = col(row, "name"), email = col(row, "email");
  const sender = (state.sender || "").trim();
  $("pvFromRow").hidden = !sender;
  $("pvFrom").textContent = sender + (myEmail ? " <" + myEmail + ">" : "");
  const reply = (state.replyTo || "").trim();
  $("pvReplyRow").hidden = !reply;
  $("pvReply").textContent = reply;
  const editable = !sending && state.status[current] !== "ok";
  const pe = $("pvEmail");
  $("pvName").textContent = name ? name + " " : "";
  if (document.activeElement !== pe) pe.textContent = email; // 正在打字時不要蓋掉
  pe.contentEditable = editable && state.map.email >= 0 ? "plaintext-only" : "false";
  pe.classList.toggle("wrong", !validRow(row));
  const mine = state.custom[current];
  if (mine) { $("pvSubject").textContent = mine.subject; $("pvBody").innerHTML = mine.html; }
  else { $("pvSubject").innerHTML = fill(esc(state.subject), row, true); $("pvBody").innerHTML = fill(state.body, row, true); }
  $("pvReceipt").innerHTML = state.receipt ? receiptHtml(current) : "";
  $("pvSubject").contentEditable = editable ? "plaintext-only" : "false";
  $("pvBody").contentEditable = editable ? "true" : "false";
  $("customNote").hidden = !mine;
  // 已寄的人：可以再寄一次（順便改 Email）；按了之後可以反悔
  const done1 = state.status[current] === "ok", before = state.prev[current];
  $("sentNote").hidden = !(done1 || before);
  $("sentNote").classList.toggle("again", !done1);
  $("sentText").textContent = done1 ? "✓ 已" + (state.sentAt[current] ? "在 " + clock(state.sentAt[current]) + " " : "") + "寄出。信被退回或想再寄？"
    : before ? "↻ 這一位" + (before.at ? " " + clock(before.at) + " " : "") + "寄過（" + before.email + "），這次會再寄一次。" : "";
  $("resend").textContent = done1 ? "再寄一次（可改 Email）" : "不重寄了";
  $("resend").hidden = sending;
  $("editHint").hidden = !!mine || !editable || !!before;
  $("pvAttach").textContent = attachments.length ? "📎 " + attachments.map((a) => a.name).join("、") : "";

  $("warnings").innerHTML = problems().map((p) => "<li>" + esc(p) + "</li>").join("");

  const left = pending().length;
  const done = Object.values(state.status).filter((s) => s === "ok").length;
  const btn = $("sendBtn");
  btn.classList.toggle("stop", sending);
  if (sending) { btn.textContent = "停止"; btn.disabled = false; }
  else if (!left && done && !state.rows.some((r, i) => validRow(r) && state.status[i] !== "ok")) { btn.textContent = "全部寄完了"; btn.disabled = true; }
  else if (!left) { btn.textContent = "請先勾選要寄的人"; btn.disabled = true; }
  else { btn.textContent = "寄出勾選的 " + left + " 封"; btn.disabled = false; }
  $("testBtn").disabled = sending;
}

// 寄出前該知道的問題
function problems() {
  const list = [];
  const keys = usedKeys();
  const rows = pending().map((i) => state.rows[i]);
  if (state.map.email < 0) list.push("還不知道哪一欄是 Email，請在名單上方選一下。");
  const again = pending().filter((i) => state.prev[i]).length;
  if (again) list.push("有 " + again + " 位之前寄過，這次會再寄一次。");
  for (const k of keys) {
    if (lookup(state.rows[0], k) === undefined) list.push("名單裡沒有「" + k + "」這個欄位，信裡會原樣顯示 {{" + k + "}}。");
    else {
      const n = rows.filter((r) => !lookup(r, k)).length;
      if (n) list.push("有 " + n + " 位的「" + k + "」是空白的。");
    }
  }
  return list;
}

// ---------- 寄信 ----------

async function sendOne(i, toSelf) {
  const row = state.rows[i];
  const sender = (state.sender || "").trim();
  if ((sender || state.receipt) && !myEmail) await connect(); // 換顯示名稱、收信確認都要知道寄件信箱
  const mime = buildMime({
    fromName: sender,
    fromEmail: myEmail,
    replyTo: (state.replyTo || "").trim(),
    toName: toSelf ? "" : col(row, "name"),
    toEmail: toSelf || col(row, "email"),
    subject: (toSelf ? "【測試】" : "") + subjectFor(i),
    receiptTo: state.receipt ? (state.replyTo || "").trim() || myEmail : "",
    html: mailHtml(i),
    attachments,
  });
  await gfetch("https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=media", {
    method: "POST", headers: { "Content-Type": "message/rfc822" }, body: mime,
  });
}

function ready() {
  const reply = (state.replyTo || "").trim();
  if (reply && !EMAIL_RE.test(reply)) { showMsg("sendMsg", "回覆信箱的格式不對，請檢查一下。", "bad"); $("replyTo").focus(); return false; }
  if (!state.subject.trim()) { showMsg("sendMsg", "還沒寫主旨。", "bad"); $("subject").focus(); return false; }
  if (!$("body").textContent.trim()) { showMsg("sendMsg", "信件內容還是空的。", "bad"); $("body").focus(); return false; }
  return true;
}

async function sendTest() {
  if (!ready()) return;
  $("testBtn").disabled = true;
  showMsg("sendMsg", "寄送測試信中…");
  try {
    if (!myEmail) await connect();
    await sendOne(current, myEmail);
    showMsg("sendMsg", "測試信已寄到 " + myEmail + "（內容是目前預覽的這一位）。", "good");
  } catch (e) { showMsg("sendMsg", e.message, "bad"); }
  $("testBtn").disabled = false;
}

function askConfirm(count) {
  $("confirmTitle").textContent = "確定寄給 " + count + " 位嗎？";
  $("confirmText").innerHTML = "<p>每個人會各自收到一封專屬的信，看不到其他收件人。寄出後無法收回。</p>" +
    problems().map((p) => '<p class="warn">⚠ ' + esc(p) + "</p>").join("");
  const dlg = $("confirm");
  dlg.showModal();
  return new Promise((resolve) => {
    $("confirmYes").onclick = () => { dlg.close(); resolve(true); };
    $("confirmNo").onclick = () => { dlg.close(); resolve(false); };
    dlg.oncancel = () => resolve(false);
  });
}

async function sendAll() {
  if (sending) { stopFlag = true; return; }
  if (!ready()) return;
  const todo = pending();
  if (!todo.length || !(await askConfirm(todo.length))) return;

  sending = true; stopFlag = false;
  $("progress").hidden = false;
  let sent = 0, failed = 0, streak = 0, halt = "";
  for (const i of todo) {
    if (stopFlag) break;
    current = i;
    state.status[i] = "sending";
    renderPeople(); renderPreview();
    document.querySelector("tr.current")?.scrollIntoView({ block: "nearest" });
    showMsg("sendMsg", "寄送中 " + (sent + failed + 1) + " / " + todo.length + "…");
    try {
      await sendOne(i);
      state.status[i] = "ok"; state.sentAt[i] = Date.now(); sent++; streak = 0;
    } catch (e) {
      state.status[i] = e.message; failed++; streak++;
      // 授權或額度問題，再試也沒用，先停下來
      if (e.status === 429 || !e.status || streak >= 3) { halt = e.message; }
    }
    store.save();
    $("bar").style.width = ((sent + failed) / todo.length) * 100 + "%";
    if (halt) break;
    await sleep(800);
  }
  sending = false;
  renderPeople(); renderPreview();
  const rest = pending().length;
  if (halt) showMsg("sendMsg", "已寄出 " + sent + " 封後停下來：" + halt, "bad");
  else if (failed) showMsg("sendMsg", "寄出 " + sent + " 封，" + failed + " 封失敗（名單上打 ✗ 的，滑鼠移上去可看原因）。", "bad");
  else if (rest) showMsg("sendMsg", "已停止。寄出 " + sent + " 封，還有 " + rest + " 封沒寄。", "");
  else showMsg("sendMsg", "全部寄完了，共 " + sent + " 封。", "good");
}

// ---------- 事件 ----------

function insertKey(key) {
  const text = "{{" + key + "}}";
  const subject = $("subject");
  if (document.activeElement === subject) {
    subject.setRangeText(text, subject.selectionStart, subject.selectionEnd, "end");
    subject.dispatchEvent(new Event("input"));
    return;
  }
  const body = $("body");
  if (document.activeElement !== body) {
    body.focus();
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    const sel = getSelection();
    sel.removeAllRanges(); sel.addRange(range);
  }
  document.execCommand("insertText", false, text);
}

// ---------- 排版工具列 ----------
// 字型、大小、顏色：有選取就改選取的，沒選取就整封一起改（貼進來的內容才會和稱謂姓名一致）

function bodySelection(whole) {
  const body = $("body");
  const sel = getSelection();
  const inside = sel.rangeCount && body.contains(sel.getRangeAt(0).commonAncestorContainer);
  if (inside && !(whole && sel.isCollapsed)) { body.focus(); return; }
  body.focus();
  const range = document.createRange();
  range.selectNodeContents(body);
  if (!whole) range.collapse(false);
  sel.removeAllRanges(); sel.addRange(range);
}

// execCommand 會產生 <font>，換成 <span style>，Gmail／Outlook 都看得懂
function tidyFonts(px) {
  for (const f of $("body").querySelectorAll("font")) {
    const s = document.createElement("span");
    if (f.getAttribute("face")) s.style.fontFamily = f.getAttribute("face");
    if (f.getAttribute("color")) s.style.color = f.getAttribute("color");
    if (f.getAttribute("size") === "7" && px) s.style.fontSize = px + "px";
    s.innerHTML = f.innerHTML;
    f.replaceWith(s);
  }
}

function format(cmd, value) {
  const whole = cmd === "fontName" || cmd === "fontSize" || cmd === "foreColor" || cmd === "removeFormat";
  bodySelection(whole);
  if (!$("body").textContent.trim()) return;
  if (cmd === "fontSize") { document.execCommand("fontSize", false, "7"); tidyFonts(value); }
  else if (cmd === "removeFormat") {
    document.execCommand("removeFormat");
    // 清掉貼進來的整段樣式（Word、網頁常帶 style），只留段落
    for (const el of $("body").querySelectorAll("[style], font")) { el.removeAttribute("style"); if (el.tagName === "FONT") { const s = document.createElement("span"); s.innerHTML = el.innerHTML; el.replaceWith(s); } }
    for (const el of $("body").querySelectorAll("[class], [align], [bgcolor]")) { el.removeAttribute("class"); el.removeAttribute("align"); el.removeAttribute("bgcolor"); }
  } else { document.execCommand(cmd, false, value); tidyFonts(); }
  $("body").dispatchEvent(new Event("input"));
}

function bindFormat() {
  $("fmt").addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); }); // 按按鈕不要讓編輯區失焦
  $("fmt").addEventListener("click", (e) => { const b = e.target.closest("button[data-cmd]"); if (b) format(b.dataset.cmd); });
  $("fmtClear").onclick = () => format("removeFormat");
  $("fmtFont").onchange = (e) => { if (e.target.value) format("fontName", e.target.value); e.target.value = ""; };
  $("fmtSize").onchange = (e) => { if (e.target.value) format("fontSize", e.target.value); e.target.value = ""; };
  $("fmtColor").oninput = (e) => format("foreColor", e.target.value);
}

function bind() {
  bindFormat();
  const drop = $("drop");
  $("file").onchange = (e) => { importFile(e.target.files[0]); e.target.value = ""; };
  for (const ev of ["dragenter", "dragover"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const ev of ["dragleave", "drop"]) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  drop.addEventListener("drop", (e) => importFile(e.dataTransfer.files[0]));
  // 拖到頁面其他地方時，不要讓瀏覽器直接開啟檔案
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", (e) => e.preventDefault());

  const url = $("sheetUrl");
  url.addEventListener("paste", () => setTimeout(() => importSheet(url.value.trim())));
  url.addEventListener("keydown", (e) => { if (e.key === "Enter") importSheet(url.value.trim()); });

  $("fixCols").onclick = () => { showMap = true; render(); };
  // 名單有新人：試算表直接重讀；Excel 檔請再選一次檔案
  $("refreshList").onclick = () => {
    if (sending) return;
    if (state.sheetUrl) importSheet(state.sheetUrl, true);
    else { showMsg("listMsg", "請再選一次更新過的 Excel 檔。寄過的、打勾的、個別修改過的都會保留，只會加進新人。"); $("fileMerge").click(); }
  };
  $("fileMerge").onchange = (e) => { importFile(e.target.files[0], true); e.target.value = ""; };
  $("changeList").onclick = () => {
    if (sending) return;
    showMap = false;
    Object.assign(state, { source: "", headers: [], rows: [], map: { title: -1, name: -1, email: -1 }, sheetUrl: "", status: {}, off: {}, custom: {}, sentAt: {}, alias: {}, prev: {} });
    url.value = "";
    showMsg("sendMsg", ""); $("progress").hidden = true; $("bar").style.width = 0;
    store.save(); render();
  };

  for (const [id, key] of [["mapTitle", "title"], ["mapName", "name"], ["mapEmail", "email"]]) {
    $(id).onchange = (e) => { state.map[key] = +e.target.value; store.save(); render(); };
  }

  // 稱謂自動轉換
  const rulesChanged = (rebuild) => { store.save(); renderRules(rebuild); renderPeople(); renderPreview(); };
  const addRule = () => {
    state.rules.push({ from: "", to: "" });
    rulesChanged(true);
    $("ruleRows").querySelector(".rule:last-child .rFrom").focus();
  };
  $("editRules").onclick = () => {
    const open = $("rules").hidden;
    $("rules").hidden = !open;
    $("editRules").textContent = open ? "收起" : "修改";
    if (open) { renderRules(true); if (!state.rules.length) addRule(); }
  };
  $("addRule").onclick = addRule;
  $("ruleRows").addEventListener("input", (e) => {
    const d = e.target.closest(".rule");
    if (!d || sending) return;
    state.rules[+d.dataset.i][e.target.classList.contains("rFrom") ? "from" : "to"] = e.target.value;
    rulesChanged(false);
  });
  $("ruleRows").addEventListener("click", (e) => {
    const d = e.target.closest(".rule");
    if (!d || !e.target.closest(".rdel") || sending) return;
    state.rules.splice(+d.dataset.i, 1);
    rulesChanged(true);
  });

  $("people").onclick = (e) => {
    if (sending) return;
    if (e.target.id === "checkAll") {
      state.rows.forEach((row, i) => {
        if (!validRow(row) || state.status[i] === "ok") return;
        if (e.target.checked) delete state.off[i]; else state.off[i] = 1;
      });
      store.save(); renderPeople(); renderPreview();
      return;
    }
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const k = th.dataset.sort, s = state.sort;
      state.sort = !s || s.key !== k ? { key: k, dir: 1 } : s.dir > 0 ? { key: k, dir: -1 } : null;
      store.save(); renderPeople(); renderPreview();
      return;
    }
    const tr = e.target.closest("tr[data-i]");
    if (!tr) return;
    const i = +tr.dataset.i;
    if (e.target.closest(".del")) return removeRow(i);
    if (e.target.classList.contains("pick")) {
      if (e.target.checked) delete state.off[i]; else state.off[i] = 1;
      store.save();
    } else current = i;
    renderPeople(); renderPreview();
  };
  $("sortReset").onclick = () => {
    if (sending) return;
    state.sort = null;
    store.save(); renderPeople(); renderPreview();
    document.querySelector("tr.current")?.scrollIntoView({ block: "nearest" });
  };
  const step = (d) => {
    if (sending) return;
    // 只翻打勾要寄的信，照列表順序；都沒打勾時才翻全部
    const todo = pending(), list = todo.length ? todo : order(), at = list.indexOf(current);
    if (at >= 0) current = list[(at + d + list.length) % list.length];
    else { // 現在看的不是要寄的（已寄或沒勾）：跳到列表上離它最近的下一封／上一封
      const ord = order(), pos = ord.indexOf(current);
      const after = list.filter((i) => ord.indexOf(i) > pos), before = list.filter((i) => ord.indexOf(i) < pos);
      current = d > 0 ? after[0] ?? list[0] : before[before.length - 1] ?? list[list.length - 1];
    }
    renderPeople(); renderPreview();
    document.querySelector("tr.current")?.scrollIntoView({ block: "nearest" });
  };
  $("prev").onclick = () => step(-1);
  $("next").onclick = () => step(1);

  $("sender").oninput = (e) => { state.sender = e.target.value; store.save(); renderPreview(); };
  $("replyTo").oninput = (e) => { state.replyTo = e.target.value; store.save(); renderPreview(); };
  $("receipt").onchange = (e) => { state.receipt = e.target.checked; store.save(); renderPreview(); };
  document.querySelector(".mailBody").addEventListener("click", (e) => { if (e.target.closest("a")) e.preventDefault(); }); // 預覽裡的連結不要真的打開
  // 直接在預覽上改：只存成這一位的版本，自動儲存
  const saveCustom = () => {
    const first = !state.custom[current];
    state.custom[current] = { subject: $("pvSubject").textContent.replace(/\s*\n\s*/g, " ").trim(), html: $("pvBody").innerHTML.replace(/<\/?mark>/g, "") };
    store.save();
    if (first) { $("customNote").hidden = false; $("editHint").hidden = true; renderPeople(); }
  };
  $("pvSubject").addEventListener("input", saveCustom);
  $("pvBody").addEventListener("input", saveCustom);
  $("pvSubject").addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
  $("restore").onclick = () => { delete state.custom[current]; store.save(); renderPeople(); renderPreview(); };
  // 直接在預覽上改這一位的收件 Email（例如信被退回，換一個信箱）
  const pe = $("pvEmail");
  pe.addEventListener("input", () => {
    if (sending || state.status[current] === "ok") return;
    const t = pe.textContent;
    setEmail(current, (t.match(/<([^<>]+)>/)?.[1] || t).replace(/^mailto:/i, "").replace(/\s+/g, "")); // 貼「姓名 <信箱>」也認得
    if (!pe.textContent.trim()) pe.textContent = "";
    store.save(); renderPeople(); renderPreview();
  });
  pe.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pe.blur(); } });
  pe.addEventListener("blur", renderPreview);
  // 已寄的人再寄一次：變回沒寄、打勾，Email 可以改；反悔就按「不重寄了」，回到上次寄出的樣子
  $("resend").onclick = () => {
    if (sending) return;
    const i = current, before = state.prev[i];
    if (state.status[i] === "ok") {
      state.prev[i] = { email: col(state.rows[i], "email"), at: state.sentAt[i] || 0 };
      delete state.status[i]; delete state.sentAt[i]; delete state.off[i];
    } else if (before) {
      setEmail(i, before.email);
      state.status[i] = "ok";
      if (before.at) state.sentAt[i] = before.at;
      delete state.prev[i];
    } else return;
    store.save(); renderPeople(); renderPreview();
    if (state.status[i] !== "ok" && pe.isContentEditable) { pe.focus(); getSelection().selectAllChildren(pe); }
  };
  $("subject").oninput = (e) => { state.subject = e.target.value; store.save(); renderPreview(); };
  $("body").oninput = () => { state.body = $("body").innerHTML; store.save(); renderPreview(); };
  $("chips").addEventListener("mousedown", (e) => e.preventDefault()); // 點按鈕時游標留在原處
  $("chips").onclick = (e) => { const c = e.target.closest(".chip"); if (c) insertKey(c.dataset.key); };

  $("attachInput").onchange = async (e) => {
    for (const f of e.target.files) attachments.push(await fileToAttachment(f));
    e.target.value = "";
    while (attachments.reduce((n, a) => n + a.size, 0) > MAX_ATTACH) {
      attachments.pop();
      showMsg("sendMsg", "附件加起來不能超過 20 MB，太大的沒有加入。", "bad");
    }
    renderAttach();
  };
  $("attachList").onclick = (e) => {
    const b = e.target.closest("button");
    if (b) { attachments.splice(+b.dataset.i, 1); renderAttach(); }
  };

  $("testBtn").onclick = sendTest;
  if (ext) {
    $("account").onclick = openSetup;
    $("connectBtn").onclick = saveSetup;
    $("clientId").addEventListener("keydown", (e) => { if (e.key === "Enter") saveSetup(); });
    $("copyRedirect").onclick = async () => {
      await navigator.clipboard.writeText($("redirect").textContent);
      $("copyRedirect").textContent = "已複製";
      setTimeout(() => ($("copyRedirect").textContent = "複製"), 1500);
    };
  }
  $("sendBtn").onclick = sendAll;
  addEventListener("beforeunload", (e) => { if (sending) e.preventDefault(); });
}

function renderAttach() {
  $("attachList").innerHTML = attachments.map((a, i) =>
    '<span class="file">' + esc(a.name) + '<button type="button" data-i="' + i + '" aria-label="移除">×</button></span>').join("");
  renderPreview();
}

// ---------- 案件：結案、開始新案件、回查過去寄過的信 ----------

let cases = []; // 收在案件紀錄裡的案件（暫存中或已結案），新的在前面；畫面上正在用的那一案不在裡面
let openCase = null; // 案件紀錄裡正在看的那一案
let casePerson = 0;
let picked = new Set(); // 案件紀錄列表裡勾選的案件（批次刪除用）
let editing = null; // 正在改名字／日期的案件
let toDelete = []; // 等使用者確認刪除的案件

const caseStore = {
  async load() {
    if (ext) return (await chrome.storage.local.get("vipCases")).vipCases || [];
    try { return JSON.parse(localStorage.getItem("vipCases")) || []; } catch { return []; }
  },
  save() {
    if (ext) chrome.storage.local.set({ vipCases: cases });
    else localStorage.setItem("vipCases", JSON.stringify(cases));
  },
};

const meet = (c) => (c.date || "").replace(/-/g, "/"); // 會議日期 2026/11/20
const sentCount = (c) => Object.values(c.status).filter((v) => v === "ok").length;
const day = (t) => { const d = new Date(t); return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate(); };
const clock = (t) => { const d = new Date(t); return day(t) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };

const CASE_KEYS = ["source", "sheetUrl", "headers", "rows", "map", "sender", "replyTo", "subject", "body", "receipt", "status", "off", "custom", "sentAt", "alias", "prev", "rules"];
const autoName = () => (state.subject.replace(TOKEN, "").replace(/\s+/g, " ").trim() || state.source || "未命名案件").slice(0, 60);

// 把畫面上這一案打包成案件紀錄的一筆（closed：結案；否則是暫存，之後可以打開繼續寄）
function snapshot(closed, name, date) {
  const c = { id: state.caseId || Date.now(), name: name || state.caseName || autoName(), date: date ?? state.caseDate ?? "", closedAt: closed ? Date.now() : null, files: attachments.map((a) => a.name), attach: attachments };
  for (const k of CASE_KEYS) c[k] = JSON.parse(JSON.stringify(state[k]));
  return c;
}

function loadForm() {
  $("subject").value = state.subject; $("body").innerHTML = state.body;
  $("sender").value = state.sender || ""; $("replyTo").value = state.replyTo || ""; $("receipt").checked = !!state.receipt;
  $("sheetUrl").value = "";
  showMsg("sendMsg", ""); $("progress").hidden = true; $("bar").style.width = 0;
}

// 新案件：名單和信清空，寄件人名稱、回覆信箱、稱謂轉換沿用
function resetCase() {
  Object.assign(state, { source: "", headers: [], rows: [], map: { title: -1, name: -1, email: -1 }, sheetUrl: "", subject: "", body: DEFAULT_BODY, status: {}, off: {}, custom: {}, sentAt: {}, alias: {}, prev: {}, caseId: null, caseName: "", caseDate: "" });
  attachments = []; current = 0; showMap = false;
  loadForm();
}

function askClose() {
  if (sending || !state.rows.length) return;
  const sent = sentCount(state), left = pending().length;
  $("closeText").innerHTML = "<p>這個案件會收進「案件紀錄」，畫面清空，準備下一個案件。還要再寄的選「暫存」，之後從案件紀錄打開就能接著寄；寄完了選「結案」。</p>" +
    "<p>已寄出 " + sent + " 位" + (left ? '，<span class="warn">還有 ' + left + " 位打勾但沒寄</span>" : "") + "。</p>";
  $("caseName").value = state.caseName || autoName();
  $("caseDate").value = state.caseDate || "";
  $("closeDlg").showModal();
  $("caseName").select();
}

function putAway(closed) {
  const c = snapshot(closed, $("caseName").value.trim(), $("caseDate").value);
  cases = cases.filter((x) => x.id !== c.id);
  cases.unshift(c);
  caseStore.save();
  resetCase();
  $("closeDlg").close();
  renderAttach(); store.save(); render();
  showMsg("listMsg", closed ? "「" + c.name + "」已結案，收進案件紀錄了。可以開始新案件。"
    : "「" + c.name + "」先暫存在案件紀錄，隨時可以打開接著寄。可以開始新案件。", "good");
}

// 從案件紀錄打開一案（已結案的也行，打開後可以繼續寄給還沒寄的人）；畫面上原本那一案先自動暫存
function openCaseNow(c) {
  if (sending) return;
  if (state.rows.length) {
    const cur = snapshot(false, "");
    cases = cases.filter((x) => x.id !== cur.id);
    cases.unshift(cur);
  }
  cases = cases.filter((x) => x !== c);
  caseStore.save();
  for (const k of CASE_KEYS) if (k !== "rules" && k in c) state[k] = c[k];
  state.alias = c.alias || {}; state.prev = c.prev || {}; // 舊版存的案件沒有這兩項
  state.caseId = c.id; state.caseName = c.name; state.caseDate = c.date || "";
  attachments = c.attach || []; current = firstCurrent(); showMap = false;
  loadForm();
  openCase = null; $("cases").close();
  renderAttach(); store.save(); render();
  showMsg("listMsg", "已打開「" + c.name + "」" + (c.closedAt ? "，原本已結案，現在可以接著寄給還沒寄的人" : "") + "。", "good");
}

function showCases() {
  openCase = null;
  $("caseSearch").value = "";
  renderCases();
  $("cases").showModal();
}

function renderCases() {
  const detail = !!openCase;
  $("caseList").hidden = detail;
  $("caseDetail").hidden = !detail;
  $("caseSearch").hidden = detail;
  if (detail) return renderCaseDetail();
  const q = $("caseSearch").value.trim().toLowerCase();
  const hit = cases.filter((c) => !q || c.name.toLowerCase().includes(q) || meet(c).includes(q) || c.rows.some((r) => r.some((cell) => cell.toLowerCase().includes(q))));
  const now = state.rows.length ? '<p class="nowCase">目前畫面上：' + esc(state.caseName || autoName()) + "</p>" : "";
  hit.sort((a, b) => (b.closedAt ? 0 : 1) - (a.closedAt ? 0 : 1)); // 暫存中的排前面
  for (const id of picked) if (!cases.some((c) => c.id === id)) picked.delete(id);
  $("caseTools").hidden = !cases.length;
  $("caseAll").checked = hit.length > 0 && hit.every((c) => picked.has(c.id));
  $("caseAll").disabled = !hit.length;
  $("caseDelSel").hidden = !picked.size;
  $("caseDelSel").textContent = "刪除勾選的 " + picked.size + " 個";
  $("caseList").innerHTML = now + (!cases.length
    ? '<p class="empty">還沒有收起來的案件。<br>按寄出按鈕下面的「✓ 暫存／結案，開新案件」，這一案就會收到這裡。</p>'
    : !hit.length ? '<p class="empty">找不到符合的案件。</p>'
    : hit.map((c) => '<div class="caseItem' + (c.closedAt ? "" : " live") + '" data-id="' + c.id + '">' +
        '<input type="checkbox" class="cpick"' + (picked.has(c.id) ? " checked" : "") + '>' +
        '<button type="button" class="caseMain"><b>' + (c.date ? '<i class="date">📅 ' + meet(c) + "</i>" : "") + esc(c.name) + "</b><span>" +
        (c.closedAt ? day(c.closedAt) + " 結案" : '<i class="live">暫存中</i>') + "　寄出 " + sentCount(c) + "／" + c.rows.length + " 位</span></button>" +
        '<span class="caseAct"><button type="button" class="link" data-act="edit" title="改名字或日期">✎</button><button type="button" class="del" data-act="del" title="刪除">×</button></span></div>').join(""));
}

function askDeleteCases(list) {
  toDelete = list;
  $("caseDelText").innerHTML = (list.length === 1 ? "<p>要刪除「" + esc(list[0].name) + "」嗎？</p>" : "<p>要刪除這 " + list.length + " 個案件嗎？</p>" +
    "<p>" + list.map((c) => esc(c.name)).join("、") + "</p>") + '<p class="warn">刪了就救不回來，裡面寄過誰的紀錄也會一起消失。</p>';
  $("caseDelDlg").showModal();
}

function renderCaseDetail() {
  const c = openCase;
  $("caseOpen").textContent = c.closedAt ? "重新打開，接著寄" : "打開這個案件";
  $("caseTitle").innerHTML = "<b>" + esc(c.name) + "</b><span>" + (c.date ? "📅 會議 " + meet(c) + "　" : "") + (c.closedAt ? day(c.closedAt) + " 結案" : "暫存中") + "　寄出 " + sentCount(c) + "／" + c.rows.length + " 位" +
    (c.sender ? "　寄件人：" + esc(c.sender) : "") + "</span>";
  $("casePeople").innerHTML = "<thead><tr><th class=\"st\"></th><th>稱謂</th><th>姓名</th><th>Email</th><th>寄出時間</th></tr></thead><tbody>" +
    c.rows.map((row, i) => {
      const st = c.status[i];
      const mark = st === "ok" ? '<td class="st ok">✓</td>' : st ? '<td class="st err" title="' + esc(st) + '">✗</td>' : '<td class="st"></td>';
      return '<tr data-i="' + i + '" class="' + (i === casePerson ? "current" : "") + '">' + mark + "<td>" + esc(col(row, "title", c)) + "</td><td>" +
        esc(col(row, "name", c)) + "</td><td>" + esc(col(row, "email", c)) + "</td><td>" + (st === "ok" ? (c.sentAt?.[i] ? clock(c.sentAt[i]) : "已寄") : st ? "沒寄成功" : "沒寄") + "</td></tr>";
    }).join("") + "</tbody>";
  const row = c.rows[casePerson];
  if (!row) return;
  const mine = c.custom?.[casePerson];
  const st = c.status[casePerson];
  $("caseTo").textContent = (st === "ok" ? "已寄給：" : "沒有寄出：") + col(row, "name", c) + " <" + col(row, "email", c) + ">" + (mine ? "　✎ 個別修改過" : "") +
    (c.prev?.[casePerson] ? "　↻ 之前" + (c.prev[casePerson].at ? " " + clock(c.prev[casePerson].at) + " " : "") + "寄過 " + c.prev[casePerson].email : "");
  $("caseSubject").textContent = mine ? mine.subject : fill(c.subject, row, false, c);
  $("caseBody").innerHTML = mine ? mine.html : fill(c.body, row, true, c).replace(/<\/?mark>/g, "");
  $("caseAttach").textContent = (c.files?.length ? "📎 " + c.files.join("、") : "") + (c.receipt ? "　含「我已收到」按鈕" : "");
}

function bindCases() {
  $("closeCase").onclick = askClose;
  $("closeYes").onclick = () => putAway(true);
  $("stashYes").onclick = () => putAway(false);
  $("closeNo").onclick = () => $("closeDlg").close();
  $("caseName").addEventListener("keydown", (e) => { if (e.key === "Enter") putAway(true); });
  $("caseOpen").onclick = () => openCaseNow(openCase);
  $("openCases").onclick = showCases;
  $("casesClose").onclick = () => $("cases").close();
  $("caseSearch").oninput = renderCases;
  $("caseList").onclick = (e) => {
    const item = e.target.closest(".caseItem");
    if (!item) return;
    const c = cases.find((x) => x.id === +item.dataset.id);
    if (e.target.classList.contains("cpick")) { if (e.target.checked) picked.add(c.id); else picked.delete(c.id); return renderCases(); }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "del") return askDeleteCases([c]);
    if (act === "edit") {
      editing = c;
      $("caseEditName").value = c.name; $("caseEditDate").value = c.date || "";
      $("caseEditDlg").showModal(); $("caseEditName").select();
      return;
    }
    openCase = c;
    casePerson = Math.max(0, openCase.rows.findIndex((r, i) => openCase.status[i] === "ok"));
    renderCases();
  };
  $("caseAll").onchange = (e) => {
    const q = $("caseSearch").value.trim().toLowerCase();
    const hit = cases.filter((c) => !q || c.name.toLowerCase().includes(q) || meet(c).includes(q) || c.rows.some((r) => r.some((cell) => cell.toLowerCase().includes(q))));
    for (const c of hit) if (e.target.checked) picked.add(c.id); else picked.delete(c.id);
    renderCases();
  };
  $("caseDelSel").onclick = () => askDeleteCases(cases.filter((c) => picked.has(c.id)));
  $("caseDelNo").onclick = () => $("caseDelDlg").close();
  $("caseDelYes").onclick = () => {
    cases = cases.filter((c) => !toDelete.includes(c));
    for (const c of toDelete) picked.delete(c.id);
    if (toDelete.includes(openCase)) openCase = null;
    toDelete = [];
    caseStore.save();
    $("caseDelDlg").close();
    renderCases();
  };
  const saveEdit = () => {
    editing.name = $("caseEditName").value.trim() || "未命名案件";
    editing.date = $("caseEditDate").value;
    if (editing.id === state.caseId) { state.caseName = editing.name; state.caseDate = editing.date; store.save(); }
    caseStore.save();
    $("caseEditDlg").close();
    renderCases();
  };
  $("caseEditYes").onclick = saveEdit;
  $("caseEditName").addEventListener("keydown", (e) => { if (e.key === "Enter") saveEdit(); });
  $("caseEditNo").onclick = () => $("caseEditDlg").close();
  $("caseBack").onclick = () => { openCase = null; renderCases(); };
  $("casePeople").onclick = (e) => {
    const tr = e.target.closest("tr[data-i]");
    if (tr) { casePerson = +tr.dataset.i; renderCaseDetail(); }
  };
  document.querySelector("#caseBody").addEventListener("click", (e) => { if (e.target.closest("a")) e.preventDefault(); });
  $("caseReuse").onclick = () => {
    const c = openCase;
    Object.assign(state, { subject: c.subject, body: c.body, sender: c.sender || "", replyTo: c.replyTo || "", receipt: !!c.receipt, custom: {} });
    $("subject").value = state.subject; $("body").innerHTML = state.body;
    $("sender").value = state.sender; $("replyTo").value = state.replyTo; $("receipt").checked = state.receipt;
    store.save(); render();
    $("cases").close();
    showMsg("sendMsg", "已帶入「" + c.name + "」的主旨和內容，改一改就能寄。", "good");
  };
  $("caseDelete").onclick = () => askDeleteCases([openCase]);
}

// ---------- 新版本提醒（做法和小伐速記一樣：查 GitHub Release，有新版就在畫面上提醒） ----------

const UPDATE_REPO = "carminowu-gen1/picomeeting-assistant";
const UPDATE_TAG = "mail-v";
const newerThan = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

async function checkForUpdate() {
  try {
    const now = chrome.runtime.getManifest().version;
    let { vipUpdate, vipUpdateAt = 0 } = await chrome.storage.local.get(["vipUpdate", "vipUpdateAt"]);
    if (Date.now() - vipUpdateAt > 10 * 60e3) { // 最多 10 分鐘查一次
      await chrome.storage.local.set({ vipUpdateAt: Date.now() });
      const r = await fetch("https://api.github.com/repos/" + UPDATE_REPO + "/releases?per_page=30", { headers: { accept: "application/vnd.github+json" } });
      if (r.ok) {
        // GitHub 回傳的順序不一定是版號順序（1.9.0 可能排在 1.10.0 前面），所以自己挑版號最大的
        const rel = (await r.json()).filter((x) => !x.draft && String(x.tag_name).startsWith(UPDATE_TAG))
          .reduce((best, x) => (!best || newerThan(x.tag_name.slice(UPDATE_TAG.length), best.tag_name.slice(UPDATE_TAG.length)) ? x : best), null);
        const zip = rel?.assets?.find((a) => a.name.endsWith(".zip"));
        vipUpdate = rel ? { version: rel.tag_name.slice(UPDATE_TAG.length), url: zip?.browser_download_url || rel.html_url } : null;
        await chrome.storage.local.set({ vipUpdate });
      }
    }
    const has = vipUpdate && newerThan(vipUpdate.version, now);
    $("update").hidden = !has;
    if (has) { $("updVer").textContent = vipUpdate.version; $("updLink").href = vipUpdate.url; }
  } catch { /* 沒網路就下次再查 */ }
}

// ---------- 啟動 ----------

(async function init() {
  const saved = await store.load();
  if (saved) Object.assign(state, saved);
  if (!Array.isArray(state.rules)) state.rules = DEFAULT_RULES.map((r) => ({ ...r }));
  state.alias ||= {}; state.prev ||= {};
  for (const k in state.status) if (state.status[k] === "sending") delete state.status[k];
  current = firstCurrent();
  $("sender").value = state.sender || "";
  $("replyTo").value = state.replyTo || "";
  $("receipt").checked = !!state.receipt;
  $("subject").value = state.subject;
  $("body").innerHTML = state.body;
  cases = await caseStore.load();
  bind();
  bindCases();
  render();
  if (ext) {
    const cfg = await chrome.storage.local.get(["vipClientId", "vipEmail"]);
    clientId = cfg.vipClientId || "";
    myEmail = cfg.vipEmail || "";
    auth = (await chrome.storage.session?.get("vipAuth"))?.vipAuth || null;
    showAccount();
    if (!clientId) openSetup();
    checkForUpdate();
  }
})();
