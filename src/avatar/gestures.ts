import type { Gesture } from '../protocol';
import { type ArmPose, type TorsoBone, type Vec3 } from './pose';

/**
 * 程序化手勢。每個手勢遵循動畫原則：
 *   預備（反向小動作）→ 主動作 → 跟隨（小幅回彈）→ 回穩
 * 手勢是「疊加層」：它不會覆寫狀態姿勢，淡出後自然回到狀態姿勢。
 */

export interface GestureFrame {
  /** 疊加在軀幹骨頭上的 euler 偏移 */
  euler: Partial<Record<TorsoBone, Vec3>>;
  /** 手臂覆寫（依 weight 與狀態姿勢混合） */
  right?: { pose: ArmPose; weight: number };
  left?: { pose: ArmPose; weight: number };
  /** 臀部高度偏移（公尺） */
  hipsY?: number;
}

export interface GestureDef {
  duration: number;
  sample(t: number): GestureFrame;
}

type Keys = [number, number][];

/** 比向對話框的右手：上臂往前下、前臂往身前中央、前臂翻轉讓掌心朝上（push = 手腕往前送） */
function POINT_DIALOG_R(push: number): ArmPose {
  return { upper: [-0.26, -0.78, 0.57], fore: [0.5, -0.22, 0.84], foreTwist: 2.1, hand: [0, 0, 0.15 + push] };
}

/** Catmull-Rom 插值：通過每個關鍵點且速度連續 */
function curve(keys: Keys, t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last[1];
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
  const p0 = keys[Math.max(0, i - 1)];
  const p1 = keys[i];
  const p2 = keys[i + 1];
  const p3 = keys[Math.min(keys.length - 1, i + 2)];
  const span = p2[0] - p1[0];
  const u = (t - p1[0]) / span;
  // 以時間正規化的切線
  const m1 = ((p2[1] - p0[1]) / (p2[0] - p0[0] || span)) * span;
  const m2 = ((p3[1] - p1[1]) / (p3[0] - p1[0] || span)) * span;
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * p1[1] + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2[1] + (u3 - u2) * m2
  );
}

/** 0→1→0 的平滑包絡（淡入 inT 秒、淡出 outT 秒） */
function envelope(t: number, duration: number, inT: number, outT: number): number {
  const a = Math.min(1, t / inT);
  const b = Math.min(1, (duration - t) / outT);
  const k = Math.max(0, Math.min(a, b));
  return k * k * (3 - 2 * k);
}

export const GESTURE_DEFS: Record<Exclude<Gesture, 'lookAround'>, GestureDef> = {
  nod: {
    duration: 0.95,
    sample: (t) => {
      const k: Keys = [[0, 0], [0.12, -0.05], [0.34, 0.2], [0.52, 0.02], [0.66, 0.09], [0.95, 0]];
      const h = curve(k, t);
      return { euler: { head: [h, 0, 0], neck: [h * 0.35, 0, 0], upperChest: [h * 0.08, 0, 0] } };
    },
  },
  shake: {
    duration: 1.15,
    sample: (t) => {
      const k: Keys = [[0, 0], [0.1, 0.04], [0.3, -0.17], [0.55, 0.16], [0.8, -0.08], [1.15, 0]];
      const y = curve(k, t);
      return { euler: { head: [0, y, 0], neck: [0, y * 0.4, 0] } };
    },
  },
  tilt: {
    duration: 1.5,
    sample: (t) => {
      const k: Keys = [[0, 0], [0.15, -0.025], [0.45, 0.17], [1.05, 0.15], [1.5, 0]];
      const z = curve(k, t);
      return { euler: { head: [z * 0.15, 0, z], neck: [0, 0, z * 0.3], upperChest: [0, 0, z * 0.08] } };
    },
  },
  bounce: {
    duration: 0.95,
    sample: (t) => {
      const y = curve([[0, 0], [0.12, -0.018], [0.3, 0.028], [0.46, -0.004], [0.62, 0.016], [0.95, 0]], t);
      const c = curve([[0, 0], [0.12, 0.03], [0.3, -0.06], [0.95, 0]], t);
      return {
        hipsY: y,
        euler: {
          chest: [c, 0, 0],
          head: [-c * 0.6, 0, 0],
          leftShoulder: [0, 0, y * 2],
          rightShoulder: [0, 0, -y * 2],
        },
      };
    },
  },
  sigh: {
    duration: 1.9,
    sample: (t) => {
      const c = curve([[0, 0], [0.45, -0.05], [1.05, 0.08], [1.9, 0]], t);
      const s = curve([[0, 0], [0.45, 0.06], [1.05, -0.05], [1.9, 0]], t);
      return {
        euler: {
          chest: [c, 0, 0],
          upperChest: [c * 0.6, 0, 0],
          head: [c * 1.4, 0, 0],
          leftShoulder: [0, 0, s],
          rightShoulder: [0, 0, -s],
        },
      };
    },
  },
  wave: {
    duration: 2.4,
    sample: (t) => {
      const w = envelope(t, 2.4, 0.4, 0.45);
      // 前臂在舉起後左右擺動（在前額平面上旋轉方向）
      const swing = Math.sin((t - 0.4) * Math.PI * 2 * 1.6) * 0.38 * Math.min(1, Math.max(0, (t - 0.35) * 3));
      const fx = -0.12 + Math.sin(swing) * 1.0;
      const fy = Math.cos(swing);
      return {
        right: {
          weight: w,
          pose: { upper: [-0.82, -0.28, 0.45], fore: [fx, fy, 0.25], hand: [0, 0, 0] },
        },
        euler: { head: [0, -0.06 * w, 0.06 * w], upperChest: [0, -0.04 * w, 0.03 * w] },
      };
    },
  },
  pointDialog: {
    // 右手掌心朝上、往身前下方（對話框）一比，停一下再收回；視線由排程器帶去看對話框
    duration: 2.2,
    sample: (t) => {
      const w = envelope(t, 2.2, 0.35, 0.55);
      // 到位時手腕帶一點「請看這裡」的小推送
      const push = curve([[0, 0], [0.35, 0], [0.55, 0.12], [0.8, 0], [2.2, 0]], t);
      return {
        right: { weight: w, pose: POINT_DIALOG_R(push) },
        euler: { head: [0.07 * w, -0.05 * w, 0.04 * w], upperChest: [0.02 * w, -0.05 * w, 0] },
      };
    },
  },
};
