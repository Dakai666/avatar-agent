/**
 * 多 session 測試：A 當 hub、B 自動成為 relay；hook 轉發；A 關閉後 B 接手成為 hub。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawnSync } from 'node:child_process';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const open = async (name: string) => {
  const c = new Client({ name, version: '0' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: ['server/mcp.ts'], stderr: 'inherit' }));
  return c;
};
const status = async (c: Client) =>
  JSON.parse(((await c.callTool({ name: 'avatar_status', arguments: {} })).content as { text: string }[])[0].text);
const hook = (payload: object) =>
  spawnSync(process.execPath, ['server/hook.ts'], { input: JSON.stringify(payload) }).status;
const pageState = async () => (await fetch('http://127.0.0.1:5179/status')).json();

const a = await open('A');
await wait(300);
const b = await open('B');
await wait(3000);
console.log('A:', await status(a));
console.log('B:', await status(b));

await b.callTool({ name: 'avatar_say', arguments: { text: '我是從 relay 送來的。' } });
console.log('hook exit code:', hook({ hook_event_name: 'PreToolUse', tool_name: 'Grep' }));
console.log('hub /status:', await pageState());

await a.close();
console.log('A closed; waiting for B to take over…');
await wait(7000);
console.log('B:', await status(b));
console.log('hook exit code (after takeover):', hook({ hook_event_name: 'Stop' }));
await b.close();
await wait(500);
console.log('hook exit code (no hub):', hook({ hook_event_name: 'Stop' }));
