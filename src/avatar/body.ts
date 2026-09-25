import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { QuatSpring, Spring } from '../core/spring';
import { fbm1 } from '../core/noise';
import type { Gesture } from '../protocol';
import { GESTURE_DEFS, type GestureFrame } from './gestures';
import type { GazeController } from './gaze';
import { RELAXED, TORSO_BONES, armToQuats, eulerToQuat, type Pose, type TorsoBone, type Vec3 } from './pose';

/**
 * 身體控制：分層合成，每層各自平滑，最後相乘。
 *
 *   狀態姿勢（慢彈簧，0.25~0.4s）
 *   × 視線（胸/頸/頭，由 GazeController 平滑）
 *   × 手勢疊加層（曲線 × 淡入淡出權重）
 *   × idle 微動 + 呼吸（雜訊，本身即連續）
 *
 * 任何一層的目標跳變，都只會改變該層彈簧的「目標」，輸出永遠連續。
 */

const FINGERS = ['Index', 'Middle', 'Ring', 'Little'] as const;
const SEGMENTS = ['Proximal', 'Intermediate', 'Distal'] as const;
type Side = 'left' | 'right';

/** 打字時手指懸在鍵盤上的額外彎曲（依指節） */
const TYPING_HOVER = [0.28, 0.32, 0.12];
/** 按鍵時的額外彎曲（依指節） */
const TAP_CURL = [0.38, 0.22, 0.08];
/** 各手指被選中按鍵的機率權重（食指、中指最常用） */
const TAP_WEIGHT = [0.38, 0.3, 0.2, 0.12];

/** 各骨頭狀態層的反應速度：下盤穩、上身慢、頭較快、手臂居中 */
const HALFLIFE: Partial<Record<string, number>> = {
  hips: 0.4,
  spine: 0.38,
  chest: 0.34,
  upperChest: 0.3,
  neck: 0.26,
  head: 0.22,
  leftShoulder: 0.28,
  rightShoulder: 0.28,
  leftUpperArm: 0.3,
  rightUpperArm: 0.3,
  leftLowerArm: 0.26,
  rightLowerArm: 0.26,
  leftHand: 0.2,
  rightHand: 0.2,
};

interface ActiveGesture {
  name: Gesture;
  t: number;
  duration: number;
  weight: Spring;
  frame: GestureFrame;
}

export class BodyController {
  private nodes = new Map<string, THREE.Object3D>();
  private springs = new Map<string, QuatSpring>();
  private hipsRestY = 0;
  /**
   * 姿勢一律以「面向 +Z、+X 為角色左手」撰寫。VRM 0.x 的骨骼局部座標是面向 -Z，
   * rotateVRM0 只轉了根節點，所以寫入骨頭前要繞 Y 軸 180° 共軛：(x,y,z,w) → (-x,y,-z,w)。
   */
  private flip: boolean;
  private gestures: ActiveGesture[] = [];
  /** idle 雜訊的相位：以積分累加，速度改變時相位仍連續（不可用 clock × 速度） */
  private noisePhase = 0;
  private breathPhase = 0;
  private fingerNodes: Record<Side, (THREE.Object3D | null)[][]> = { left: [], right: [] };
  /** 每根手指的按鍵彈簧（0 = 懸空、1 = 按下）：按鍵只是短暫把目標推到 1 再放回 0 */
  private taps: Record<Side, Spring[]> = {
    left: FINGERS.map(() => new Spring(0, 0.035)),
    right: FINGERS.map(() => new Spring(0, 0.035)),
  };
  private tapRelease: Record<Side, number[]> = { left: [0, 0, 0, 0], right: [0, 0, 0, 0] };
  private nextTap: Record<Side, number> = { left: 0, right: 0.12 };

