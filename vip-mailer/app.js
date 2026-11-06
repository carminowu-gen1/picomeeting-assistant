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
  sender: "", replyTo: "", subject: "", body: DEFAULT_BODY,
  receipt: false,
  status: {}, // 列號 → "ok" 或錯誤訊息
  off: {}, // 列號 → 1 表示沒打勾（不寄）
  custom: {}, // 列號 → { subject, html }：在預覽裡為這一位單獨改過的版本
  sentAt: {}, // 列號 → 寄出時間
};
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

const col = (row, key, c = state) => (c.map[key] >= 0 ? row[c.map[key]] || "" : "");
const validRow = (row) => EMAIL_RE.test(col(row, "email"));

// {{稱謂}} {{姓名}} {{Email}} 走對應欄位，其他用 Excel 的欄位名稱
function lookup(row, key, c = state) {
  const fixed = { 稱謂: "title", 姓名: "name", Email: "email" }[key] || (key.toLowerCase() === "email" ? "email" : null);
  if (fixed && c.map[fixed] >= 0) return row[c.map[fixed]] || "";
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
  Object.assign(state, { headers: table.headers, rows: table.rows, map: table.map, source: table.source || source, status: {}, off: {}, custom: {}, sentAt: {} });
  current = Math.max(0, state.rows.findIndex(validRow));
  showMsg("listMsg", "");
  store.save();
  render();
}

async function importFile(file) {
  if (!file) return;
  try { setTable(await readFile(file), file.name); }
  catch (e) { showMsg("listMsg", e.message, "bad"); }
}

async function importSheet(url) {
  if (!parseSheetUrl(url)) return showMsg("listMsg", "這不像 Google 試算表的網址。請從試算表的網址列整段複製。", "bad");
  showMsg("listMsg", "讀取中…");
  try { setTable(await readGoogleSheet(url, gfetch), "Google 試算表"); }
  catch (e) { showMsg("listMsg", e.message, "bad"); }
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
  renderPeople();
  renderPreview();
}

function renderPeople() {
  const can = state.rows.map((r, i) => i).filter((i) => validRow(state.rows[i]) && state.status[i] !== "ok");
  const allOn = can.length > 0 && can.every((i) => !state.off[i]);
  const lock = sending ? " disabled" : "";
  const bad = state.rows.filter((r) => !validRow(r)).length;
  const sent = Object.values(state.status).filter((v) => v === "ok").length;
  $("listSummary").textContent = state.source + "　已勾選 " + pending().length + " 位" +
    (sent ? "，已寄 " + sent + " 位" : "") + (bad ? "（" + bad + " 列 Email 有問題，不會寄）" : "");

  const head = '<thead><tr><th class="st"><input type="checkbox" id="checkAll" title="全選／全不選"' +
    (allOn ? " checked" : "") + (can.length ? lock : " disabled") + "></th><th>稱謂</th><th>姓名</th><th>Email</th><th></th></tr></thead>";
  $("people").innerHTML = head + "<tbody>" + state.rows.map((row, i) => {
    const st = state.status[i];
    const ok = validRow(row);
    const mark = st === "ok" ? '<td class="st ok" title="已寄出">✓</td>'
      : st === "sending" ? '<td class="st">…</td>'
      : '<td class="st"><input type="checkbox" class="pick"' + (ok && !state.off[i] ? " checked" : "") + (ok ? lock : " disabled") + "></td>";
    const err = st && st !== "ok" && st !== "sending" ? '<span class="err" title="' + esc(st) + '">✗</span>' : "";
    return '<tr data-i="' + i + '" class="' + (i === current ? "current " : "") + (ok ? "" : "bad") + '">' + mark +
      "<td>" + esc(col(row, "title")) + "</td><td>" + esc(col(row, "name")) + "</td><td>" + esc(col(row, "email") || "（沒有 Email）") + "</td>" +
      '<td class="act">' + (state.custom[i] ? '<span class="edited" title="這一位的信個別修改過">✎</span>' : "") + err + '<button type="button" class="del" title="從列表刪除"' + lock + ">×</button></td></tr>";
  }).join("") + "</tbody>";
}

