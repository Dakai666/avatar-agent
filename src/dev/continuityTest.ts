import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import { EMOTIONS, GESTURES, STATES, type AvatarCommand } from '../protocol';
import type { IntentScheduler } from '../behavior/scheduler';
import { smoothing } from '../core/spring';

/**
 * 連貫性回歸測試：模擬 agent 的高頻碎事件（每 40~400ms 一個指令），
 * 以固定 dt 推進，量測每幀骨骼旋轉與表情 morph 的最大跳動量。
 *
 * 在 console 執行：__avatar.continuityTest()
 */

const BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand',
] as const;

export interface ContinuityResult {
  smooth: boolean;
  sched: boolean;
  /** 單幀最大骨骼旋轉（度） */
  maxBoneDeg: number;
  maxBoneName: string;
  /** 單幀旋轉超過 5° 的次數（≈ 300°/s，肉眼會覺得「閃」） */
  framesOver5deg: number;
  /** 單幀最大 morph 變化（不含眨眼） */
  maxMorphStep: number;
  stateChanges: number;
  commands: number;
}

export function makeContinuityTest(vrm: VRM, sched: IntentScheduler, step: (s: number) => void) {
  const bones = BONES.map((n) => [n, vrm.humanoid.getNormalizedBoneNode(n as VRMHumanBoneName)!] as const);
  let faceMesh: THREE.Mesh | null = null;
  vrm.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!faceMesh && m.morphTargetDictionary?.['Fcl_EYE_Close'] !== undefined) faceMesh = m;
  });
  const face = faceMesh as THREE.Mesh | null;
  const blinkIdx = face?.morphTargetDictionary?.['Fcl_EYE_Close'] ?? -1;

  const run = (smooth: boolean, useSched: boolean, seconds: number): ContinuityResult => {
    smoothing.scale = smooth ? 1 : 0;
    sched.enabled = useSched;
    const dt = 1 / 60;
    let t = 0;
    let next = 0;
    let maxBone = 0;
    let maxBoneName = '';
    let over = 0;
    let maxMorph = 0;
    let stateChanges = 0;
    let commands = 0;
    let lastState = sched.state;
    const prevQ = bones.map(([, b]) => b.quaternion.clone());
    const prevM = face ? Array.from(face.morphTargetInfluences!) : [];
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];
    while (t < seconds) {
      if (t >= next) {
        const r = Math.random();
        let cmd: AvatarCommand;
        if (r < 0.7) cmd = { type: 'state', state: pick(['thinking', 'reading', 'working'] as const) };
        else if (r < 0.8) cmd = { type: 'state', state: pick(STATES) };
        else if (r < 0.9) cmd = { type: 'gesture', gesture: pick(GESTURES) };
        else cmd = { type: 'emotion', emotion: pick(EMOTIONS), intensity: 0.7 };
        sched.send(cmd);
        commands++;
        next = t + 0.04 + Math.random() * 0.36;
      }
      step(dt);
      if (sched.state !== lastState) {
        stateChanges++;
        lastState = sched.state;
      }
      bones.forEach(([n, b], i) => {
        const ang = b.quaternion.angleTo(prevQ[i]);
        if (ang > (5 * Math.PI) / 180) over++;
        if (ang > maxBone) {
          maxBone = ang;
          maxBoneName = n;
        }
        prevQ[i].copy(b.quaternion);
      });
      face?.morphTargetInfluences!.forEach((v, i) => {
        if (i !== blinkIdx) maxMorph = Math.max(maxMorph, Math.abs(v - prevM[i]));
        prevM[i] = v;
      });
      t += dt;
    }
    return {
      smooth,
      sched: useSched,
      maxBoneDeg: +THREE.MathUtils.radToDeg(maxBone).toFixed(2),
      maxBoneName,
      framesOver5deg: over,
      maxMorphStep: +maxMorph.toFixed(3),
      stateChanges,
      commands,
    };
  };

  return (seconds = 30): ContinuityResult[] => {
    const prevScale = smoothing.scale;
    const prevSched = sched.enabled;
    try {
      return [run(false, false, seconds), run(true, false, seconds), run(true, true, seconds)];
    } finally {
      smoothing.scale = prevScale;
      sched.enabled = prevSched;
    }
  };
}
