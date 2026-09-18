(function () {
  'use strict';

  // ─── DOM ────────────────────────────────────────────
  const codeScreen = document.getElementById('code-screen');
  const controllerScreen = document.getElementById('controller-screen');

  const codeInput = document.getElementById('code-input');
  const connectBtn = document.getElementById('connect-btn');
  const codeError = document.getElementById('code-error');

  const connBar = document.getElementById('conn-bar');
  const connText = document.getElementById('conn-text');
  const connCode = document.getElementById('conn-code');

  const camPreview = document.getElementById('cam-preview');
  const camCanvas = document.getElementById('cam-canvas');
  const camLoading = document.getElementById('cam-loading');
  const camError = document.getElementById('cam-error');
  const camErrorText = document.getElementById('cam-error-text');
  const camRetryBtn = document.getElementById('cam-retry-btn');

  const gestureValue = document.getElementById('gesture-value');
  const gestureAction = document.getElementById('gesture-action');

  const statePlayback = document.getElementById('state-playback');
  const stateTime = document.getElementById('state-time');
  const stateVolume = document.getElementById('state-volume');

  const connectionLost = document.getElementById('connection-lost');

  // ─── State ──────────────────────────────────────────
  const state = {
    code: null,
    connected: false,
    mediaStream: null,
    detector: null,
    lastGesture: null,
  };

  const ws = new WSClient('/ws');

  // ─── Code entry ─────────────────────────────────────
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.replace(/\D/g, '').slice(0, 6);
    codeInput.classList.remove('is-invalid');
    codeError.hidden = true;
  });

  codeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryConnect();
  });

  connectBtn.addEventListener('click', tryConnect);

  async function tryConnect() {
    const code = codeInput.value.trim();
    if (!/^\d{6}$/.test(code)) {
      showCodeError('Enter the 6-digit code shown on your TV.');
      return;
    }

    connectBtn.disabled = true;
    connectBtn.textContent = 'Connecting…';

    try {
      const res = await fetch(`/api/sessions/${code}`);
      const data = await res.json();

      if (!data.ok) {
        const messages = {
          ROOM_NOT_FOUND: 'No TV is using this code.',
          ROOM_EXPIRED: 'This code has expired.',
          PHONE_ALREADY_CONNECTED: 'Another phone is already connected.',
          INVALID_FORMAT: 'Enter a valid 6-digit code.',
          TOO_MANY_ATTEMPTS: 'Too many attempts. Wait a minute.',
        };
        showCodeError(messages[data.error] || 'Could not connect.');
        return;
      }

      state.code = code;
      enterController();
    } catch (err) {
      console.error('[camera] connect failed:', err);
      showCodeError('Network error. Please try again.');
    } finally {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect';
    }
  }

  function showCodeError(text) {
    codeError.textContent = text;
    codeError.hidden = false;
    codeInput.classList.add('is-invalid');
    setTimeout(() => codeInput.classList.remove('is-invalid'), 450);
  }

  // ─── Enter controller ───────────────────────────────
  function enterController() {
    codeScreen.hidden = true;
    controllerScreen.hidden = false;
    connCode.textContent = `#${state.code}`;

    setConn('connecting', 'Connecting to TV…');
    wireWs();
    ws.connect();

    // Wait for open → then join
    ws.on('open', () => {
      ws.send({ type: 'JOIN_ROOM', code: state.code, role: 'phone' });
    });

    // Start camera + gestures in parallel
    startCamera();
  }

  // ─── WS wiring ──────────────────────────────────────
  function wireWs() {
    ws.on('message', (msg) => handleServerMessage(msg));

    ws.on('close', () => {
      setConn('lost', 'Connection lost. Reconnecting…');
      connectionLost.hidden = false;
    });

    ws.on('open', () => {
      connectionLost.hidden = true;
    });

    ws.on('reconnecting', () => {
      connectionLost.hidden = false;
    });
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'ROOM_JOINED':
        setConn('connected', 'Connected to TV');
        break;

      case 'TV_DISCONNECTED':
        setConn('lost', 'TV disconnected');
        break;

      case 'PLAYBACK_STATE':
        updatePlaybackUI(msg);
        break;

      case 'ERROR':
        console.warn('[camera] server error:', msg.code, msg.message);
        if (msg.code === 'ROOM_GONE' || msg.code === 'ROOM_EXPIRED') {
          setConn('lost', msg.message);
        }
        if (msg.code === 'TV_OFFLINE') {
          setConn('lost', 'TV is offline');
        }
        break;
    }
  }

  function setConn(kind, text) {
    connBar.className = `conn-bar conn-bar--${kind}`;
    if (kind === 'connected') connBar.classList.add('is-connected');
    if (kind === 'lost') connBar.classList.add('is-lost');
    connText.textContent = text;
  }

  function updatePlaybackUI(s) {
    statePlayback.textContent = s.isPlaying ? '▶ Playing' : '⏸ Paused';
    stateTime.textContent = formatTime(s.currentTime);
    stateVolume.textContent = s.muted
      ? 'Muted'
      : `${Math.round((s.volume || 0) * 100)}%`;
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return `${m}:${s}`;
  }

  // ─── Manual controls ────────────────────────────────
  document.querySelectorAll('[data-command]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const command = btn.dataset.command;
      if (!command) return;
      sendCommand(command);
      bumpButton(btn);
    });
  });

  function sendCommand(command) {
    if (!ws.isOpen) {
      setConn('lost', 'Not connected. Reconnecting…');
      return;
    }
    ws.send({ type: 'COMMAND', command });
  }

  function bumpButton(btn) {
    btn.style.transform = 'scale(0.94)';
    setTimeout(() => (btn.style.transform = ''), 100);
  }

  // ─── Camera ─────────────────────────────────────────
  async function startCamera() {
    camLoading.hidden = false;
    camError.hidden = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 640 },
          height: { ideal: 480 },
        },
        audio: false,
      });

      state.mediaStream = stream;
      camPreview.srcObject = stream;
      await camPreview.play();
      camLoading.hidden = true;

      startGestures();
    } catch (err) {
      console.error('[camera] getUserMedia failed:', err);
      camLoading.hidden = true;
      camError.hidden = false;
      camErrorText.textContent =
        err.name === 'NotAllowedError'
          ? 'Camera permission denied. Enable it in your browser settings.'
          : 'Camera unavailable on this device.';
    }
  }

  camRetryBtn.addEventListener('click', startCamera);

  async function startGestures() {
    if (!window.GestureDetector) {
      gestureValue.textContent = '— unavailable —';
      return;
    }

    state.detector = new GestureDetector({
      videoEl: camPreview,
      canvasEl: camCanvas,
      onStatus: (s) => {
        if (s.state === 'loading') gestureValue.textContent = 'Loading…';
        if (s.state === 'error') {
          gestureValue.textContent = '— unavailable —';
        }
      },
      onGesture: (g) => {
        // Update UI
        if (g.name === 'UNKNOWN') {
          gestureValue.textContent = '— none —';
          gestureValue.classList.remove('gesture-value--active');
          gestureValue.classList.add('gesture-value--idle');
          gestureAction.textContent = '—';
        } else {
          gestureValue.textContent = `${g.emoji} ${g.label}`;
          gestureValue.classList.add('gesture-value--active');
          gestureValue.classList.remove('gesture-value--idle');
          gestureAction.textContent = g.action || '—';
        }

        // Fire command only when the stability gate passes
        if (g.fire && g.action) {
          sendCommand(g.action);
        }
      },
    });

    const ok = await state.detector.start();
    if (!ok) {
      gestureValue.textContent = '— unavailable —';
    }
  }

  // ─── Cleanup ────────────────────────────────────────
  window.addEventListener('beforeunload', () => {
    if (state.detector) state.detector.stop();
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach((t) => t.stop());
    }
    ws.close();
  });
})();