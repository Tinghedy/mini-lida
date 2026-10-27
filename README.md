# Mini LIDA · Class Lab

課堂互動用的網頁：18 位同學用手機填 4 題（螢幕時間、幾點睡、鬧鐘數、幾點起床）＋猜全班平均。投影幕即時顯示全班資料，講者按「下載 CSV 給 LIDA」，在台上用自己的 LIDA 現場畫圖。

## 兩種模式（`index.html` 最上面的 `CONFIG.MODE`）
- `'collect'`（預設）：手機只收資料，填完顯示「請看大螢幕」。**後端不需要 Gemini key**。
- `'full'`：手機也會跑 Gemini 版迷你 LIDA（Stage 1–3）並投票，需要設定 `GEMINI_API_KEY`。

- 手機：`…/index.html#join`（掃投影幕上的 QR code 進來）
- 投影幕：`…/index.html#wall`（即時資料 / 猜測 vs 真相 / AI 畫的圖）
- 沒設定後端時會自動進入 **DEMO 模式**（假資料 17 筆，只在單一裝置上有效，排練用）

## 架構

```
手機 / 投影幕（GitHub Pages，純前端）
        │  POST JSON
        ▼
Google Apps Script（後端，API key 藏在這）── Google 試算表（存資料、圖、投票）
        │
        ▼
Gemini API（Goal Explorer 提問、VisGenerator 寫 Vega-Lite 規格）
```

LIDA 的對應：
| LIDA | 這個網頁 | 誰做 |
|---|---|---|
| Summarizer | Stage 1 資料摘要（範圍、平均） | 規則（程式） |
| Goal Explorer | Stage 2 AI 提 4 個問題，全班共用，只呼叫一次 | Gemini |
| VisGenerator | Stage 3 AI 寫 Vega-Lite 規格，瀏覽器畫圖；畫不出來就顯示「失敗（VER）」 | Gemini 寫、瀏覽器畫 |
| （批判用） | AI 下標題：故意請它寫聳動標題，讓全班討論 18 筆資料撐不撐得起 | Gemini |

安全：AI 只輸出圖表規格（JSON），不執行 AI 寫的程式碼；資料由網頁自己塞進去，規格裡的外部網址一律封鎖。

## 一、設定後端（約 10 分鐘）

1. 開一個新的 Google 試算表，命名例如「Mini LIDA 課堂資料」。
2. 選單 **擴充功能 → Apps Script**，把 `apps-script/Code.gs` 的內容整個貼進去，存檔。
3. 左側 **專案設定（齒輪）→ 指令碼屬性**，新增：
   - `GEMINI_API_KEY`：只有 `full` 模式需要；`collect` 模式可以不填
   - `ADMIN_PIN`：自訂 4 位數（投影幕上「全部清空」「重新產生 AI 問題」要用）
   - `GEMINI_MODEL`（可省略）：預設 `gemini-2.5-flash`；你現在 LIDA 用哪個模型就填哪個
4. 右上 **部署 → 新增部署作業 → 類型選「網頁應用程式」**
   - 執行身分：**我**
   - 誰可以存取：**所有人**
   - 第一次會要求授權（存取試算表、連外網路），按允許
5. 複製部署後的網址（結尾是 `/exec`）。

> 之後改了 Code.gs，要用 **部署 → 管理部署作業 → 編輯 → 版本選「新版本」**，網址才不會變。

## 二、設定前端並上線

1. 打開 `index.html`，找到最上面的
   ```js
   const CONFIG = { API_URL: '' };
   ```
   把 `/exec` 網址貼進引號裡。
2. 在 GitHub 新建一個公開 repo（例如 `mini-lida`），上傳 `index.html`。
3. repo 的 **Settings → Pages → Branch 選 main / root → Save**。約 1 分鐘後網址會是
   `https://tinghedy.github.io/mini-lida/`
4. 投影幕開 `https://tinghedy.github.io/mini-lida/#wall`，QR code 會自動指向 `#join`。

## 三、上課前檢查

- [ ] 用自己手機 + 一台筆電跑完整流程：手機填資料 → 投影幕看到動物 → 下載 CSV → 丟進 LIDA 跑一次
- [ ] 投影幕輸入 PIN 按「全部清空」，把測試資料刪掉
- [ ] 準備備案：網路掛掉時，用 `index.html?demo#wall` 展示假資料，CSV 也能從 DEMO 版下載

## 課堂流程（collect 模式，約 8 分鐘）

1. **掃碼填資料**（1–2 分鐘）：投影幕「即時資料」，每個人的動物會一隻隻跳出來。
2. **猜測 vs 真相**（1 分鐘）：切到第二個分頁揭曉全班平均螢幕時間。
3. **下載 CSV → 丟進你的 LIDA**（3 分鐘）：當場讓 LIDA 產生摘要和問題，請同學喊出想看哪一題，或現場出一題。
4. **批判**（2 分鐘）：同一份資料，畫法該由誰決定？AI 的結論，18 筆資料撐得起嗎？

CSV 欄位（英文、無 emoji，避免 matplotlib 中文/emoji 變方塊）：
`person, screen_time_hours, bedtime, bedtime_hour, alarms, wakeup_time, wakeup_hour, sleep_hours`
（`bedtime_hour` ≥ 24 代表過了午夜，例如 25.5 = 凌晨 1:30）

## 注意

- Gemini 免費額度約每分鐘十幾次。後端遇到 429 會自動等待重試，18 人同時按最多等十幾秒。
- 匿名：只存動物暱稱，不存姓名。資料存在你自己的 Google 試算表，課後可以刪掉。
- 語言：右上角可以切換中文 / English，AI 的回答也會跟著換語言。
