// 介面文字：繁體中文／English／日本語。跟著手機語言（設定可改）
const T = {
  zh: {
    locale: "zh-TW", sumLang: "繁體中文", speaker: "說話者 {x}", app: "小伐速記", sub: "會議摘要助理",
    // 歡迎頁
    w_tag: "把手機放在桌上，它會記下每個人說的話，<br>散會後自動整理成摘要。",
    w0_h: "先把它放到手機桌面", w0_p: "iPhone 會把「桌面的 App」和「Safari」分開存資料，先放到桌面、再從桌面打開設定，金鑰就只要貼一次。",
    w0_1: "按 Safari 下面的「分享」⎙", w0_2: "往下找「<b>加入主畫面</b>」→ 右上角「<b>新增</b>」", w0_3: "關掉 Safari，從桌面的「小伐速記」圖示打開，繼續下面的步驟", w0_note: "已經是從桌面打開的，就不會看到這一步。",
    w1_h: "允許使用麥克風", w1_p: "按下按鈕，手機會問你要不要允許，請按「<b>允許</b>」，然後隨便說幾句話。", w1_btn: "🎤 允許並測試",
    w2_h: "連接 AI（免費）", w2_p: "辨識和摘要用 Groq 的免費服務，需要一組「金鑰」，三步拿到：",
    w2_1a: "打開 Groq 網站 ↗", w2_1b: "，用 Google 帳號登入", w2_2: "按「<b>Create API Key</b>」→ 名稱隨便填 → 「<b>Submit</b>」", w2_3: "按「<b>Copy</b>」，回到這裡貼上",
    w2_ph: "貼在這裡（gsk_ 開頭）", paste: "貼上", confirm: "確認", w2_note: "金鑰只存在這支手機裡，只會在辨識時直接送給 Groq。",
    w_done: "開始使用 →", w_foot: "下一步會教你把它放到手機桌面，以後就像 App 一樣一點就開。",
    w_say: "請說幾句話…", w_heard: "✓ 聽到你的聲音了", w_notheard: "沒聽到聲音，請再試一次（靠近一點說話）", w_micdenied: "沒有取得麥克風權限：請在手機的瀏覽器設定裡允許",
    w_nokey: "還沒貼上", checking: "檢查中…", w_connected: "✓ 連上了", key_ok: "✓ 金鑰可以用",
    clip_empty: "剪貼簿是空的，先去 Groq 按 Copy", clip_denied: "瀏覽器不讓我讀剪貼簿，請長按輸入框選「貼上」",
    // 主畫面
    title_ph: "會議標題（可以改）", hist: "過去的會議", new: "新會議", settings: "設定", back: "返回",
    ready: "準備好了", listening: "聆聽中", recognizing: "辨識中…", finishing: "整理最後幾句…", ended: "已結束",
    mic: "🎤 麥克風", groq: "✦ Groq", tr_btn: "🌐 翻譯", tr_on: "翻譯已開：原文照記，每句下面顯示翻譯", tr_off: "翻譯已關", tr_fail: "翻譯失敗：",
    upd_h: "有新版本", upd_p: "按一下就更新，幾秒鐘", upd_btn: "更新", upd_rec: "錄音中先不更新，結束會議後再按",
    inst_h: "放到手機桌面，下次一點就開", inst_android: "按「安裝」，手機桌面就會多一個「小伐速記」圖示", inst_install: "安裝",
    inst_ios: "按 Safari 下面的「分享」⎙ → 「加入主畫面」→「新增」。第一次從桌面打開要再貼一次金鑰，先按「複製金鑰」。", inst_copykey: "複製金鑰",
    inst_other: "按瀏覽器右上角「⋮」→「加到主畫面」或「安裝應用程式」", inst_done: "已放到桌面，下次從桌面打開就好",
    key_copied: "金鑰已複製，從桌面打開後按「貼上」", key_copyfail: "複製失敗，請到設定頁長按金鑰複製",
    empty_listen_h: "正在聽…", empty_listen_p: "有人說話後，文字會一句一句出現在這裡",
    empty_h: "開會就交給它記", empty_1: "把手機放桌上", empty_2: "按下面「開始記錄」", empty_3: "散會自動整理摘要",
    chip_title: "點一下改名字", who: "這位是誰？\n（輸入已經有的名字，就會把兩個人合併成同一人）",
    copy: "📋 複製全文", word: "📄 存成 Word", rec_start: "開始記錄", rec_cont: "繼續記錄", rec_stop: "結束會議",
    hint_rec: "把手機放在桌子中間、螢幕保持開著。點說話者的名字可以改。", hint_done: "要開下一場會，按右上角的 ＋",
    meeting_title: "會議 {d}", platform: "現場錄音",
    need_key: "請先到設定貼上 Groq 金鑰", rec_err: "錄音錯誤：", mic_denied_start: "沒有麥克風權限：請到手機設定允許這個網站使用麥克風", cant_start: "無法開始錄音：",
    vp_fail: "聲紋模型載入失敗，仍會記錄但無法分辨說話者", stt_fail: "辨識失敗：", groq_err: "Groq 剛才回錯誤：",
    // 摘要
    sum_h: "會議摘要", sum_points: "重點整理", sum_decisions: "決議事項", sum_todo: "待辦事項", sum_owner: "（負責：{x}）", sum_due: "，期限：{x}", sum_open: "後續追蹤", sum_by: "由 {m} 產生",
    sum_wait: "AI 正在整理摘要…", sum_done: "摘要完成", sum_fail: "摘要失敗：", retry: "再試一次",
    copied: "已複製，可以貼到 LINE 或 Email", copied2: "已複製",
    // 歷史
    hist_lines: "{n} 句", hist_sum: "・有摘要", del: "刪除", del_q: "刪除這場會議？", hist_empty: "還沒有會議紀錄",
    // 設定
    s_key: "Groq 金鑰", check: "檢查", s_ui: "介面語言", s_ui_auto: "跟著手機", s_stt: "說話的語言",
    s_stt_auto: "中文＋英文（夾雜也可以，照原文記）", s_stt_ja: "中文＋英文＋日文", s_stt_all: "任何語言（自動偵測）", s_stt_zh: "固定中文", s_stt_en: "固定英文", s_stt_jp: "固定日文",
    s_sum: "摘要用的語言", s_sum_follow: "跟著介面語言（預設）", s_s2t: "簡體自動轉繁體", s_big: "大字模式", s_auto: "散會後自動產生摘要",
    s_vp: "聲紋模型：", s_agc: "麥克風自動增益：", s_dsp: "降噪／人聲偵測：", later: "開始錄音後才知道",
    s_note: "所有資料只存在這支手機裡。", privacy: "隱私權政策", version: "版本",
    vp_loaded: "已載入（{ms} ms）", vp_err: "載入失敗：",
    agc_browser: "瀏覽器內建（AGC 已生效）", agc_soft: "瀏覽器沒開，改用軟體增益（遠處小聲會自動放大）",
    dsp_dn_ok: "降噪 ✓", dsp_dn_no: "降噪 ✗", dsp_vad_ok: "人聲偵測 ✓（音樂、雜音不會送去辨識）", dsp_vad_no: "人聲偵測 ✗（改用音量判斷）", dsp_fail: "載入失敗，改用音量判斷",
    no_key_yet: "還沒有 Groq 金鑰，無法辨識",
    // 燈號
    mic_off: "麥克風權限被關掉了：到手機「設定」找這個瀏覽器（或網站設定），把麥克風改成允許", mic_retry: "沒有麥克風權限：按一下這裡會再問一次；還是不行就到手機「設定」裡允許", mic_none: "找不到麥克風：", mic_ok: "麥克風正常",
    groq_nokey: "還沒有 Groq 金鑰：到右上角 ⚙ 設定貼上", offline: "沒有網路", groq_401: "Groq 金鑰失效了：到右上角 ⚙ 重新貼一組", groq_down: "連不上 Groq：", groq_ok: "Groq 連線正常",
    // 錯誤
    e_key: "Groq 金鑰不對，請到設定重新貼上", e_rate: "Groq 免費額度暫時用完，等一下會自動再試", e_net: "連不上網路",
    // 匯出
    x_transcript: "會議逐字稿", x_open: "後續追蹤 / 未決問題",
  },
  en: {
    locale: "en-US", sumLang: "English", speaker: "Speaker {x}", app: "PicoNotes", sub: "Meeting notes assistant",
    w_tag: "Put your phone on the table. It writes down what everyone says<br>and turns it into a summary when the meeting ends.",
    w0_h: "First, add it to your Home Screen", w0_p: "iPhone keeps data for \"Home Screen apps\" and \"Safari\" separately. Add it to the Home Screen first and set up from there, so you only paste the key once.",
    w0_1: "Tap Safari's Share button ⎙", w0_2: "Scroll to \"<b>Add to Home Screen</b>\" → tap \"<b>Add</b>\"", w0_3: "Close Safari, open the \"PicoNotes\" icon on your Home Screen, and continue below", w0_note: "If you already opened it from the Home Screen, you won't see this step.",
    w1_h: "Allow the microphone", w1_p: "Tap the button. Your phone will ask for permission — tap \"<b>Allow</b>\", then say a few words.", w1_btn: "🎤 Allow and test",
    w2_h: "Connect the AI (free)", w2_p: "Transcription and summaries use Groq's free service. You need a \"key\" — three steps:",
    w2_1a: "Open the Groq website ↗", w2_1b: " and sign in with Google", w2_2: "Tap \"<b>Create API Key</b>\" → any name → \"<b>Submit</b>\"", w2_3: "Tap \"<b>Copy</b>\", come back and paste it here",
    w2_ph: "Paste here (starts with gsk_)", paste: "Paste", confirm: "OK", w2_note: "The key stays on this phone only and is sent directly to Groq during transcription.",
    w_done: "Get started →", w_foot: "Next we'll show you how to add it to your Home Screen so it opens like an app.",
    w_say: "Say a few words…", w_heard: "✓ Heard you", w_notheard: "Nothing heard — try again, a little closer", w_micdenied: "Microphone not allowed: enable it in your phone's browser settings",
    w_nokey: "Nothing pasted yet", checking: "Checking…", w_connected: "✓ Connected", key_ok: "✓ Key works",
    clip_empty: "Clipboard is empty — tap Copy on the Groq site first", clip_denied: "The browser won't let me read the clipboard. Long-press the box and choose Paste",
    title_ph: "Meeting title (editable)", hist: "Past meetings", new: "New meeting", settings: "Settings", back: "Back",
    ready: "Ready", listening: "Listening", recognizing: "Transcribing…", finishing: "Finishing last lines…", ended: "Ended",
    mic: "🎤 Mic", groq: "✦ Groq", tr_btn: "🌐 Translate", tr_on: "Translation on: original kept, translation shown under each line", tr_off: "Translation off", tr_fail: "Translation failed: ",
    upd_h: "New version available", upd_p: "One tap, takes a few seconds", upd_btn: "Update", upd_rec: "Recording — update after the meeting",
    inst_h: "Add to Home Screen for one-tap access", inst_android: "Tap \"Install\" and a \"PicoNotes\" icon appears on your Home Screen", inst_install: "Install",
    inst_ios: "Tap Safari's Share ⎙ → \"Add to Home Screen\" → \"Add\". The first launch from the Home Screen asks for the key again — tap \"Copy key\" first.", inst_copykey: "Copy key",
    inst_other: "Tap the browser's ⋮ menu → \"Add to Home screen\" or \"Install app\"", inst_done: "Added to the Home Screen — open it from there next time",
    key_copied: "Key copied — tap Paste after opening from the Home Screen", key_copyfail: "Copy failed — long-press the key in Settings to copy",
    empty_listen_h: "Listening…", empty_listen_p: "Once someone speaks, the text appears here line by line",
    empty_h: "Let it take the notes", empty_1: "Put the phone on the table", empty_2: "Tap \"Start\" below", empty_3: "Summary is made when you stop",
    chip_title: "Tap to rename", who: "Who is this?\n(Type an existing name to merge the two into one person)",
    copy: "📋 Copy all", word: "📄 Save as Word", rec_start: "Start", rec_cont: "Continue", rec_stop: "End meeting",
    hint_rec: "Keep the phone in the middle of the table with the screen on. Tap a speaker's name to rename.", hint_done: "For the next meeting, tap ＋ at the top right",
    meeting_title: "Meeting {d}", platform: "In-person recording",
    need_key: "Paste your Groq key in Settings first", rec_err: "Recording error: ", mic_denied_start: "No microphone permission: allow this site's microphone in your phone settings", cant_start: "Can't start recording: ",
    vp_fail: "Voiceprint model failed to load — still recording, but speakers won't be told apart", stt_fail: "Transcription failed: ", groq_err: "Groq returned an error: ",
    sum_h: "Summary", sum_points: "Key points", sum_decisions: "Decisions", sum_todo: "Action items", sum_owner: " (owner: {x})", sum_due: ", due: {x}", sum_open: "Follow-ups", sum_by: "Generated by {m}",
    sum_wait: "AI is writing the summary…", sum_done: "Summary ready", sum_fail: "Summary failed: ", retry: "Try again",
    copied: "Copied — paste it into a message or email", copied2: "Copied",
    hist_lines: "{n} lines", hist_sum: " · summary", del: "Delete", del_q: "Delete this meeting?", hist_empty: "No meetings yet",
    s_key: "Groq key", check: "Check", s_ui: "Interface language", s_ui_auto: "Follow phone", s_stt: "Spoken language",
    s_stt_auto: "Chinese + English (mixed is fine, kept as spoken)", s_stt_ja: "Chinese + English + Japanese", s_stt_all: "Any language (auto-detect)", s_stt_zh: "Chinese only", s_stt_en: "English only", s_stt_jp: "Japanese only",
    s_sum: "Summary language", s_sum_follow: "Same as interface (default)", s_s2t: "Convert Simplified to Traditional Chinese", s_big: "Large text", s_auto: "Summarize automatically when the meeting ends",
    s_vp: "Voiceprint model: ", s_agc: "Mic auto gain: ", s_dsp: "Noise reduction / voice detection: ", later: "Known after recording starts",
    s_note: "All data stays on this phone.", privacy: "Privacy policy", version: "Version",
    vp_loaded: "Loaded ({ms} ms)", vp_err: "Failed to load: ",
    agc_browser: "Browser built-in (AGC active)", agc_soft: "Browser AGC off — using software gain (quiet voices are boosted)",
    dsp_dn_ok: "Noise reduction ✓", dsp_dn_no: "Noise reduction ✗", dsp_vad_ok: "Voice detection ✓ (music and noise are not transcribed)", dsp_vad_no: "Voice detection ✗ (using volume instead)", dsp_fail: "Failed to load — using volume instead",
    no_key_yet: "No Groq key yet — transcription won't work",
    mic_off: "Microphone permission is off: open your phone's Settings, find this browser (or site settings) and allow the microphone", mic_retry: "No microphone permission: tap here to ask again; if that fails, allow it in your phone's Settings", mic_none: "No microphone found: ", mic_ok: "Microphone OK",
    groq_nokey: "No Groq key yet: tap ⚙ at the top right and paste it", offline: "No internet", groq_401: "Groq key no longer valid: tap ⚙ and paste a new one", groq_down: "Can't reach Groq: ", groq_ok: "Groq connection OK",
    e_key: "Wrong Groq key — paste it again in Settings", e_rate: "Groq free quota is temporarily used up — it will retry shortly", e_net: "No internet connection",
    x_transcript: "Transcript", x_open: "Follow-ups / open questions",
  },
  ja: {
    locale: "ja-JP", sumLang: "日本語", speaker: "話者 {x}", app: "PicoNotes", sub: "会議メモアシスタント",
    w_tag: "スマホを机に置くだけ。みんなの発言を記録し、<br>会議が終わると自動で要約します。",
    w0_h: "まずホーム画面に追加", w0_p: "iPhone は「ホーム画面のアプリ」と「Safari」のデータを別々に保存します。先にホーム画面に追加し、そこから開いて設定すれば、キーの貼り付けは一回で済みます。",
    w0_1: "Safari 下部の「共有」⎙ をタップ", w0_2: "「<b>ホーム画面に追加</b>」→ 右上の「<b>追加</b>」", w0_3: "Safari を閉じ、ホーム画面の「PicoNotes」アイコンから開いて、下の手順へ", w0_note: "すでにホーム画面から開いている場合、この手順は表示されません。",
    w1_h: "マイクを許可", w1_p: "ボタンを押すと許可を求められます。「<b>許可</b>」を押して、何か話してみてください。", w1_btn: "🎤 許可してテスト",
    w2_h: "AI に接続（無料）", w2_p: "文字起こしと要約には Groq の無料サービスを使います。「キー」が必要です。3 ステップ：",
    w2_1a: "Groq のサイトを開く ↗", w2_1b: "、Google アカウントでログイン", w2_2: "「<b>Create API Key</b>」→ 名前は何でも → 「<b>Submit</b>」", w2_3: "「<b>Copy</b>」を押して、ここに貼り付け",
    w2_ph: "ここに貼り付け（gsk_ で始まる）", paste: "貼り付け", confirm: "確認", w2_note: "キーはこのスマホにだけ保存され、文字起こしの時に Groq へ直接送られます。",
    w_done: "使い始める →", w_foot: "次にホーム画面への追加方法を案内します。アプリのようにワンタップで開けます。",
    w_say: "何か話してください…", w_heard: "✓ 聞こえました", w_notheard: "聞こえませんでした。もう少し近くで話してください", w_micdenied: "マイクが許可されていません：ブラウザの設定で許可してください",
    w_nokey: "まだ貼り付けていません", checking: "確認中…", w_connected: "✓ 接続できました", key_ok: "✓ キーは有効です",
    clip_empty: "クリップボードが空です。先に Groq で Copy を押してください", clip_denied: "ブラウザがクリップボードを読めません。入力欄を長押しして「ペースト」を選んでください",
    title_ph: "会議のタイトル（変更可）", hist: "過去の会議", new: "新しい会議", settings: "設定", back: "戻る",
    ready: "準備完了", listening: "聞いています", recognizing: "文字起こし中…", finishing: "最後の数文を整理中…", ended: "終了",
    mic: "🎤 マイク", groq: "✦ Groq", tr_btn: "🌐 翻訳", tr_on: "翻訳オン：原文はそのまま、各行の下に翻訳を表示", tr_off: "翻訳オフ", tr_fail: "翻訳に失敗：",
    upd_h: "新しいバージョンがあります", upd_p: "ワンタップ、数秒で完了", upd_btn: "更新", upd_rec: "録音中です。会議の後で更新してください",
    inst_h: "ホーム画面に追加すると次回からワンタップ", inst_android: "「インストール」を押すとホーム画面に「PicoNotes」のアイコンが追加されます", inst_install: "インストール",
    inst_ios: "Safari の「共有」⎙ → 「ホーム画面に追加」→「追加」。ホーム画面から初めて開くときはキーをもう一度貼り付けます。先に「キーをコピー」を押してください。", inst_copykey: "キーをコピー",
    inst_other: "ブラウザ右上の「⋮」→「ホーム画面に追加」または「アプリをインストール」", inst_done: "ホーム画面に追加しました。次回はそこから開いてください",
    key_copied: "キーをコピーしました。ホーム画面から開いたら「貼り付け」を押してください", key_copyfail: "コピーできませんでした。設定画面でキーを長押ししてコピーしてください",
    empty_listen_h: "聞いています…", empty_listen_p: "誰かが話すと、ここに一文ずつ表示されます",
    empty_h: "記録はおまかせ", empty_1: "スマホを机に置く", empty_2: "下の「記録開始」を押す", empty_3: "終了すると自動で要約",
    chip_title: "タップして名前を変更", who: "この人は誰ですか？\n（既存の名前を入力すると、二人を同一人物として統合します）",
    copy: "📋 全文をコピー", word: "📄 Word で保存", rec_start: "記録開始", rec_cont: "記録を続ける", rec_stop: "会議を終了",
    hint_rec: "スマホを机の中央に置き、画面を点けたままにしてください。話者名をタップすると変更できます。", hint_done: "次の会議は右上の ＋ から",
    meeting_title: "会議 {d}", platform: "対面録音",
    need_key: "先に設定で Groq キーを貼り付けてください", rec_err: "録音エラー：", mic_denied_start: "マイクの権限がありません：スマホの設定でこのサイトのマイクを許可してください", cant_start: "録音を開始できません：",
    vp_fail: "声紋モデルの読み込みに失敗。記録は続きますが話者の区別はできません", stt_fail: "文字起こし失敗：", groq_err: "Groq がエラーを返しました：",
    sum_h: "会議の要約", sum_points: "要点", sum_decisions: "決定事項", sum_todo: "アクションアイテム", sum_owner: "（担当：{x}）", sum_due: "、期限：{x}", sum_open: "フォローアップ", sum_by: "{m} により生成",
    sum_wait: "AI が要約を作成中…", sum_done: "要約が完成しました", sum_fail: "要約に失敗：", retry: "もう一度",
    copied: "コピーしました。LINE やメールに貼り付けられます", copied2: "コピーしました",
    hist_lines: "{n} 文", hist_sum: "・要約あり", del: "削除", del_q: "この会議を削除しますか？", hist_empty: "まだ会議の記録はありません",
    s_key: "Groq キー", check: "確認", s_ui: "表示言語", s_ui_auto: "スマホに合わせる", s_stt: "話す言語",
    s_stt_auto: "中国語＋英語（混在可、そのまま記録）", s_stt_ja: "中国語＋英語＋日本語", s_stt_all: "どの言語でも（自動検出）", s_stt_zh: "中国語のみ", s_stt_en: "英語のみ", s_stt_jp: "日本語のみ",
    s_sum: "要約の言語", s_sum_follow: "表示言語に合わせる（既定）", s_s2t: "簡体字を繁体字に自動変換", s_big: "大きな文字", s_auto: "会議終了後に自動で要約",
    s_vp: "声紋モデル：", s_agc: "マイク自動ゲイン：", s_dsp: "ノイズ除去／音声検出：", later: "録音開始後にわかります",
    s_note: "すべてのデータはこのスマホにのみ保存されます。", privacy: "プライバシーポリシー", version: "バージョン",
    vp_loaded: "読み込み済み（{ms} ms）", vp_err: "読み込み失敗：",
    agc_browser: "ブラウザ内蔵（AGC 有効）", agc_soft: "ブラウザの AGC は無効。ソフトウェアゲインを使用（小さな声を自動で増幅）",
    dsp_dn_ok: "ノイズ除去 ✓", dsp_dn_no: "ノイズ除去 ✗", dsp_vad_ok: "音声検出 ✓（音楽や雑音は文字起こししません）", dsp_vad_no: "音声検出 ✗（音量で判断）", dsp_fail: "読み込み失敗。音量で判断します",
    no_key_yet: "Groq キーがまだありません。文字起こしできません",
    mic_off: "マイクの権限がオフです：スマホの「設定」でこのブラウザ（またはサイト設定）のマイクを許可してください", mic_retry: "マイクの権限がありません：ここをタップするともう一度確認します。だめならスマホの「設定」で許可してください", mic_none: "マイクが見つかりません：", mic_ok: "マイクは正常です",
    groq_nokey: "Groq キーがまだありません：右上の ⚙ から貼り付けてください", offline: "インターネットに接続されていません", groq_401: "Groq キーが無効になりました：右上の ⚙ から新しいキーを貼り付けてください", groq_down: "Groq に接続できません：", groq_ok: "Groq 接続は正常です",
    e_key: "Groq キーが正しくありません。設定で貼り直してください", e_rate: "Groq の無料枠を一時的に使い切りました。しばらくすると自動で再試行します", e_net: "インターネットに接続できません",
    x_transcript: "会議の文字起こし", x_open: "フォローアップ / 未解決事項",
  },
};

export let lang = "zh";
export function detectLang(pref) {
  if (pref && pref !== "auto") return pref;
  const l = (navigator.language || "zh").toLowerCase();
  return l.startsWith("ja") ? "ja" : l.startsWith("zh") ? "zh" : "en";
}
export function setLang(l) { lang = T[l] ? l : "zh"; document.documentElement.lang = T[lang].locale; }
export function t(key, vars) {
  let s = T[lang][key] ?? T.zh[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}
/** 把頁面上所有 data-t（文字）、data-th（含 HTML）、data-tp（placeholder）、data-tt（title）換成目前語言 */
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  for (const el of root.querySelectorAll("[data-th]")) el.innerHTML = t(el.dataset.th);
  for (const el of root.querySelectorAll("[data-tp]")) el.placeholder = t(el.dataset.tp);
  for (const el of root.querySelectorAll("[data-tt]")) el.title = t(el.dataset.tt);
  document.title = t("app");
}
