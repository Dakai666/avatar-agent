import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AvatarCommand } from '../src/protocol.ts';
import {
  ALLOWED_ORIGINS,
  BRIDGE_HOST,
  type AgentToHub,
  type AskAnswer,
  type AskRequest,
  type FromPage,
  type HubToAgent,
  type ToPage,
} from '../src/bridgeProtocol.ts';
import { mapHook, type HookPayload } from './hookMap.ts';
import { parseCommand } from './schema.ts';
import { listSceneImages, sceneImageMime, sceneImagePath } from './sceneFiles.ts';

/**
 * Hub：本機唯一的 avatar 中樞（第一個搶到 port 的 MCP 行程擔任）。
 *
 *   /ws?role=page   瀏覽器頁面
 *   /ws?role=agent  其他 MCP 行程（relay）
 *   POST /hook      Claude Code hook 原始 payload（由 hub 對應成指令）
 *   POST /cmd       任意 agent 直接送 AvatarCommand
 *   GET  /status    連線狀態
 *   GET  /scenes/…  自訂背景圖（只限專案 scenes/ 資料夾；list.json 列出可用檔名）
 *   其他            提供打包後的頁面（dist/）與本機模型
 */

const ROOT = resolve(import.meta.dirname, '..');
const DIST = join(ROOT, 'dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function readModelPath(): string | undefined {
  if (process.env.AVATAR_VRM_PATH) return process.env.AVATAR_VRM_PATH;
  const envFile = join(ROOT, '.env.local');
  if (!existsSync(envFile)) return undefined;
  const line = readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith('AVATAR_VRM_PATH='));
  return line?.slice('AVATAR_VRM_PATH='.length).trim() || undefined;
}

/** 瀏覽器一定會帶 Origin；沒有 Origin 的是本機 Node/CLI（relay、hook、curl） */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !origin || ALLOWED_ORIGINS.includes(origin);
}

interface PendingAsk {
  ask: AskRequest;
  /** local = 本行程的 MCP；否則為發問的 relay 連線 */
  origin: 'local' | WebSocket;
}

export class Hub {
  private pages = new Set<WebSocket>();
  private agents = new Set<WebSocket>();
  private pending = new Map<string, PendingAsk>();
  private server: Server;
  private wss: WebSocketServer;
  private modelPath = readModelPath();

  /** 本行程 MCP 的 ask 回答 */
  onLocalAnswer?: (a: AskAnswer) => void;
  onLocalAskFailed?: (id: string, reason: string) => void;

