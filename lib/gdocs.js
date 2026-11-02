// Google 授權（chrome.identity OAuth）＋ Google Docs / Drive 匯出
import { meetingToBlocks } from "./format.js";

const FOLDER_NAME = "會議摘要助理";

function hasClientId() {
  const id = chrome.runtime.getManifest().oauth2?.client_id || "";
  return id && !id.startsWith("YOUR_");
}

function getToken(interactive) {
  return new Promise((res, rej) => {
    if (!hasClientId()) return rej(new Error("尚未設定 Google OAuth Client ID，請依 README 在 manifest.json 填入後重新載入擴充功能。"));
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) rej(new Error(chrome.runtime.lastError?.message || "未取得授權"));
      else res(token);
    });
  });
}

// ── 連結狀態 ─────────────────────────────────────────────────────────────
export async function googleStatus() {
  if (!hasClientId()) return { connected: false, configured: false };
  try {
    await getToken(false); // 不跳視窗，只看有沒有既有授權（不讀取使用者的 Google 帳號資料）
    return { connected: true, configured: true };
  } catch {
    return { connected: false, configured: true };
  }
}

// 跳出 Google 授權視窗（像 Scribbl 那樣）
export async function googleConnect() {
  await getToken(true);
  return googleStatus();
}

export async function googleDisconnect() {
  try {
    const token = await getToken(false);
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(token)}`).catch(() => {});
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
  } catch {}
  if (chrome.identity) await new Promise((r) => chrome.identity.clearAllCachedAuthTokens(r));
  return { connected: false, configured: hasClientId() };
}

// ── API helper ───────────────────────────────────────────────────────────
async function api(token, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  if (res.status === 401) {
    await new Promise((r) => chrome.identity.removeCachedAuthToken({ token }, r));
    throw new Error("Google 授權已過期，請再試一次。");
  }
  if (!res.ok) throw new Error(`Google API 錯誤 (${res.status})：${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// 在雲端硬碟找或建「會議摘要助理」資料夾
async function ensureFolder(token) {
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await api(token, `https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&spaces=drive`);
  if (found.files?.length) return found.files[0].id;
  const created = await api(token, "https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
  });
  return created.id;
}

// ── 匯出 ─────────────────────────────────────────────────────────────────
export async function exportToGoogleDoc(meeting, settings) {
  const token = await getToken(true); // 未連結時直接跳授權視窗
  const blocks = meetingToBlocks(meeting, settings);

  const doc = await api(token, "https://docs.googleapis.com/v1/documents", {
    method: "POST",
    body: JSON.stringify({ title: `${meeting.title} - 會議記錄` }),
  });

  // 先一次插入全部文字，再依字元範圍套用段落樣式（Docs API 以 UTF-16 計算 index，和 JS 字串長度一致）
  let text = "";
  const ranges = [];
  for (const b of blocks) {
    if (b.style === "title") continue;
    const line = b.text + "\n";
    ranges.push({ start: 1 + text.length, end: 1 + text.length + line.length, style: b.style });
    text += line;
  }
  const titleLine = blocks[0].text + "\n";
  ranges.forEach((r) => { r.start += titleLine.length; r.end += titleLine.length; });
  ranges.unshift({ start: 1, end: 1 + titleLine.length, style: "title" });
  text = titleLine + text;

  const named = { title: "TITLE", h1: "HEADING_1", h2: "HEADING_2", meta: "SUBTITLE", p: "NORMAL_TEXT", bullet: "NORMAL_TEXT" };
  const requests = [{ insertText: { location: { index: 1 }, text } }];
  for (const r of ranges) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: r.start, endIndex: r.end },
        paragraphStyle: { namedStyleType: named[r.style] || "NORMAL_TEXT" },
        fields: "namedStyleType",
      },
    });
  }
  let i = 0;
  while (i < ranges.length) {
    if (ranges[i].style !== "bullet") { i++; continue; }
    let j = i;
    while (j + 1 < ranges.length && ranges[j + 1].style === "bullet") j++;
    requests.push({
      createParagraphBullets: {
        range: { startIndex: ranges[i].start, endIndex: ranges[j].end },
        bulletPreset: "BULLET_DISC_CIRCLE_SQUARE",
      },
    });
    i = j + 1;
  }

  await api(token, `https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests }),
  });

  // 移到「會議摘要助理」資料夾（失敗不影響匯出）
  try {
    const folderId = await ensureFolder(token);
    await api(token, `https://www.googleapis.com/drive/v3/files/${doc.documentId}?addParents=${folderId}&removeParents=root&fields=id`, { method: "PATCH", body: "{}" });
  } catch (e) { console.warn("move to folder failed", e); }

  return `https://docs.google.com/document/d/${doc.documentId}/edit`;
}
