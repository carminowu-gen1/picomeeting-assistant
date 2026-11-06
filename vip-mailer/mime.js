// 把一封信組成 Gmail 收得懂的格式（RFC 822），中文標題、姓名、附件檔名都正確編碼

function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64utf8 = (str) => b64(new TextEncoder().encode(str));
const wrap = (s) => s.replace(/.{76}/g, "$&\r\n");
const clean = (s) => String(s).replace(/[\r\n]+/g, " ").trim();

// 標題類欄位：有非英文字就用 =?UTF-8?B?…?= 分段編碼
function encodeWord(text) {
  text = clean(text);
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const parts = [];
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i += 10) parts.push("=?UTF-8?B?" + b64utf8(chars.slice(i, i + 10).join("")) + "?=");
  return parts.join("\r\n ");
}

function address(name, email) {
  email = clean(email);
  name = clean(name || "");
  if (!name) return email;
  if (/^[\x20-\x7e]*$/.test(name)) return '"' + name.replace(/["\\]/g, "") + '" <' + email + ">";
  return encodeWord(name) + " <" + email + ">";
}

export async function fileToAttachment(file) {
  return { name: file.name, type: file.type || "application/octet-stream", size: file.size, data: b64(new Uint8Array(await file.arrayBuffer())) };
}

export function htmlToText(html) {
  const div = document.createElement("div");
  div.innerHTML = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(div|p|li|h\d|tr)>/gi, "\n");
  return div.textContent.replace(/\n{3,}/g, "\n\n").trim();
}

export function buildMime({ fromName, fromEmail, replyTo, receiptTo, toName, toEmail, subject, html, attachments = [] }) {
  const id = "vip_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const page = '<div style="font-family:\'Microsoft JhengHei\',\'PingFang TC\',Arial,sans-serif;font-size:15px;line-height:1.75;color:#222">' + html + "</div>";
  const part = (type, content) =>
    "Content-Type: " + type + "; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + wrap(b64utf8(content)) + "\r\n";
  const alt =
    'Content-Type: multipart/alternative; boundary="alt_' + id + '"\r\n\r\n' +
    "--alt_" + id + "\r\n" + part("text/plain", htmlToText(html)) +
    "--alt_" + id + "\r\n" + part("text/html", page) +
    "--alt_" + id + "--\r\n";

  // 有填寄件人名稱才自己寫 From；沒填就讓 Gmail 用帳號原本的名稱
  let out = (fromName && fromEmail ? "From: " + address(fromName, fromEmail) + "\r\n" : "") + (replyTo ? "Reply-To: " + clean(replyTo) + "\r\n" : "") + (receiptTo ? "Disposition-Notification-To: <" + clean(receiptTo) + ">\r\n" : "") + "To: " + address(toName, toEmail) + "\r\nSubject: " + encodeWord(subject) + "\r\nMIME-Version: 1.0\r\n";
  if (!attachments.length) return out + alt;

  out += 'Content-Type: multipart/mixed; boundary="mix_' + id + '"\r\n\r\n--mix_' + id + "\r\n" + alt;
  for (const a of attachments) {
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(a.type) ? a.type : "application/octet-stream";
    out +=
      "--mix_" + id + "\r\n" +
      "Content-Type: " + type + '; name="' + encodeWord(a.name).replace(/\r\n /g, " ") + '"\r\n' +
      "Content-Disposition: attachment; filename*=UTF-8''" + encodeURIComponent(clean(a.name)).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()) + "\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\n" + wrap(a.data) + "\r\n";
  }
  return out + "--mix_" + id + "--\r\n";
}
