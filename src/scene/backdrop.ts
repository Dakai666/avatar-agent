import * as THREE from 'three';
import type { SceneName } from '../protocol';
import type { Lighting, LightSettings } from './lighting';

/**
 * 背景場景：CSS 背景層（畫布後面）+ 選用的 3D 物件群組 + 場景光線覆寫。
 *
 * 切換是交叉淡化：新場景疊在舊場景上淡入；只有新場景「會透出後面」時（透明、綠幕以外的 CSS 都不透），
 * 舊場景才同時淡出，否則舊場景維持不透明到最後，避免中途透出白底。角色本身完全不受影響。
 */

interface SceneDef {
  /** CSS 背景層；null = 不畫（透明） */
  css: (image?: string) => string | null;
  build3d?: () => THREE.Group;
  light: Partial<LightSettings>;
}

const GRADIENT = 'linear-gradient(180deg, var(--bg-top), var(--bg-bottom))';

const SCENE_DEFS: Record<SceneName, SceneDef> = {
  default: { css: () => GRADIENT, light: {} },
  greenscreen: { css: () => '#00ff00', light: { glow: 0 } },
  transparent: { css: () => null, light: { glow: 0 } },
  image: { css: (img) => `center / cover no-repeat url("/scenes/${encodeURIComponent(img ?? '')}")`, light: { glow: 0 } },
  room: { css: () => GRADIENT, build3d: () => buildRoom(false), light: { glow: 0, keyWarmth: 0.2, ambient: 0.95 } },
  roomNight: {
    css: () => GRADIENT,
    build3d: () => buildRoom(true),
    light: { glow: 0, keyIntensity: 2.0, keyWarmth: 0.35, ambient: 0.55, ambientWarmth: -0.45 },
  },
};

const FADE_SEC = 0.9;
const STORAGE_KEY = 'avatar.scene';

interface Layer {
  name: SceneName;
  image?: string;
  el: HTMLElement;
  group?: THREE.Group;
  materials: THREE.Material[];
  opacity: number;
}

export class Backdrop {
  private current: Layer | null = null;
  private incoming: Layer | null = null;
  private fade = 1;
  private renderBase = 0;

  constructor(
    private host: HTMLElement,
    /** 背景層插在這個元素前面（光暈之下） */
    private before: HTMLElement,
    private scene3d: THREE.Scene,
    private lighting: Lighting,
  ) {
    const saved = this.load();
    this.current = this.makeLayer(saved.scene, saved.image);
    this.setOpacity(this.current, 1);
    this.lighting.setSceneOverride(SCENE_DEFS[saved.scene].light);
    this.syncPageBackground(saved.scene);
  }

  get scene(): SceneName {
    return (this.incoming ?? this.current)!.name;
  }

  /** 切換場景；image 場景會先把圖載好再開始淡入，載入失敗就不換 */
  async set(scene: SceneName, image?: string): Promise<boolean> {
    if (scene === 'image') {
      if (!image) return false;
      const ok = await new Promise<boolean>((done) => {
        const img = new Image();
        img.onload = () => done(true);
        img.onerror = () => done(false);
        img.src = `/scenes/${encodeURIComponent(image)}`;
      });
      if (!ok) {
        console.warn(`[avatar] 找不到背景圖 scenes/${image}`);
        return false;
      }
    }
    const shown = this.incoming ?? this.current;
    if (shown && shown.name === scene && shown.image === image) return true;
    // 前一次還沒淡完：直接收掉舊的，從目前畫面接著淡
    if (this.incoming) {
      this.dispose(this.current!);
      this.current = this.incoming;
      this.setOpacity(this.current, 1);
    }
    this.incoming = this.makeLayer(scene, image);
    this.setOpacity(this.incoming, 0);
    this.fade = 0;
    this.lighting.setSceneOverride(SCENE_DEFS[scene].light);
    this.save(scene, image);
    return true;
  }

  update(dt: number): void {
    if (!this.incoming) return;
    this.fade = Math.min(1, this.fade + dt / FADE_SEC);
    const k = this.fade * this.fade * (3 - 2 * this.fade);
    this.setOpacity(this.incoming, k);
    // 新場景不透明 → 舊場景保持不透明墊底；新場景會透出來 → 舊場景一起淡出
    this.setOpacity(this.current!, this.isOpaque(this.incoming) ? 1 : 1 - k);
    if (this.fade >= 1) {
      this.dispose(this.current!);
      this.current = this.incoming;
      this.incoming = null;
      this.setOpacity(this.current, 1);
      this.syncPageBackground(this.current.name);
    } else if (!this.isOpaque(this.incoming)) {
      this.syncPageBackground(this.incoming.name);
    }
  }

  private isOpaque(l: Layer): boolean {
    return l.name !== 'transparent';
  }

  /** 透明場景要讓整頁背景透明（OBS 瀏覽器來源才看得到後面） */
  private syncPageBackground(name: SceneName): void {
    document.documentElement.classList.toggle('bg-transparent', name === 'transparent');
  }

