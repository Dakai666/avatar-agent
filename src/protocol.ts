/**
 * Avatar 事件協定。
 *
 * 與 agent 種類無關：Phase 2 的 MCP server 會把工具呼叫轉成這些指令，
 * 經 WebSocket 送到瀏覽器；Phase 1 則由除錯面板直接送。
 * 指令只描述「意圖」，何時、如何切換由 IntentScheduler 與各 controller 決定，
 * 所以送得再快、再亂，畫面都不會閃現。
 */

export const STATES = [
  'idle', // 閒置
  'listening', // 在聽使用者說話 / 打字
  'thinking', // 思考、規劃
  'reading', // 讀檔、搜尋
  'working', // 執行指令、寫程式
  'speaking', // 說話中（由 say 自動進入）
  'waiting', // 等使用者決定（授權、選擇）
  'happy', // 完成、成功
  'troubled', // 錯誤、失敗、困惑
] as const;
export type AvatarState = (typeof STATES)[number];

export const EMOTIONS = ['neutral', 'joy', 'fun', 'angry', 'sorrow', 'surprised'] as const;
export type Emotion = (typeof EMOTIONS)[number];

export const GESTURES = ['nod', 'shake', 'tilt', 'wave', 'bounce', 'sigh', 'lookAround', 'pointDialog'] as const;
export type Gesture = (typeof GESTURES)[number];

export const GAZE_TARGETS = ['user', 'down', 'thinkUp', 'side', 'dialog', 'wander'] as const;
export type GazeTarget = (typeof GAZE_TARGETS)[number];

export const SCENES = [
  'default', // 漸層背景 + 光暈
  'greenscreen', // 綠幕（OBS 色鍵去背）
  'transparent', // 透明背景（OBS 瀏覽器來源）
  'image', // 2D 背景圖（專案 scenes/ 資料夾內的圖片）
  'room', // 內建 3D 房間（白天）
  'roomNight', // 內建 3D 房間（夜晚）
] as const;
export type SceneName = (typeof SCENES)[number];

/** scenes/ 資料夾內的圖片檔名：不含路徑、限定副檔名 */
export const SCENE_IMAGE_NAME = /^[\w\-. ]{1,100}\.(png|jpe?g|webp)$/i;

export type AvatarCommand =
  | { type: 'state'; state: AvatarState; reason?: string }
  | { type: 'emotion'; emotion: Emotion; intensity?: number; holdMs?: number; fadeMs?: number }
  | { type: 'gesture'; gesture: Gesture }
  | { type: 'gaze'; target: GazeTarget; holdMs?: number }
  | { type: 'say'; text: string; emotion?: Emotion; name?: string }
  | { type: 'scene'; scene: SceneName; image?: string };