  private constructor(server: Server) {
    this.server = server;
    this.wss = new WebSocketServer({ noServer: true });
    server.on('request', (req, res) => this.handleHttp(req, res));
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/ws' || !originAllowed(req)) {
        socket.destroy();
        return;
      }
      const role = url.searchParams.get('role');
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        if (role === 'page') this.addPage(ws);
        else if (role === 'agent' && !req.headers.origin) this.addAgent(ws);
        else ws.close();
      });
    });
  }

  /** 嘗試成為 hub；port 被占用時回傳 null（改當 relay） */
  static tryStart(port: number): Promise<Hub | null> {
    return new Promise((res, rej) => {
      const server = createServer();
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') res(null);
        else rej(err);
      });
      server.listen(port, BRIDGE_HOST, () => res(new Hub(server)));
    });
  }

  get pageCount(): number {
    return this.pages.size;
  }

  close(): void {
    for (const ws of [...this.pages, ...this.agents]) ws.close();
    this.wss.close();
    this.server.close();
  }

  // ---- 對外 API（本行程 MCP 使用） ----

  sendCommand(cmd: AvatarCommand): void {
    this.toPages({ t: 'cmd', cmd });
  }

  /** 送出提問；沒有頁面時回傳 false */
  ask(ask: AskRequest, origin: PendingAsk['origin'] = 'local'): boolean {
    if (this.pages.size === 0) return false;
    this.pending.set(ask.id, { ask, origin });
    this.toPages({ t: 'ask', ask });
    return true;
  }

  cancelAsk(id: string): void {
    if (this.pending.delete(id)) this.toPages({ t: 'askCancel', id });
  }

  // ---- 內部 ----

  private toPages(msg: ToPage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.pages) ws.send(data);
  }

  private toAgent(ws: WebSocket, msg: HubToAgent): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private broadcastStatus(): void {
    for (const ws of this.agents) this.toAgent(ws, { t: 'status', pages: this.pages.size });
  }

  private addPage(ws: WebSocket): void {
    this.pages.add(ws);
    // 新頁面補上尚未回答的提問
    for (const p of this.pending.values()) ws.send(JSON.stringify({ t: 'ask', ask: p.ask } satisfies ToPage));
    this.broadcastStatus();
    ws.on('message', (raw) => {
      let msg: FromPage;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t === 'answer') this.resolveAnswer(msg.answer);
    });
    ws.on('close', () => {
      this.pages.delete(ws);
      this.broadcastStatus();
      if (this.pages.size === 0) {
        // 所有頁面都關了：提問不可能被回答
        for (const [id, p] of this.pending) this.failAsk(id, p, '頁面已關閉');
      }
    });
  }

  private resolveAnswer(answer: AskAnswer): void {
    const p = this.pending.get(answer.id);
    if (!p) return; // 已被其他頁面回答或已取消
    this.pending.delete(answer.id);
    // 其他頁面收回選項
    this.toPages({ t: 'askCancel', id: answer.id });
    if (p.origin === 'local') this.onLocalAnswer?.(answer);
    else this.toAgent(p.origin, { t: 'answer', answer });
  }

  private failAsk(id: string, p: PendingAsk, reason: string): void {
    this.pending.delete(id);
    if (p.origin === 'local') this.onLocalAskFailed?.(id, reason);
    else this.toAgent(p.origin, { t: 'askFailed', id, reason });
  }

  private addAgent(ws: WebSocket): void {
    this.agents.add(ws);
    this.toAgent(ws, { t: 'status', pages: this.pages.size });
    ws.on('message', (raw) => {
      let msg: AgentToHub;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t === 'cmd') {
        const cmd = parseCommand(msg.cmd);
        if (cmd) this.sendCommand(cmd);
      } else if (msg.t === 'ask') {
        if (!this.ask(msg.ask, ws)) this.toAgent(ws, { t: 'askFailed', id: msg.ask.id, reason: '沒有開啟的 avatar 頁面' });
      } else if (msg.t === 'askCancel') this.cancelAsk(msg.id);
    });
    ws.on('close', () => {
      this.agents.delete(ws);
      for (const [id, p] of this.pending) if (p.origin === ws) this.cancelAsk(id);
    });
  }

  private async readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new Error('payload too large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!originAllowed(req)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (req.method === 'POST' && url.pathname === '/hook') {
        const payload = JSON.parse((await this.readBody(req)) || '{}') as HookPayload;
        for (const cmd of mapHook(payload)) this.sendCommand(cmd);
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/cmd') {
        const cmd = parseCommand(JSON.parse(await this.readBody(req)));
        if (!cmd) {
          res.writeHead(422).end();
          return;
        }
        this.sendCommand(cmd);
        res.writeHead(204).end();
        return;
      }
      if (url.pathname === '/status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pages: this.pages.size, agents: this.agents.size, pendingAsks: this.pending.size }));
        return;
      }
      if (url.pathname === '/scenes/list.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ images: listSceneImages(ROOT) }));
        return;
      }
      if (url.pathname.startsWith('/scenes/')) {
        const file = sceneImagePath(ROOT, decodeURIComponent(url.pathname.slice('/scenes/'.length)));
        if (!file) {
          res.writeHead(404).end();
          return;
        }
        this.serveFile(res, file, sceneImageMime(file));
        return;
      }
      if (url.pathname === '/avatar/model.vrm') {
        this.serveFile(res, this.modelPath, 'model/gltf-binary');
        return;
      }
      // 靜態頁面（需先 npm run build）
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = resolve(DIST, rel);
      if (!file.startsWith(DIST + sep)) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(join(DIST, 'index.html'))) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('尚未打包頁面：請在專案目錄執行 npm run build（開發時可改用 npm run dev → http://127.0.0.1:5178）');
        return;
      }
      this.serveFile(res, file, MIME[extname(file)] ?? 'application/octet-stream');
    } catch {
      if (!res.headersSent) res.writeHead(400).end();
    }
  }

  private serveFile(res: ServerResponse, path: string | undefined, type: string): void {
    if (!path || !existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': statSync(path).size, 'Cache-Control': 'no-store' });
    createReadStream(path).pipe(res);
  }
}