  private makeLayer(name: SceneName, image?: string): Layer {
    const def = SCENE_DEFS[name];
    const el = document.createElement('div');
    el.className = 'backdrop';
    el.style.background = def.css(image) ?? 'transparent';
    this.host.insertBefore(el, this.before);
    const layer: Layer = { name, image, el, materials: [], opacity: 1 };
    if (def.build3d) {
      layer.group = def.build3d();
      // 背景物件在角色之後畫；淡入時用透明混合，依建立順序決定前後
      this.renderBase += 100;
      let order = this.renderBase;
      layer.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.renderOrder = order++;
        for (const m of [mesh.material].flat()) layer.materials.push(m);
      });
      this.scene3d.add(layer.group);
    }
    return layer;
  }

  private setOpacity(l: Layer, v: number): void {
    l.opacity = v;
    l.el.style.opacity = String(v);
    const fading = v < 1;
    for (const m of l.materials) {
      m.transparent = fading;
      m.opacity = v;
      m.depthWrite = !fading;
    }
  }

  private dispose(l: Layer): void {
    l.el.remove();
    if (!l.group) return;
    this.scene3d.remove(l.group);
    l.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const m of [mesh.material].flat()) {
        (m as THREE.MeshBasicMaterial).map?.dispose();
        m.dispose();
      }
    });
  }

  private load(): { scene: SceneName; image?: string } {
    try {
      const v = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
      // 圖片場景不在啟動時自動恢復（圖可能已刪除）；其他場景直接恢復
      if (v && v.scene in SCENE_DEFS && v.scene !== 'image') return { scene: v.scene };
    } catch {
      /* 無法存取 storage 時用預設 */
    }
    return { scene: 'default' };
  }

  private save(scene: SceneName, image?: string): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ scene, image }));
    } catch {
      /* 無法存取 storage 時照樣運作 */
    }
  }
}

// ---------------- 內建 3D 房間（程序產生，不需要素材檔） ----------------

/**
 * 角色站在原點面向 +Z、相機在 +Z。背牆在身後 3.4 m：胸上構圖（fov 26°）時牆上可見範圍約寬 2.3 m、高 0.3~2.4 m，
 * 右後方一扇窗、左後方書架與畫框都放在這個範圍內。用 Lambert 材質：跟著場景主光/環境光變化，和卡通角色的平塗感一致。
 */
function buildRoom(night: boolean): THREE.Group {
  const g = new THREE.Group();
  const P = night
    ? { wall: '#474b6e', trim: '#363955', floor: '#3d302b', frame: '#c9c2d8', curtain: '#6b5a8e', shelf: '#5b4636' }
    : { wall: '#efe3d0', trim: '#d8c3a5', floor: '#b8906b', frame: '#fbf8f2', curtain: '#9cc5a1', shelf: '#a57c56' };
  const mat = (color: string) => new THREE.MeshLambertMaterial({ color });
  const box = (w: number, h: number, d: number, color: string, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };
  const Z = -3.4;

  // 牆、踢腳板、地板
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(12, 6), mat(P.wall));
  wall.position.set(0, 3, Z);
  g.add(wall);
  box(12, 0.8, 0.04, P.trim, 0, 0.4, Z + 0.02);
  box(12, 0.05, 0.06, P.trim, 0, 0.82, Z + 0.03);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 8), mat(P.floor));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, Z + 4);
  g.add(floor);

  // 窗戶（右後方）：窗外天空是貼圖，不受光影響
  const wx = 0.78;
  const wy = 1.55;
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 0.95),
    new THREE.MeshBasicMaterial({ map: skyTexture(night) }),
  );
  sky.position.set(wx, wy, Z + 0.01);
  g.add(sky);
  box(1.12, 0.06, 0.08, P.frame, wx, wy + 0.5, Z + 0.04);
  box(1.12, 0.06, 0.08, P.frame, wx, wy - 0.5, Z + 0.04);
  box(0.06, 1.06, 0.08, P.frame, wx - 0.53, wy, Z + 0.04);
  box(0.06, 1.06, 0.08, P.frame, wx + 0.53, wy, Z + 0.04);
  box(0.03, 0.95, 0.04, P.frame, wx, wy, Z + 0.03);
  box(1.0, 0.03, 0.04, P.frame, wx, wy + 0.1, Z + 0.03);
  box(1.26, 0.05, 0.16, P.frame, wx, wy - 0.55, Z + 0.08); // 窗台
  box(0.26, 1.35, 0.06, P.curtain, wx - 0.72, wy - 0.05, Z + 0.1);
  box(0.26, 1.35, 0.06, P.curtain, wx + 0.72, wy - 0.05, Z + 0.1);
  box(1.8, 0.035, 0.035, P.trim, wx, wy + 0.72, Z + 0.12); // 窗簾桿

  // 書架（左後方）+ 書 + 小盆栽
  const sx = -0.78;
  const sy = 1.05;
  box(0.95, 0.04, 0.24, P.shelf, sx, sy, Z + 0.12);
  box(0.95, 0.04, 0.24, P.shelf, sx, sy + 0.42, Z + 0.12);
  const books = night
    ? ['#8e5f7b', '#4f6f8f', '#b08a5a', '#5f7f6a', '#7a6aa0', '#a05f5f']
    : ['#d9826b', '#6f9fc4', '#e2c26a', '#7fb28a', '#b08ac8', '#e39aa6'];
  let bx = sx - 0.42;
  for (let i = 0; i < 9; i++) {
    const h = 0.2 + ((i * 37) % 11) / 100;
    const w = 0.045 + ((i * 13) % 4) / 100;
    box(w, h, 0.17, books[i % books.length], bx + w / 2, sy + 0.02 + h / 2, Z + 0.12);
    bx += w + 0.008;
  }
  box(0.11, 0.1, 0.11, night ? '#8a6a5a' : '#c98e6c', sx + 0.3, sy + 0.07, Z + 0.12); // 盆
  const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), mat(night ? '#4d7a5a' : '#79b07a'));
  leaf.position.set(sx + 0.3, sy + 0.2, Z + 0.12);
  leaf.scale.set(1, 0.85, 1);
  g.add(leaf);
  for (let i = 0; i < 4; i++) {
    const h = 0.16 + (i % 2) * 0.05;
    box(0.06, h, 0.15, books[(i + 3) % books.length], sx - 0.3 + i * 0.075, sy + 0.44 + h / 2, Z + 0.12);
  }

  // 畫框（左上）
  box(0.5, 0.38, 0.03, P.frame, -0.72, 1.95, Z + 0.02);
  const art = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.3), new THREE.MeshLambertMaterial({ map: artTexture(night) }));
  art.position.set(-0.72, 1.95, Z + 0.04);
  g.add(art);

  // 夜晚：窗邊小燈串（自發光，不受光影響）
  if (night) {
    for (let i = 0; i < 13; i++) {
      const t = i / 12;
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.018, 8, 6),
        new THREE.MeshBasicMaterial({ color: i % 3 === 0 ? '#ffd59a' : '#ffe9b8' }),
      );
      bulb.position.set(wx - 0.85 + t * 1.7, wy + 0.66 - Math.sin(t * Math.PI) * 0.12, Z + 0.14);
      g.add(bulb);
    }
  }
  return g;
}

