import * as THREE from 'three';

/**
 * 姿勢描述。
 *
 * 軀幹/頭用 euler（normalized bone 的局部旋轉，弧度）。
 * 手臂用「方向」描述：上臂指向哪、前臂指向哪（在肩膀空間，+X 為角色左、+Y 上、+Z 前）。
 * 用方向寫姿勢比調骨頭角度直覺得多，也不會因軸向搞錯而扭曲。
 */

export type Vec3 = [number, number, number];

export const TORSO_BONES = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'rightShoulder',
  'leftHand',
  'rightHand',
] as const;
export type TorsoBone = (typeof TORSO_BONES)[number];

export interface ArmPose {
  /** 上臂方向 */
  upper: Vec3;
  /** 前臂方向 */
  fore: Vec3;
  /** 上臂繞自身軸的扭轉（弧度），用來調整手肘朝向 */
  twist?: number;
  /**
   * 前臂繞自身軸的扭轉（弧度）：掌心翻上/翻下用這個，不要只靠手腕大角度 roll——
   * 手腕覆寫與狀態姿勢相差超過 180° 時，slerp 的最短路徑會突然換邊，手腕瞬間翻轉。
   */
  foreTwist?: number;
  /** 手腕 euler */
  hand?: Vec3;
}

export interface Pose {
  euler?: Partial<Record<TorsoBone, Vec3>>;
  left?: ArmPose;
  right?: ArmPose;
}

/** 右臂 → 左臂的鏡像（X 反向） */
export function mirrorArm(a: ArmPose): ArmPose {
  return {
    upper: [-a.upper[0], a.upper[1], a.upper[2]],
    fore: [-a.fore[0], a.fore[1], a.fore[2]],
    twist: a.twist !== undefined ? -a.twist : undefined,
    foreTwist: a.foreTwist !== undefined ? -a.foreTwist : undefined,
    hand: a.hand ? [a.hand[0], -a.hand[1], -a.hand[2]] : undefined,
  };
}

/** 自然垂手，手肘微彎（以左臂描述） */
export const ARM_RELAXED_L: ArmPose = {
  upper: [0.22, -0.97, 0.02],
  fore: [0.16, -0.95, 0.2],
  hand: [0, 0, -0.1],
};

export const RELAXED: Required<Pick<Pose, 'left' | 'right'>> & Pose = {
  euler: {},
  left: ARM_RELAXED_L,
  right: mirrorArm(ARM_RELAXED_L),
};

// ---- 手臂方向 → 局部四元數 ----

const REST_L = new THREE.Vector3(1, 0, 0);
const REST_R = new THREE.Vector3(-1, 0, 0);
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _qTwist = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();

export function armToQuats(
  side: 'left' | 'right',
  arm: ArmPose,
  outUpper: THREE.Quaternion,
  outLower: THREE.Quaternion,
): void {
  const rest = side === 'left' ? REST_L : REST_R;
  _d1.set(...arm.upper).normalize();
  _d2.set(...arm.fore).normalize();
  outUpper.setFromUnitVectors(rest, _d1);
  if (arm.twist) {
    _qTwist.setFromAxisAngle(_d1, arm.twist);
    outUpper.premultiply(_qTwist);
  }
  // 前臂的世界（肩膀空間）旋轉 = 從上臂的朝向再轉到 d2；取局部 = inv(upper) * world
  const world = new THREE.Quaternion().setFromUnitVectors(_d1, _d2).multiply(outUpper);
  if (arm.foreTwist) world.premultiply(_qTwist.setFromAxisAngle(_d2, arm.foreTwist));
  outLower.copy(_qInv.copy(outUpper).invert().multiply(world));
}

export function eulerToQuat(e: Vec3 | undefined, out: THREE.Quaternion): THREE.Quaternion {
  if (!e) return out.set(0, 0, 0, 1);
  return out.setFromEuler(new THREE.Euler(e[0], e[1], e[2], 'XYZ'));
}
