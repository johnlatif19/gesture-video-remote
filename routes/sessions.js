const express = require('express');
const router = express.Router();
const roomManager = require('../lib/room-manager');

// Simple in-memory rate limit for join attempts (per IP).
const joinAttempts = new Map();
const JOIN_LIMIT = 10;          // max attempts
const JOIN_WINDOW_MS = 60_000;  // per minute

function rateLimitJoin(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const entry = joinAttempts.get(ip) || { count: 0, resetAt: now + JOIN_WINDOW_MS };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + JOIN_WINDOW_MS;
  }
  entry.count += 1;
  joinAttempts.set(ip, entry);

  if (entry.count > JOIN_LIMIT) {
    return res.status(429).json({
      ok: false,
      error: 'TOO_MANY_ATTEMPTS',
      message: 'Too many attempts. Please wait a minute.',
    });
  }
  next();
}

/**
 * POST /api/sessions
 * Creates a new session and returns its 6-digit code.
 * NOTE: The TV is expected to be the one calling this right before
 *       opening the WebSocket connection.
 */
router.post('/', (req, res) => {
  try {
    const ttl = parseInt(process.env.SESSION_TTL_MINUTES || '30', 10);
    // We don't have a socket yet here — the TV will attach after connecting.
    // So we just reserve a code and return it.
    const code = roomManager.generateCode();

    // Reserve a lightweight placeholder so the code can't be reused
    // before the TV connects. Will be replaced when TV joins via WS.
    roomManager.roomsByCode.set(code, {
      id: null,
      code,
      tvConnectionId: null,
      phoneConnectionId: null,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + ttl * 60 * 1000),
      activeVideoId: null,
      playbackState: null,
      reserved: true,
    });

    return res.json({
      ok: true,
      code,
      expiresAt: new Date(Date.now() + ttl * 60 * 1000).toISOString(),
      ttlMinutes: ttl,
    });
  } catch (err) {
    console.error('[POST /api/sessions]', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/sessions/:code
 * Validates a code from the phone BEFORE it opens the WebSocket.
 */
router.get('/:code', rateLimitJoin, (req, res) => {
  const { code } = req.params;

  if (!/^\d{6}$/.test(code)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_FORMAT',
      message: 'Code must be 6 digits.',
    });
  }

  const room = roomManager.getRoomByCode(code);

  if (!room) {
    return res.status(404).json({
      ok: false,
      error: 'ROOM_NOT_FOUND',
      message: 'No TV is using this code.',
    });
  }

  if (room.expiresAt.getTime() < Date.now()) {
    roomManager.destroyRoom(code);
    return res.status(410).json({
      ok: false,
      error: 'ROOM_EXPIRED',
      message: 'This code has expired.',
    });
  }

  if (room.phoneConnectionId) {
    return res.status(409).json({
      ok: false,
      error: 'PHONE_ALREADY_CONNECTED',
      message: 'Another phone is already controlling this TV.',
    });
  }

  return res.json({
    ok: true,
    code,
    reserved: !!room.reserved,
    hasTv: !!room.tvConnectionId,
    activeVideoId: room.activeVideoId,
    expiresAt: room.expiresAt.toISOString(),
  });
});

/**
 * GET /api/sessions
 * Admin: list all currently active rooms.
 */
router.get('/', (_req, res) => {
  const rooms = roomManager.listRooms().map((r) => ({
    code: r.code,
    hasTv: !!r.tvConnectionId,
    hasPhone: !!r.phoneConnectionId,
    activeVideoId: r.activeVideoId,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  }));
  return res.json({ ok: true, count: rooms.length, rooms });
});

module.exports = router;