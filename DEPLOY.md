# 部署指南：讓不會電腦的同事也能輕鬆使用

## 同事的使用體驗（目標）

1. 點你給的連結 → 按「加到 Chrome」
2. 自動跳出歡迎頁，照著做 2～3 步（約 1 分鐘）
3. 以後開會：點右上角 ✦ → 按「**開始記錄**」→ 開完會直接離開 → 摘要自動產生 → 按「Word」下載

## 選一種方案

| 方案 | 同事要做的 | 你要做的 | 費用 |
|---|---|---|---|
| **A. 商店不公開＋組織代理（推薦）** | 點連結安裝、允許麥克風 | 架代理伺服器、上架商店 | 商店註冊 US$5（一次）、Groq 用量 |
| B. 商店不公開＋各自金鑰 | 點連結安裝、允許麥克風、到 Groq 免費申請金鑰（歡迎頁有圖文步驟） | 上架商店 | 商店註冊 US$5（一次） |
| C. 公司 Google Workspace 強制安裝 | 什麼都不用做 | 管理控制台 → Chrome → 應用程式和擴充功能 → 加入商店 ID 並設為「強制安裝」 | 同 A |

> 不建議用「開發人員模式 → 載入未封裝項目」發給一般同事：每次 Chrome 啟動都會跳警告，也不會自動更新。

---

## 步驟 1（方案 A、C）：架設代理伺服器

代理伺服器保管你的 Groq 金鑰，同事的擴充功能只拿到一組「存取碼」。使用 Cloudflare Workers 的免費方案即可。

1. 到 [Groq](https://console.groq.com/keys) 建立一把 API 金鑰。
   多人共用同一把金鑰時，免費方案的每分鐘、每日上限很快會用完，建議在 Groq 的 Billing 升級為付費方案（依用量計費）。
2. 註冊並登入 [Cloudflare](https://dash.cloudflare.com/)，進入「Workers & Pages」→「建立」→「Worker」→ 取個名字 → 部署。
3. 按「編輯程式碼」，把 `deploy/worker.js` 的內容全部貼上，按「部署」。
4. 到這個 Worker 的「設定」→「變數和秘密」，新增：
   - `GROQ_API_KEY`（類型選「秘密」）：你的 Groq 金鑰
   - `ACCESS_CODES`（類型選「秘密」）：自己想一組長一點的亂碼當存取碼，例如 `mtg-7Kq2-Xz91-pLm4`
5. 記下網址，例如 `https://meeting-assistant-proxy.你的帳號.workers.dev`。用瀏覽器打開，看到 `{"ok":true,...}` 就成功了。

> 會寫程式的話也可以用指令：`cd deploy`、`npx wrangler deploy`，然後執行 `npx wrangler secret put GROQ_API_KEY` 和 `npx wrangler secret put ACCESS_CODES`。

**安全提醒**：存取碼會打包在擴充功能裡，有心人拆開安裝檔看得到。萬一外流，可以在 `ACCESS_CODES` 換一組新的，重新打包並上傳新版本，舊的存取碼就會失效。上架後可以把擴充功能 ID 填進 `EXTENSION_IDS`，只允許你的擴充功能呼叫。

## 步驟 2：打包

在 `D:\MA` 資料夾開 PowerShell，依方案執行其中一行：

```powershell
# 方案 A / C：走代理（同事不用金鑰）
powershell -ExecutionPolicy Bypass -File build.ps1 -ProxyUrl https://你的worker網址 -AccessCode 你的存取碼

# 方案 B：同事各自填金鑰
powershell -ExecutionPolicy Bypass -File build.ps1
```

會產生：
- `dist\meeting-assistant-版本.zip`：上傳到商店用的檔案
- `dist\unpacked\`：先在自己的 Chrome 測試（`chrome://extensions` → 開發人員模式 → 載入未封裝項目）

## 步驟 3：上架 Chrome 線上應用程式商店（不公開）

1. 到 [Chrome 開發人員資訊主頁](https://chrome.google.com/webstore/devconsole) 註冊，一次性費用 US$5。
2. 「新增項目」→ 上傳 zip。
3. **商店資訊**
   - 簡短說明：`開會時自動記錄逐字稿，會後用 AI 整理摘要、重點與待辦，一鍵匯出 Word。支援 Google Meet、Teams、Zoom、Jitsi。`
   - 類別：「工作效率」
   - 截圖：至少 1 張 1280×800（popup 和全文頁各截一張）
4. **隱私權**（審查最常卡在這裡，請照實填寫）
   - 單一用途：`記錄線上會議的逐字稿並產生摘要。`
   - 權限說明（每個權限都要寫一句）：

     | 權限 | 說明 |
     |---|---|
     | tabCapture | 擷取會議分頁的聲音，轉成逐字稿 |
     | offscreen | 在背景處理音訊錄製 |
     | activeTab / tabs | 確認目前分頁是會議頁面，並在離開會議時自動停止 |
     | storage | 在使用者電腦上保存會議記錄和設定 |
     | downloads | 下載 Word 檔 |
     | sidePanel | 在側邊欄顯示即時逐字稿 |
     | 主機權限（meet.google.com 等） | 讀取會議畫面上的參與者名稱與字幕 |
     | 主機權限（api.groq.com／代理網址） | 把音訊和文字送去做語音辨識與摘要 |

   - 資料使用：勾選「網站內容」（音訊與文字）、「個人通訊」（會議內容），並勾選三項聲明（不販售、不用於無關用途、不用於信用評估）。
   - 隱私權政策網址：把 `PRIVACY.md` 放到可以公開瀏覽的網址（Google 協作平台、Notion 公開頁或 GitHub Pages 都可以）。
5. **發布**：可見度選「**不公開**」→ 提交審查。使用 tabCapture 的擴充功能審查通常要幾天。
6. 審查通過後，複製商店連結發給同事（範本在下面）。

**之後要更新**：把 `manifest.json` 的 `version` 加 1（例如 1.0.0 → 1.0.1），重新執行 `build.ps1`，在資訊主頁上傳新的 zip。同事的 Chrome 會自動更新，什麼都不用做。

## 給同事的安裝說明（可以直接複製貼到 LINE / Email）

```
【會議摘要助理】開會自動記錄＋整理摘要

安裝（只要做一次，約 1 分鐘）：
1. 用 Chrome 打開：<這裡貼商店連結>
2. 按「加到 Chrome」→「新增擴充功能」
3. 會自動跳出設定頁，照著畫面做就好

使用：
1. 進入 Google Meet / Teams / Zoom 會議
2. 點 Chrome 右上角的 ✦ 圖示 → 按「開始記錄」
3. 開完會直接離開，摘要會自動產生，按「Word」就能下載

※ Teams、Zoom 請用網頁版開會
※ 開始記錄前，請先告知與會者會議將被記錄
```

## 選用：存到 Google 文件

Word 下載已經可以滿足大部分需求。如果要啟用「存到 Google 文件」：

1. 在 Google Cloud Console 建立專案，並啟用 Google Docs API 和 Google Drive API。
2. 建立「OAuth 用戶端 ID」，類型選「Chrome 擴充功能」，填入商店項目的 ID。
3. 用 `build.ps1 ... -GoogleClientId 你的ClientID` 重新打包，然後上傳新版本。

注意：Docs 權限屬於敏感範圍，對外開放前要先通過 Google 的 OAuth 驗證。只給公司內部用的話，可以把 OAuth 同意畫面設為「內部」，就不需要驗證。
