# 部署與更新

整體流程：**第一次上架在商店網站手動做一次，之後每次更新交給 GitHub 自動處理。**

```
改程式 → 改 manifest.json 版本 → 推標籤 v1.0.1
  → GitHub 自動打包 → 自動上傳商店並送審 → 審核通過 → 同事的 Chrome 自動更新
```

同事那一端：點連結 → 加到 Chrome → 照歡迎頁做 2～3 步，之後就不用再管。

---

## 一、先決定一件事：同事要不要自己申請金鑰

| 方案 | 同事要做的 | 你要做的 |
|---|---|---|
| **A. 組織代理（推薦）** | 允許麥克風就好 | 架一個代理伺服器（見第五節），在 GitHub 設定 `PROXY_URL`、`ACCESS_CODE` |
| B. 各自金鑰 | 照歡迎頁到 Groq 免費申請金鑰（約 2 分鐘） | 不用多做什麼 |

之後要從 B 換成 A 也可以，在 GitHub 補上兩個 Secrets，再發一個新版本就好。

---

## 二、第一次上架（手動，只做一次）

### 1. 產生要上傳的 zip（用 GitHub，不用自己跑指令）

1. 選方案 A 的話，先到 GitHub repo →「Settings」→「Secrets and variables」→「Actions」→「New repository secret」，新增 `PROXY_URL` 和 `ACCESS_CODE`。
2. 到「Actions」→ 左邊選「發布新版本」→ 右邊「Run workflow」，「上傳到商店並送審」**不要勾** → 執行。
3. 大約 2 分鐘後完成。點進這次執行，在最下面的「Artifacts」下載 zip。
   下載下來是一層包裝，**解開後裡面的 `meeting-assistant-1.0.0.zip` 才是要上傳的檔案**，這個不要再解壓縮。

### 2. 註冊開發人員帳號