function canvasTexture(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d')!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 固定亂數（同一個場景每次長得一樣） */
function seeded(seed: number): () => number {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

function skyTexture(night: boolean): THREE.CanvasTexture {
  return canvasTexture(512, 512, (c) => {
    const grd = c.createLinearGradient(0, 0, 0, 512);
    if (night) {
      grd.addColorStop(0, '#0e1433');
      grd.addColorStop(1, '#3a3f78');
    } else {
      grd.addColorStop(0, '#7fb6ea');
      grd.addColorStop(1, '#d6ecfb');
    }
    c.fillStyle = grd;
    c.fillRect(0, 0, 512, 512);
    const rnd = seeded(night ? 7 : 3);
    if (night) {
      for (let i = 0; i < 90; i++) {
        c.fillStyle = `rgba(255,255,255,${0.35 + rnd() * 0.6})`;
        c.beginPath();
        c.arc(rnd() * 512, rnd() * 400, rnd() * 1.8 + 0.4, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = '#fff6d8';
      c.shadowColor = '#fff2c0';
      c.shadowBlur = 40;
      c.beginPath();
      c.arc(360, 130, 46, 0, Math.PI * 2);
      c.fill();
    } else {
      c.fillStyle = 'rgba(255,255,255,0.9)';
      for (const [x, y, r] of [
        [140, 170, 46],
        [190, 150, 58],
        [245, 175, 40],
        [380, 300, 34],
        [420, 285, 44],
        [460, 305, 30],
      ]) {
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fill();
      }
    }
    // 遠方的屋頂剪影
    c.fillStyle = night ? '#1b1d3a' : '#9fb7c9';
    c.beginPath();
    c.moveTo(0, 512);
    let x = 0;
    while (x < 512) {
      const w = 40 + rnd() * 70;
      const h = 60 + rnd() * 90;
      c.lineTo(x, 512 - h);
      c.lineTo(x + w, 512 - h);
      x += w;
    }
    c.lineTo(512, 512);
    c.fill();
    if (night) {
      rnd();
      for (let i = 0; i < 14; i++) {
        c.fillStyle = 'rgba(255,214,140,0.85)';
        c.fillRect(rnd() * 500, 430 + rnd() * 70, 6, 8);
      }
    }
  });
}

function artTexture(night: boolean): THREE.CanvasTexture {
  return canvasTexture(256, 192, (c) => {
    c.fillStyle = night ? '#2c3050' : '#f6efe2';
    c.fillRect(0, 0, 256, 192);
    const cols = night ? ['#6d7ab8', '#b07aa8', '#e0c27a'] : ['#e8a87c', '#85c1c8', '#f2d388'];
    c.globalAlpha = 0.9;
    c.fillStyle = cols[0];
    c.beginPath();
    c.arc(90, 110, 55, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = cols[1];
    c.fillRect(120, 40, 90, 90);
    c.fillStyle = cols[2];
    c.beginPath();
    c.moveTo(40, 170);
    c.lineTo(220, 170);
    c.lineTo(160, 120);
    c.fill();
  });
}
