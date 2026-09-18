const { nanoid } = require('nanoid');

/** @typedef {'tv' | 'phone'} Role */

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} code → room */
    this.roomsByCode = new Map();

    /** @type {Map<string, string>} connectionId → code */
    this.codeByConnection = new Map();

    /** @type {Map<string, import('ws').WebSocket>} connectionId → socket */
    this.socketById = new Map();
  }

  /**
   * Generate a unique 6-digit code that isn't currently in use.
   * Retries up to 20 times to avoid collisions.
   */
  generateCode() {
    for (let i = 0; i < 20; i++) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      if (!this.roomsByCode.has(code)) return code;
    }
    throw new Error('Could not generate unique room code');
  }

  /**
   * Create a new room and register the TV socket to it.
   * @param {import('ws').WebSocket} socket
   * @param {number} ttlMinutes
   */
  createRoom(socket, ttlMinutes = 30) {
    const code = this.generateCode();
    const now = Date.now();
    const connectionId = nanoid(12);

    const room = {
      id: nanoid(16),
      code,
      tvConnectionId: connectionId,
      phoneConnectionId: null,
      createdAt: new Date(now),
      expiresAt: new Date(now + ttlMinutes * 60 * 1000),
      activeVideoId: null,
      playbackState: null, // filled by TV: { isPlaying, currentTime, volume, muted }
    };

    this.roomsByCode.set(code, room);
    this.codeByConnection.set(connectionId, code);
    this.socketById.set(connectionId, socket);

    // Attach metadata to the socket so we can find it on close
    socket.meta = { connectionId, role: 'tv', code };

    return { room, connectionId };
  }

  /**
   * Attach a phone to an existing room.
   * @param {string} code
   * @param {import('ws').WebSocket} socket
   */
  joinRoom(code, socket) {
    const room = this.roomsByCode.get(code);
    if (!room) return { error: 'ROOM_NOT_FOUND' };
    if (room.expiresAt.getTime() < Date.now()) {
      this.destroyRoom(code);
      return { error: 'ROOM_EXPIRED' };
    }
    if (room.phoneConnectionId) {
      return { error: 'PHONE_ALREADY_CONNECTED' };
    }

    const connectionId = nanoid(12);
    room.phoneConnectionId = connectionId;
    this.codeByConnection.set(connectionId, code);
    this.socketById.set(connectionId, socket);

    socket.meta = { connectionId, role: 'phone', code };

    return { room, connectionId };
  }

  /** Get the room a socket belongs to (or null). */
  getRoomBySocket(socket) {
    const code = socket?.meta?.code;
    return code ? this.roomsByCode.get(code) || null : null;
  }

  /** Get the TV socket of a room. */
  getTvSocket(room) {
    const id = room?.tvConnectionId;
    return id ? this.socketById.get(id) || null : null;
  }

  /** Get the phone socket of a room. */
  getPhoneSocket(room) {
    const id = room?.phoneConnectionId;
    return id ? this.socketById.get(id) || null : null;
  }

  /**
   * Called on socket close.
   * If TV leaves → destroy the room.
   * If phone leaves → detach it but keep the room alive.
   */
  handleDisconnect(socket) {
    const meta = socket?.meta;
    if (!meta) return null;

    const { connectionId, role, code } = meta;
    this.codeByConnection.delete(connectionId);
    this.socketById.delete(connectionId);

    const room = this.roomsByCode.get(code);
    if (!room) return null;

    if (role === 'tv') {
      this.destroyRoom(code);
      return { role, code, destroyed: true };
    }

    if (role === 'phone') {
      room.phoneConnectionId = null;
      return { role, code, destroyed: false };
    }

    return null;
  }

  /** Remove a room and its connection index entries. */
  destroyRoom(code) {
    const room = this.roomsByCode.get(code);
    if (!room) return;

    if (room.tvConnectionId) {
      this.codeByConnection.delete(room.tvConnectionId);
      this.socketById.delete(room.tvConnectionId);
    }
    if (room.phoneConnectionId) {
      this.codeByConnection.delete(room.phoneConnectionId);
      this.socketById.delete(room.phoneConnectionId);
    }

    this.roomsByCode.delete(code);
  }

  /** Update the cached playback state (called by TV). */
  setPlaybackState(code, state) {
    const room = this.roomsByCode.get(code);
    if (room) room.playbackState = state;
  }

  /** Update the active video (called by dashboard). */
  setActiveVideo(code, videoId) {
    const room = this.roomsByCode.get(code);
    if (room) room.activeVideoId = videoId;
  }

  /** Find a room by code (used by dashboard/sessions API). */
  getRoomByCode(code) {
    return this.roomsByCode.get(code) || null;
  }

  /** For debugging / admin. */
  listRooms() {
    return Array.from(this.roomsByCode.values());
  }
}

/** Singleton — one instance per server process. */
module.exports = new RoomManager();