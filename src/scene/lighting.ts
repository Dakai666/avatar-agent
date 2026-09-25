import * as THREE from 'three';

/**
 * 場景打光：主光 + 環境光 + 輪廓光（MToon 邊緣光）+ 背景光暈。
 *
 * VRoid 模型多半是 MToon 卡通材質：主光方向決定明暗交界線落在哪，
 * 環境光決定暗面有多暗；深色衣服容易和背景融在一起，靠輪廓光與背景光暈分離。
 *
 * 輪廓光不能用背後的平行光做：MToon 背光面仍會以陰影色疊加光源亮度，整個角色會過曝。
 * 改用 MToon 自帶的參數式邊緣光（依視角的 fresnel），疊在材質原本的設定上。
 *
 * 角度慣例：方位角 0° = 從相機方向照、正值往畫面右；仰角 = 由下往上幾度。
 * 色溫：-1 偏冷（藍）~ 0 白 ~ 1 偏暖（橙）。
 *
 * 實際套用的數值 = 使用者設定（滑桿、存在瀏覽器）疊上場景的暫時覆寫，並平滑過渡，換場景時不會一下跳亮/跳暗。
 */

export interface LightSettings {
  keyIntensity: number;
  keyAzimuth: number;
  keyElevation: number;
  keyWarmth: number;
  ambient: number;
  ambientWarmth: number;
  rimIntensity: number;
  rimWidth: number;
  rimWarmth: number;
  glow: number;
  glowWarmth: number;
}

export const LIGHT_DEFAULTS: LightSettings = {
  keyIntensity: 2.6,
  keyAzimuth: -24,
  keyElevation: 35,
  keyWarmth: -0.1,
  ambient: 0.88,
  ambientWarmth: 0.05,
  rimIntensity: 0,
  rimWidth: 0,
  rimWarmth: -0.95,
  glow: 0.35,
  glowWarmth: -0.1,
};

export interface SliderDef<K extends string> {
  key: K;
  label: string;
  min: number;
  max: number;
  step: number;
}

export const LIGHT_SLIDERS: SliderDef<keyof LightSettings>[] = [
  { key: 'keyIntensity', label: '主光強度', min: 0, max: 6, step: 0.05 },
  { key: 'keyAzimuth', label: '主光方位', min: -90, max: 90, step: 1 },
  { key: 'keyElevation', label: '主光仰角', min: -30, max: 80, step: 1 },
  { key: 'keyWarmth', label: '主光色溫', min: -1, max: 1, step: 0.05 },
  { key: 'ambient', label: '環境光', min: 0, max: 2, step: 0.02 },
  { key: 'ambientWarmth', label: '環境色溫', min: -1, max: 1, step: 0.05 },
  { key: 'rimIntensity', label: '輪廓光強度', min: 0, max: 1, step: 0.01 },
  { key: 'rimWidth', label: '輪廓光寬度', min: 0, max: 1, step: 0.01 },
  { key: 'rimWarmth', label: '輪廓光色溫', min: -1, max: 1, step: 0.05 },
  { key: 'glow', label: '背景光暈', min: 0, max: 1, step: 0.02 },
  { key: 'glowWarmth', label: '光暈色溫', min: -1, max: 1, step: 0.05 },
];

const STORAGE_KEY = 'avatar.lighting';
const WARM = new THREE.Color('#ffc890');
const COOL = new THREE.Color('#9dbcff');
const WHITE = new THREE.Color('#ffffff');

function warmthColor(w: number, out: THREE.Color): THREE.Color {
  return out.copy(WHITE).lerp(w >= 0 ? WARM : COOL, Math.min(1, Math.abs(w)));
}

function placeLight(light: THREE.DirectionalLight, azimuthDeg: number, elevationDeg: number): void {
  const az = THREE.MathUtils.degToRad(azimuthDeg);
  const el = THREE.MathUtils.degToRad(elevationDeg);
  // 目標在原點（DirectionalLight 預設），只有方向有意義
  light.position.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(3);
}

/** MToonMaterial 中用到的邊緣光欄位 */
interface RimMaterial {
  parametricRimColorFactor: THREE.Color;
  parametricRimFresnelPowerFactor: number;
  parametricRimLiftFactor: number;
}
interface RimOriginal {
  mat: RimMaterial;
  color: THREE.Color;
  fresnel: number;
  lift: number;
}

