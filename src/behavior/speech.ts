import type { Vowel } from '../avatar/face';

/**
 * 說話時間軸（Phase 1：沒有 TTS，從文字推估音節）。
 *
 * - 中文字：每字一個音節，母音由字碼雜湊決定（接上 TTS 後改用真實音素時間）。
 * - 英文：母音字母直接對應，子音短暫閉口。
 * - 標點：停頓；「！」「？」會觸發微手勢。
 *
 * 輸出：每個時間點的母音權重（交給臉部彈簧做協同發音平滑）＋ 打字機應顯示到第幾個字。
 */

export interface Syllable {
  /** 開始時間（秒） */
  start: number;
  duration: number;
  vowel: Vowel | null;
  amp: number;
  /** 這個音節結束時，對話框應顯示到的字元索引（不含） */
  revealTo: number;
  cue?: 'exclaim' | 'question' | 'pause';
}

const CJK = /[㐀-鿿豈-﫿]/;
const KANA = /[぀-ヿ]/;
const SHORT_PAUSE = /[，、,；;：:]/;
const LONG_PAUSE = /[。．.…～~\n]/;
const VOWEL_TABLE: Vowel[] = ['A', 'A', 'A', 'O', 'O', 'E', 'E', 'I', 'I', 'U'];

function hashVowel(code: number): Vowel {
  const h = Math.abs(Math.sin(code * 12.9898) * 43758.5453) % 1;
  return VOWEL_TABLE[Math.floor(h * VOWEL_TABLE.length)];
}

export function buildTimeline(text: string, charsPerSecond = 6.5): Syllable[] {
  const out: Syllable[] = [];
  let t = 0;
  const base = 1 / charsPerSecond;
  const chars = [...text];
  let idx = 0;
  for (const ch of chars) {
    idx += ch.length; // revealTo 以 UTF-16 索引計
    const code = ch.codePointAt(0)!;
    if (CJK.test(ch) || KANA.test(ch)) {
      const d = base * (0.85 + Math.random() * 0.3);
      out.push({ start: t, duration: d, vowel: hashVowel(code), amp: 0.65 + Math.random() * 0.35, revealTo: idx });
      t += d;
    } else if (/[aeiouAEIOU]/.test(ch)) {
      const d = base * 0.55;
      out.push({ start: t, duration: d, vowel: ch.toUpperCase() as Vowel, amp: 0.8, revealTo: idx });
      t += d;
    } else if (/[a-zA-Z0-9]/.test(ch)) {
      const d = base * 0.3;
      out.push({ start: t, duration: d, vowel: null, amp: 0, revealTo: idx });
      t += d;
    } else if (ch === '！' || ch === '!') {
      out.push({ start: t, duration: base * 2.5, vowel: null, amp: 0, revealTo: idx, cue: 'exclaim' });
      t += base * 2.5;
    } else if (ch === '？' || ch === '?') {
      out.push({ start: t, duration: base * 2.5, vowel: null, amp: 0, revealTo: idx, cue: 'question' });
      t += base * 2.5;
    } else if (LONG_PAUSE.test(ch)) {
      out.push({ start: t, duration: base * 2.8, vowel: null, amp: 0, revealTo: idx, cue: 'pause' });
      t += base * 2.8;
    } else if (SHORT_PAUSE.test(ch)) {
      out.push({ start: t, duration: base * 1.6, vowel: null, amp: 0, revealTo: idx, cue: 'pause' });
      t += base * 1.6;
    } else {
      out.push({ start: t, duration: base * 0.2, vowel: null, amp: 0, revealTo: idx });
      t += base * 0.2;
    }
  }
  return out;
}

export class SpeechPlayer {
  private timeline: Syllable[] = [];
  private t = 0;
  private cursor = 0;
  private cued = -1;
  playing = false;
  revealed = 0;
  text = '';
  readonly vowels: Record<Vowel, number> = { A: 0, I: 0, U: 0, E: 0, O: 0 };

  constructor(private onCue: (cue: NonNullable<Syllable['cue']>) => void) {}

  start(text: string): void {
    this.text = text;
    this.timeline = buildTimeline(text);
    this.t = 0;
    this.cursor = 0;
    this.cued = -1;
    this.revealed = 0;
    this.playing = true;
  }

  /** 立刻結束（嘴型經彈簧自然閉合，不會瞬間歸零） */
  finish(): void {
    this.playing = false;
    this.revealed = this.text.length;
    for (const k of Object.keys(this.vowels) as Vowel[]) this.vowels[k] = 0;
  }

  get duration(): number {
    const last = this.timeline[this.timeline.length - 1];
    return last ? last.start + last.duration : 0;
  }

  update(dt: number): void {
    for (const k of Object.keys(this.vowels) as Vowel[]) this.vowels[k] = 0;
    if (!this.playing) return;
    this.t += dt;
    while (this.cursor < this.timeline.length && this.timeline[this.cursor].start + this.timeline[this.cursor].duration <= this.t) {
      const s = this.timeline[this.cursor];
      this.revealed = s.revealTo;
      this.cursor++;
    }
    const cur = this.timeline[this.cursor];
    if (!cur) {
      this.finish();
      return;
    }
    // 音節開始時觸發標點提示
    if (cur.cue && this.cued !== this.cursor) {
      this.cued = this.cursor;
      this.onCue(cur.cue);
    }
    // 音節內包絡：快速張開、維持、收合
    if (cur.vowel) {
      const u = (this.t - cur.start) / cur.duration;
      const env = u < 0.3 ? u / 0.3 : u > 0.75 ? Math.max(0, (1 - u) / 0.25) : 1;
      this.vowels[cur.vowel] = env * cur.amp;
      // 字元在音節一開始就顯示，看起來「字與嘴同步」
      this.revealed = Math.max(this.revealed, cur.revealTo);
    }
  }
}
