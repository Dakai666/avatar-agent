/**
 * MCP 煙霧測試：以 stdio 啟動 server/mcp.ts，列出工具並呼叫幾個。
 * 用法：node scripts/smoke.ts [say 的台詞]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: process.execPath, args: ['server/mcp.ts'], stderr: 'inherit' });
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

const show = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const c = (r.content as { text: string }[])[0]?.text;
  console.log(`${name} →`, r.isError ? '[error] ' : '', c);
};
await show('avatar_status');
await show('avatar_say', { text: process.argv[2] ?? '這是 MCP 煙霧測試！', emotion: 'joy', gesture: 'wave' });
await show('avatar_express', {});
await show('avatar_ask', { question: '沒有選項也沒有輸入框', options: [] });
await client.close();
