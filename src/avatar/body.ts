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
  private clock = 0;
  private breathPhase = 0;

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

  /** 手指自然微彎（靜態，不需要動畫） */
  private relaxFingers(): void {
    for (const side of ['left', 'right'] as const) {
      const sign = side === 'left' ? -1 : 1;
      FINGERS.forEach((f, fi) => {
        SEGMENTS.forEach((seg, si) => {
          const node = this.vrm.humanoid.getNormalizedBoneNode(`${side}${f}${seg}` as VRMHumanBoneName);
          if (node) node.rotation.set(0, 0, this.axisSign * sign * (0.18 + si * 0.1 + fi * 0.04));
        });
      });
      const thumb = this.vrm.humanoid.getNormalizedBoneNode(`${side}ThumbProximal` as VRMHumanBoneName);
      if (thumb) thumb.rotation.set(0, sign * -0.25, this.axisSign * sign * 0.1);
    }
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
    this.clock += dt;
    const energy = this.energy.update(dt);
    const breathRate = this.breathRate.update(dt);
    this.breathPhase += dt * breathRate * Math.PI * 2;

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

    const q = new THREE.Quaternion();
    const tmp = new THREE.Quaternion();
    const e = new THREE.Euler();

    // 呼吸：吸氣時胸口微抬、肩膀上提
    const breath = Math.sin(this.breathPhase);
    const breathIn = (breath + 1) / 2;
    const t = this.clock * (0.35 + energy * 0.25);
    const n = (seed: number, amp: number) => fbm1(t + seed * 7.3, seed) * amp * energy;

    const idle: Partial<Record<string, Vec3>> = {
      hips: [0, n(1, 0.012), n(2, 0.01)],
      spine: [n(3, 0.01), n(4, 0.012), n(5, 0.012)],
      chest: [-breath * 0.012, 0, 0],
      upperChest: [-breath * 0.01, 0, 0],
      neck: [n(6, 0.012), n(7, 0.015), n(8, 0.01)],
      head: [n(9, 0.02), n(10, 0.025), n(11, 0.018)],
      leftShoulder: [0, 0, breathIn * 0.018],
      rightShoulder: [0, 0, -breathIn * 0.018],
      leftUpperArm: [n(12, 0.015), 0, n(13, 0.012)],
      rightUpperArm: [n(14, 0.015), 0, n(15, 0.012)],
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
    const armOverride: Record<'left' | 'right', { up: THREE.Quaternion; lo: THREE.Quaternion; w: number }[]> = {
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
        armOverride[side].push({ up, lo, w: a.weight * w });
      }
    }

    for (const [name, node] of this.nodes) {
      q.copy(this.springs.get(name)!.x);
      // 手臂覆寫：與狀態姿勢 slerp
      const side = name.startsWith('left') ? 'left' : name.startsWith('right') ? 'right' : null;
      if (side && (name.endsWith('UpperArm') || name.endsWith('LowerArm'))) {
        for (const o of armOverride[side]) {
          if (o.w > 0) q.slerp(name.endsWith('UpperArm') ? o.up : o.lo, Math.min(1, o.w));
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
