import { z } from 'zod';
import { EMOTIONS, GAZE_TARGETS, GESTURES, STATES, type AvatarCommand } from '../src/protocol.ts';

/** AvatarCommand 的執行期驗證（MCP 參數與 HTTP /cmd 共用） */

export const zState = z.enum(STATES);
export const zEmotion = z.enum(EMOTIONS);
export const zGesture = z.enum(GESTURES);
export const zGaze = z.enum(GAZE_TARGETS);

const zText = z.string().min(1).max(600);

export const zCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('state'), state: zState, reason: z.string().max(80).optional() }),
  z.object({
    type: z.literal('emotion'),
    emotion: zEmotion,
    intensity: z.number().min(0).max(1).optional(),
    holdMs: z.number().int().min(0).max(60_000).optional(),
  }),
  z.object({ type: z.literal('gesture'), gesture: zGesture }),
  z.object({ type: z.literal('gaze'), target: zGaze, holdMs: z.number().int().min(0).max(60_000).optional() }),
  z.object({ type: z.literal('say'), text: zText, emotion: zEmotion.optional(), name: z.string().max(40).optional() }),
]);

export function parseCommand(x: unknown): AvatarCommand | null {
  const r = zCommand.safeParse(x);
  return r.success ? (r.data as AvatarCommand) : null;
}
