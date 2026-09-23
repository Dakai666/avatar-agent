/**
 * 端對端情境：以 MCP client 身分依序呼叫工具，最後向使用者提問並等待回答。
 * 用法：node scripts/scenario.ts（需先開啟 avatar 頁面）
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: process.execPath, args: ['server/mcp.ts'], stderr: 'inherit' });
const client = new Client({ name: 'scenario', version: '0' });
await client.connect(transport);
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  console.log(`${name} →`, (r.content as { text: string }[])[0]?.text);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

await wait(2500); // 等頁面重連到這個 hub
await call('avatar_status');
await call('avatar_say', { text: '嗨！我是透過 MCP 連上的。', emotion: 'joy', gesture: 'wave' });
await wait(4000);
await call('avatar_set_state', { state: 'reading' });
await wait(2500);
await call('avatar_set_state', { state: 'working' });
await wait(2500);
await call('avatar_ask', {
  question: '要把這次的修改提交到 git 嗎？',
  options: ['提交', '先讓我看 diff', '不要'],
  allow_text: true,
  timeout_sec: Number(process.env.ASK_TIMEOUT ?? 90),
});
await call('avatar_express', { emotion: 'joy', gesture: 'bounce' });
await wait(1500);
await client.close();
