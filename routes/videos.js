const express = require('express');
const multer = require('multer');
const router = express.Router();

const { getFirestore } = require('../lib/firebase-admin');
const {
  uploadVideoBuffer,
  deleteVideo,
  buildThumbnailUrl,
} = require('../lib/cloudinary');
const roomManager = require('../lib/room-manager');

// ─── Multer: keep files in memory, max 200MB ────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = /^video\/(mp4|webm|quicktime|x-matroska|ogg)$/.test(file.mimetype);
    if (!ok) return cb(new Error('UNSUPPORTED_FILE_TYPE'));
    cb(null, true);
  },
});

// ─── Helpers ────────────────────────────────────────────────
function requireDb(res) {
  const db = getFirestore();
  if (!db) {
    res.status(503).json({
      ok: false,
      error: 'DB_NOT_CONFIGURED',
      message: 'Firebase is not configured on the server.',
    });
    return null;
  }
  return db;
}

const COLLECTION = 'videos';

// ─── GET /api/videos ────────────────────────────────────────
router.get('/', async (_req, res) => {
  const db = requireDb(res);
  if (!db) return;

  try {
    const snap = await db
      .collection(COLLECTION)
      .orderBy('createdAt', 'desc')
      .get();

    const videos = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return res.json({ ok: true, count: videos.length, videos });
  } catch (err) {
    console.error('[GET /api/videos]', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ─── POST /api/videos ───────────────────────────────────────
router.post('/', upload.single('video'), async (req, res) => {
  const db = requireDb(res);
  if (!db) return;

  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: 'NO_FILE',
      message: 'No video file uploaded.',
    });
  }

  const title = (req.body.title || '').trim();
  if (!title) {
    return res.status(400).json({
      ok: false,
      error: 'MISSING_TITLE',
      message: 'Video title is required.',
    });
  }

  try {
    const result = await uploadVideoBuffer(req.file.buffer);
    const thumbnailUrl = buildThumbnailUrl(result.secure_url);

    const docRef = await db.collection(COLLECTION).add({
      title,
      storageKey: result.public_id,
      url: result.secure_url,
      thumbnailUrl,
      duration: result.duration || 0,
      format: result.format,
      bytes: result.bytes,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return res.status(201).json({
      ok: true,
      video: {
        id: docRef.id,
        title,
        storageKey: result.public_id,
        url: result.secure_url,
        thumbnailUrl,
        duration: result.duration || 0,
        format: result.format,
        bytes: result.bytes,
      },
    });
  } catch (err) {
    console.error('[POST /api/videos]', err);
    const message =
      err.message === 'UNSUPPORTED_FILE_TYPE'
        ? 'Only video files are allowed.'
        : 'Upload failed. Please try again.';
    return res.status(500).json({ ok: false, error: 'UPLOAD_FAILED', message });
  }
});

// ─── GET /api/videos/:id ────────────────────────────────────
router.get('/:id', async (req, res) => {
  const db = requireDb(res);
  if (!db) return;

  try {
    const doc = await db.collection(COLLECTION).doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: 'VIDEO_NOT_FOUND' });
    }
    return res.json({ ok: true, video: { id: doc.id, ...doc.data() } });
  } catch (err) {
    console.error('[GET /api/videos/:id]', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ─── DELETE /api/videos/:id ─────────────────────────────────
router.delete('/:id', async (req, res) => {
  const db = requireDb(res);
  if (!db) return;

  try {
    const docRef = db.collection(COLLECTION).doc(req.params.id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: 'VIDEO_NOT_FOUND' });
    }

    const { storageKey } = doc.data();
    if (storageKey) {
      try {
        await deleteVideo(storageKey);
      } catch (cloudErr) {
        // Log but don't block DB deletion
        console.warn('[DELETE /api/videos] Cloudinary delete failed:', cloudErr.message);
      }
    }

    await docRef.delete();
    return res.json({ ok: true, id: req.params.id });
  } catch (err) {
    console.error('[DELETE /api/videos/:id]', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

// ─── PUT /api/videos/:id/active ─────────────────────────────
router.put('/:id/active', async (req, res) => {
  const db = requireDb(res);
  if (!db) return;

  const { code } = req.body || {};
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_CODE',
      message: 'A valid 6-digit session code is required.',
    });
  }

  try {
    const doc = await db.collection(COLLECTION).doc(req.params.id).get();
    if (!doc.exists) {
      return res.status(404).json({ ok: false, error: 'VIDEO_NOT_FOUND' });
    }

    const room = roomManager.getRoomByCode(code);
    if (!room) {
      return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });
    }

    roomManager.setActiveVideo(code, req.params.id);

    const tv = roomManager.getTvSocket(room);
    if (tv && tv.readyState === 1) {
      tv.send(
        JSON.stringify({
          type: 'LOAD_VIDEO',
          video: { id: doc.id, ...doc.data() },
        })
      );
    }

    return res.json({ ok: true, code, videoId: req.params.id });
  } catch (err) {
    console.error('[PUT /api/videos/:id/active]', err);
    return res.status(500).json({ ok: false, error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;