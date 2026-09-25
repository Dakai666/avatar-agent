/**
 * Agent hook 轉發器（Claude Code / Hermes Agent 共用）：把事件名 + 工具名 POST 給 hub。
 * 對應邏輯在 hub（server/hookMap.ts）。
 *
 * 事件來源兩種：
 *  1) Claude Code：事件名在 stdin payload 的 `hook_event_name` 欄位（不用 CLI arg）
 *  2) Hermes Agent：事件名必須由 `hooks:` config 的 `event:` 那一行用 `--event=<name>` 傳進來
 *     （Hermes 的 shell hook stdin payload 沒有 `hook_event_name` 欄位——見 agent/shell_hooks.py 的 _payload_fields()）
 *
 * 絕對不能拖慢或擋住 agent：短逾時、所有錯誤都吞掉、永遠 exit 0、不輸出到 stdout。
 */
import { BRIDGE_HOST, BRIDGE_PORT } from '../src/bridgeProtocol.ts';

// 1. CLI arg：Hermes 的 event name（`--event=pre_tool_call` 或 `--event pre_tool_call`）
function readEventArg(): string | undefined {
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('--event=')) return a.slice('--event='.length);
    if (a === '--event' && i + 1 < process.argv.length) return process.argv[i + 1];
  }
  return undefined;
}

// 2. stdin：Hermes 把欄位攤平在 top-level；Claude 跟以前一樣有 hook_event_name 欄位
const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);

try {
  const stdinPayload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;

  // 事件名：優先用 CLI arg（Hermes 模式），fallback 到 stdin 的 hook_event_name（Claude 模式）
  const cliEvent = readEventArg();
  const stdinEvent = typeof stdinPayload.hook_event_name === 'string' ? stdinPayload.hook_event_name : undefined;
  const hook_event_name = cliEvent ?? stdinEvent;

  // 工具名：兩種來源都有（Hermes top-level、Claude top-level）
  const tool_name = typeof stdinPayload.tool_name === 'string' ? stdinPayload.tool_name : undefined;

  // 狀態旗標：
  //  - Hermes on_session_end 用 top-level 的 `completed` / `interrupted` / `failed`
  //  - Hermes post_tool_call 用 top-level 的 `result` 字串（hub 端用 status 判斷）
  //  - Hermes 把多餘欄位放在 `extra` 物件
  const extra = (stdinPayload.extra ?? {}) as Record<string, unknown>;
  const status = (stdinPayload.status ?? extra.status) as string | undefined;
  const completed = (stdinPayload.completed ?? extra.completed) as boolean | undefined;
  const interrupted = (stdinPayload.interrupted ?? extra.interrupted) as boolean | undefined;
  // post_tool_call 的 result 是 string；status 沒值時用 result 的長度當 ok 標記
  const inferredStatus =
    status ?? (typeof stdinPayload.result === 'string' && stdinPayload.result.length > 0 && stdinPayload.result[0] !== '{' ? 'error' : 'ok');

  await fetch(`http://${BRIDGE_HOST}:${BRIDGE_PORT}/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name, tool_name, status: inferredStatus, completed, interrupted }),
    signal: AbortSignal.timeout(400),
  });
} catch {
  // hub 沒開（沒有 avatar session）時安靜略過
}
process.exit(0);
