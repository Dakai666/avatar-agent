# avatar-agent

給 AI agent 使用的虛擬人互動介面。agent 送出「意圖」（狀態、情緒、手勢、視線、台詞），
角色用連續、不閃現的動態表現出來。

## 啟動

```bash
npm install
cp .env.local.example .env.local   # 填入 VRM 模型的絕對路徑
npm run dev                        # http://127.0.0.1:5178
```

模型檔不進專案，由 dev server 從 `AVATAR_VRM_PATH` 直接讀取（`*.vrm` 已列入 `.gitignore`）。

## 架構

```
src/
  protocol.ts            事件協定（agent 無關）：state / emotion / gesture / gaze / say
  core/spring.ts         臨界阻尼彈簧（純量 + 四元數），所有動態的基礎
  avatar/face.ts         Fcl_* 分區表情、眨眼、母音嘴型、通道仲裁
  avatar/body.ts         分層姿勢合成：狀態 × 視線 × 手勢 × idle/呼吸
  avatar/gaze.ts         眼 → 頭 → 上身依序跟隨、頭部死區、微掃視
  avatar/gestures.ts     程序化手勢（預備 → 主動作 → 跟隨 → 回穩）
  avatar/pose.ts         用「方向」描述手臂姿勢
  behavior/states.ts     9 個狀態的目標定義
  behavior/scheduler.ts  意圖排程器：合併窗口、最短停留、出口點、說話預備
  behavior/speech.ts     文字 → 音節時間軸（Phase 1 無 TTS）
  ui/dialog.ts           遊戲式對話框（打字機與嘴型同步）
  ui/debug.ts            除錯面板
  dev/continuityTest.ts  連貫性回歸測試
```

## 連貫性驗證

在瀏覽器 console 執行 `__avatar.continuityTest(30)`：以每 40–400ms 一個亂數指令轟炸 30 秒，
量測單幀最大骨骼旋轉與 morph 變化，分別比較「無平滑」「只有彈簧」「彈簧 + 排程器」三種設定。

除錯面板也可以即時切換「彈簧平滑」「意圖排程器」，用眼睛比較差異。

## 接上 agent（MCP）

```
Claude Code ──stdio──▶ server/mcp.ts ──┐
   │ hooks (async)                      ├─ hub（port 5179，第一個啟動的 MCP 行程擔任）
   └──▶ server/hook.ts ──POST /hook──▶  │   ├─ WebSocket ⇄ 瀏覽器頁面
其他 session 的 MCP ──WebSocket relay──▶ ┘   └─ 提供 dist/ 頁面與本機模型
```

1. `npm run build`（hub 會直接提供打包後的頁面）
2. 在本專案目錄啟動 Claude Code：`.mcp.json` 註冊 `avatar` MCP server，`.claude/settings.json` 註冊 hooks
3. 瀏覽器開 <http://127.0.0.1:5179/>（開發時也可用 Vite 的 5178，兩者都會連到 hub）

### 工具

| 工具 | 用途 |
|---|---|
| `avatar_say` | 說一句話（對話框 + 嘴型），可附情緒、手勢；不阻塞 |
| `avatar_set_state` | 切換狀態（hooks 推不出來的，如 happy / troubled） |
| `avatar_express` | 情緒 / 手勢 / 視線 |
| `avatar_ask` | 在對話框顯示選項與輸入框，**阻塞直到使用者回答**或逾時 |
| `avatar_status` | 頁面是否開啟、網址 |

### Hooks 對應（server/hookMap.ts）

| 事件 | 角色 |
|---|---|
| SessionStart | 揮手 + 開心 |
| UserPromptSubmit | 點頭 → 思考 |
| PreToolUse | Read/Grep/Glob/Web* → 閱讀；Bash/Edit/Write → 工作；Task/Agent → 思考；AskUserQuestion → 等待 |
| PermissionRequest / Notification | 等待回應 |
| PostToolUseFailure | 短暫難過 |
| Stop / StopFailure | 閒置 / 困擾 |

hook 以 `async` 執行，不會拖慢 Claude；轉發器只送事件名與工具名，不送 payload 其他內容。

### 多 session

第一個啟動的 MCP 行程成為 hub，其餘自動成為 relay；hub 所在 session 結束時，其他 session 在約 1 秒內接手，頁面自動重連。

### 安全

hub 只綁 127.0.0.1；瀏覽器連線必須來自允許的 Origin（擋掉其他網站連進本機、偷答提問）；所有指令經 zod 驗證。

### 測試腳本

- `npm run smoke`：列出工具、驗證參數檢查
- `npm run scenario`：端對端情境（需開頁面，最後會發問等你點）
- `node scripts/multi.ts`：hub / relay / 接手 / hook
