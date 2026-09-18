/**
 * Gesture detection using MediaPipe Tasks Vision.
 * Detects: Open Palm → PLAY, Closed Fist → PAUSE.
 */

(function (global) {
  'use strict';

  const TASKS_VISION_URL =
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/vision_bundle.mjs';
  const WASM_URL =
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.20/wasm';
  const MODEL_URL =
    'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  const STABLE_FRAMES = 6;
  const COOLDOWN_MS = 1500;
  const MIN_CONFIDENCE = 0.6;

  const GESTURES = {
    OPEN_PALM: { name: 'OPEN_PALM', action: 'PLAY', emoji: '🤚', label: 'OPEN PALM' },
    CLOSED_FIST: { name: 'CLOSED_FIST', action: 'PAUSE', emoji: '✊', label: 'CLOSED FIST' },
    UNKNOWN: { name: 'UNKNOWN', action: null, emoji: '—', label: '— none —' },
  };

  class GestureDetector {
    constructor({ videoEl, canvasEl, onGesture, onStatus }) {
      this.videoEl = videoEl;
      this.canvasEl = canvasEl;
      this.onGesture = onGesture || (() => {});
      this.onStatus = onStatus || (() => {});

      this.landmarker = null;
      this.running = false;
      this.rafId = null;

      this.lastVideoTime = -1;
      this.candidate = null;
      this.candidateFrames = 0;
      this.lastFiredAt = 0;
      this.lastFiredName = null;
      this.lastEmitted = null;
    }

    async start() {
      try {
        this.onStatus({ state: 'loading', message: 'Loading MediaPipe…' });

        const vision = await import(/* @vite-ignore */ TASKS_VISION_URL);
        const { FilesetResolver, HandLandmarker } = vision;

        const fileset = await FilesetResolver.forVisionTasks(WASM_URL);

        // Try GPU first, fall back to CPU
        let landmarker;
        try {
          landmarker = await HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
            runningMode: 'VIDEO',
            numHands: 1,
            minHandDetectionConfidence: MIN_CONFIDENCE,
            minHandPresenceConfidence: MIN_CONFIDENCE,
            minTrackingConfidence: MIN_CONFIDENCE,
          });
        } catch (gpuErr) {
          console.warn('[Gestures] GPU failed, trying CPU:', gpuErr.message);
          landmarker = await HandLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: 'CPU' },
            runningMode: 'VIDEO',
            numHands: 1,
            minHandDetectionConfidence: MIN_CONFIDENCE,
            minHandPresenceConfidence: MIN_CONFIDENCE,
            minTrackingConfidence: MIN_CONFIDENCE,
          });
        }

        this.landmarker = landmarker;
        this.running = true;
        this.onStatus({ state: 'ready', message: 'Gesture detection active' });
        this._loop();
        return true;
      } catch (err) {
        console.error('[Gestures] init failed:', err);
        this.onStatus({
          state: 'error',
          message: 'Gesture detection unavailable. Use manual controls.',
        });
        return false;
      }
    }

    stop() {
      this.running = false;
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      if (this.landmarker && this.landmarker.close) {
        try { this.landmarker.close(); } catch { /* ignore */ }
      }
      this.landmarker = null;
    }

    _loop() {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(() => this._loop());

      const v = this.videoEl;
      if (!v || v.readyState < 2 || v.videoWidth === 0) return;
      if (v.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = v.currentTime;

      let result;
      try {
        result = this.landmarker.detectForVideo(v, performance.now());
      } catch {
        return;
      }

      const classification = this._classify(result);
      this._drawCanvas(result);

      const name = classification.name;
      if (name !== 'UNKNOWN') {
        if (this.candidate === name) {
          this.candidateFrames += 1;
        } else {
          this.candidate = name;
          this.candidateFrames = 1;
        }

        if (this.candidateFrames >= STABLE_FRAMES) {
          this._maybeFire(name, classification.confidence);
        }
      } else {
        this.candidate = null;
        this.candidateFrames = 0;
      }

      if (this.lastEmitted?.name !== name) {
        this.lastEmitted = GESTURES[name] || GESTURES.UNKNOWN;
        this.onGesture({
          ...this.lastEmitted,
          confidence: classification.confidence,
          stable: this.candidateFrames >= STABLE_FRAMES,
        });
      }
    }

    _maybeFire(name, confidence) {
      const now = Date.now();
      const sameAsLast = name === this.lastFiredName;
      const withinCooldown = now - this.lastFiredAt < COOLDOWN_MS;

      if (sameAsLast && withinCooldown) return;

      this.lastFiredAt = now;
      this.lastFiredName = name;

      const gesture = GESTURES[name];
      if (gesture && gesture.action) {
        this.onGesture({
          ...gesture,
          confidence,
          stable: true,
          fire: true,
        });
      }
    }

    _classify(result) {
      if (!result || !result.landmarks || result.landmarks.length === 0) {
        return { name: 'UNKNOWN', confidence: 0 };
      }

      const lm = result.landmarks[0];
      const fingersExtended = this._countExtendedFingers(lm);

      if (fingersExtended >= 4) {
        return { name: 'OPEN_PALM', confidence: 0.9 };
      }
      if (fingersExtended <= 1) {
        return { name: 'CLOSED_FIST', confidence: 0.9 };
      }
      return { name: 'UNKNOWN', confidence: 0 };
    }

    _countExtendedFingers(lm) {
      let count = 0;

      if (lm[8].y < lm[6].y) count++;
      if (lm[12].y < lm[10].y) count++;
      if (lm[16].y < lm[14].y) count++;
      if (lm[20].y < lm[18].y) count++;

      const dxThumb = Math.abs(lm[4].x - lm[3].x);
      if (dxThumb > 0.04) count++;

      return count;
    }

    _drawCanvas(result) {
      const canvas = this.canvasEl;
      if (!canvas) return;
      const v = this.videoEl;
      if (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
      }

      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (!result || !result.landmarks) return;

      ctx.fillStyle = 'rgba(94, 234, 212, 0.9)';
      ctx.strokeStyle = 'rgba(94, 234, 212, 0.35)';
      ctx.lineWidth = 2;

      const connections = [
        [0,1],[1,2],[2,3],[3,4],
        [0,5],[5,6],[6,7],[7,8],
        [5,9],[9,10],[10,11],[11,12],
        [9,13],[13,14],[14,15],[15,16],
        [13,17],[17,18],[18,19],[19,20],
        [0,17],
      ];

      for (const hand of result.landmarks) {
        ctx.beginPath();
        for (const [a, b] of connections) {
          ctx.moveTo(hand[a].x * canvas.width, hand[a].y * canvas.height);
          ctx.lineTo(hand[b].x * canvas.width, hand[b].y * canvas.height);
        }
        ctx.stroke();

        for (const p of hand) {
          ctx.beginPath();
          ctx.arc(p.x * canvas.width, p.y * canvas.height, 4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  global.GestureDetector = GestureDetector;
  global.GESTURES = GESTURES;
})(window);
