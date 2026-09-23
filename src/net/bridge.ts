import { BRIDGE_HOST, BRIDGE_PORT, type AskAnswer, type AskRequest, type FromPage, type ToPage } from '../bridgeProtocol';
import type { AvatarCommand } from '../protocol';

/**
 * 頁面端橋接：連到本機 hub，收指令 / 提問，回傳答案。
 * hub 可能隨 session 開關而換手，所以斷線後持續以退避重連。
 */

export type BridgeStatus = 'connecting' | 'online' | 'offline';

export class Bridge {
  private ws: WebSocket | null = null;
  private retry = 0;
  status: BridgeStatus = 'connecting';

  onCommand?: (cmd: AvatarCommand) => void;
  onAsk?: (ask: AskRequest) => void;
  onAskCancel?: (id: string) => void;
  onStatus?: (s: BridgeStatus) => void;

  connect(): void {
    this.setStatus(this.retry === 0 ? 'connecting' : 'offline');
    const ws = new WebSocket(`ws://${BRIDGE_HOST}:${BRIDGE_PORT}/ws?role=page`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('online');
      this.send({ t: 'hello', version: 1 });
    };
    ws.onmessage = (e) => {
      let msg: ToPage;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.t === 'cmd') this.onCommand?.(msg.cmd);
      else if (msg.t === 'ask') this.onAsk?.(msg.ask);
      else if (msg.t === 'askCancel') this.onAskCancel?.(msg.id);
    };
    ws.onclose = () => {
      this.ws = null;
      this.setStatus('offline');
      const delay = Math.min(2000, 400 * 2 ** this.retry++);
      window.setTimeout(() => this.connect(), delay);
    };
  }

  answer(a: AskAnswer): void {
    this.send({ t: 'answer', answer: a });
  }

  private send(msg: FromPage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private setStatus(s: BridgeStatus): void {
    if (s === this.status) return;
    this.status = s;
    this.onStatus?.(s);
  }
}
