import type { AvatarCommand } from './protocol';

/**
 * Hub ↔ 頁面 / Hub ↔ agent relay 之間的訊息格式。
 * 頁面（瀏覽器）與 server（Node）共用這份定義。
 */

export const BRIDGE_PORT = 5179;
export const BRIDGE_HOST = '127.0.0.1';

/** 允許連線的頁面來源（瀏覽器一定會帶 Origin，藉此擋掉其他網站連進本機 hub） */
export const ALLOWED_ORIGINS = [
  'http://127.0.0.1:5178',
  'http://localhost:5178',
  `http://${BRIDGE_HOST}:${BRIDGE_PORT}`,
  `http://localhost:${BRIDGE_PORT}`,
];

export interface AskRequest {
  id: string;
  question: string;
  options: string[];
  /** 是否允許使用者自由輸入文字 */
  allowText: boolean;
  name?: string;
}

export interface AskAnswer {
  id: string;
  /** 選了第幾個選項（自由輸入時為 -1） */
  index: number;
  /** 選項文字或自由輸入內容 */
  text: string;
}

/** hub → 頁面 */
export type ToPage =
  | { t: 'cmd'; cmd: AvatarCommand }
  | { t: 'ask'; ask: AskRequest }
  | { t: 'askCancel'; id: string };

/** 頁面 → hub */
export type FromPage = { t: 'answer'; answer: AskAnswer } | { t: 'hello'; version: number };

/** relay agent → hub */
export type AgentToHub =
  | { t: 'cmd'; cmd: AvatarCommand }
  | { t: 'ask'; ask: AskRequest }
  | { t: 'askCancel'; id: string };

/** hub → relay agent */
export type HubToAgent =
  | { t: 'answer'; answer: AskAnswer }
  | { t: 'askFailed'; id: string; reason: string }
  | { t: 'status'; pages: number };
