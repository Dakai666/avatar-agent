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

## 下一步（Phase 2）

- MCP server（stdio）+ WebSocket 橋接：把 agent 的工具呼叫轉成 `AvatarCommand` 送到頁面
- `avatar.ask`：阻塞式工具，在對話框顯示選項，使用者點選後回傳給 agent
- Claude Code hooks 自動映射工具事件 → 狀態（不需要 agent 主動呼叫）
