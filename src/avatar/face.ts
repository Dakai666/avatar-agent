import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { Spring, clamp } from '../core/spring';
import { rand } from '../core/noise';
import type { Emotion } from '../protocol';

/**
 * 臉部控制：直接驅動 VRoid 的 Fcl_* 分區 morph（眉 BRW / 眼 EYE / 嘴 MTH），
 * 不走 VRM 預設表情，才能自由組合、並做通道仲裁。
 *
 * 連貫性設計：
 * - 每個 morph 通道都是一顆彈簧；眉比眼快、眼比嘴快 → 表情變化時「眉先動，嘴後跟」。
 * - 眨眼是彈道動作（快閉慢開），用曲線而非彈簧，但會依眼部表情自動衰減，避免穿模。
 * - 母音嘴型優先：說話時嘴部表情自動讓位。
 */

export type FacePose = Partial<Record<string, number>>;

/** 各情緒對應的分區組合（值為滿強度時的權重） */
const EMOTION_POSES: Record<Emotion, FacePose> = {
  neutral: {},
  joy: { BRW_Joy: 0.8, EYE_Joy: 0.45, MTH_Joy: 0.55 },
  fun: { BRW_Fun: 0.7, EYE_Fun: 0.35, MTH_Fun: 0.6 },
  angry: { BRW_Angry: 0.85, EYE_Angry: 0.5, MTH_Angry: 0.45 },
  sorrow: { BRW_Sorrow: 0.85, EYE_Sorrow: 0.45, MTH_Sorrow: 0.5 },
  surprised: { BRW_Surprised: 0.9, EYE_Surprised: 0.55, MTH_Surprised: 0.45 },
};

const VOWELS = ['A', 'I', 'U', 'E', 'O'] as const;
export type Vowel = (typeof VOWELS)[number];

/** 區域反應速度（halflife 秒）：眉最快，嘴最慢 */
const REGION_HALFLIFE: Record<string, number> = { BRW: 0.09, EYE: 0.12, MTH: 0.16 };
/** 母音通道要快，才對得上音節；但仍有平滑 → 自然的協同發音 */
const VOWEL_HALFLIFE = 0.045;

/** 會「閉上眼睛」的眼部表情：它們和眨眼疊加會穿模 */
const EYE_CLOSING = ['EYE_Joy', 'EYE_Fun'];

interface Channel {
  name: string;
  spring: Spring;
  /** 所有含此 morph 的 mesh 與其 index */
  targets: { mesh: THREE.Mesh; index: number }[];
}

class BlinkScheduler {
  /** 目前眨眼閉合量 0..1 */
  value = 0;
  private t = -1;
  private next = rand(1.5, 4);
  private doubleQueued = false;
  /** 眨眼頻率倍率（專注時少眨，說話時多眨） */
  rate = 1;

  trigger(): void {
    if (this.t < 0) this.t = 0;
  }

  update(dt: number): number {
    if (this.t < 0) {
      this.next -= dt * this.rate;
      if (this.next <= 0) this.trigger();
    }
    if (this.t >= 0) {
      this.t += dt;
      const close = 0.07;
      const hold = 0.03;
      const open = 0.14;
      const t = this.t;
      if (t < close) {
        const k = t / close;
        this.value = k * k; // ease-in
      } else if (t < close + hold) {
        this.value = 1;
      } else if (t < close + hold + open) {
        const k = 1 - (t - close - hold) / open;
        this.value = k * k * (3 - 2 * k);
      } else {
        this.value = 0;
        this.t = -1;
        if (!this.doubleQueued && Math.random() < 0.15) {
          this.doubleQueued = true;
          this.next = 0.12;
        } else {
          this.doubleQueued = false;
          this.next = rand(2, 5.5);
        }
      }
    }
    return this.value;
  }
}

export class FaceController {
  private channels = new Map<string, Channel>();
  private emotionWeights = new Map<Emotion, Spring>();
  readonly blink = new BlinkScheduler();

  /** 狀態提供的臉部底色（如思考時微皺眉） */
  bias: FacePose = {};
  /** 母音目標值（由說話系統寫入） */
  readonly vowels: Record<Vowel, number> = { A: 0, I: 0, U: 0, E: 0, O: 0 };