  /** 打字權重（0~1）：由狀態設定目標，手指與手腕的打字動作都乘上它 */
  readonly typing = new Spring(0, 0.25);
  /** 說話中（0~1）：頭部隨說話輕微擺動 */
  readonly speaking = new Spring(0, 0.3);
  /** 目前發聲強度（母音總和，0~1）：重音時頭微微下點 */
  readonly voice = new Spring(0, 0.12);

  /** idle 活躍度：雜訊幅度與速度 */
  readonly energy = new Spring(1, 0.6);
  /** 呼吸頻率（次/秒） */
  readonly breathRate = new Spring(0.26, 0.8);

  constructor(
    private vrm: VRM,
    private gaze: GazeController,
  ) {
    this.flip = vrm.meta.metaVersion === '0';
    const names: string[] = [
      ...TORSO_BONES,
      'leftUpperArm',
      'rightUpperArm',
      'leftLowerArm',
      'rightLowerArm',
    ];
    for (const n of names) {
      const node = vrm.humanoid.getNormalizedBoneNode(n as VRMHumanBoneName);
      if (!node) continue;
      this.nodes.set(n, node);
      this.springs.set(n, new QuatSpring(HALFLIFE[n] ?? 0.3));
    }
    this.hipsRestY = this.nodes.get('hips')?.position.y ?? 0;
    this.relaxFingers();
    this.setPose({});
    // 初始直接到位，不要從 T-pose 慢慢放下
    for (const s of this.springs.values()) s.x.copy(s.target);
  }

  private get axisSign(): number {
    return this.flip ? -1 : 1;
  }

  /** 收集手指骨；大拇指是靜態的自然微彎 */
  private relaxFingers(): void {
    for (const side of ['left', 'right'] as const) {
      const sign = side === 'left' ? -1 : 1;
      this.fingerNodes[side] = FINGERS.map((f) =>
        SEGMENTS.map((seg) => this.vrm.humanoid.getNormalizedBoneNode(`${side}${f}${seg}` as VRMHumanBoneName)),
      );
      const thumb = this.vrm.humanoid.getNormalizedBoneNode(`${side}ThumbProximal` as VRMHumanBoneName);
      if (thumb) thumb.rotation.set(0, sign * -0.25, this.axisSign * sign * 0.1);
    }
    this.updateFingers(0);
  }

  /** 手指彎曲 = 自然微彎 + 打字懸空 + 按鍵；全部來自彈簧輸出 */
  private updateFingers(dt: number): void {
    const typing = this.typing.x;
    for (const side of ['left', 'right'] as const) {
      const sign = side === 'left' ? -1 : 1;
      const taps = this.taps[side];
      const release = this.tapRelease[side];
      // 排程下一次按鍵（只在打字時）；每次按下約 70ms 後放開
      this.nextTap[side] -= dt;
      if (this.typing.target > 0 && this.nextTap[side] <= 0) {
        let r = Math.random();
        let fi = 0;
        while (fi < TAP_WEIGHT.length - 1 && r > TAP_WEIGHT[fi]) r -= TAP_WEIGHT[fi++];
        taps[fi].target = 1;
        release[fi] = 0.06 + Math.random() * 0.04;
        this.nextTap[side] = 0.09 + Math.random() * 0.22 + (Math.random() < 0.12 ? 0.4 : 0);
      }
      FINGERS.forEach((_, fi) => {
        if (release[fi] > 0) {
          release[fi] -= dt;
          if (release[fi] <= 0) taps[fi].target = 0;
        }
        const tap = taps[fi].update(dt) * typing;
        this.fingerNodes[side][fi]?.forEach((node, si) => {
          if (!node) return;
          const curl = 0.18 + si * 0.1 + fi * 0.04 + typing * TYPING_HOVER[si] + tap * TAP_CURL[si];
          node.rotation.set(0, 0, this.axisSign * sign * curl);
        });
      });
    }
  }

  /** 按鍵活動量（0~1）：讓手腕跟著手指輕微起伏 */
  private tapActivity(side: Side): number {
    let a = 0;
    for (const t of this.taps[side]) a = Math.max(a, t.x);
    return a * this.typing.x;
  }