export class Lighting {
  readonly key = new THREE.DirectionalLight();
  readonly ambient = new THREE.AmbientLight();
  private rimMaterials: RimOriginal[] = [];
  /** 使用者設定（滑桿） */
  settings: LightSettings;
  /** 場景帶來的暫時覆寫（不存檔） */
  private sceneOverride: Partial<LightSettings> = {};
  /** 目前實際套用的值：每幀往目標靠近 */
  private shown: LightSettings;
  private color = new THREE.Color();

  constructor(
    scene: THREE.Scene,
    private glowEl: HTMLElement,
  ) {
    scene.add(this.key, this.ambient);
    this.settings = { ...LIGHT_DEFAULTS, ...this.load() };
    this.shown = { ...this.settings };
    this.apply(this.shown);
  }

  /** 模型載入後呼叫：記下各 MToon 材質原本的邊緣光設定，之後疊加在上面 */
  attachModel(root: THREE.Object3D): void {
    const seen = new Set<THREE.Material>();
    root.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      if (!mats) return;
      for (const m of Array.isArray(mats) ? mats : [mats]) {
        if (seen.has(m) || !(m as unknown as { isMToonMaterial?: boolean }).isMToonMaterial) continue;
        seen.add(m);
        const mat = m as unknown as RimMaterial;
        this.rimMaterials.push({
          mat,
          color: mat.parametricRimColorFactor.clone(),
          fresnel: mat.parametricRimFresnelPowerFactor,
          lift: mat.parametricRimLiftFactor,
        });
      }
    });
    this.apply(this.shown);
  }

  set<K extends keyof LightSettings>(k: K, v: LightSettings[K]): void {
    this.settings[k] = v;
    this.save();
  }

  setSceneOverride(o: Partial<LightSettings>): void {
    this.sceneOverride = o;
  }

  /** 每幀呼叫：實際值以約 0.25 秒的時間常數靠近目標 */
  update(dt: number): void {
    const target = { ...this.settings, ...this.sceneOverride };
    const k = 1 - Math.exp(-dt / 0.25);
    let changed = false;
    for (const key of Object.keys(target) as (keyof LightSettings)[]) {
      const d = target[key] - this.shown[key];
      if (Math.abs(d) < 1e-4) continue;
      this.shown[key] = Math.abs(d) < 1e-3 ? target[key] : this.shown[key] + d * k;
      changed = true;
    }
    if (changed) this.apply(this.shown);
  }

  reset(): void {
    this.settings = { ...LIGHT_DEFAULTS };
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* 無法存取 storage 時照樣運作 */
    }
  }

  private apply(s: LightSettings): void {
    this.key.intensity = s.keyIntensity;
    this.key.color.copy(warmthColor(s.keyWarmth, this.color));
    placeLight(this.key, s.keyAzimuth, s.keyElevation);
    // 寬度 0→1 對應 fresnel 次方 12（細邊）→ 1.5（寬）
    const rimColor = warmthColor(s.rimWarmth, this.color).multiplyScalar(s.rimIntensity);
    const fresnel = THREE.MathUtils.lerp(12, 1.5, s.rimWidth);
    for (const o of this.rimMaterials) {
      o.mat.parametricRimColorFactor.copy(o.color).add(rimColor);
      o.mat.parametricRimFresnelPowerFactor = s.rimIntensity > 0 ? fresnel : o.fresnel;
      o.mat.parametricRimLiftFactor = o.lift;
    }
    this.ambient.intensity = s.ambient;
    this.ambient.color.copy(warmthColor(s.ambientWarmth, this.color));

    const [r, g, b] = warmthColor(s.glowWarmth, this.color)
      .toArray()
      .map((c) => Math.round(c * 255));
    this.glowEl.style.background = `radial-gradient(ellipse 55% 60% at 50% 42%, rgba(${r},${g},${b},${s.glow}) 0%, rgba(${r},${g},${b},${s.glow * 0.35}) 45%, transparent 75%)`;
  }

  private load(): Partial<LightSettings> {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    } catch {
      return {};
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* 無法存取 storage 時照樣運作 */
    }
  }
}
