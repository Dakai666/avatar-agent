/**
 * Claude Code hook 轉發器：從 hook 的 stdin payload 取出事件名與工具名，POST 給 hub。
 * 對應邏輯在 hub（server/hookMap.ts）。
 *
 * 絕對不能拖慢或擋住 Claude：設定為 async hook、短逾時、所有錯誤都吞掉、永遠 exit 0、不輸出到 stdout。
 */
import { BRIDGE_HOST, BRIDGE_PORT } from '../src/bridgeProtocol.ts';

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);

try {
  // 只轉發對應需要的欄位：payload 可能含檔案內容、指令等，不必離開這個行程
  const { hook_event_name, tool_name } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  await fetch(`http://${BRIDGE_HOST}:${BRIDGE_PORT}/hook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hook_event_name, tool_name }),
    signal: AbortSignal.timeout(400),
  });
} catch {
  // hub 沒開（沒有 avatar session）時安靜略過
}
process.exit(0);