  /** 設定狀態姿勢（只改彈簧目標） */
  setPose(pose: Pose): void {
    const euler = { ...RELAXED.euler, ...pose.euler } as Partial<Record<TorsoBone, Vec3>>;
    for (const b of TORSO_BONES) {
      const s = this.springs.get(b);
      if (s) eulerToQuat(euler[b], s.target);
    }
    for (const side of ['left', 'right'] as const) {
      const arm = pose[side] ?? RELAXED[side];
      const up = this.springs.get(`${side}UpperArm`);
      const lo = this.springs.get(`${side}LowerArm`);
      if (up && lo) armToQuats(side, arm, up.target, lo.target);
      const hand = this.springs.get(`${side}Hand`);
      if (hand) eulerToQuat(arm.hand ?? euler[`${side}Hand`], hand.target);
    }
  }

  /** 播放手勢；正在播放的手勢會淡出（不是切斷） */
  playGesture(name: Gesture): void {
    if (name === 'lookAround') return; // 由視線系統處理
    const def = GESTURE_DEFS[name];
    // 被打斷的手勢放慢淡出（手臂類幅度大，要更慢），避免被「拉走」
    for (const g of this.gestures) {
      if (g.weight.target === 0) continue;
      g.weight.target = 0;
      g.weight.halflife = g.frame.left || g.frame.right ? 0.22 : 0.12;
    }
    const weight = new Spring(0, 0.06);
    weight.target = 1;
    this.gestures.push({ name, t: 0, duration: def.duration, weight, frame: def.sample(0) });
  }

  /** 目前主要手勢剩餘時間（秒）；排程器用來等「出口點」 */
  get gestureRemaining(): number {
    const g = this.gestures.find((x) => x.weight.target > 0);
    return g ? Math.max(0, g.duration - g.t) : 0;
  }

  get activeGesture(): Gesture | null {
    return this.gestures.find((x) => x.weight.target > 0)?.name ?? null;
  }

