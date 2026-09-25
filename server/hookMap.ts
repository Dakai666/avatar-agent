import type { AvatarCommand, AvatarState } from '../src/protocol.ts';

/**
 * Agent hook 事件 → avatar 指令。支援 Claude Code 與 Hermes Agent（兩者事件名稱不重疊，共用一個對應）。
 * 這是「被動」訊號：agent 不用主動呼叫工具，角色也會反映它實際在做什麼。
 * 高頻的 PreToolUse 由頁面端的意圖排程器負責合併，這裡不用節流。
 */

export interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  /** Hermes post_tool_call：'ok' 或錯誤 */
  status?: string;
  /** Hermes on_session_end */
  completed?: boolean;
  interrupted?: boolean;
  [k: string]: unknown;
}

// 每組前半是 Claude Code 的工具名，後半是 Hermes 的
const READING =
  /^(Read|Grep|Glob|LS|WebFetch|WebSearch|NotebookRead|ToolSearch|ListMcpResources|ReadMcpResource|read_file|search_files|web_search|web_extract|x_search|session_search|skill_view|skills_list|read_terminal|read_window_below|vision_analyze|video_analyze|feishu_doc_read|tool_search|tool_describe)$/;
const WORKING =
  /^(Bash|PowerShell|BashOutput|KillShell|Monitor|Edit|Write|MultiEdit|NotebookEdit|terminal|process_manage|close_terminal|patch|write_file|execute_code|skill_manage)$/;
const THINKING = /^(Task|Agent|TodoWrite|EnterPlanMode|Skill|delegate_task|todo_list|memory)$/;
const WAITING = /^(AskUserQuestion|ExitPlanMode|clarify)$/;

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

    // ---- Hermes Agent（shell hooks；hook_event_name 由 Hermes 放在 stdin） ----
    case 'on_session_start':
      return [
        { type: 'gesture', gesture: 'wave' },
        { type: 'emotion', emotion: 'joy', intensity: 0.7, holdMs: 2500 },
      ];
    case 'pre_llm_call':
      return [{ type: 'state', state: 'thinking', reason: 'llm' }];
    case 'pre_tool_call': {
      const s = p.tool_name ? toolState(p.tool_name) : null;
      return s ? [{ type: 'state', state: s, reason: p.tool_name }] : [];
    }
    case 'post_tool_call':
      // Hermes 沒有獨立的失敗事件，看 status
      return p.status && p.status !== 'ok' ? [{ type: 'emotion', emotion: 'sorrow', intensity: 0.5, holdMs: 1500 }] : [];
    case 'pre_approval_request':
      return [{ type: 'state', state: 'waiting', reason: 'approval' }];
    case 'subagent_start':
      return [{ type: 'state', state: 'thinking', reason: 'subagent' }];
    case 'on_session_end':
      // 每輪結束都會觸發；沒完成也不是被中斷 = 出錯
      return p.completed === false && !p.interrupted
        ? [{ type: 'state', state: 'troubled', reason: 'turn failed' }]
        : [{ type: 'state', state: 'idle', reason: 'turn end' }];
    case 'agent_loop_stopped':
      return [{ type: 'state', state: 'idle', reason: 'stopped' }];
    default:
      return [];
  }
}
