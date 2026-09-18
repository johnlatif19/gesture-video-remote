const WebSocket = require('ws');
const roomManager = require('./room-manager');
const { parseClientMessage } = require('./validation');

const OPEN = WebSocket.OPEN;
const TV_GRACE_MS = 10000;

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
  if (socket.meta) {
    return sendError(socket, 'ALREADY_JOINED', 'This socket already joined a room.');
  }

  const { code, role } = msg;

  if (role === 'tv') {
    const existing = roomManager.getRoomByCode(code);

    if (existing && existing.reserved) {
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

    send(socket, {
      type: 'ROOM_JOINED',
      roomId: room.id,
      code: room.code,
      role: 'phone',
    });

    const tv = roomManager.getTvSocket(room);
    if (tv) {
      send(tv, { type: 'PHONE_CONNECTED' });

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

  const phone = roomManager.getPhoneSocket(room);
  if (phone) {
    send(phone, { type: 'PLAYBACK_STATE', ...state });
  }
}

// ─── Disconnect ──────────────────────────────────────────

function handleDisconnect(socket) {
  const meta = socket?.meta;
  if (!meta) return;

  const { role, code, connectionId } = meta;

  if (role === 'phone') {
    const room = roomManager.getRoomByCode(code);
    if (room) {
      if (room.phoneConnectionId === connectionId) {
        room.phoneConnectionId = null;
      }
      roomManager.codeByConnection.delete(connectionId);
      roomManager.socketById.delete(connectionId);

      const tv = roomManager.getTvSocket(room);
      if (tv) send(tv, { type: 'PHONE_DISCONNECTED' });
    }
    return;
  }

  if (role === 'tv') {
    const room = roomManager.getRoomByCode(code);
    if (!room) return;
    if (room.tvConnectionId !== connectionId) return;

    console.log(`[WS] TV left room ${code}, waiting ${TV_GRACE_MS / 1000}s before destroy...`);

    setTimeout(() => {
      const stillRoom = roomManager.getRoomByCode(code);
      if (!stillRoom) return;

      // TV reconnected with a new connectionId → keep room
      if (stillRoom.tvConnectionId && stillRoom.tvConnectionId !== connectionId) {
        console.log(`[WS] TV reconnected to room ${code}, keeping room`);
        roomManager.codeByConnection.delete(connectionId);
        roomManager.socketById.delete(connectionId);
        return;
      }

      console.log(`[WS] Room ${code} destroyed (TV gone after grace period)`);
      roomManager.destroyRoom(code);
    }, TV_GRACE_MS);
  }
}

// ─── Expiry sweep ────────────────────────────────────────

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
