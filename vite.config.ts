import { createReadStream, statSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { listSceneImages, sceneImageMime, sceneImagePath } from './server/sceneFiles.ts';

/**
 * 從本機路徑直接提供 VRM 模型（/avatar/model.vrm），模型檔不進專案目錄。
 * 模型受授權限制，這個端點只在 dev server（本機）存在，build 產物不包含模型。
 */
function localModel(modelPath: string | undefined): Plugin {
  return {
    name: 'local-vrm-model',
    configureServer(server) {
      server.middlewares.use('/avatar/model.vrm', (_req, res) => {
        if (!modelPath) {
          res.statusCode = 404;
          res.end('AVATAR_VRM_PATH 未設定，請參考 .env.local.example');
          return;
        }
        try {
          const { size } = statSync(modelPath);
          res.setHeader('Content-Type', 'model/gltf-binary');
          res.setHeader('Content-Length', size);
          res.setHeader('Cache-Control', 'no-store');
          createReadStream(modelPath).pipe(res);
        } catch {
          res.statusCode = 404;
          res.end(`找不到模型檔：${modelPath}`);
        }
      });
    },
  };
}

/** 自訂背景圖（與 hub 相同規則：只限專案 scenes/ 資料夾） */
function sceneImages(root: string): Plugin {
  return {
    name: 'scene-images',
    configureServer(server) {
      server.middlewares.use('/scenes', (req, res) => {
        const name = decodeURIComponent((req.url ?? '/').split('?')[0].slice(1));
        if (name === 'list.json') {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ images: listSceneImages(root) }));
          return;
        }
        const file = sceneImagePath(root, name);
        if (!file) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader('Content-Type', sceneImageMime(file));
        res.setHeader('Cache-Control', 'no-store');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'AVATAR_');
  return {
    plugins: [localModel(env.AVATAR_VRM_PATH), sceneImages(process.cwd())],
    server: { port: 5178, strictPort: true, host: '127.0.0.1' },
  };
});