1. 用你的 Google 帳號打開 [Chrome 開發人員資訊主頁](https://chrome.google.com/webstore/devconsole)。
2. 帳號要先開啟**兩步驟驗證**，接著同意條款，付一次性的 US$5 註冊費。
3. 填寫發布者資料。會被問到是不是「交易者（Trader）」：沒有販售、只給同事用的話，選「**非交易者**」。

### 3. 建立項目並上傳

資訊主頁 →「**新增項目**」→ 選剛剛那個 zip。上傳後會進入編輯頁，左邊有幾個分頁要填：

**商店資訊**
- 說明：
  `開會時自動記錄逐字稿，會後用 AI 整理摘要、重點與待辦，一鍵匯出 Word。支援 Google Meet、Microsoft Teams、Zoom、Jitsi。按一下開始記錄，離開會議自動產生摘要。`
- 類別：工作效率 → 工具
- 語言：中文（繁體）
- 商店圖示：上傳 `icons/icon128.png`
- 螢幕截圖：至少 1 張，尺寸 1280×800 或 640×400。建議截 popup 和全文頁，可以用 Windows 的「剪取工具」截圖後裁成這個尺寸。
- 宣傳圖塊（440×280）：如果顯示為必填，用圖示加上名稱做一張簡單的圖即可。

**隱私權**（審查最常卡在這裡，請照實填寫）
- 單一用途說明：`記錄線上會議的逐字稿，並用 AI 產生會議摘要。`
- 權限理由，每一項各填一句：

  | 權限 | 理由 |
  |---|---|
  | tabCapture | 擷取會議分頁的聲音，用來產生逐字稿 |
  | offscreen | 在背景錄製和處理音訊 |
  | activeTab | 確認使用者是在會議頁面按下開始 |
  | tabs | 偵測使用者離開會議，自動停止記錄 |
  | storage | 在使用者的電腦上保存會議記錄和設定 |
  | downloads | 把會議記錄下載成 Word 檔 |
  | sidePanel | 在側邊欄顯示即時逐字稿 |
  | 主機權限（meet.google.com 等會議網站） | 讀取會議畫面上的參與者名稱與字幕 |
  | 主機權限（api.groq.com 或代理網址） | 把音訊和文字送去做語音辨識與摘要 |
  | 遠端程式碼 | 選「否，我沒有使用遠端程式碼」 |

- 資料使用：勾選「**網站內容**」和「**個人通訊**」（會議的音訊與文字），並勾選下方三項聲明。
- 隱私權政策網址：必填。repo 是私人的，同事打不開，所以要另外放一份公開的版本。最簡單的方法：
  1. 打開 [gist.github.com](https://gist.github.com)
  2. 檔名填 `privacy.md`，內容貼上 `PRIVACY.md`（先把最後一行的聯絡 Email 改成你的）
  3. 按「Create **public** gist」，把網址貼到這個欄位

**發布**
- 可見度選「**不公開**」（只有拿到連結的人能安裝）
- 按「**提交審查**」。使用錄音權限的擴充功能，審查通常要幾天。

### 4. 審查通過後

1. 在資訊主頁複製商店連結，發給同事（訊息範本在第六節）。
2. 記下兩個 ID，第三節設定自動更新時會用到：
   - **項目 ID**：商店網址最後那串 32 個英文字母，也會顯示在項目頁上
   - **發布者 ID**：資訊主頁 →「發布者」→「設定」

---

## 三、設定 GitHub 自動更新（只做一次）

讓 GitHub 有權限幫你上傳新版本到商店：

1. 打開 [Google Cloud Console](https://console.cloud.google.com/)，建立一個專案（名稱隨意）。
2. 上方搜尋「**Chrome Web Store API**」→ 啟用。
3. 「IAM 與管理」→「服務帳戶」→「建立服務帳戶」，名稱隨意，**不需要給任何角色**，完成。
4. 點進剛建立的服務帳戶 →「金鑰」→「新增金鑰」→「JSON」，會下載一個 .json 檔。**這個檔案等同密碼，不要傳給別人。**
5. 回到 Chrome 開發人員資訊主頁 →「帳戶」，在服務帳戶區塊貼上服務帳戶的 Email（格式像 `xxx@專案.iam.gserviceaccount.com`）。
6. 到 GitHub repo →「Settings」→「Secrets and variables」→「Actions」，新增三個 Secret：
   - `CWS_SERVICE_ACCOUNT_JSON`：用記事本打開剛下載的 .json，**全部內容**貼上
   - `CWS_PUBLISHER_ID`：發布者 ID
   - `CWS_EXTENSION_ID`：項目 ID
7. 設定完成後，可以把電腦裡那個 .json 檔刪掉。

---

## 四、之後每次更新（全自動）

1. 改程式。
2. 把 `manifest.json` 的 `version` 加 1，例如 `1.0.0` → `1.0.1`（**每次都要比上次大，否則商店會拒收**）。
3. 推一個同版本號的標籤，在 `D:\MA` 執行：
   ```bash
   git commit -am "說明這次改了什麼"
   git tag v1.0.1
   git push --follow-tags
   ```
4. 到 GitHub「Actions」可以看到進度，完成後：
   - 「Releases」會多一個 v1.0.1，附上這次的 zip
   - 新版本已經送審，審核通過後會自動上線，同事的 Chrome 會在幾小時內自動更新

想先自己審查再上線：在 Secrets 加一個 `CWS_PUBLISH_TYPE`，值填 `STAGED_PUBLISH`。審核通過後要到資訊主頁手動按「發布」。

> 提醒：之後如果在資訊主頁手動改了可見度（例如從「不公開」改成「公開」），要先在網站上手動發布一次，自動上傳才會恢復正常。

---

## 五、架設組織代理（方案 A 才需要）

代理伺服器幫你保管 Groq 金鑰，同事的擴充功能只會拿到一組「存取碼」。使用 Cloudflare Workers 的免費方案即可。

1. 到 [Groq](https://console.groq.com/keys) 建立一把 API 金鑰。多人共用同一把時，免費額度很快會用完，建議在 Groq 的 Billing 升級為付費方案（依用量計費）。
2. 登入 [Cloudflare](https://dash.cloudflare.com/) →「Workers & Pages」→「建立」→「Worker」→ 取個名字 → 部署。
3. 按「編輯程式碼」，把 `deploy/worker.js` 的內容全部貼上，按「部署」。
4. 這個 Worker 的「設定」→「變數和秘密」，新增兩個「秘密」：
   - `GROQ_API_KEY`：你的 Groq 金鑰
   - `ACCESS_CODES`：自己想一組長亂碼當存取碼，例如 `mtg-7Kq2-Xz91-pLm4`
5. 用瀏覽器打開 Worker 的網址，看到 `{"ok":true,...}` 就成功了。
6. 到 GitHub Secrets 設定 `PROXY_URL`（Worker 網址）和 `ACCESS_CODE`（剛剛那組存取碼）。

**選用：之後改了 `deploy/worker.js` 時，讓 GitHub 自動更新代理**
在 GitHub Secrets 加上 `CLOUDFLARE_API_TOKEN`（Cloudflare →「我的設定檔」→「API 權杖」→ 用「編輯 Cloudflare Workers」範本建立）和 `CLOUDFLARE_ACCOUNT_ID`（Workers 頁面右側可以看到）。

**安全提醒**：存取碼會被打包進擴充功能，有心人拆開安裝檔看得到。萬一外流，在 Cloudflare 把 `ACCESS_CODES` 換成新的一組，同時更新 GitHub 的 `ACCESS_CODE`，再發一個新版本。審查通過後，還可以在 Cloudflare 加上 `EXTENSION_IDS` = 你的項目 ID，限制只有你的擴充功能能呼叫代理。

---

## 六、給同事的安裝說明（直接複製貼到 LINE 或 Email）

```
【小伐議事助理】開會自動記錄＋整理摘要

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

---

## 選用：存到 Google 文件

Word 下載已經可以滿足大部分需求。真的需要的話：

1. 在 Google Cloud Console 啟用 Google Docs API 和 Google Drive API。
2. 建立「OAuth 用戶端 ID」，類型選「Chrome 擴充功能」，填入項目 ID。
3. 在 GitHub Secrets 設定 `GOOGLE_CLIENT_ID`，再發一個新版本。

Docs 權限屬於敏感範圍：只給公司內部用的話，把 OAuth 同意畫面設成「內部」；對外開放則要先通過 Google 的驗證。
