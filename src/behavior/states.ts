import type { AvatarState, Emotion, GazeTarget, Gesture } from '../protocol';
import type { FacePose } from '../avatar/face';
import { mirrorArm, type Pose } from '../avatar/pose';

/**
 * 每個狀態 = 一組「目標」：姿勢、臉部底色、預設情緒、視線模式、活躍度。
 * 狀態切換只是換目標，實際過渡交給各層彈簧。
 */
export interface StateDef {
  label: string;
  pose: Pose;
  face: FacePose;
  emotion: { emotion: Emotion; intensity: number };
  gaze: GazeTarget;
  /** idle 雜訊活躍度 */
  energy: number;
  /** 呼吸頻率（次/秒） */
  breath: number;
  /** 眨眼頻率倍率 */
  blinkRate: number;
  /** 最短停留時間（ms）：防止狀態抖動 */
  minDwell: number;
  /** 優先級：高優先級可以不等 minDwell 直接打斷 */
  priority: number;
  /** 進入時的伴隨手勢 */
  enterGesture?: Gesture;
}

/** 右手托下巴（思考） */
const CHIN_R = { upper: [-0.18, -0.86, 0.48] as [number, number, number], fore: [0.48, 0.84, 0.3] as [number, number, number], twist: 0.4, hand: [0.1, 0.4, 0.5] as [number, number, number] };
/** 手在身前（打字/操作） */
const WORK_L = { upper: [0.28, -0.88, 0.38] as [number, number, number], fore: [0.08, -0.08, 1] as [number, number, number], hand: [0.2, 0, -0.1] as [number, number, number] };
/**
 * 雙手在身前相疊（等待）：左手在下、右手疊在上面且稍微往前，手背朝外。
 * 不能左右對稱——對稱時兩手在同一平面，手指會互相穿插。
 */
const WAIT_L = { upper: [0.18, -0.95, 0.27] as [number, number, number], fore: [-0.62, -0.52, 0.64] as [number, number, number], hand: [1.2, 0.3, -0.1] as [number, number, number] };
const WAIT_R = mirrorArm({ upper: [0.18, -0.95, 0.3], fore: [-0.5, -0.5, 0.72], hand: [1.2, 0.3, -0.1] });

export const STATE_DEFS: Record<AvatarState, StateDef> = {
  idle: {
    label: '閒置',
    pose: {},
    face: {},
    emotion: { emotion: 'neutral', intensity: 0 },
    gaze: 'wander',
    energy: 1,
    breath: 0.25,
    blinkRate: 1,
    minDwell: 600,
    priority: 0,
  },
  listening: {
    label: '聆聽',
    pose: { euler: { spine: [0.03, 0, 0], head: [0.03, 0, 0.06], neck: [0.02, 0, 0.03] } },
    face: { BRW_Surprised: 0.12, MTH_Close: 0.1 },
    emotion: { emotion: 'joy', intensity: 0.2 },
    gaze: 'user',
    energy: 0.8,
    breath: 0.25,
    blinkRate: 0.9,
    minDwell: 800,
    priority: 1,
  },
  thinking: {
    label: '思考',
    pose: {
      euler: { spine: [0.02, 0, 0], neck: [0, 0, -0.04], head: [-0.04, 0, -0.08] },
      right: CHIN_R,
    },
    face: { BRW_Sorrow: 0.25, BRW_Angry: 0.12, MTH_Small: 0.35 },
    emotion: { emotion: 'neutral', intensity: 0 },
    gaze: 'thinkUp',
    energy: 0.6,
    breath: 0.22,
    blinkRate: 0.7,
    minDwell: 1400,
    priority: 1,
  },
  reading: {
    label: '閱讀',
    pose: { euler: { spine: [0.04, 0, 0], chest: [0.03, 0, 0], head: [0.08, 0, 0.02] } },
    face: { BRW_Angry: 0.12, EYE_Angry: 0.1, MTH_Close: 0.2 },
    emotion: { emotion: 'neutral', intensity: 0 },
    gaze: 'down',
    energy: 0.5,
    breath: 0.22,
    blinkRate: 0.6,
    minDwell: 1200,
    priority: 1,
  },
  working: {
    label: '工作',
    pose: {
      euler: { spine: [0.05, 0, 0], chest: [0.03, 0, 0], head: [0.05, 0, 0] },
      left: WORK_L,
      right: mirrorArm(WORK_L),
    },
    face: { BRW_Angry: 0.22, EYE_Angry: 0.12, MTH_Close: 0.25 },
    emotion: { emotion: 'neutral', intensity: 0 },
    gaze: 'side',
    energy: 0.55,
    breath: 0.24,
    blinkRate: 0.6,
    minDwell: 1200,
    priority: 1,
  },
  speaking: {
    label: '說話',
    pose: { euler: { spine: [-0.01, 0, 0], head: [0, 0, 0.02] } },
    face: {},
    emotion: { emotion: 'joy', intensity: 0.25 },
    gaze: 'user',
    energy: 1.2,
    breath: 0.3,
    blinkRate: 1.3,
    minDwell: 300,
    priority: 2,
  },
  waiting: {
    label: '等待回應',
    pose: {
      euler: { spine: [0.05, 0, 0], neck: [0.02, 0, 0.04], head: [0.02, 0, 0.1] },
      left: WAIT_L,
      right: WAIT_R,
    },
    face: { BRW_Surprised: 0.3, MTH_Small: 0.2 },
    emotion: { emotion: 'joy', intensity: 0.15 },
    gaze: 'user',
    energy: 0.9,
    breath: 0.27,
    blinkRate: 1,
    minDwell: 800,
    priority: 3,
    enterGesture: 'tilt',
  },
  happy: {
    label: '開心',
    pose: { euler: { spine: [-0.03, 0, 0], chest: [-0.03, 0, 0], head: [-0.03, 0, 0.05] } },
    face: {},
    emotion: { emotion: 'joy', intensity: 0.85 },
    gaze: 'user',
    energy: 1.4,
    breath: 0.3,
    blinkRate: 1.1,
    minDwell: 1600,
    priority: 2,
    enterGesture: 'bounce',
  },
  troubled: {
    label: '困擾',
    pose: { euler: { spine: [0.05, 0, 0], neck: [0.03, 0, -0.03], head: [0.08, 0, -0.07] } },
    face: { MTH_Down: 0.2 },
    emotion: { emotion: 'sorrow', intensity: 0.55 },
    gaze: 'wander',
    energy: 0.7,
    breath: 0.2,
    blinkRate: 1.2,
    minDwell: 1600,
    priority: 3,
    enterGesture: 'sigh',
  },
};
