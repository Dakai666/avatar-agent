import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { AvatarLink } from './link.ts';
import { resolve } from 'node:path';
import { zEmotion, zGaze, zGesture, zScene, zState } from './schema.ts';
import { listSceneImages, sceneImagePath } from './sceneFiles.ts';

/**
 * Avatar MCP server（stdio）。
 * 讓 agent 透過工具驅動角色：說話、切換狀態、表情手勢、以及在對話框向使用者提問。
 */

const SPEAKER = process.env.AVATAR_NAME || 'Agent';
const ROOT = resolve(import.meta.dirname, '..');
const link = new AvatarLink();
await link.start();

const server = new McpServer(
  { name: 'avatar', version: '0.2.0' },
  {
    instructions: [
      'You have an animated avatar shown to the user in a browser page. It already reacts to your tool use automatically',
      '(reading / working / thinking / waiting), so you do NOT need to narrate every step.',
      'Use avatar_say for short spoken lines in the user\'s language (1-2 sentences) at meaningful moments:',
      'greeting, announcing a result, or reacting. Keep full explanations in the normal chat reply.',
      'Use avatar_express to add emotion or a gesture that matches what you are saying or feeling.',
      'Use avatar_ask for quick decisions the user can answer with a click; if it reports no page or timeout,',
      'fall back to asking in chat.',
    ].join(' '),
  },
);

const noPageNote = () =>
  link.pageCount > 0 ? '' : `（目前沒有開啟的 avatar 頁面，指令未顯示。頁面網址：${link.pageUrl}）`;

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

server.registerTool(
  'avatar_say',
  {
    title: 'Avatar: say',
    description:
      'Make the avatar speak a short line in the dialog box, with lip-sync. Non-blocking. ' +
      'Use the user\'s language. Keep it short (1-2 sentences); long content belongs in the chat reply.',
    inputSchema: {
      text: z.string().min(1).max(600).describe('What the avatar says'),
      emotion: zEmotion.optional().describe('Facial emotion while speaking'),
      gesture: zGesture.optional().describe('Gesture to play while speaking'),
    },
  },
  async ({ text: line, emotion, gesture }) => {
    link.send({ type: 'say', text: line, emotion, name: SPEAKER });
    if (gesture) link.send({ type: 'gesture', gesture });
    return text(`已送出台詞${noPageNote()}`);
  },
);

server.registerTool(
  'avatar_set_state',
  {
    title: 'Avatar: set state',
    description:
      'Set the avatar\'s activity state. Tool-use hooks already set reading/working/thinking automatically; ' +
      'use this for states hooks cannot infer, e.g. "happy" after a success or "troubled" after a failure.',
    inputSchema: {
      state: zState,
      reason: z.string().max(80).optional().describe('Short note for the event log'),
    },
  },
  async ({ state, reason }) => {
    link.send({ type: 'state', state, reason });
    return text(`狀態 → ${state}${noPageNote()}`);
  },
);

server.registerTool(
  'avatar_express',
  {
    title: 'Avatar: express',
    description:
      'Show an emotion, play a gesture, and/or direct the avatar\'s gaze. At least one field is required. ' +
      'Emotions fade back to the state default after hold_ms.',
    inputSchema: {
      emotion: zEmotion.optional(),
      intensity: z.number().min(0).max(1).optional().describe('Emotion strength, default 0.8'),
      gesture: zGesture.optional(),
      gaze: zGaze.optional().describe('Where to look: user, down, thinkUp, side, dialog, wander'),
      hold_ms: z.number().int().min(200).max(60_000).optional().describe('How long to hold emotion/gaze'),
      fade_ms: z
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .describe('How long the emotion takes to blend in, e.g. 0 for a sudden shock, 1500 for slowly turning sad'),
    },
  },
  async ({ emotion, intensity, gesture, gaze, hold_ms, fade_ms }) => {
    if (!emotion && !gesture && !gaze) return { ...text('至少要指定 emotion、gesture、gaze 其中一個'), isError: true };
    if (emotion) link.send({ type: 'emotion', emotion, intensity, holdMs: hold_ms, fadeMs: fade_ms });
    if (gesture) link.send({ type: 'gesture', gesture });
    if (gaze) link.send({ type: 'gaze', target: gaze, holdMs: hold_ms });
    return text(`已表現${noPageNote()}`);
  },
);

server.registerTool(
  'avatar_ask',
  {
    title: 'Avatar: ask the user',
    description:
      'The avatar asks the user a question in the dialog box and shows clickable options (and optionally a text field). ' +
      'Blocks until the user answers or the timeout expires. The answer comes from the user through the avatar page. ' +
      'If no page is open or it times out, ask in chat instead.',
    inputSchema: {
      question: z.string().min(1).max(300),
      options: z.array(z.string().min(1).max(60)).max(6).default([]).describe('Clickable choices (0-6)'),
      allow_text: z.boolean().default(false).describe('Also show a free-text input'),
      timeout_sec: z.number().int().min(5).max(600).default(180),
    },
  },
  async ({ question, options, allow_text, timeout_sec }) => {
    if (options.length === 0 && !allow_text) {
      return { ...text('options 為空時必須設定 allow_text: true'), isError: true };
    }
    const r = await link.ask({ question, options, allowText: allow_text, name: SPEAKER }, timeout_sec * 1000);
    if (r.ok) {
      const how = r.answer.index >= 0 ? `選項 #${r.answer.index + 1}` : '自由輸入';
      return text(`使用者回答（${how}）：${r.answer.text}`);
    }
    const why =
      r.reason === 'no-page'
        ? `沒有開啟的 avatar 頁面（${link.pageUrl}），請改在對話中詢問。`
        : r.reason === 'timeout'
          ? `使用者在 ${timeout_sec} 秒內沒有回應，請改在對話中詢問。`
          : `提問失敗：${r.detail ?? '未知原因'}，請改在對話中詢問。`;
    return text(why);
  },
);

server.registerTool(
  'avatar_set_scene',
  {
    title: 'Avatar: set scene',
    description:
      'Change the background behind the avatar (cross-fades, the avatar keeps moving). ' +
      'default = soft gradient; greenscreen = solid green for chroma key; transparent = see-through page for OBS; ' +
      'room / roomNight = built-in 3D room; image = a picture from the project scenes/ folder (pass its file name). ' +
      'Only change the scene when the user asks or it clearly fits the moment.',
    inputSchema: {
      scene: zScene,
      image: z.string().max(120).optional().describe('File name inside scenes/, required when scene is "image"'),
    },
  },
  async ({ scene, image }) => {
    if (scene === 'image') {
      const available = listSceneImages(ROOT);
      if (!image || !sceneImagePath(ROOT, image)) {
        const list = available.length ? available.join(', ') : '（scenes/ 資料夾目前沒有圖片）';
        return { ...text(`找不到背景圖「${image ?? ''}」。可用的圖片：${list}`), isError: true };
      }
      link.send({ type: 'scene', scene, image });
    } else {
      link.send({ type: 'scene', scene });
    }
    return text(`場景 → ${scene}${image && scene === 'image' ? `（${image}）` : ''}${noPageNote()}`);
  },
);

server.registerTool(
  'avatar_status',
  {
    title: 'Avatar: status',
    description: 'Check whether an avatar page is open and get its URL.',
    inputSchema: {},
  },
  async () =>
    text(JSON.stringify({ mode: link.mode, pagesConnected: link.pageCount, pageUrl: link.pageUrl }, null, 2)),
);

await server.connect(new StdioServerTransport());

const shutdown = () => {
  link.close();
  process.exit(0);
};
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
