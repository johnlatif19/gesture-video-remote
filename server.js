require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const wsHandler = require('./lib/websocket-handler');

// ─── Config ──────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// ─── Express App ─────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── API Routes ──────────────────────────────────────────
app.use('/api/sessions', require('./routes/sessions'));
app.use('/api/videos', require('./routes/videos'));

app.get('/api/config', (_req, res) => {
  res.json({
    firebase: {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
    },
  });
});

// ─── Page Routes ─────────────────────────────────────────
app.get('/home', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'home.html'))
);
app.get('/camera', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'camera.html'))
);
app.get('/dashboard', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'))
);

app.get('/health', (_req, res) => res.json({ ok: true, env: NODE_ENV }));

app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: 'NOT_FOUND' });
});

// ─── HTTP + WebSocket Server ─────────────────────────────
const server = http.createServer(app);

// ws auto-attaches the upgrade handler when "server" is passed
const wss = new WebSocketServer({
  server,
  path: '/ws',
  perMessageDeflate: false,
});

wss.on('connection', (socket) => {
  socket.isAlive = true;

  socket.on('pong', () => {
    socket.isAlive = true;
  });

  socket.on('message', (raw) => {
    try {
      wsHandler.handleMessage(socket, raw);
    } catch (err) {
      console.error('[WS] handleMessage error:', err);
      if (socket.readyState === 1) {
        socket.send(
          JSON.stringify({
            type: 'ERROR',
            code: 'SERVER_ERROR',
            message: 'Something went wrong.',
          })
        );
      }
    }
  });

  socket.on('close', () => {
    wsHandler.handleDisconnect(socket);
  });

  socket.on('error', (err) => {
    console.error('[WS] socket error:', err.message);
  });
});

// Heartbeat: 15s to survive Railway proxy timeouts
const heartbeat = setInterval(() => {
  wss.clients.forEach((socket) => {
    if (socket.isAlive === false) return socket.terminate();
    socket.isAlive = false;
    socket.ping();
  });
}, 15000);

const expirySweep = wsHandler.startExpirySweep(60_000);

wss.on('close', () => {
  clearInterval(heartbeat);
  clearInterval(expirySweep);
});

// ─── Start ───────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT} (${NODE_ENV})`);
  console.log(`   Home:      http://localhost:${PORT}/home`);
  console.log(`   Camera:    http://localhost:${PORT}/camera`);
  console.log(`   Dashboard: http://localhost:${PORT}/dashboard`);
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`);
});

// ─── Graceful Shutdown ───────────────────────────────────
function shutdown(signal) {
  console.log(`${signal} received, closing server...`);
  clearInterval(heartbeat);
  clearInterval(expirySweep);
  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
