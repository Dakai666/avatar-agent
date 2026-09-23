import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { FaceController } from './avatar/face';
import { BodyController } from './avatar/body';
import { GazeController } from './avatar/gaze';
import { IntentScheduler } from './behavior/scheduler';
import { DialogBox } from './ui/dialog';
import { DebugPanel } from './ui/debug';
import { smoothing } from './core/spring';
import { makeContinuityTest } from './dev/continuityTest';
import { Bridge } from './net/bridge';
import { AskFlow } from './behavior/ask';
import { Lighting } from './scene/lighting';

const app = document.getElementById('app')!;
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const loadingEl = document.getElementById('loading')!;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 20);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 0.6;
controls.maxDistance = 3.5;

// 背景光暈放在畫布後面（畫布是透明的）
const glowEl = document.createElement('div');
glowEl.className = 'stage-glow';
app.insertBefore(glowEl, canvas);
const lighting = new Lighting(scene, glowEl);

function resize(): void {
  const w = app.clientWidth;
  const h = app.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

async function loadVRM(): Promise<VRM> {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync('/avatar/model.vrm', (p) => {
    if (p.total) loadingEl.textContent = `載入角色中… ${Math.round((p.loaded / p.total) * 100)}%`;
  });
  const vrm = gltf.userData.vrm as VRM;
  VRMUtils.removeUnnecessaryVertices(gltf.scene);
  VRMUtils.combineSkeletons(gltf.scene);
  VRMUtils.rotateVRM0(vrm); // VRM 0.x 面向 -Z，轉成面向相機
  vrm.scene.traverse((o) => (o.frustumCulled = false));
  return vrm;
}

async function main(): Promise<void> {
  let vrm: VRM;
  try {
    vrm = await loadVRM();
  } catch (err) {
    loadingEl.textContent = `模型載入失敗：${(err as Error).message}（檢查 .env.local 的 AVATAR_VRM_PATH）`;
    throw err;
  }
  scene.add(vrm.scene);
  lighting.attachModel(vrm.scene);
  loadingEl.remove();

  // 相機：胸上構圖（VTuber 常見框法）
  vrm.scene.updateMatrixWorld(true);
  const headPos = new THREE.Vector3();
  vrm.humanoid.getNormalizedBoneNode('head')!.getWorldPosition(headPos);
  const focusY = headPos.y - 0.14;
  // 直式視窗時拉遠，讓胸上構圖完整入鏡
  const frameCamera = () => {
    const dist = 1.35 * Math.max(1, 0.95 / camera.aspect);
    camera.position.set(0, headPos.y - 0.02, dist);
    controls.target.set(0, focusY, 0);
    controls.update();
  };
  frameCamera();

  const eyeWorld = new THREE.Vector3();
  // 從眼睛高度量（lookAt 原點），不是頭骨：頭骨比眼睛低約 6cm，會讓視線整體偏高
  const userAngles = () => {
    vrm.lookAt!.getLookAtWorldPosition(eyeWorld);
    const d = camera.position.clone().sub(eyeWorld);
    return { yaw: Math.atan2(d.x, d.z), pitch: Math.atan2(-d.y, Math.hypot(d.x, d.z)) };
  };

  const face = new FaceController(vrm);
  const gaze = new GazeController(userAngles, () => face.blink.trigger());
  const body = new BodyController(vrm, gaze);
  const sched = new IntentScheduler(face, body, gaze);
  vrm.lookAt!.autoUpdate = false;

  const dialog = new DialogBox(app, () => sched.skipSpeech());
  sched.onDialog = (d) => dialog.update(d);
  const debug = new DebugPanel(app, sched);
  debug.addLighting(lighting);
  if (window.innerWidth < 900) debug.collapse();

  // ---- 與 agent 的橋接（本機 hub，由 MCP server 提供） ----
  const bridge = new Bridge();
  const askFlow = new AskFlow(sched, dialog, (id, index, text) => bridge.answer({ id, index, text }));
  const linkDot = document.createElement('div');
  linkDot.className = 'link-dot';
  app.appendChild(linkDot);
  const LINK_LABEL = { connecting: '連線中', online: 'Agent 已連線', offline: '等待 Agent' } as const;
  bridge.onStatus = (s) => {
    linkDot.dataset.status = s;
    linkDot.textContent = LINK_LABEL[s];
  };
  bridge.onStatus(bridge.status);
  bridge.onCommand = (cmd) => sched.send(cmd);
  bridge.onAsk = (ask) => askFlow.enqueue(ask);
  bridge.onAskCancel = (id) => askFlow.cancel(id);
  bridge.connect();

  // 本機測試提問（不經 agent）
  debug.addAction('ask', '測試提問', () => {
    const id = `local-${Date.now()}`;
    const local = new AskFlow(sched, dialog, (_id, index, text) => sched.send({ type: 'say', text: `收到，你選了「${text}」${index < 0 ? '（自由輸入）' : ''}`, name: 'Agent' }));
    local.enqueue({ id, question: '這個指令會刪除 build 資料夾，要繼續嗎？', options: ['繼續執行', '先備份再執行', '取消'], allowText: true, name: 'Agent' });
  });

  const frame = (dt: number) => {
    sched.update(dt);
    gaze.update(dt);
    body.update(dt);
    face.update(dt);
    vrm.lookAt!.yaw = THREE.MathUtils.radToDeg(gaze.eyeYaw.x);
    vrm.lookAt!.pitch = THREE.MathUtils.radToDeg(gaze.eyePitch.x);
    vrm.update(dt);
    face.apply(); // 必須在 vrm.update 之後
    controls.update();
    renderer.render(scene, camera);
  };

  // 除錯/調校用：step() 可在 rAF 被暫停時（分頁不可見）手動推進模擬
  const step = (seconds: number, fpsStep = 60) => {
    for (let i = 0; i < Math.round(seconds * fpsStep); i++) frame(1 / fpsStep);
  };
  const continuityTest = makeContinuityTest(vrm, sched, step);
  Object.assign(window, { __avatar: { vrm, face, gaze, body, sched, camera, step, smoothing, continuityTest, bridge, askFlow, lighting } });

  const timer = new THREE.Timer();
  timer.connect(document);
  let fpsAcc = 0;
  let fpsFrames = 0;
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    // 限制 dt：分頁切回來時不會一次跳一大步
    const dt = Math.min(timer.getDelta(), 1 / 20);
    frame(dt);

    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc > 0.5) {
      const fps = fpsFrames / fpsAcc;
      fpsAcc = 0;
      fpsFrames = 0;
      debug.updateStatus(fps, `視線:${gaze.current} · 手勢:${body.activeGesture ?? '—'} · 情緒:${face.dominantEmotion}`);
    }
  });
}

main();
