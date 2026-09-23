/**
 * 1D 平滑雜訊（value noise + 五次插值），用於 idle 微動。
 * 每個 channel 用不同 seed，避免所有骨頭同步晃動。
 */

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return (s - Math.floor(s)) * 2 - 1;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function noise1(x: number, seed = 0): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hash(i + seed * 1013);
  const b = hash(i + 1 + seed * 1013);
  return a + (b - a) * fade(f);
}

/** 兩個八度疊加，較自然 */
export function fbm1(x: number, seed = 0): number {
  return noise1(x, seed) * 0.7 + noise1(x * 2.13, seed + 17) * 0.3;
}

/** 範圍 [lo, hi) 的亂數 */
export function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}
