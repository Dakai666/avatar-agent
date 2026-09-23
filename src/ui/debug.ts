import { EMOTIONS, GAZE_TARGETS, GESTURES, STATES, type AvatarCommand } from '../protocol';
import { STATE_DEFS } from '../behavior/states';
import type { IntentScheduler, LogEntry } from '../behavior/scheduler';
import { smoothing } from '../core/spring';

/**
 * 除錯面板：手動送指令、混亂測試、平滑/排程開關、事件紀錄。
 * 目的是讓人用眼睛驗證「怎麼切都不會閃現」。
 */

const SAMPLE_LINES = [
  '你好！我是你的 agent 助手，今天要做什麼呢？',
  '嗯……這個問題有點複雜，讓我想一下。',
  '找到了！問題出在設定檔的路徑，我已經修好了。',
  '這個指令會刪除資料夾，要繼續嗎？',
  '測試全部通過了，辛苦了～',
];

const EMOTION_LABEL: Record<string, string> = {
  neutral: '平靜', joy: '開心', fun: '愉快', angry: '生氣', sorrow: '難過', surprised: '驚訝',
};
const GESTURE_LABEL: Record<string, string> = {
  nod: '點頭', shake: '搖頭', tilt: '歪頭', wave: '揮手', bounce: '雀躍', sigh: '嘆氣', lookAround: '張望',
};
const GAZE_LABEL: Record<string, string> = {
  user: '看使用者', down: '往下讀', thinkUp: '往上想', side: '看側邊', dialog: '看對話框', wander: '游移',
};

export class DebugPanel {
  private root: HTMLElement;
  private logEl: HTMLElement;
  private statusEl: HTMLElement;
  private chaosTimer = 0;

  constructor(parent: HTMLElement, private sched: IntentScheduler) {
    this.root = document.createElement('aside');
    this.root.className = 'debug';
    this.root.innerHTML = `
      <header><strong>除錯面板</strong><button class="collapse" title="收合">—</button></header>
      <div class="debug-body">
        <div class="status"></div>
        <section><h3>狀態</h3><div class="btns" data-group="state"></div></section>
        <section><h3>情緒</h3><div class="btns" data-group="emotion"></div></section>
        <section><h3>手勢</h3><div class="btns" data-group="gesture"></div></section>
        <section><h3>視線</h3><div class="btns" data-group="gaze"></div></section>
        <section><h3>說話</h3>
          <div class="say-row"><input class="say-input" placeholder="輸入台詞，Enter 送出"><button class="say-btn">說</button></div>
          <div class="btns" data-group="lines"></div>
        </section>
        <section><h3>連貫性測試</h3>
          <label><input type="checkbox" class="chaos"> 混亂模式（模擬 agent 高頻事件）</label>
          <label><input type="checkbox" class="smooth" checked> 彈簧平滑</label>
          <label><input type="checkbox" class="sched" checked> 意圖排程器</label>
        </section>
        <section class="log-section"><h3>事件紀錄</h3><div class="log"></div></section>
      </div>`;
    parent.appendChild(this.root);
    this.logEl = this.root.querySelector('.log')!;
    this.statusEl = this.root.querySelector('.status')!;

    this.root.querySelector('.collapse')!.addEventListener('click', () => this.root.classList.toggle('collapsed'));

    const group = (name: string) => this.root.querySelector(`[data-group="${name}"]`)!;
    const btn = (parentEl: Element, label: string, cmd: () => AvatarCommand) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => this.sched.send(cmd()));
      parentEl.appendChild(b);
    };
    for (const s of STATES) btn(group('state'), STATE_DEFS[s].label, () => ({ type: 'state', state: s }));
    for (const e of EMOTIONS) btn(group('emotion'), EMOTION_LABEL[e], () => ({ type: 'emotion', emotion: e, intensity: 0.85 }));
    for (const g of GESTURES) btn(group('gesture'), GESTURE_LABEL[g], () => ({ type: 'gesture', gesture: g }));
    for (const g of GAZE_TARGETS) btn(group('gaze'), GAZE_LABEL[g], () => ({ type: 'gaze', target: g, holdMs: 2500 }));
    SAMPLE_LINES.forEach((line, i) =>
      btn(group('lines'), `台詞 ${i + 1}`, () => ({ type: 'say', text: line, name: 'Agent' })),
    );

    const input = this.root.querySelector<HTMLInputElement>('.say-input')!;
    const say = () => {
      const text = input.value.trim();
      if (!text) return;
      this.sched.send({ type: 'say', text, name: 'Agent' });
      input.value = '';
    };
    input.addEventListener('keydown', (e) => e.key === 'Enter' && say());
    this.root.querySelector('.say-btn')!.addEventListener('click', say);

    this.root.querySelector<HTMLInputElement>('.chaos')!.addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).checked) this.startChaos();
      else window.clearTimeout(this.chaosTimer);
    });
    this.root.querySelector<HTMLInputElement>('.smooth')!.addEventListener('change', (e) => {
      smoothing.scale = (e.target as HTMLInputElement).checked ? 1 : 0;
    });
    this.root.querySelector<HTMLInputElement>('.sched')!.addEventListener('change', (e) => {
      this.sched.enabled = (e.target as HTMLInputElement).checked;
    });

    sched.onLog = (e) => this.appendLog(e);
  }

  /** 模擬 agent：大量工具呼叫造成的碎狀態，夾雜情緒/手勢 */
  private startChaos(): void {
    const workStates = ['thinking', 'reading', 'working', 'reading', 'working', 'thinking'] as const;
    const tick = () => {
      const r = Math.random();
      let cmd: AvatarCommand;
      if (r < 0.7) cmd = { type: 'state', state: workStates[Math.floor(Math.random() * workStates.length)] };
      else if (r < 0.8) cmd = { type: 'state', state: STATES[Math.floor(Math.random() * STATES.length)] };
      else if (r < 0.9) cmd = { type: 'gesture', gesture: GESTURES[Math.floor(Math.random() * GESTURES.length)] };
      else cmd = { type: 'emotion', emotion: EMOTIONS[Math.floor(Math.random() * EMOTIONS.length)], intensity: 0.7 };
      this.sched.send(cmd);
      this.chaosTimer = window.setTimeout(tick, 40 + Math.random() * 360);
    };
    tick();
  }

  private appendLog(e: LogEntry): void {
    const row = document.createElement('div');
    row.className = `log-${e.kind}`;
    const tag = { in: '收', apply: '套', drop: '棄', hold: '等' }[e.kind];
    row.textContent = `${(e.at / 1000).toFixed(2)}s [${tag}] ${e.text}`;
    this.logEl.prepend(row);
    while (this.logEl.childElementCount > 60) this.logEl.lastElementChild!.remove();
  }

  collapse(): void {
    this.root.classList.add('collapsed');
  }

  updateStatus(fps: number, extra: string): void {
    const s = this.sched;
    const pending = s.pendingState ? ` ⏳ ${STATE_DEFS[s.pendingState].label}` : '';
    this.statusEl.textContent = `${fps.toFixed(0)} fps · ${STATE_DEFS[s.state].label}${pending} · ${extra}`;
  }
}
