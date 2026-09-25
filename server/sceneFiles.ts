import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { SCENE_IMAGE_NAME } from '../src/protocol.ts';

/**
 * 自訂背景圖：只從專案內的 scenes/ 資料夾提供（hub 與 Vite dev server 共用）。
 * 限定檔名格式與圖片副檔名、禁止跳出資料夾——agent 只能指定檔名，不能讓 hub 讀電腦上的任意檔案。
 * 沒有上傳端點：使用者自己把圖片放進資料夾。
 */

export const SCENE_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export function scenesDir(root: string): string {
  return join(root, 'scenes');
}

/** 檔名合法且檔案存在時回傳絕對路徑，否則 null */
export function sceneImagePath(root: string, name: string): string | null {
  if (!SCENE_IMAGE_NAME.test(name) || basename(name) !== name) return null;
  const dir = resolve(scenesDir(root));
  const file = resolve(dir, name);
  if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) return null;
  return file;
}

export function listSceneImages(root: string): string[] {
  const dir = scenesDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => SCENE_IMAGE_NAME.test(n) && statSync(join(dir, n)).isFile())
    .sort();
}

export function sceneImageMime(file: string): string {
  return SCENE_IMAGE_MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}
