import * as THREE from 'three';

/**
 * 臨界阻尼彈簧（exact solution，與幀率無關）。
 * 參考 Daniel Holden, "Spring-It-On: The Game Developer's Spring-Roll-Call"。
 *
 * 用 halflife（秒）描述反應速度：經過 halflife 秒後，與目標的距離剩一半。
 * 臨界阻尼 → 不會過衝，速度連續 → 目標怎麼跳，輸出都不會瞬間跳動。
 */

const LN2x4 = 4 * Math.LN2;

/** 全域平滑倍率：除錯面板用來比較「有平滑 / 無平滑」。0 = 直接跳到目標。 */
export const smoothing = { scale: 1 };

export function halflifeToDamping(halflife: number): number {
  return LN2x4 / (halflife * smoothing.scale + 1e-5);
}

export class Spring {
  x: number;
  v = 0;
  target: number;

  constructor(initial = 0, public halflife = 0.2) {
    this.x = initial;
    this.target = initial;
  }

  update(dt: number): number {
    if (smoothing.scale === 0) {
      this.x = this.target;
      this.v = 0;
      return this.x;
    }
    const y = halflifeToDamping(this.halflife) / 2;
    const j0 = this.x - this.target;
    const j1 = this.v + j0 * y;
    const eydt = Math.exp(-y * dt);
    this.x = eydt * (j0 + j1 * dt) + this.target;
    this.v = eydt * (this.v - j1 * y * dt);
    return this.x;
  }
}

// ---- 四元數彈簧：在旋轉的 log 空間（角速度向量）裡做同樣的臨界阻尼 ----

const _qDiff = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _vDiff = new THREE.Vector3();
const _j1 = new THREE.Vector3();

/** q → 旋轉向量（axis * angle） */
function quatToScaledAngleAxis(q: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3 {
  // 取最短路徑
  const w = q.w < 0 ? -q.w : q.w;
  const s = q.w < 0 ? -1 : 1;
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z);
  if (len < 1e-8) return out.set(0, 0, 0);
  const angle = 2 * Math.atan2(len, w);
  const k = (angle / len) * s;
  return out.set(q.x * k, q.y * k, q.z * k);
}

function scaledAngleAxisToQuat(v: THREE.Vector3, out: THREE.Quaternion): THREE.Quaternion {
  const angle = v.length();
  if (angle < 1e-8) return out.set(0, 0, 0, 1);
  const half = angle / 2;
  const s = Math.sin(half) / angle;
  return out.set(v.x * s, v.y * s, v.z * s, Math.cos(half));
}

export class QuatSpring {
  readonly x = new THREE.Quaternion();
  readonly target = new THREE.Quaternion();
  /** 角速度（rad/s，旋轉向量） */
  readonly v = new THREE.Vector3();

  constructor(public halflife = 0.2, initial?: THREE.Quaternion) {
    if (initial) {
      this.x.copy(initial);
      this.target.copy(initial);
    }
  }

  update(dt: number): THREE.Quaternion {
    if (smoothing.scale === 0) {
      this.x.copy(this.target);
      this.v.set(0, 0, 0);
      return this.x;
    }
    const y = halflifeToDamping(this.halflife) / 2;
    // j0 = log(x * inv(target))
    _qInv.copy(this.target).invert();
    _qDiff.copy(this.x).multiply(_qInv);
    quatToScaledAngleAxis(_qDiff, _vDiff);
    const j0 = _vDiff;
    _j1.copy(j0).multiplyScalar(y).add(this.v);
    const eydt = Math.exp(-y * dt);

    // x = exp(eydt * (j0 + j1*dt)) * target
    j0.addScaledVector(_j1, dt).multiplyScalar(eydt);
    scaledAngleAxisToQuat(j0, _qDiff);
    this.x.copy(_qDiff).multiply(this.target);
    // v = eydt * (v - j1*y*dt)
    this.v.addScaledVector(_j1, -y * dt).multiplyScalar(eydt);
    return this.x;
  }
}

/** 平滑的 0→1 包絡：smoothstep */
export function smoothstep(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}
