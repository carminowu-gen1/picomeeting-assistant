# 交接檔：換電腦繼續開發（小伐速記＋小伐郵件高手）

> 2026-11-13 整理。兩個工具都在**同一個 GitHub repo** 裡，所以換電腦只要 clone 一次。
> repo：<https://github.com/carminowu-gen1/picomeeting-assistant>（公開）

---

## 一、在新電腦（N97）要做的事（約 15 分鐘）

### 1. 裝工具

| 工具 | 用途 | 下載 |
|---|---|---|
| **Git for Windows** | 抓程式、提交、推上 GitHub | <https://git-scm.com/download/win>（一路下一步） |
| **Chrome** | 兩個外掛都是 Chrome 擴充功能 | — |
| **Claude 桌面版（Code 分頁）** | 改程式 | 和現在一樣 |
| Python 3（選裝） | Claude 預覽畫面用（`python -m http.server`） | <https://www.python.org/downloads/>（勾 Add to PATH） |

不需要 Node、不需要 gh、不需要任何套件。

### 2. 抓程式

建議放在**一樣的路徑 `D:\MA`**（Claude 的記憶是照資料夾路徑記的，一樣的路徑就能沿用）。

```bash
git clone https://github.com/carminowu-gen1/picomeeting-assistant.git D:\MA
```

然後設定提交者（和現在一樣，用 GitHub 的 noreply 地址，不會露出真實 Email）：

```bash
git -C D:\MA config user.name "Carmino"
```

```bash
git -C D:\MA config user.email "266629319+carminowu-gen1@users.noreply.github.com"
```

### 3. 第一次 push 時登入 GitHub

第一次 `git push` 會跳出 GitHub 登入視窗（Git Credential Manager），用瀏覽器登入 `carminowu-gen1` 帳號授權一次即可，之後不用再登入。

### 4. 把外掛載入 Chrome（改程式時直接讀資料夾）

`chrome://extensions` → 右上角「開發人員模式」→「載入未封裝項目」：

- 小伐速記 → 選 `D:\MA`（整個資料夾就是外掛）
- 小伐郵件高手 → 選 `D:\MA\vip-mailer`

之後改完程式，按卡片上的重新整理（圓形箭頭）就生效。

### 5. 從舊電腦手動搬的東西（這些**沒有**在 GitHub 上）