// 從列表刪掉一位（不會動到原本的 Excel）
function removeRow(i) {
  state.rows.splice(i, 1);
  for (const key of ["status", "off", "custom", "sentAt"]) {
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

function pending() {
  return state.rows.map((row, i) => i).filter((i) => validRow(state.rows[i]) && state.status[i] !== "ok" && !state.off[i]);
}

function renderPreview() {
  if (!state.rows.length) return;
  const row = state.rows[current] || state.rows[0];
  $("navLabel").textContent = "第 " + (current + 1) + " 位，共 " + state.rows.length + " 位";
  const name = col(row, "name"), email = col(row, "email");
  const sender = (state.sender || "").trim();
  $("pvFromRow").hidden = !sender;
  $("pvFrom").textContent = sender + (myEmail ? " <" + myEmail + ">" : "");
  const reply = (state.replyTo || "").trim();
  $("pvReplyRow").hidden = !reply;
  $("pvReply").textContent = reply;
  $("pvTo").textContent = (name ? name + " " : "") + "<" + (email || "沒有 Email") + ">";
  const mine = state.custom[current];
  if (mine) { $("pvSubject").textContent = mine.subject; $("pvBody").innerHTML = mine.html; }
  else { $("pvSubject").innerHTML = fill(esc(state.subject), row, true); $("pvBody").innerHTML = fill(state.body, row, true); }
  $("pvReceipt").innerHTML = state.receipt ? receiptHtml(current) : "";
  const editable = !sending && state.status[current] !== "ok";
  $("pvSubject").contentEditable = editable ? "plaintext-only" : "false";
  $("pvBody").contentEditable = editable ? "true" : "false";
  $("customNote").hidden = !mine;
  $("editHint").hidden = !!mine || !editable;
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

function bind() {
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
  $("changeList").onclick = () => {
    if (sending) return;
    showMap = false;
    Object.assign(state, { source: "", headers: [], rows: [], map: { title: -1, name: -1, email: -1 }, status: {}, off: {}, custom: {}, sentAt: {} });
    url.value = "";
    showMsg("sendMsg", ""); $("progress").hidden = true; $("bar").style.width = 0;
    store.save(); render();
  };

  for (const [id, key] of [["mapTitle", "title"], ["mapName", "name"], ["mapEmail", "email"]]) {
    $(id).onchange = (e) => { state.map[key] = +e.target.value; store.save(); render(); };
  }

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
  const step = (d) => {
    if (sending) return;
    current = (current + d + state.rows.length) % state.rows.length;
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

let cases = []; // 已結案的案件，新的在前面
let openCase = null; // 案件紀錄裡正在看的那一案
let casePerson = 0;

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

const sentCount = (c) => Object.values(c.status).filter((v) => v === "ok").length;
const day = (t) => { const d = new Date(t); return d.getFullYear() + "/" + (d.getMonth() + 1) + "/" + d.getDate(); };
const clock = (t) => { const d = new Date(t); return day(t) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); };

function askClose() {
  if (sending || !state.rows.length) return;
  const sent = sentCount(state), left = pending().length;
  $("closeText").innerHTML = "<p>這個案件會收進「案件紀錄」，之後隨時可以回來查寄給了誰、寄了什麼。畫面會清空，準備下一個案件。</p>" +
    "<p>已寄出 " + sent + " 位" + (left ? '，<span class="warn">還有 ' + left + " 位打勾但沒寄</span>" : "") + "。</p>";
  $("caseName").value = (state.subject.replace(TOKEN, "").replace(/\s+/g, " ").trim() || state.source || "未命名案件").slice(0, 60);
  $("closeDlg").showModal();
  $("caseName").select();
}

function closeCase() {
  const keep = ["source", "headers", "rows", "map", "sender", "replyTo", "subject", "body", "receipt", "status", "off", "custom", "sentAt"];
  const c = { id: Date.now(), name: $("caseName").value.trim() || "未命名案件", closedAt: Date.now(), files: attachments.map((a) => a.name) };
  for (const k of keep) c[k] = JSON.parse(JSON.stringify(state[k]));
  cases.unshift(c);
  caseStore.save();
  // 新案件：名單和信清空，寄件人名稱、回覆信箱沿用
  Object.assign(state, { source: "", headers: [], rows: [], map: { title: -1, name: -1, email: -1 }, subject: "", body: DEFAULT_BODY, status: {}, off: {}, custom: {}, sentAt: {} });
  attachments = []; current = 0; showMap = false;
  $("subject").value = ""; $("body").innerHTML = DEFAULT_BODY; $("sheetUrl").value = "";
  showMsg("sendMsg", ""); $("progress").hidden = true; $("bar").style.width = 0;
  $("closeDlg").close();
  renderAttach(); store.save(); render();
  showMsg("listMsg", "「" + c.name + "」已結案，收進案件紀錄了。可以開始新案件。", "good");
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
  const hit = cases.filter((c) => !q || c.name.toLowerCase().includes(q) || c.rows.some((r) => r.some((cell) => cell.toLowerCase().includes(q))));
  $("caseList").innerHTML = !cases.length
    ? '<p class="empty">還沒有結案的案件。<br>信寄完後按「✓ 結案，開始新案件」，就會收到這裡。</p>'
    : !hit.length ? '<p class="empty">找不到符合的案件。</p>'
    : hit.map((c) => '<button type="button" class="caseItem" data-id="' + c.id + '"><b>' + esc(c.name) + "</b><span>" + day(c.closedAt) +
        " 結案　寄出 " + sentCount(c) + "／" + c.rows.length + " 位</span></button>").join("");
}

function renderCaseDetail() {
  const c = openCase;
  $("caseTitle").innerHTML = "<b>" + esc(c.name) + "</b><span>" + day(c.closedAt) + " 結案　寄出 " + sentCount(c) + "／" + c.rows.length + " 位" +
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
  $("caseTo").textContent = (st === "ok" ? "已寄給：" : "沒有寄出：") + col(row, "name", c) + " <" + col(row, "email", c) + ">" + (mine ? "　✎ 個別修改過" : "");
  $("caseSubject").textContent = mine ? mine.subject : fill(c.subject, row, false, c);
  $("caseBody").innerHTML = mine ? mine.html : fill(c.body, row, true, c).replace(/<\/?mark>/g, "");
  $("caseAttach").textContent = (c.files?.length ? "📎 " + c.files.join("、") : "") + (c.receipt ? "　含「我已收到」按鈕" : "");
}

function bindCases() {
  $("closeCase").onclick = askClose;
  $("closeYes").onclick = closeCase;
  $("closeNo").onclick = () => $("closeDlg").close();
  $("caseName").addEventListener("keydown", (e) => { if (e.key === "Enter") closeCase(); });
  $("openCases").onclick = showCases;
  $("casesClose").onclick = () => $("cases").close();
  $("caseSearch").oninput = renderCases;
  $("caseList").onclick = (e) => {
    const b = e.target.closest(".caseItem");
    if (!b) return;
    openCase = cases.find((c) => c.id === +b.dataset.id);
    casePerson = Math.max(0, openCase.rows.findIndex((r, i) => openCase.status[i] === "ok"));
    $("caseDelete").textContent = "刪除這個案件";
    renderCases();
  };
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
  $("caseDelete").onclick = () => {
    // 按第一次先問，按第二次才真的刪
    if ($("caseDelete").textContent !== "確定刪除？刪了救不回來") { $("caseDelete").textContent = "確定刪除？刪了救不回來"; return; }
    cases = cases.filter((c) => c !== openCase);
    caseStore.save();
    openCase = null;
    renderCases();
  };
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
        const rel = (await r.json()).find((x) => !x.draft && String(x.tag_name).startsWith(UPDATE_TAG));
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
  for (const k in state.status) if (state.status[k] === "sending") delete state.status[k];
  current = Math.max(0, state.rows.findIndex(validRow));
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
