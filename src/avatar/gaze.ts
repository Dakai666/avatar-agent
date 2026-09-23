import { Spring, clamp } from '../core/spring';
import { rand } from '../core/noise';
import type { GazeTarget } from '../protocol';

/**
 * 視線系統：眼 → 頭 → 上身，依序跟隨。
 *
 * - 眼睛用極快的彈簧（掃視 saccade 本來就快，這是自然的，不是閃現）。
 * - 頭有「死區」：小幅掃視只動眼睛，超過門檻頭才跟上 → 不會一直晃頭。
 * - 眼睛目標 = 注視點 − 頭目前實際角度：頭還沒轉過去時眼睛先到，頭跟上後眼睛回正。
 *
 * 角度慣例（弧度）：yaw > 0 往角色的左邊，pitch > 0 往下看。
 */

interface Angles {
  yaw: number;
  pitch: number;
}

const EYE_YAW_MAX = 0.42;
const EYE_PITCH_MAX = 0.3;
const HEAD_DEADZONE = 0.1;

export class GazeController {
  private fixation: Angles = { yaw: 0, pitch: 0 };
  private headGoal: Angles = { yaw: 0, pitch: 0 };

  readonly eyeYaw = new Spring(0, 0.028);
  readonly eyePitch = new Spring(0, 0.028);
  readonly headYaw = new Spring(0, 0.17);
  readonly headPitch = new Spring(0, 0.19);
  readonly chestYaw = new Spring(0, 0.42);
  readonly chestPitch = new Spring(0, 0.45);

  private base: GazeTarget = 'user';
  private override: { target: GazeTarget; until: number } | null = null;
  private clock = 0;
  private nextSaccade = 0;
  private patternStep = 0;
  private thinkSide = 1;
  private lastTarget: GazeTarget | null = null;
  /** 看使用者時的微掃視偏移 */
  private micro: Angles = { yaw: 0, pitch: 0 };

  /** 活躍度：影響飄移幅度與頻率 */
  energy = 1;

  constructor(
    /** 使用者（相機）相對角色頭部的角度 */
    private userAngles: () => Angles,
    /** 大幅掃視時呼叫（眨眼觸發） */
    private onBigSaccade: () => void,
  ) {}

  setBase(target: GazeTarget): void {
    this.base = target;
  }

  setOverride(target: GazeTarget, holdMs: number): void {
    this.override = { target, until: this.clock + holdMs / 1000 };
    this.nextSaccade = 0;
  }

  get current(): GazeTarget {
    return this.override?.target ?? this.base;
  }

  private moveTo(a: Angles): void {
    const d = Math.hypot(a.yaw - this.fixation.yaw, a.pitch - this.fixation.pitch);
    if (d > 0.3 && Math.random() < 0.6) this.onBigSaccade();
    this.fixation = a;
  }

  /** 依注視模式產生下一個注視點 */
  private pickFixation(target: GazeTarget): number {
    const u = this.userAngles();
    const e = this.energy;
    switch (target) {
      case 'user':
        // 看著使用者，伴隨微掃視（兩眼之間、嘴巴附近小幅游移）
        this.micro = { yaw: rand(-0.025, 0.025), pitch: rand(-0.015, 0.03) };
        this.moveTo({ yaw: u.yaw + this.micro.yaw, pitch: u.pitch + this.micro.pitch });
        return rand(0.5, 1.8) / e;
      case 'down': {
        // 閱讀：一行內左→右小步掃視，行尾跳回
        const perLine = 5;
        const col = this.patternStep % perLine;
        const line = Math.floor(this.patternStep / perLine) % 4;
        this.patternStep++;
        this.moveTo({ yaw: -0.16 + col * 0.08, pitch: 0.36 + line * 0.03 });
        return col === perLine - 1 ? 0.35 : rand(0.18, 0.3);
      }
      case 'thinkUp':
        this.moveTo({ yaw: this.thinkSide * rand(0.25, 0.38), pitch: rand(-0.26, -0.14) });
        return rand(0.9, 2.2);
      case 'side':
        this.moveTo({ yaw: rand(-0.62, -0.5), pitch: rand(0.04, 0.12) });
        return rand(0.4, 1.0);
      case 'dialog':
        this.moveTo({ yaw: rand(-0.12, 0.12), pitch: rand(0.28, 0.34) });
        return rand(0.3, 0.7);
      case 'wander':
      default:
        if (Math.random() < 0.3) this.moveTo({ yaw: u.yaw, pitch: u.pitch });
        else this.moveTo({ yaw: rand(-0.5, 0.5) * e, pitch: rand(-0.15, 0.22) });
        return rand(1.2, 3.5) / e;
    }
  }

  update(dt: number): void {
    this.clock += dt;
    if (this.override && this.clock > this.override.until) {
      this.override = null;
      this.nextSaccade = 0;
    }
    const target = this.current;
    if (target !== this.lastTarget) {
      this.lastTarget = target;
      this.patternStep = 0;
      this.thinkSide = Math.random() < 0.5 ? -1 : 1;
      this.nextSaccade = 0;
    }

    this.nextSaccade -= dt;
    if (this.nextSaccade <= 0) this.nextSaccade = this.pickFixation(target);
    // 看使用者時持續追蹤相機（使用者/相機移動時也會跟著）
    if (target === 'user') {
      const u = this.userAngles();
      this.fixation.yaw = u.yaw + this.micro.yaw;
      this.fixation.pitch = u.pitch + this.micro.pitch;
    }

    // 頭：死區外才更新目標，承擔約 55% 的轉動
    const fy = this.fixation.yaw * 0.58;
    const fp = this.fixation.pitch * 0.5;
    if (Math.hypot(fy - this.headGoal.yaw, fp - this.headGoal.pitch) > HEAD_DEADZONE * 0.55) {
      this.headGoal = { yaw: fy, pitch: fp };
    }
    this.headYaw.target = this.headGoal.yaw;
    this.headPitch.target = this.headGoal.pitch;
    this.chestYaw.target = this.headGoal.yaw * 0.3;
    this.chestPitch.target = this.headGoal.pitch * 0.15;
    this.headYaw.update(dt);
    this.headPitch.update(dt);
    this.chestYaw.update(dt);
    this.chestPitch.update(dt);

    // 眼：補足剩下的角度（相對頭部目前的實際朝向）
    const headTotalYaw = this.headYaw.x + this.chestYaw.x;
    const headTotalPitch = this.headPitch.x + this.chestPitch.x;
    this.eyeYaw.target = clamp(this.fixation.yaw - headTotalYaw, -EYE_YAW_MAX, EYE_YAW_MAX);
    this.eyePitch.target = clamp(this.fixation.pitch - headTotalPitch, -EYE_PITCH_MAX, EYE_PITCH_MAX);
    this.eyeYaw.update(dt);
    this.eyePitch.update(dt);
  }
}
