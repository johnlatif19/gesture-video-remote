(function (global) {
  'use strict';

  const RECONNECT_BASE_MS = 500;
  const RECONNECT_MAX_MS = 10000;
  const HEARTBEAT_INTERVAL_MS = 15000;   // ← 15s to survive proxy timeouts

  class WSClient {
    /**
     * @param {string} path  e.g. "/ws" or a full "wss://..." URL
     * @param {{ autoReconnect?: boolean }} [opts]
     */
    constructor(path, opts = {}) {
      this.path = path;
      this.autoReconnect = opts.autoReconnect !== false;

      /** @type {WebSocket | null} */
      this.socket = null;
      this.isOpen = false;
      this.shouldReconnect = this.autoReconnect;

      this.reconnectAttempts = 0;
      this.reconnectTimer = null;
      this.heartbeatTimer = null;

      /** @type {Array<object>} */
      this.queue = [];
      /** @type {Map<string, Set<Function>>} */
      this.listeners = new Map();
    }

    // ─── URL builder ─────────────────────────────────────
    _resolveUrl() {
      if (/^wss?:\/\//i.test(this.path)) return this.path;
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}${this.path}`;
    }

    // ─── Events ──────────────────────────────────────────
    on(event, fn) {
      if (!this.listeners.has(event)) this.listeners.set(event, new Set());
      this.listeners.get(event).add(fn);
      return this;
    }

    off(event, fn) {
      const set = this.listeners.get(event);
      if (!set) return this;
      if (fn) set.delete(fn);
      else set.clear();
      return this;
    }

    emit(event, ...args) {
      const set = this.listeners.get(event);
      if (!set) return;
      set.forEach((fn) => {
        try {
          fn(...args);
        } catch (err) {
          console.error(`[WS] listener "${event}" failed:`, err);
        }
      });
    }

    // ─── Connect ─────────────────────────────────────────
    connect() {
      if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) {
        return;
      }

      const url = this._resolveUrl();
      this.emit('connecting', { url, attempt: this.reconnectAttempts + 1 });

      try {
        this.socket = new WebSocket(url);
      } catch (err) {
        console.error('[WS] construct failed:', err);
        this._scheduleReconnect();
        return;
      }

      this.socket.addEventListener('open', () => this._onOpen());
      this.socket.addEventListener('message', (e) => this._onMessage(e));
      this.socket.addEventListener('close', (e) => this._onClose(e));
      this.socket.addEventListener('error', (e) => this._onError(e));
    }

    _onOpen() {
      this.isOpen = true;
      this.reconnectAttempts = 0;
      console.log('[WS] open at', new Date().toISOString());
      this.emit('open');
      this._startHeartbeat();

      // Flush queue
      const pending = this.queue.splice(0, this.queue.length);
      pending.forEach((msg) => this.send(msg));
    }

    _onMessage(event) {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      this.emit('message', data);
      if (data && typeof data.type === 'string') {
        this.emit(data.type, data);
      }
    }

    _onClose(event) {
      const wasOpen = this.isOpen;
      this.isOpen = false;
      this._stopHeartbeat();

      console.log('[WS] closed', {
        code: event.code,
        reason: event.reason || '(none)',
        wasOpen,
        at: new Date().toISOString(),
      });

      this.emit('close', { code: event.code, reason: event.reason, wasOpen });

      if (this.shouldReconnect && event.code !== 1000) {
        this._scheduleReconnect();
      }
    }

    _onError(event) {
      this.emit('error', event);
    }

    // ─── Send ────────────────────────────────────────────
    send(message) {
      if (!this.isOpen || !this.socket) {
        this.queue.push(message);
        if (!this.socket || this.socket.readyState === 3) this.connect();
        return false;
      }
      try {
        this.socket.send(JSON.stringify(message));
        return true;
      } catch (err) {
        console.error('[WS] send failed:', err);
        this.queue.push(message);
        return false;
      }
    }

    // ─── Close ───────────────────────────────────────────
    close(code = 1000, reason = 'client-close') {
      this.shouldReconnect = false;
      this._stopHeartbeat();
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.socket && this.socket.readyState < 2) {
        this.socket.close(code, reason);
      }
    }

    // ─── Reconnect ───────────────────────────────────────
    _scheduleReconnect() {
      if (this.reconnectTimer) return;
      const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
        RECONNECT_MAX_MS
      );
      this.reconnectAttempts += 1;
      this.emit('reconnecting', { delay, attempt: this.reconnectAttempts });

      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.connect();
      }, delay);
    }

    // ─── Heartbeat ───────────────────────────────────────
    _startHeartbeat() {
      this._stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (this.isOpen && this.socket && this.socket.readyState === 1) {
          try {
            this.socket.send(JSON.stringify({ type: 'PING', t: Date.now() }));
          } catch {
            /* ignore */
          }
        }
      }, HEARTBEAT_INTERVAL_MS);
    }

    _stopHeartbeat() {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    }
  }

  global.WSClient = WSClient;
})(window);