  constructor(vrm: VRM) {
    const found = new Map<string, { mesh: THREE.Mesh; index: number }[]>();
    vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.morphTargetDictionary) return;
      for (const [raw, index] of Object.entries(mesh.morphTargetDictionary)) {
        if (!raw.startsWith('Fcl_')) continue;
        const name = raw.slice(4);
        if (!found.has(name)) found.set(name, []);
        found.get(name)!.push({ mesh, index });
      }
    });
    for (const [name, targets] of found) {
      const region = name.split('_')[0];
      const isVowel = region === 'MTH' && (VOWELS as readonly string[]).includes(name.slice(4));
      const halflife = isVowel ? VOWEL_HALFLIFE : (REGION_HALFLIFE[region] ?? 0.12);
      this.channels.set(name, { name, targets, spring: new Spring(0, halflife) });
    }
    for (const e of Object.keys(EMOTION_POSES) as Emotion[]) {
      // 情緒本身也是彈簧：情緒之間是「混合」過去，不是切換
      this.emotionWeights.set(e, new Spring(0, 0.18));
    }
  }

  get channelNames(): string[] {
    return [...this.channels.keys()];
  }

  /** 設定目標情緒；其他情緒自動淡出 */
  setEmotion(emotion: Emotion, intensity = 1): void {
    for (const [e, s] of this.emotionWeights) s.target = e === emotion ? clamp(intensity, 0, 1) : 0;
  }

  get dominantEmotion(): Emotion {
    let best: Emotion = 'neutral';
    let bestW = 0.15;
    for (const [e, s] of this.emotionWeights) {
      if (s.x > bestW) {
        best = e;
        bestW = s.x;
      }
    }
    return best;
  }

  update(dt: number): void {
    // 1) 情緒權重平滑
    for (const s of this.emotionWeights.values()) s.update(dt);

    // 2) 組合目標：情緒混合 + 狀態底色
    const target = new Map<string, number>();
    const add = (k: string, v: number) => target.set(k, (target.get(k) ?? 0) + v);
    for (const [e, s] of this.emotionWeights) {
      if (s.x < 1e-3) continue;
      for (const [k, v] of Object.entries(EMOTION_POSES[e])) add(k, (v ?? 0) * s.x);
    }
    for (const [k, v] of Object.entries(this.bias)) add(k, v ?? 0);

    // 3) 區域正規化：同區總和 > 1 時等比縮小（VRoid morph 疊太多會崩）
    for (const region of ['BRW', 'EYE', 'MTH']) {
      let sum = 0;
      for (const [k, v] of target) if (k.startsWith(region)) sum += v;
      if (sum > 1) for (const [k, v] of target) if (k.startsWith(region)) target.set(k, v / sum);
    }

    // 4) 仲裁：母音優先 → 嘴部表情讓位
    let vowelSum = 0;
    for (const v of VOWELS) vowelSum += this.vowels[v];
    const mouthYield = 1 - 0.7 * clamp(vowelSum, 0, 1);
    for (const [k, v] of target) if (k.startsWith('MTH')) target.set(k, v * mouthYield);
    for (const v of VOWELS) target.set(`MTH_${v}`, this.vowels[v] * 0.85);

    // 5) 寫入彈簧目標並推進
    for (const ch of this.channels.values()) {
      ch.spring.target = target.get(ch.name) ?? 0;
      ch.spring.update(dt);
    }

    // 6) 眨眼（在彈簧之後疊加：它是彈道動作）
    const b = this.blink.update(dt);
    let eyeClosing = 0;
    for (const k of EYE_CLOSING) eyeClosing += this.channels.get(k)?.spring.x ?? 0;
    const blinkAmount = b * (1 - clamp(eyeClosing * 1.4, 0, 1));
    this.blinkAmount = blinkAmount;
  }

  private blinkAmount = 0;

  /** 必須在 vrm.update() 之後呼叫（VRM expression manager 每幀會清零它管的 morph） */
  apply(): void {
    const b = this.blinkAmount;
    for (const ch of this.channels.values()) {
      let v = ch.spring.x;
      // 眨眼時其他眼部表情讓位，避免與 EYE_Close 疊加穿模
      if (ch.name.startsWith('EYE_') && ch.name !== 'EYE_Close') v *= 1 - b;
      if (ch.name === 'EYE_Close') v = clamp(v + b, 0, 1);
      for (const { mesh, index } of ch.targets) {
        if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = clamp(v, 0, 1);
      }
    }
  }
}
