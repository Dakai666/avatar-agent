import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { AvatarCommand } from '../src/protocol.ts';
import {
  BRIDGE_HOST,
  BRIDGE_PORT,
  type AgentToHub,
  type AskAnswer,
  type AskRequest,
  type HubToAgent,
} from '../src/bridgeProtocol.ts';
import { Hub } from './hub.ts';

/**
 * MCP 行程與 avatar 之間的連線，自動在兩種模式間切換：
 *   hub   ：本行程持有 port，直接管理頁面
 *   relay ：port 已被別的 session 占用，透過 WebSocket 轉給那個 hub
 * relay 斷線時會嘗試接手成為 hub，所以任何一個 session 關掉都不影響其他 session。
 */

export type AskResult =
  | { ok: true; answer: AskAnswer }
  | { ok: false; reason: 'no-page' | 'timeout' | 'failed'; detail?: string };

interface Waiter {
  resolve: (r: AskResult) => void;
  timer: NodeJS.Timeout;
}

const log = (...args: unknown[]) => console.error('[avatar]', ...args); // stdout 保留給 MCP

export class AvatarLink {
  private hub: Hub | null = null;
  private relay: WebSocket | null = null;
  private relayPages = 0;
  private waiters = new Map<string, Waiter>();
  private closed = false;
  readonly port: number;

  constructor(port = BRIDGE_PORT) {
    this.port = port;
  }

  get mode(): 'hub' | 'relay' | 'connecting' {
    if (this.hub) return 'hub';
    if (this.relay?.readyState === WebSocket.OPEN) return 'relay';
    return 'connecting';
  }

  get pageCount(): number {
    if (this.hub) return this.hub.pageCount;
    return this.mode === 'relay' ? this.relayPages : 0;
  }

  get pageUrl(): string {
    return `http://${BRIDGE_HOST}:${this.port}/`;
  }

  async start(): Promise<void> {
    if (this.closed) return;
    const hub = await Hub.tryStart(this.port);
    if (hub) {
      this.hub = hub;
      hub.onLocalAnswer = (a) => this.settle(a.id, { ok: true, answer: a });
      hub.onLocalAskFailed = (id, reason) => this.settle(id, { ok: false, reason: 'failed', detail: reason });
      log(`hub 模式，頁面：${this.pageUrl}`);
      return;
    }
    await this.connectRelay();
  }

  private connectRelay(): Promise<void> {
    return new Promise((res) => {
      const ws = new WebSocket(`ws://${BRIDGE_HOST}:${this.port}/ws?role=agent`);
      let opened = false;
      ws.on('open', () => {
        opened = true;
        this.relay = ws;
        log('relay 模式（hub 由其他 session 持有）');
        res();
      });
      ws.on('message', (raw) => {
        let msg: HubToAgent;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (msg.t === 'status') this.relayPages = msg.pages;
        else if (msg.t === 'answer') this.settle(msg.answer.id, { ok: true, answer: msg.answer });
        else if (msg.t === 'askFailed') {
          const noPage = msg.reason.includes('沒有開啟');
          this.settle(msg.id, { ok: false, reason: noPage ? 'no-page' : 'failed', detail: msg.reason });
        }
      });
      ws.on('error', () => {}); // close 事件會處理
      ws.on('close', () => {
        this.relay = null;
        this.relayPages = 0;
        for (const id of [...this.waiters.keys()]) this.settle(id, { ok: false, reason: 'failed', detail: '與 hub 斷線' });
        if (!opened) res();
        // hub 所屬的 session 結束了 → 嘗試接手
        if (!this.closed) setTimeout(() => void this.start(), 300 + Math.random() * 700);
      });
    });
  }

  private sendRelay(msg: AgentToHub): boolean {
    if (this.relay?.readyState !== WebSocket.OPEN) return false;
    this.relay.send(JSON.stringify(msg));
    return true;
  }

  /** 送出指令；回傳是否有頁面會收到 */
  send(cmd: AvatarCommand): boolean {
    if (this.hub) {
      this.hub.sendCommand(cmd);
      return this.hub.pageCount > 0;
    }
    return this.sendRelay({ t: 'cmd', cmd }) && this.relayPages > 0;
  }

  ask(req: Omit<AskRequest, 'id'>, timeoutMs: number): Promise<AskResult> {
    const ask: AskRequest = { ...req, id: randomUUID() };
    return new Promise((resolve) => {
      if (this.pageCount === 0) {
        resolve({ ok: false, reason: 'no-page' });
        return;
      }
      const timer = setTimeout(() => {
        this.cancel(ask.id);
        this.settle(ask.id, { ok: false, reason: 'timeout' });
      }, timeoutMs);
      this.waiters.set(ask.id, { resolve, timer });
      const sent = this.hub ? this.hub.ask(ask) : this.sendRelay({ t: 'ask', ask });
      if (!sent) this.settle(ask.id, { ok: false, reason: 'no-page' });
    });
  }

  private cancel(id: string): void {
    if (this.hub) this.hub.cancelAsk(id);
    else this.sendRelay({ t: 'askCancel', id });
  }

  private settle(id: string, r: AskResult): void {
    const w = this.waiters.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    this.waiters.delete(id);
    w.resolve(r);
  }

  close(): void {
    this.closed = true;
    this.hub?.close();
    this.relay?.close();
  }
}
