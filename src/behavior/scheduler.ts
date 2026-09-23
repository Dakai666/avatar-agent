import type { AvatarCommand, AvatarState, Emotion, Gesture } from '../protocol';
import type { FaceController } from '../avatar/face';
import type { BodyController } from '../avatar/body';
import type { GazeController } from '../avatar/gaze';
import { STATE_DEFS } from './states';
import { SpeechPlayer } from './speech';

/**
 * 意圖排程器：刻意用少量延遲換連貫性。
 *
 * 1. 合併窗口：狀態指令先等 COALESCE_MS，窗口內只保留最後一個（agent 連續呼叫工具時不會抖動）。
 * 2. 最短停留：目前狀態未滿 minDwell 不切換（除非新狀態優先級更高）。
 * 3. 出口點：手勢即將結束（或等待逾時）才切狀態，不在點頭一半時被拉走。
 * 4. 預備動作：說話前先「吸氣、看向使用者」再開口。
 * 5. 情緒衰減：臨時情緒 holdMs 後回到狀態預設情緒。
 */

const COALESCE_MS = 200;
const GESTURE_EXIT_WAIT_MAX = 700;
const SPEECH_PREP_MS = 280;
const SPEECH_TAIL_MS = 700;
const GESTURE_QUEUE_MAX = 2;

export interface LogEntry {
  at: number;
  kind: 'in' | 'apply' | 'drop' | 'hold';
  text: string;
}

export class IntentScheduler {
  state: AvatarState = 'idle';
  private stateSince = 0;
  private pending: { state: AvatarState; at: number; firstAt: number } | null = null;
  private gestureQueue: Gesture[] = [];
  private emotionUntil = 0;
  private speech: SpeechPlayer;
  private speechPhase: 'none' | 'prep' | 'talk' | 'tail' = 'none';
  private speechPhaseAt = 0;
  private stateBeforeSpeech: AvatarState = 'idle';
  private queuedSay: { text: string; emotion?: Emotion; name?: string }[] = [];
  private now = 0;

  /** 關閉時：指令立即套用（除錯比較用） */
  enabled = true;
  readonly log: LogEntry[] = [];
  onLog?: (e: LogEntry) => void;
  onDialog?: (d: { name: string; text: string; revealed: number; speaking: boolean } | null) => void;
  private dialogName = '';

  constructor(
    private face: FaceController,
    private body: BodyController,
    private gaze: GazeController,
  ) {
    this.speech = new SpeechPlayer((cue) => {
      if (cue === 'exclaim') this.body.playGesture('nod');
      else if (cue === 'question') this.body.playGesture('tilt');
      else if (cue === 'pause' && Math.random() < 0.5) this.face.blink.trigger();
    });
    this.applyState('idle', true);
  }

  private emit(kind: LogEntry['kind'], text: string): void {
    const e = { at: this.now, kind, text };
    this.log.push(e);
    if (this.log.length > 200) this.log.shift();
    this.onLog?.(e);
  }

  send(cmd: AvatarCommand): void {
    this.emit('in', describe(cmd));
    switch (cmd.type) {
      case 'state':
        if (!this.enabled) {
          this.applyState(cmd.state);
          return;
        }
        if (this.pending && this.pending.state !== cmd.state) this.emit('drop', `合併：捨棄 ${this.pending.state}`);
        this.pending = { state: cmd.state, at: this.now, firstAt: this.pending?.firstAt ?? this.now };
        return;
      case 'emotion':
        this.face.setEmotion(cmd.emotion, cmd.intensity ?? 0.8);
        this.emotionUntil = this.now + (cmd.holdMs ?? 2500);
        this.emit('apply', `情緒 ${cmd.emotion}`);
        return;
      case 'gesture':
        if (!this.enabled) {
          this.startGesture(cmd.gesture);
          return;
        }
        this.gestureQueue.push(cmd.gesture);
        while (this.gestureQueue.length > GESTURE_QUEUE_MAX) {
          this.emit('drop', `手勢佇列滿：捨棄 ${this.gestureQueue.shift()}`);
        }
        return;
      case 'gaze':
        this.gaze.setOverride(cmd.target, cmd.holdMs ?? 1800);
        this.emit('apply', `視線 ${cmd.target}`);
        return;
      case 'say':
        if (this.speechPhase !== 'none' && this.speechPhase !== 'tail') {
          this.queuedSay.push(cmd);
          this.emit('hold', '說話中：排隊');
          return;
        }
        this.beginSpeech(cmd);
        return;
    }
  }

  private startGesture(g: Gesture): void {
    if (g === 'lookAround') {
      this.gaze.setOverride('wander', 2600);
      this.gaze.energy = 1.6;
      setTimeout(() => (this.gaze.energy = 1), 2600);
    } else {
      this.body.playGesture(g);
    }
    this.emit('apply', `手勢 ${g}`);
  }

  private applyState(state: AvatarState, initial = false): void {
    const def = STATE_DEFS[state];
    const prev = this.state;
    this.state = state;
    this.stateSince = this.now;
    this.body.setPose(def.pose);
    this.body.energy.target = def.energy;
    this.body.breathRate.target = def.breath;
    this.body.typing.target = def.typing ? 1 : 0;
    this.face.bias = def.face;
    if (this.now >= this.emotionUntil) this.face.setEmotion(def.emotion.emotion, def.emotion.intensity);
    this.face.blink.rate = def.blinkRate;
    this.gaze.setBase(def.gaze);
    this.gaze.energy = def.energy;
    // 轉換時的自然眨眼（狀態切換常伴隨視線轉移）
    if (!initial && prev !== state && Math.random() < 0.5) this.face.blink.trigger();
    if (!initial && def.enterGesture) this.gestureQueue.unshift(def.enterGesture);
    if (!initial) this.emit('apply', `狀態 ${prev} → ${state}`);
  }

