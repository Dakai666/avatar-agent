# avatar-agent

給 AI agent 用的 VRM 虛擬人互動介面：agent 透過 MCP 工具與 Claude Code hooks 驅動角色的狀態、表情、手勢、說話與提問。架構與使用方式見 README.md，後續計畫與實測清單見 ROADMAP.md。

## 指令

- `npm run dev` — Vite 開發頁面（http://127.0.0.1:5178）
- `npm run build` — 型別檢查 + 打包到 `dist/`（hub 在 5179 提供這份）
- `npm run typecheck`
- `npm run smoke` / `npm run scenario` / `node scripts/multi.ts` — MCP 與 hub 測試
- 瀏覽器 console：`__avatar.continuityTest(30)` — 連貫性回歸測試（改動畫相關程式後要跑）

## 限制

- **角色模型受授權限制（僅作者、禁止再散佈）**：模型路徑在 `.env.local`，永遠不要複製進專案、不要 commit、不要上傳或放進任何公開頁面。`*.vrm` 已在 `.gitignore`。
- server 端（`server/`）由 Node 直接執行 `.ts`（type stripping）：只能用可抹除語法——不能用 enum、constructor parameter properties、namespace；import 要寫 `.ts` 副檔名。
- MCP 走 stdio：server 端 log 一律用 `console.error`，stdout 保留給協定。
- 連貫性原則：任何動態都改「彈簧目標」，不要直接設定骨骼或 morph 的值。

## 使用 avatar 工具時

角色已經會依 hooks 自動反映你在讀檔、工作、思考、等待。`avatar_say` 只在關鍵時刻說 1–2 句短話（用使用者的語言），完整說明仍放在對話回覆裡。`avatar_ask` 適合能用點選回答的快速決定；回報沒有頁面或逾時時，改在對話中詢問。
