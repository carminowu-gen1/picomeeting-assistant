// 名單讀取：.xlsx / .csv / Google 試算表 → { headers, rows }，並自動猜出稱謂、姓名、Email 欄位

export const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

// ---------- 檔案 ----------

export async function readFile(file) {
  const buf = await file.arrayBuffer();
  const name = file.name.toLowerCase();
  const head = new Uint8Array(buf.slice(0, 4));
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (isZip) return toTable(await readXlsx(buf));
  if (name.endsWith(".xls") || (head[0] === 0xd0 && head[1] === 0xcf)) {
    throw new Error("這是舊版 .xls 檔。請在 Excel 用「另存新檔」存成 .xlsx 再匯入。");
  }
  return toTable(parseCsv(decodeText(buf)));
}

// Excel 在台灣存 CSV 常是 Big5，UTF-8 解不開就改用 Big5
function decodeText(buf) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("big5").decode(buf);
  }
}

export function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? "\t" : ",";
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delim) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------- xlsx（zip + XML，不靠外部函式庫） ----------

async function unzip(buf, want) {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("檔案看起來壞掉了，打不開。");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name)) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = new Uint8Array(buf, start, compSize);
    if (method === 0) out.set(name, dec.decode(data));
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out.set(name, await new Response(stream).text());
    }
  }
  return out;
}

const xml = (s) => new DOMParser().parseFromString(s, "application/xml");
const tags = (node, name) => Array.from(node.getElementsByTagNameNS("*", name));

async function readXlsx(buf) {
  const files = await unzip(buf, (n) =>
    n === "xl/workbook.xml" || n === "xl/_rels/workbook.xml.rels" || n === "xl/sharedStrings.xml" || n.startsWith("xl/worksheets/"));

  // 第一張工作表的路徑
  let path = "xl/worksheets/sheet1.xml";
  try {
    const first = tags(xml(files.get("xl/workbook.xml")), "sheet")[0];
    const rid = Array.from(first.attributes).find((a) => a.localName === "id" && a.name !== "sheetId")?.value;
    const rel = tags(xml(files.get("xl/_rels/workbook.xml.rels")), "Relationship").find((r) => r.getAttribute("Id") === rid);
    const target = rel.getAttribute("Target");
    path = target.startsWith("/") ? target.slice(1) : "xl/" + target;
  } catch { /* 用預設路徑 */ }
  const sheetXml = files.get(path) || [...files].find(([n]) => n.startsWith("xl/worksheets/"))?.[1];
  if (!sheetXml) throw new Error("這個 Excel 檔裡找不到工作表。");

  const shared = files.has("xl/sharedStrings.xml")
    ? tags(xml(files.get("xl/sharedStrings.xml")), "si").map((si) =>
        tags(si, "t").filter((t) => t.parentNode.localName !== "rPh").map((t) => t.textContent).join(""))
    : [];

  const rows = [];
  for (const r of tags(xml(sheetXml), "row")) {
    const row = [];
    let next = 0;
    for (const c of tags(r, "c")) {
      const ref = c.getAttribute("r");
      const col = ref ? colIndex(ref) : next;
      next = col + 1;
      const type = c.getAttribute("t");
      let v;
      if (type === "inlineStr") v = tags(c, "t").map((t) => t.textContent).join("");
      else {
        v = tags(c, "v")[0]?.textContent ?? "";
        if (type === "s") v = shared[+v] ?? "";
      }
      row[col] = v;
    }
    rows.push(Array.from(row, (x) => x ?? ""));
  }
  return rows;
}

function colIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function colName(i) {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// ---------- 整理成表格 ----------

export function toTable(raw) {
  let rows = raw.map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some((c) => c));
  if (!rows.length) throw new Error("名單是空的。");
  const width = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => r.concat(Array(width - r.length).fill("")));
  // 第一列若已經有 Email，代表沒有標題列
  const hasHeader = !rows[0].some((c) => EMAIL_RE.test(c));
  const headers = (hasHeader ? rows.shift() : Array(width).fill("")).map((h, i) => h || "欄 " + colName(i));
  if (!rows.length) throw new Error("名單只有標題，沒有收件人。");
  return { headers, rows, map: guessMap(headers, rows) };
}

export function guessMap(headers, rows) {
  const find = (re) => headers.findIndex((h) => re.test(h));
  let email = find(/e-?mail|信箱|郵件|電郵|郵箱/i);
  if (email < 0) {
    // 看內容：哪一欄最多 Email
    const score = headers.map((_, i) => rows.filter((r) => EMAIL_RE.test(r[i])).length);
    const best = Math.max(...score);
    email = best > 0 ? score.indexOf(best) : -1;
  }
  const title = find(/稱謂|稱呼|職稱|頭銜|title|salutation/i);
  let name = headers.findIndex((h, i) => i !== title && i !== email && /姓名|名字|大名|收件人|name/i.test(h));
  return { title, name, email };
}

// ---------- Google 試算表 ----------

export function parseSheetUrl(url) {
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/.exec(url);
  if (!m) return null;
  const gid = /[#&?]gid=(\d+)/.exec(url);
  return { id: m[1], gid: gid ? +gid[1] : null };
}

// gfetch：會自動帶上 Google 授權的 fetch
export async function readGoogleSheet(url, gfetch) {
  const ref = parseSheetUrl(url);
  if (!ref) throw new Error("這不像 Google 試算表的網址。請從試算表的網址列整段複製。");
  const base = "https://sheets.googleapis.com/v4/spreadsheets/" + ref.id;
  const meta = await gfetch(base + "?fields=properties.title,sheets.properties(sheetId,title)");
  const sheet = meta.sheets.find((s) => s.properties.sheetId === ref.gid) || meta.sheets[0];
  const range = encodeURIComponent("'" + sheet.properties.title.replace(/'/g, "''") + "'");
  const data = await gfetch(base + "/values/" + range);
  const table = toTable(data.values || []);
  table.source = meta.properties.title + "／" + sheet.properties.title;
  return table;
}