| 東西 | 在舊電腦的位置 | 說明 |
|---|---|---|
| Claude 的記憶（回覆用繁中、介面風格等） | `C:\Users\wcm\.claude\projects\D--MA\memory\` | 整個資料夾複製到新電腦同路徑（`C:\Users\<帳號>\.claude\projects\D--MA\memory\`）。不搬也行，只是要重新交代一次偏好。 |
| `docs-internal\` | `D:\MA\docs-internal\` | 未提交的內部筆記（會客室聽寫回覆）。要留就直接複製，或提交進 repo。 |
| 小伐郵件高手的 Google 用戶端 ID | 存在 Chrome 外掛裡（`chrome.storage`） | 新電腦載入外掛後會再出現設定畫面，把同一組用戶端 ID 貼進去即可（在 Google Cloud Console →「憑證」可以查）。外掛 ID 固定是 `hgldmebiafknndoekhfaiggbcfecpfic`（manifest 有 `key`），所以重新導向 URI 不用改。 |
| 小伐速記的 Groq 金鑰 | 存在 Chrome 外掛裡 | 新電腦的歡迎頁再貼一次。 |

---

## 二、repo 長什麼樣

```
D:\MA\
├── manifest.json, background.js, popup/, live/, options/, offscreen/,
│   content/, lib/, dsp/, ui/, welcome/, perm/, icons/      ← 小伐速記（Chrome 外掛，v1.9.5）
├── docs/                 ← GitHub Pages（公開網站 https://carminowu-gen1.github.io/picomeeting-assistant/）
│   ├── index.html        小伐速記安裝說明頁
│   ├── app/              小伐速記手機版 PWA（docs/app/app.js 的 VERSION = "1.7.3"）
│   └── mail/             小伐郵件高手下載頁
├── vip-mailer/           ← 小伐郵件高手（Chrome 外掛，v1.8.0）
│   ├── manifest.json, app.html, app.js, app.css, sheet.js, mime.js, background.js
│   ├── guide.html        給使用者的說明書（外掛裡的「使用說明」連結）
│   └── README.md         開發說明、Google 授權設定、發布流程
├── deploy/               Cloudflare Worker 代理（選用，目前沒在用）
├── .github/workflows/
│   ├── release.yml       推 v* 標籤 → 打包小伐速記、建 Release
│   ├── release-mail.yml  推 mail-v* 標籤 → 打包小伐郵件高手、建 Release
│   └── worker.yml        deploy/ 有變動時更新 Cloudflare（要有 Secret 才會跑）
├── build.ps1             小伐速記手動打包（上架商店才用）
├── README.md / DEPLOY.md 小伐速記的說明與部署文件
├── PRIVACY.md            隱私權政策
└── .claude/launch.json   Claude 預覽用（python http.server 8765 → vip-mailer）
```

---

## 三、兩個工具的發布流程（在新電腦一樣適用）

兩個工具都靠「推標籤」觸發 GitHub Actions 自動打包，**標籤前綴不同**，互不干擾：

| | 小伐速記 | 小伐郵件高手 |
|---|---|---|
| 版本號在 | `manifest.json`（repo 根目錄） | `vip-mailer/manifest.json` |
| 標籤 | `v1.9.6` | `mail-v1.8.1` |
| Release 檔 | `meeting-assistant-<版本>.zip` | `xiaofa-mail.zip` |
| 新版提醒看的是 | `releases/latest` | 標籤 `mail-v` 開頭的最新 Release |
| 下載頁 | `docs/index.html` | `docs/mail/index.html`（JS 會自動指到最新版；fallback 連結記得順手改版號） |

**小伐速記發新版：**
```bash
git commit -am "說明改了什麼"
```
```bash
git tag v1.9.6
```
```bash
git push --follow-tags
```

**小伐郵件高手發新版：**
```bash
git commit -am "說明改了什麼"
```
```bash
git tag mail-v1.8.1
```
```bash
git push origin main mail-v1.8.1
```

重點規則：
- 標籤的數字必須和 manifest 的 `version` **完全一樣**，不一樣 Actions 會失敗。
- 小伐郵件高手的 Release 是用 `--latest=false` 建的，**不會**變成 repo 的 latest，小伐速記的更新檢查才不會抓錯。改 workflow 時要保留這個。
- 推上去大約 1–2 分鐘打包完成；可到 GitHub →「Actions」看進度，→「Releases」確認 zip。
- 手機版 PWA（`docs/app`）不走 Release，推上 `main` 就自動上線（GitHub Pages）；改版時把 `docs/app/app.js` 的 `VERSION`（如 `1.7.3`）和 `docs/app/sw.js` 的 `CACHE`（如 `pm-app-v25`）一起加號，手機才會更新快取。

---

## 四、小伐郵件高手：重要設計，改程式前先知道

- **Google 授權**：`chrome.identity.launchWebAuthFlow` 隱含流程，Google Cloud 的用戶端類型是「網頁應用程式」，重新導向 URI `https://hgldmebiafknndoekhfaiggbcfecpfic.chromiumapp.org/`。沒有用戶端密碼、不用 manifest 的 `oauth2`。用戶端 ID 由使用者在設定畫面貼入。**manifest 的 `key` 絕對不能改**，改了外掛 ID 就變、授權全部失效。
- **範圍**：`gmail.send`、`spreadsheets.readonly`、`userinfo.email`。
- **狀態**存在 `chrome.storage.local`：`vip`（目前案件）、`vipCases`（案件紀錄，含附件 base64）、`vipClientId`、`vipUpdate`。本機預覽（非外掛）時退回 `localStorage`。
- **範本代碼** `{{稱謂}} {{姓名}} {{Email}}` ＋ Excel 任何欄位名稱；`col(row,"title")` 會先經過「稱謂自動轉換」規則（`state.rules`）。
- **名單更新**（🔄）用 Email 對照合併：個別修改過（`custom`）的人整列不動；已寄過但新名單沒有的人留在最後。
- **案件**：`snapshot()` / `putAway()` / `openCaseNow()`，暫存＝`closedAt: null`。
- 預覽用的測試方式：Claude 會開 `python -m http.server 8765 --directory vip-mailer` 看 `app.html`，用 `localStorage` 塞假名單測，不會真的寄信。**真的寄信、讀試算表、OAuth 只能在 Chrome 裝好外掛後用真帳號測。**
- 每次發版順手改：`vip-mailer/manifest.json` 版本、`docs/mail/index.html` 的 fallback 下載連結、功能列表、`guide.html`、`README.md`。

## 五、小伐速記：重點提醒

- 完整結構與各檔案用途見 `README.md`「開發」一節；上架商店、代理伺服器等見 `DEPLOY.md`。
- `lib/s2t.js` 是字典產生的，不要手改。
- `config.json` 目前是空的（使用者各自填 Groq 金鑰），repo 公開時**不能**把代理存取碼放進去。
- GitHub Actions 的 Secrets 目前都沒有設定（沒上架商店、沒用 Cloudflare 自動部署），所以 Actions 只做打包＋建 Release。

---

## 六、給 Claude 的開場白（在新電腦第一次開 Claude 時貼）

```
這個資料夾 D:\MA 有兩個工具：小伐速記（根目錄，Chrome 外掛＋docs/app 手機版）和小伐郵件高手（vip-mailer/）。
先讀 HANDOVER.md 了解結構和發布流程。回覆一律用繁體中文；介面給我太太用，要漂亮、簡單、按鈕越少越好，
風格比照夜景＋毛玻璃卡片（白字、金色小圓點、淡藍副標）。要發版時我會說「發布 x.y.z」，再提交並推標籤。
```
