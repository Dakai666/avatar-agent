import type { AvatarCommand, AvatarState } from '../src/protocol.ts';

/**
 * Claude Code hook 事件 → avatar 指令。
 * 這是「被動」訊號：agent 不用主動呼叫工具，角色也會反映它實際在做什麼。
 * 高頻的 PreToolUse 由頁面端的意圖排程器負責合併，這裡不用節流。
 */

export interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  [k: string]: unknown;
}

const READING = /^(Read|Grep|Glob|LS|WebFetch|WebSearch|NotebookRead|ToolSearch|ListMcpResources|ReadMcpResource)$/;
const WORKING = /^(Bash|PowerShell|BashOutput|KillShell|Monitor|Edit|Write|MultiEdit|NotebookEdit)$/;
const THINKING = /^(Task|Agent|TodoWrite|EnterPlanMode|Skill)$/;
const WAITING = /^(AskUserQuestion|ExitPlanMode)$/;

export function toolState(tool: string): AvatarState | null {
  // 自己的工具不要覆蓋（agent 已經主動表達了）
  if (/^mcp__avatar/.test(tool)) return null;
  if (READING.test(tool)) return 'reading';
  if (WORKING.test(tool)) return 'working';
  if (THINKING.test(tool)) return 'thinking';
  if (WAITING.test(tool)) return 'waiting';
  // 其他 MCP 工具或未知工具：視為在操作
  return 'working';
}

export function mapHook(p: HookPayload): AvatarCommand[] {
  switch (p.hook_event_name) {
    case 'SessionStart':
      return [
        { type: 'gesture', gesture: 'wave' },
        { type: 'emotion', emotion: 'joy', intensity: 0.7, holdMs: 2500 },
      ];
    case 'UserPromptSubmit':
      // 收到訊息：點頭表示「收到」，然後開始想
      return [
        { type: 'gesture', gesture: 'nod' },
        { type: 'state', state: 'thinking', reason: 'prompt' },
      ];
    case 'PreToolUse': {
      const s = p.tool_name ? toolState(p.tool_name) : null;
      return s ? [{ type: 'state', state: s, reason: p.tool_name }] : [];
    }
    case 'PostToolUseFailure':
      return [{ type: 'emotion', emotion: 'sorrow', intensity: 0.5, holdMs: 1500 }];
    case 'PermissionRequest':
      // 等你授權：轉頭看你、身體前傾
      return [{ type: 'state', state: 'waiting', reason: 'permission' }];
    case 'Notification':
      // 閒置等待輸入等
      return [{ type: 'state', state: 'waiting', reason: 'notification' }];
    case 'SubagentStart':
      return [{ type: 'state', state: 'thinking', reason: 'subagent' }];
    case 'StopFailure':
      return [{ type: 'state', state: 'troubled', reason: 'stop failure' }];
    case 'PreCompact':
      return [{ type: 'state', state: 'thinking', reason: 'compact' }];
    case 'Stop':
      return [{ type: 'state', state: 'idle', reason: 'stop' }];
    default:
      return [];
  }
}
