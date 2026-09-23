import type { AskRequest } from '../bridgeProtocol';
import type { DialogBox } from '../ui/dialog';
import type { IntentScheduler } from './scheduler';

/**
 * 提問流程：角色唸出問題 → 進入「等待回應」→ 選項浮現 → 使用者回答 → 點頭、回到思考。
 * 一次只處理一個提問，其餘排隊。
 */
export class AskFlow {
  private queue: AskRequest[] = [];
  private current: AskRequest | null = null;

  constructor(
    private sched: IntentScheduler,
    private dialog: DialogBox,
    private reply: (id: string, index: number, text: string) => void,
  ) {}

  enqueue(ask: AskRequest): void {
    if (this.current?.id === ask.id || this.queue.some((q) => q.id === ask.id)) return;
    this.queue.push(ask);
    if (!this.current) this.next();
  }

  cancel(id: string): void {
    this.queue = this.queue.filter((q) => q.id !== id);
    if (this.current?.id !== id) return;
    this.current = null;
    this.dialog.clearChoices(id);
    this.sched.send({ type: 'state', state: 'idle', reason: 'ask cancelled' });
    this.next();
  }

  private next(): void {
    const ask = this.queue.shift();
    if (!ask) return;
    this.current = ask;
    // say 先、state 後：說話期間收到的狀態會在唸完後套用 → 唸完進入「等待回應」
    this.sched.send({ type: 'say', text: ask.question, name: ask.name });
    this.sched.send({ type: 'state', state: 'waiting', reason: 'ask' });
    this.dialog.showChoices({
      id: ask.id,
      options: ask.options,
      allowText: ask.allowText,
      onAnswer: (index, text) => this.answered(ask, index, text),
    });
  }

  private answered(ask: AskRequest, index: number, text: string): void {
    if (this.current?.id !== ask.id) return;
    this.current = null;
    this.reply(ask.id, index, text);
    this.dialog.showUserLine('你', text);
    // 收到回答：點頭、微笑，然後繼續工作（agent 會接著動作）
    this.sched.send({ type: 'gesture', gesture: 'nod' });
    this.sched.send({ type: 'emotion', emotion: 'joy', intensity: 0.5, holdMs: 1200 });
    this.sched.send({ type: 'state', state: 'thinking', reason: 'answered' });
    window.setTimeout(() => this.next(), 900);
  }
}
