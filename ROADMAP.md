# Roadmap

最後更新：2026-09-24

## 目前進度

| 階段 | 內容 | 狀態 |
|---|---|---|
| Phase 1 | VRM 渲染、彈簧連貫性系統、意圖排程器、對話框、除錯面板 | ✅ `92cf0c5` |
| Phase 2 | MCP server（5 個工具）、hub/relay、async hooks、對話框選項（`avatar_ask`） | ✅ `9d7ee3e` |
| **Phase 2.5** | **在本專案開新 session 實測** | ⏳ 進行中 |

---

## Phase 2.5：實測清單（在本資料夾開新 session）

1. [ ] 啟動 Claude Code 時允許 `.mcp.json` 的 `avatar` server
2. [ ] `npm run build`（若 `dist/` 不存在或頁面有改）
3. [ ] 開 <http://127.0.0.1:5179/>，左上角顯示「Agent 已連線」
4. [ ] SessionStart：角色揮手（頁面若晚於 session 開啟，這個會錯過，屬正常）
5. [ ] 送出訊息 → 點頭 → 思考；讀檔 → 低頭閱讀；跑指令 → 看向側邊工作
6. [ ] 權限提示出現時 → 轉頭看使用者、雙手交握（PermissionRequest）
7. [ ] 回覆結束 → 回到閒置（Stop）
8. [ ] 請 agent 呼叫 `avatar_say` / `avatar_express` / `avatar_ask`，點選項後 agent 收到答案
9. [ ] 開第二個 session：兩邊都能驅動角色；關掉第一個，第二個接手

**實測時要特別觀察：**
- 真實使用下的狀態切換節奏：合併窗口（200ms）、最短停留時間是否太慢或太快 → `src/behavior/scheduler.ts`、`src/behavior/states.ts`
- `Notification` 是否太常觸發「等待」而蓋過其他狀態 → `server/hookMap.ts`
- agent 是否過度使用 `avatar_say`（應只在關鍵時刻說短句）→ `server/mcp.ts` 的 `instructions`
- hook 失敗時 Claude Code 是否有任何錯誤提示（理論上不會：async + exit 0）

---

## Phase 3：TTS 語音

目標：真的說話，嘴型用真實音素時間，取代現在由文字推估的母音。

- **引擎候選**（需要決定）：
  - 本地中文：GPT-SoVITS、CosyVoice（品質高、可做角色音色，但要 GPU、要架服務）
  - 雲端：Edge TTS 類（有 word boundary 事件、零部署，但走網路）
- **架構**：hub 端新增 TTS worker（可選）→ 產生音訊 + 音素/字時間軸 → WebSocket 傳給頁面
  - 頁面 `SpeechPlayer` 改吃真實時間軸；沒有 TTS 時退回現在的推估模式
  - 打字機與音訊同步（以音訊時鐘為準）
- **注意**：音訊開始前的「吸氣預備」（`SPEECH_PREP_MS`）要吃掉 TTS 的生成延遲

## Phase 4：語音輸入

- 頁面加按住說話（push-to-talk），本地 STT（faster-whisper / whisper.cpp / sherpa-onnx）
- 第一步只用在 `avatar_ask`：回答時可以用說的（agent 發起的互動，MCP 就做得到）
- **研究項目：使用者主動發話**。MCP 無法主動送訊息給 agent，但 Claude Code 有 **channels**（MCP server 宣告 `claude/channel` capability，可推入訊息），不需要 Agent SDK。要確認：啟用方式（`--channels`、`channelsEnabled`）、帳號方案是否支援、訊息如何呈現在 session 裡

## Phase 5：桌面浮窗

- Tauri 包成透明、置頂、可拖曳的視窗；角色以外的區域滑鼠穿透
- 系統匣圖示：顯示/隱藏、切換角色、開除錯面板
- hub 可選擇由浮窗常駐啟動（不必等 MCP session）

## Phase 6：表現力

- 更多手勢：指向、雙手比劃、托腮變化、伸懶腰（長時間閒置時）
- 支援 VRMA 動畫片段，用 inertialization 與程序化層混合
- 視線跟隨滑鼠游標；使用者在頁面打字時看向輸入框
- 從台詞內容推估情緒（標點之外），讓說話時表情有起伏
- 閒置行為多樣化（避免重複感）

## Phase 7：通用化

- 文件化事件協定（`src/protocol.ts`）與 HTTP `/cmd` API，讓其他 agent 也能接
- 角色設定檔：每個模型的姿勢校正（手臂方向、托下巴位置）、名字、聲音
  - 目前姿勢是針對這個模型的比例調的，換模型需要微調

---

## 待決定

- [ ] **全域安裝**：MCP 註冊到使用者層級 + hooks 寫進 `~/.claude/settings.json`，讓任何專案都有 avatar（會改動全域設定，需使用者同意）
- [ ] **TTS 引擎**選擇（本地 vs 雲端）
- [ ] **公開展示用模型**：目前模型授權為「僅作者、禁止再散佈」，只能本機測試；要公開 demo 需換成授權允許的模型

## 已知限制 / 技術債

- 對嘴是從文字推估（中文母音由字碼雜湊決定，不是真實讀音）→ Phase 3 解決
- 頁面 bundle 約 800KB（three.js），浮窗階段可考慮拆分
- `lookAround` 手勢用 `setTimeout` 恢復視線活躍度，應改由排程器時鐘驅動
- 改頁面後要重新 `npm run build`，5179 才會是新版（開發時用 `npm run dev` 的 5178）
- server 端只有腳本式測試（`scripts/`），尚無自動化測試
