const { z } = require('zod');

// ─── Command enum ────────────────────────────────────────
const CommandSchema = z.enum([
  'PLAY',
  'PAUSE',
  'VOLUME_UP',
  'VOLUME_DOWN',
  'MUTE',
  'SEEK_FORWARD',
  'SEEK_BACKWARD',
  'RESTART',
]);

// ─── Client → Server messages ────────────────────────────
const JoinRoomSchema = z.object({
  type: z.literal('JOIN_ROOM'),
  code: z.string().regex(/^\d{6}$/, 'Code must be exactly 6 digits'),
  role: z.enum(['tv', 'phone']),
});

const CommandMessageSchema = z.object({
  type: z.literal('COMMAND'),
  command: CommandSchema,
});

const PlaybackStateSchema = z.object({
  type: z.literal('PLAYBACK_STATE'),
  isPlaying: z.boolean(),
  currentTime: z.number().min(0),
  duration: z.number().min(0),
  volume: z.number().min(0).max(1),
  muted: z.boolean(),
});

const ClientMessageSchema = z.discriminatedUnion('type', [
  JoinRoomSchema,
  CommandMessageSchema,
  PlaybackStateSchema,
]);

// ─── Server → Client messages (for documentation / typing) ─
const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ROOM_JOINED'),
    roomId: z.string(),
    code: z.string(),
    role: z.enum(['tv', 'phone']),
  }),
  z.object({
    type: z.literal('ROOM_CREATED'),
    roomId: z.string(),
    code: z.string(),
  }),
  z.object({
    type: z.literal('COMMAND'),
    command: CommandSchema,
  }),
  z.object({
    type: z.literal('PHONE_CONNECTED'),
  }),
  z.object({
    type: z.literal('PHONE_DISCONNECTED'),
  }),
  z.object({
    type: z.literal('TV_DISCONNECTED'),
  }),
  z.object({
    type: z.literal('PLAYBACK_STATE'),
    isPlaying: z.boolean(),
    currentTime: z.number(),
    duration: z.number(),
    volume: z.number(),
    muted: z.boolean(),
  }),
  z.object({
    type: z.literal('LOAD_VIDEO'),
    video: z.object({
      id: z.string(),
      title: z.string(),
      url: z.string().url(),
      thumbnailUrl: z.string().url().nullable().optional(),
    }),
  }),
  z.object({
    type: z.literal('ERROR'),
    code: z.string(),
    message: z.string(),
  }),
]);

/**
 * Safely parse an incoming client message.
 * @param {string | Buffer} raw
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
function parseClientMessage(raw) {
  let json;
  try {
    json = JSON.parse(raw.toString());
  } catch {
    return { ok: false, error: 'INVALID_JSON' };
  }

  const result = ClientMessageSchema.safeParse(json);
  if (!result.success) {
    return {
      ok: false,
      error: 'INVALID_MESSAGE',
      details: result.error.flatten(),
    };
  }
  return { ok: true, data: result.data };
}

module.exports = {
  CommandSchema,
  ClientMessageSchema,
  ServerMessageSchema,
  parseClientMessage,
};