  update(dt: number): void {
    const energy = this.energy.update(dt);
    const breathRate = this.breathRate.update(dt);
    this.breathPhase += dt * breathRate * Math.PI * 2;
    this.noisePhase += dt * (0.35 + energy * 0.25);

    // --- 手勢推進 ---
    for (const g of this.gestures) {
      g.t += dt;
      if (g.t >= g.duration) g.weight.target = 0;
      g.weight.update(dt);
      g.frame = GESTURE_DEFS[g.name as keyof typeof GESTURE_DEFS].sample(Math.min(g.t, g.duration));
    }
    this.gestures = this.gestures.filter((g) => !(g.weight.target === 0 && g.weight.x < 0.005));

    // --- 狀態層 ---
    for (const s of this.springs.values()) s.update(dt);
    const typing = this.typing.update(dt);
    const speaking = this.speaking.update(dt);
    const voice = this.voice.update(dt);
    this.updateFingers(dt);

    const q = new THREE.Quaternion();
    const tmp = new THREE.Quaternion();
    const e = new THREE.Euler();

    // 呼吸：吸氣時胸口微抬、肩膀上提
    const breath = Math.sin(this.breathPhase);
    const breathIn = (breath + 1) / 2;
    const t = this.noisePhase;
    const n = (seed: number, amp: number) => fbm1(t + seed * 7.3, seed) * amp * energy;

    const idle: Partial<Record<string, Vec3>> = {
      hips: [0, n(1, 0.012), n(2, 0.01)],
      spine: [n(3, 0.01), n(4, 0.012), n(5, 0.012)],
      chest: [-breath * 0.012, 0, 0],
      upperChest: [-breath * 0.01, 0, 0],
      // 說話：低頻的左右/歪頭擺動 + 隨發聲強度輕點頭
      neck: [n(6, 0.012) + voice * 0.02, n(7, 0.015) + n(21, 0.05) * speaking, n(8, 0.01)],
      head: [n(9, 0.02) + n(20, 0.06) * speaking + voice * 0.05, n(10, 0.025) + n(22, 0.11) * speaking, n(11, 0.018) + n(23, 0.07) * speaking],
      leftShoulder: [0, 0, breathIn * 0.018],
      rightShoulder: [0, 0, -breathIn * 0.018],
      leftUpperArm: [n(12, 0.015), 0, n(13, 0.012)],
      rightUpperArm: [n(14, 0.015), 0, n(15, 0.012)],
      // 打字：手腕隨按鍵輕壓，加上在鍵盤上小幅游移
      leftHand: [0, n(16, 0.06) * typing, (-this.tapActivity('left') * 0.05 + n(17, 0.03)) * typing],
      rightHand: [0, n(18, 0.06) * typing, (this.tapActivity('right') * 0.05 + n(19, 0.03)) * typing],
    };

    // 視線分配到身體
    const gazeRot: Partial<Record<string, Vec3>> = {
      spine: [this.gaze.chestPitch.x * 0.4, this.gaze.chestYaw.x * 0.4, 0],
      chest: [this.gaze.chestPitch.x * 0.6, this.gaze.chestYaw.x * 0.6, 0],
      neck: [this.gaze.headPitch.x * 0.4, this.gaze.headYaw.x * 0.4, 0],
      head: [this.gaze.headPitch.x * 0.6, this.gaze.headYaw.x * 0.6, 0],
    };

    // 手勢疊加（加權）
    const gEuler: Record<string, Vec3> = {};
    // 手臂覆寫依序 slerp 疊上去（不是取最大權重：權重交叉時會跳）
    const armOverride: Record<'left' | 'right', { up: THREE.Quaternion; lo: THREE.Quaternion; hand: THREE.Quaternion; w: number }[]> = {
      left: [],
      right: [],
    };
    let hipsY = 0;
    for (const g of this.gestures) {
      const w = g.weight.x;
      for (const [bone, v] of Object.entries(g.frame.euler)) {
        const acc = (gEuler[bone] ??= [0, 0, 0]);
        acc[0] += v![0] * w;
        acc[1] += v![1] * w;
        acc[2] += v![2] * w;
      }
      hipsY += (g.frame.hipsY ?? 0) * w;
      for (const side of ['left', 'right'] as const) {
        const a = g.frame[side];
        if (!a) continue;
        const up = new THREE.Quaternion();
        const lo = new THREE.Quaternion();
        armToQuats(side, a.pose, up, lo);
        const hand = eulerToQuat(a.pose.hand, new THREE.Quaternion());
        armOverride[side].push({ up, lo, hand, w: a.weight * w });
      }
    }

    for (const [name, node] of this.nodes) {
      q.copy(this.springs.get(name)!.x);
      // 手臂覆寫（上臂、前臂、手腕）：與狀態姿勢 slerp
      const side = name.startsWith('left') ? 'left' : name.startsWith('right') ? 'right' : null;
      const part = name.endsWith('UpperArm') ? 'up' : name.endsWith('LowerArm') ? 'lo' : name.endsWith('Hand') ? 'hand' : null;
      if (side && part) {
        for (const o of armOverride[side]) {
          if (o.w > 0) q.slerp(o[part], Math.min(1, o.w));
        }
      }
      for (const layer of [gazeRot[name], gEuler[name], idle[name]]) {
        if (!layer) continue;
        e.set(layer[0], layer[1], layer[2], 'XYZ');
        q.multiply(tmp.setFromEuler(e));
      }
      if (this.flip) node.quaternion.set(-q.x, q.y, -q.z, q.w);
      else node.quaternion.copy(q);
    }

    // 臀部高度（跳躍等）
    const hips = this.nodes.get('hips');
    if (hips) hips.position.y = this.hipsRestY + hipsY + breathIn * 0.002;
  }
}
