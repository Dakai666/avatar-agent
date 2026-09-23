import { createReadStream, statSync } from 'node:fs';
import { defineConfig, loadEnv, type Plugin } from 'vite';

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'AVATAR_');
  return {
    plugins: [localModel(env.AVATAR_VRM_PATH)],
    server: { port: 5178, strictPort: true, host: '127.0.0.1' },
  };
});
