# 會議摘要助理（Chrome 擴充功能）

> 這個小工具，是為了我老婆做的。她在公司常常要開線上會議，一邊聽一邊抄筆記，總是抄不完，也聽不完整。所以我做了它：開會時按一下，它就把大家說的話記下來；散會後，自動整理成摘要和待辦事項。支援 Google Meet、Teams、Zoom 這些網頁會議。沒有複雜的設定，也沒有用不到的功能，就算完全不懂電腦，也能輕鬆上手。

開會時自動記錄逐字稿，會後用 AI 整理摘要、重點與待辦，一鍵匯出 Word。支援 Google Meet、Microsoft Teams（網頁版）、Zoom（網頁版）、Jitsi Meet。

- **安裝說明（給同事）** → https://carminowu-gen1.github.io/picomeeting-assistant/
- **要發給同事用、發新版本** → 看 [DEPLOY.md](DEPLOY.md)
- **隱私權政策** → [PRIVACY.md](PRIVACY.md)

## 使用方式

1. 進入會議 → 點工具列的 ✦ → 按「**開始記錄**」
2. 開完會直接離開會議，會**自動停止並產生摘要**
3. 按「Word」下載，或按「複製」貼到任何地方；按「查看全文」可以在側邊欄修改逐字稿

## 功能

- **語音辨識（Groq Whisper）**：麥克風當作「我」、會議聲音當作「對方」，兩邊分開辨識；對方是誰從會議畫面上的「正在說話」標示判斷
- **多語**：每段話各自判斷語言，照原文記錄、不會翻譯；簡體中文會自動轉成繁體（台灣用語）
- **AI 摘要（Groq Llama）**：產生摘要、重點整理、決議、待辦（含負責人、期限）和後續追蹤；模型忙碌時自動換一個；長會議會先分段整理，比較省用量
- **自動停止**：離開會議、關閉分頁或換頁時自動停止
- **匯出**：Word、Markdown、純文字；可選擇另外啟用 Google 文件
- **介面**：淺色／深色／跟隨系統；安裝後有 3 步驟的歡迎頁

## 開發

```
manifest.json        MV3 設定
config.json          部署設定（代理網址、存取碼），由 build.ps1 寫入
background.js        錄製狀態、儲存、摘要、匯出、自動停止
offscreen/           分頁音訊＋麥克風錄音，依停頓切段後送 Whisper
content/capture.js   各平台的字幕、發言者偵測、離開會議偵測
lib/                 groq（摘要）、s2t（簡轉繁字典）、docx、gdocs、speakers、compact、config
popup/               主視窗：一顆大按鈕＋三個動作
live/                全文頁（側邊欄／分頁）
options/             設定（基本＋進階）
welcome/             安裝後的歡迎頁
docs/                安裝說明頁、隱私權政策（GitHub Pages）
deploy/              Cloudflare Worker 代理（選用）
build.ps1            打包成要上傳商店的 zip
```

本機測試：`chrome://extensions` → 開發人員模式 → 載入未封裝項目 → 選這個資料夾（或執行 `build.ps1` 後選 `dist\unpacked`）。

`lib/s2t.js` 是用 zhconv 的 zh-tw 字典產生的，不要手動修改。
