(function () {
  'use strict';

  // ─── DOM ────────────────────────────────────────────
  const idleScreen = document.getElementById('idle-screen');
  const playerScreen = document.getElementById('player-screen');
  const codeDisplay = document.getElementById('code-display');
  const statusBadge = document.getElementById('status-badge');
  const statusText = document.getElementById('status-text');
  const video = document.getElementById('video');
  const emptyState = document.getElementById('empty-state');
  const overlay = document.getElementById('overlay');
  const overlayIcon = document.getElementById('overlay-icon');
  const overlayLabel = document.getElementById('overlay-label');
  const hudStatus = document.getElementById('hud-status');
  const hudText = document.getElementById('hud-text');
  const connectionLost = document.getElementById('connection-lost');

  // ─── State ──────────────────────────────────────────
  const state = {
    code: null,
    hasPhone: false,
    hasVideo: false,
    volume: 1,
    muted: false,
  };

  // ─── WS ─────────────────────────────────────────────
  const ws = new WSClient('/ws');

  // ─── Boot ───────────────────────────────────────────
  init();

  async function init() {
    setStatus('waiting', 'Connecting to server…');

    try {
      const res = await fetch('/api/sessions', { method: 'POST' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Failed');

      state.code = data.code;
      renderCode(state.code);
      hudText.textContent = `Code: ${state.code}`;
      setStatus('waiting', 'Waiting for phone…');
    } catch (err) {
      console.error('[home] session create failed:', err);
      setStatus('error', 'Could not create session. Retrying…');
      setTimeout(init, 3000);
      return;
    }

    wireWs();
    ws.connect();
  }

  // ─── WS wiring ──────────────────────────────────────
  function wireWs() {
    ws.on('open', () => {
      connectionLost.hidden = true;
      ws.send({ type: 'JOIN_ROOM', code: state.code, role: 'tv' });
    });

    ws.on('message', (msg) => handleMessage(msg));

    ws.on('close', () => {
      connectionLost.hidden = false;
    });

    ws.on('reconnecting', () => {
      connectionLost.hidden = false;
    });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'ROOM_CREATED':
        setStatus('waiting', 'Waiting for phone…');
        break;

      case 'PHONE_CONNECTED':
        state.hasPhone = true;
        setStatus('connected', 'Phone connected ✓');
        hudStatus.classList.add('is-connected');
        hudStatus.classList.remove('is-waiting');
        // Keep code visible in HUD
        hudText.textContent = `Code: ${state.code}`;
        break;

      case 'PHONE_DISCONNECTED':
        state.hasPhone = false;
        setStatus('waiting', 'Phone disconnected. Waiting…');
        hudStatus.classList.remove('is-connected');
        hudStatus.classList.add('is-waiting');
        break;

      case 'COMMAND':
        handleCommand(msg.command);
        break;

      case 'LOAD_VIDEO':
        loadVideo(msg.video);
        break;

      case 'ERROR':
        console.warn('[home] server error:', msg.code, msg.message);
        if (msg.code === 'ROOM_EXPIRED') {
          setStatus('error', 'Session expired. Reloading…');
          setTimeout(() => location.reload(), 1500);
        }
        break;
    }
  }

  // ─── Commands ───────────────────────────────────────
  function handleCommand(command) {
    if (!state.hasVideo) {
      flash('✕', 'NO VIDEO');
      return;
    }

    switch (command) {
      case 'PLAY':
        video.play().catch(() => {});
        flash('▶', 'PLAY');
        break;

      case 'PAUSE':
        video.pause();
        flash('⏸', 'PAUSE');
        break;

      case 'RESTART':
        video.currentTime = 0;
        video.play().catch(() => {});
        flash('↺', 'RESTART');
        break;

      case 'SEEK_FORWARD':
        video.currentTime = Math.min(
          video.currentTime + 10,
          video.duration || video.currentTime + 10
        );
        flash('⏩', '+10s');
        break;

      case 'SEEK_BACKWARD':
        video.currentTime = Math.max(video.currentTime - 10, 0);
        flash('⏪', '−10s');
        break;

      case 'VOLUME_UP':
        state.volume = Math.min(state.volume + 0.1, 1);
        video.volume = state.volume;
        video.muted = false;
        state.muted = false;
        flash('🔊', `${Math.round(state.volume * 100)}%`);
        break;

      case 'VOLUME_DOWN':
        state.volume = Math.max(state.volume - 0.1, 0);
        video.volume = state.volume;
        flash('🔉', `${Math.round(state.volume * 100)}%`);
        break;

      case 'MUTE':
        state.muted = !state.muted;
        video.muted = state.muted;
        flash(state.muted ? '🔇' : '🔊', state.muted ? 'MUTED' : 'UNMUTED');
        break;
    }

    sendPlaybackState();
  }

  // ─── Video ──────────────────────────────────────────
  function loadVideo(v) {
    if (!v || !v.url) return;
    state.hasVideo = true;
    video.src = v.url;
    video.load();
    emptyState.hidden = true;
    video.play().catch(() => {});
    flash('▶', v.title || 'NOW PLAYING');
  }

  video.addEventListener('play', sendPlaybackState);
  video.addEventListener('pause', sendPlaybackState);
  video.addEventListener('volumechange', sendPlaybackState);
  video.addEventListener('ended', () => {
    if (state.hasPhone) ws.send({ type: 'PLAYBACK_STATE', ...playbackSnapshot() });
  });

  // Push state to phone every 1s while playing
  setInterval(() => {
    if (state.hasPhone && state.hasVideo) sendPlaybackState();
  }, 1000);

  function playbackSnapshot() {
    return {
      isPlaying: !video.paused && !video.ended,
      currentTime: video.currentTime || 0,
      duration: video.duration || 0,
      volume: video.volume,
      muted: video.muted,
    };
  }

  function sendPlaybackState() {
    if (!state.hasPhone) return;
    ws.send({ type: 'PLAYBACK_STATE', ...playbackSnapshot() });
  }

  // ─── UI helpers ─────────────────────────────────────
  function renderCode(code) {
    const digits = String(code).padStart(6, '0').split('');
    codeDisplay.innerHTML = '';
    digits.forEach((d) => {
      const span = document.createElement('span');
      span.className = 'code-digit is-filled';
      span.textContent = d;
      codeDisplay.appendChild(span);
    });
  }

  function setStatus(kind, text) {
    statusBadge.className = `status-badge status--${kind}`;
    statusText.textContent = text;
  }

  let overlayTimer = null;
  function flash(icon, label) {
    overlayIcon.textContent = icon;
    overlayLabel.textContent = label;
    overlay.classList.add('is-visible');
    if (overlayTimer) clearTimeout(overlayTimer);
    overlayTimer = setTimeout(() => {
      overlay.classList.remove('is-visible');
    }, 900);
  }

  // ─── Enter fullscreen on first interaction ─────────
  function tryFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }
  document.body.addEventListener('click', tryFullscreen, { once: true });
})();