const WebSocket = require('ws');
const roomManager = require('./room-manager');
const { parseClientMessage } = require('./validation');

const OPEN = WebSocket.OPEN;

// ─── Send helpers ────────────────────────────────────────

function send(socket, payload) {
  if (!socket || socket.readyState !== OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    console.error('[WS] send failed:', err.message);
    return false;
  }
}

function sendError(socket, code, message) {
  send(socket, { type: 'ERROR', code, message });
}

// ─── Main handler ────────────────────────────────────────

/**
 * Called by server.js for every incoming message.
 * @param {import('ws').WebSocket} socket
 * @param {Buffer | string} raw
 */
function handleMessage(socket, raw) {
  const parsed = parseClientMessage(raw);
  if (!parsed.ok) {
    return sendError(socket, parsed.error, 'Invalid message format.');
  }

  const msg = parsed.data;

  switch (msg.type) {
    case 'JOIN_ROOM':
      return handleJoinRoom(socket, msg);
    case 'COMMAND':
      return handleCommand(socket, msg);
    case 'PLAYBACK_STATE':
      return handlePlaybackState(socket, msg);
    default:
      return sendError(socket, 'UNKNOWN_TYPE', 'Unknown message type.');
  }
}

// ─── JOIN_ROOM ───────────────────────────────────────────

function handleJoinRoom(socket, msg) {
  // Already joined?
  if (socket.meta) {
    return sendError(socket, 'ALREADY_JOINED', 'This socket already joined a room.');
  }

  const { code, role } = msg;

  if (role === 'tv') {
    // TV creates the room.
    // If the code was reserved by POST /api/sessions, upgrade it.
    const existing = roomManager.getRoomByCode(code);

    if (existing && existing.reserved) {
      // Attach TV socket to the reserved room
      const { nanoid } = require('nanoid');
      const connectionId = nanoid(12);

      existing.reserved = false;
      existing.id = existing.id || nanoid(16);
      existing.tvConnectionId = connectionId;

      roomManager.codeByConnection.set(connectionId, code);
      roomManager.socketById.set(connectionId, socket);
      socket.meta = { connectionId, role: 'tv', code };

      return send(socket, {
        type: 'ROOM_CREATED',
        roomId: existing.id,
        code,
      });
    }

    // No reservation → create fresh room
    if (existing) {
      return sendError(socket, 'CODE_IN_USE', 'This code is already taken.');
    }

    try {
      const ttl = parseInt(process.env.SESSION_TTL_MINUTES || '30', 10);
      const { room } = roomManager.createRoom(socket, ttl);
      return send(socket, {
        type: 'ROOM_CREATED',
        roomId: room.id,
        code: room.code,
      });
    } catch (err) {
      console.error('[WS] createRoom failed:', err.message);
      return sendError(socket, 'SERVER_ERROR', 'Could not create room.');
    }
  }

  if (role === 'phone') {
    const result = roomManager.joinRoom(code, socket);

    if (result.error) {
      const messages = {
        ROOM_NOT_FOUND: 'No TV is using this code.',
        ROOM_EXPIRED: 'This code has expired.',
        PHONE_ALREADY_CONNECTED: 'Another phone is already connected.',
      };
      return sendError(socket, result.error, messages[result.error] || 'Could not join.');
    }

    const { room } = result;

    // Confirm to phone
    send(socket, {
      type: 'ROOM_JOINED',
      roomId: room.id,
      code: room.code,
      role: 'phone',
    });

    // Notify TV
    const tv = roomManager.getTvSocket(room);
    if (tv) {
      send(tv, { type: 'PHONE_CONNECTED' });

      // Send current playback state to phone if TV has one
      if (room.playbackState) {
        send(socket, {
          type: 'PLAYBACK_STATE',
          ...room.playbackState,
        });
      }
    }

    return;
  }

  return sendError(socket, 'INVALID_ROLE', 'Role must be "tv" or "phone".');
}

// ─── COMMAND (phone → TV) ────────────────────────────────

function handleCommand(socket, msg) {
  const meta = socket.meta;
  if (!meta) {
    return sendError(socket, 'NOT_JOINED', 'Join a room first.');
  }

  if (meta.role !== 'phone') {
    return sendError(socket, 'FORBIDDEN', 'Only the phone can send commands.');
  }

  const room = roomManager.getRoomByCode(meta.code);
  if (!room) {
    return sendError(socket, 'ROOM_GONE', 'This room no longer exists.');
  }

  const tv = roomManager.getTvSocket(room);
  if (!tv) {
    return sendError(socket, 'TV_OFFLINE', 'The TV is not connected.');
  }

  // Route command to TV
  send(tv, { type: 'COMMAND', command: msg.command });
}

// ─── PLAYBACK_STATE (TV → phone) ─────────────────────────

function handlePlaybackState(socket, msg) {
  const meta = socket.meta;
  if (!meta) {
    return sendError(socket, 'NOT_JOINED', 'Join a room first.');
  }

  if (meta.role !== 'tv') {
    return sendError(socket, 'FORBIDDEN', 'Only the TV can report playback state.');
  }

  const room = roomManager.getRoomByCode(meta.code);
  if (!room) return;

  const state = {
    isPlaying: msg.isPlaying,
    currentTime: msg.currentTime,
    duration: msg.duration,
    volume: msg.volume,
    muted: msg.muted,
  };

  roomManager.setPlaybackState(meta.code, state);

  // Forward to phone if connected
  const phone = roomManager.getPhoneSocket(room);
  if (phone) {
    send(phone, { type: 'PLAYBACK_STATE', ...state });
  }
}

// ─── Disconnect ──────────────────────────────────────────

/**
 * Called by server.js when a socket closes.
 * @param {import('ws').WebSocket} socket
 */
function handleDisconnect(socket) {
  const result = roomManager.handleDisconnect(socket);
  if (!result) return;

  const { role, code, destroyed } = result;

  if (role === 'phone') {
    // Tell TV the phone left
    const room = roomManager.getRoomByCode(code);
    if (room) {
      const tv = roomManager.getTvSocket(room);
      if (tv) send(tv, { type: 'PHONE_DISCONNECTED' });
    }
  }

  if (role === 'tv' && destroyed) {
    // Room gone — nothing more to do.
    // (Phone will be notified via its own socket close when we terminate it,
    //  but for now we don't force-close; the phone will get ROOM_GONE
    //  on its next command attempt.)
    console.log(`[WS] Room ${code} destroyed (TV left)`);
  }
}

// ─── Expiry sweep ────────────────────────────────────────

/**
 * Periodically destroy expired rooms.
 * Runs every 60s.
 */
function startExpirySweep(intervalMs = 60_000) {
  return setInterval(() => {
    const now = Date.now();
    const rooms = roomManager.listRooms();
    for (const room of rooms) {
      if (room.expiresAt.getTime() < now && !room.reserved) {
        const tv = roomManager.getTvSocket(room);
        if (tv && tv.readyState === OPEN) {
          send(tv, { type: 'ERROR', code: 'ROOM_EXPIRED', message: 'Session expired.' });
          tv.close(4000, 'expired');
        }
        const phone = roomManager.getPhoneSocket(room);
        if (phone && phone.readyState === OPEN) {
          send(phone, { type: 'ERROR', code: 'ROOM_EXPIRED', message: 'Session expired.' });
          phone.close(4000, 'expired');
        }
        roomManager.destroyRoom(room.code);
        console.log(`[WS] Room ${room.code} expired and destroyed`);
      }
    }
  }, intervalMs);
}

module.exports = {
  handleMessage,
  handleDisconnect,
  startExpirySweep,
};