  private beginSpeech(cmd: { text: string; emotion?: Emotion; name?: string }): void {
    if (this.state !== 'speaking') this.stateBeforeSpeech = this.state;
    this.dialogName = cmd.name ?? '';
    if (cmd.emotion) {
      this.face.setEmotion(cmd.emotion, 0.7);
      this.emotionUntil = this.now + 1e9; // 說話期間維持
    }
    // 預備：先進入說話姿態、看向使用者、吸一口氣，再開口
    this.applyState('speaking');
    this.pending = null;
    this.gaze.setOverride('user', SPEECH_PREP_MS + 400);
    this.body.breathRate.x = 0.6; // 瞬間加快呼吸 → 吸氣感
    this.speechPhase = 'prep';
    this.speechPhaseAt = this.now;
    this.speech.text = cmd.text;
    this.onDialog?.({ name: this.dialogName, text: cmd.text, revealed: 0, speaking: true });
  }

  /** 對話框被點擊：跳過打字機 */
  skipSpeech(): void {
    if (this.speechPhase === 'talk' || this.speechPhase === 'prep') {
      this.speech.finish();
      this.speechPhase = 'tail';
      this.speechPhaseAt = this.now;
    }
  }

  update(dtSec: number): void {
    this.now += dtSec * 1000;
    const now = this.now;

    // --- 說話流程 ---
    if (this.speechPhase === 'prep' && now - this.speechPhaseAt >= SPEECH_PREP_MS) {
      this.speech.start(this.speech.text);
      this.speechPhase = 'talk';
    }
    this.speech.update(dtSec);
    for (const k of Object.keys(this.face.vowels) as (keyof typeof this.face.vowels)[]) {
      this.face.vowels[k] = this.speech.vowels[k];
    }
    if (this.speechPhase === 'talk' || this.speechPhase === 'prep') {
      this.onDialog?.({ name: this.dialogName, text: this.speech.text, revealed: this.speech.revealed, speaking: true });
      if (this.speechPhase === 'talk' && !this.speech.playing) {
        this.speechPhase = 'tail';
        this.speechPhaseAt = now;
      }
    }
    if (this.speechPhase === 'tail') {
      this.onDialog?.({ name: this.dialogName, text: this.speech.text, revealed: this.speech.text.length, speaking: false });
      const next = this.queuedSay.shift();
      if (next) {
        this.beginSpeech(next);
      } else if (now - this.speechPhaseAt >= SPEECH_TAIL_MS) {
        this.speechPhase = 'none';
        this.emotionUntil = now + 800; // 說完後表情再留一下才回去
        // 說話期間若有新狀態進來，pending 會接手；否則回到說話前的狀態
        if (!this.pending) this.pending = { state: this.stateBeforeSpeech === 'speaking' ? 'idle' : this.stateBeforeSpeech, at: now - COALESCE_MS, firstAt: now };
      }
    }

    // --- 狀態切換閘門 ---
    if (this.pending && this.speechPhase === 'none') {
      const p = this.pending;
      const cur = STATE_DEFS[this.state];
      const next = STATE_DEFS[p.state];
      const coalesced = now - p.at >= COALESCE_MS;
      const dwellOk = now - this.stateSince >= cur.minDwell || next.priority > cur.priority;
      const gestureOk = this.body.gestureRemaining < 0.2 || now - p.firstAt > GESTURE_EXIT_WAIT_MAX;
      if (p.state === this.state) {
        this.pending = null;
      } else if (coalesced && dwellOk && gestureOk) {
        this.pending = null;
        this.applyState(p.state);
      }
    } else if (this.pending && this.speechPhase !== 'none') {
      // 說話中收到的狀態：說完再套用（記住最後一個）
      this.stateBeforeSpeech = this.pending.state;
      this.pending = null;
    }

    // --- 手勢佇列：前一個接近尾聲才播下一個 ---
    if (this.gestureQueue.length && this.body.gestureRemaining < 0.15) {
      this.startGesture(this.gestureQueue.shift()!);
    }

    // --- 情緒衰減回狀態預設 ---
    if (this.emotionUntil > 0 && now >= this.emotionUntil && this.speechPhase === 'none') {
      this.emotionUntil = 0;
      const def = STATE_DEFS[this.state];
      this.face.setEmotion(def.emotion.emotion, def.emotion.intensity);
    }
  }

  get pendingState(): AvatarState | null {
    return this.pending?.state ?? null;
  }
}

function describe(cmd: AvatarCommand): string {
  switch (cmd.type) {
    case 'state':
      return `state:${cmd.state}`;
    case 'emotion':
      return `emotion:${cmd.emotion}`;
    case 'gesture':
      return `gesture:${cmd.gesture}`;
    case 'gaze':
      return `gaze:${cmd.target}`;
    case 'say':
      return `say:「${cmd.text.slice(0, 12)}${cmd.text.length > 12 ? '…' : ''}」`;
  }
}
