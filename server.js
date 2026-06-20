// server.js — Yathra Map Travel Partner — Production Backend
'use strict';
require('dotenv').config();

const express        = require('express');
const http           = require('http');
const WebSocket      = require('ws');
const helmet         = require('helmet');
const cors           = require('cors');
const rateLimit      = require('express-rate-limit');
const mongoSanitize  = require('express-mongo-sanitize');
const hpp            = require('hpp');
const compression    = require('compression');
const morgan         = require('morgan');
const mongoose       = require('mongoose');
const xss            = require('xss');

const listingsRouter = require('./routes/listings');
const chatRouter     = require('./routes/chat');

// Load upload router safely — won't crash server if googleapis missing
let uploadRouter = null;
try {
  uploadRouter = require('./routes/upload');
  console.log('[Server] Upload router loaded ✅');
} catch (e) {
  console.error('[Server] Upload router failed to load:', e.message);
}
const { ChatMessage, Room } = require('./src/models');
const { sanitizeInputs, validateChatMessage, validateUID } = require('./middleware/sanitize');

const PORT = parseInt(process.env.PORT) || 3001;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MSG_LIMIT = parseInt(process.env.CHAT_MESSAGE_LIMIT) || 200;

// ── Express app ──────────────────────────────────────────────────
const app = express();

// Trust proxy (needed if behind Nginx / Render / Railway etc.)
app.set('trust proxy', 1);

// ── Pre-CORS endpoints (accessible directly from browser) ────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/upload/check', (_req, res) => res.json({
  ok: true,
  routerLoaded:    !!uploadRouter,
  sheetConfigured: !!process.env.GOOGLE_SHEET_ID,
  driveConfigured: !!process.env.GOOGLE_DRIVE_FOLDER_ID,
  keyConfigured:   !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY
}));

// ── Security headers ─────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false   // CSP is handled by the frontend HTML
}));

// ── CORS ─────────────────────────────────────────────────────────
const corsOptions = {
  origin: (origin, cb) => {
    // No origin = direct browser URL, curl, Render health checks — allow
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS: origin '${origin}' not allowed`));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Accept'],
  credentials: false,
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── Body parsing ─────────────────────────────────────────────────
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: false, limit: '20mb' }));

// ── Anti-pollution & sanitization ────────────────────────────────
// hpp() removed — was stripping valid body fields like mode/budget/gender/age
app.use(mongoSanitize());
app.use(sanitizeInputs);

// ── Compression & logging ─────────────────────────────────────────
app.use(compression());
if (process.env.NODE_ENV !== 'test') app.use(morgan('combined'));

// ── Global rate limiter ──────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Too many requests. Please wait and try again.' }
});
app.use('/api', globalLimiter);

// ── Routes ───────────────────────────────────────────────────────
app.use('/api/listings', listingsRouter);
app.use('/api/chat',     chatRouter);
if (uploadRouter) {
  app.use('/api/upload', uploadRouter);
}

// ── 404 handler ──────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found.' }));

// ── Global error handler ─────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.message && err.message.startsWith('CORS:')) {
    return res.status(403).json({ ok: false, error: 'CORS policy violation.' });
  }
  console.error('[Unhandled error]', err);
  return res.status(500).json({ ok: false, error: 'Internal server error.' });
});

// ── HTTP + WebSocket server ──────────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocket.Server({ server, path: '/ws' });

// roomId → Set<WebSocket>
const rooms = new Map();
// roomId → Map<uid, { name, ts }> — online users per room
const roomPresence = new Map();

const WS_MSG_RATE   = 10;
const WS_MSG_WINDOW = 5000;

function getRoomClients(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  return rooms.get(roomId);
}

function getRoomPresence(roomId) {
  if (!roomPresence.has(roomId)) roomPresence.set(roomId, new Map());
  return roomPresence.get(roomId);
}

function broadcast(roomId, payload, excludeWs) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client !== excludeWs && client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function broadcastAll(roomId, payload) {
  const clients = rooms.get(roomId);
  if (!clients) return;
  const data = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

function broadcastPresence(roomId) {
  const presence = getRoomPresence(roomId);
  const online = Array.from(presence.entries()).map(([uid, info]) => ({ uid, name: info.name }));
  broadcastAll(roomId, { type: 'presence', roomId, online, count: online.length });
}

wss.on('connection', (ws, req) => {
  let joinedRoom = null;
  let msgCount   = 0;
  let windowStart = Date.now();

  // Upgrade request origin check
  const origin = req.headers.origin;
  if (process.env.NODE_ENV === 'production' && origin && !ALLOWED_ORIGINS.includes(origin)) {
    ws.close(4003, 'Forbidden origin');
    return;
  }

  ws.on('message', async (rawData) => {
    // Size guard
    if (rawData.length > 2048) {
      ws.send(JSON.stringify({ type: 'error', error: 'Message too large.' }));
      return;
    }

    let msg;
    try { msg = JSON.parse(rawData); }
    catch { ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON.' })); return; }

    // ── JOIN a room ──────────────────────────────────────────────
    if (msg.type === 'join') {
      const { roomId, uid } = msg;

      if (!roomId || !/^[a-f0-9]{24}$/.test(roomId)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid room ID.' }));
        return;
      }
      if (!validateUID(uid)) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid UID.' }));
        return;
      }

      // Verify room exists in DB
      try {
        const room = await Room.findById(roomId).lean();
        if (!room) {
          ws.send(JSON.stringify({ type: 'error', error: 'Room not found.' }));
          return;
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', error: 'DB error.' }));
        return;
      }

      // Leave previous room if any
      if (joinedRoom && rooms.has(joinedRoom)) {
        rooms.get(joinedRoom).delete(ws);
        if (rooms.get(joinedRoom).size === 0) rooms.delete(joinedRoom);
      }

      joinedRoom = roomId;
      ws._uid  = uid;
      ws._name = msg.name || 'Traveller';
      getRoomClients(roomId).add(ws);

      // Add to presence
      getRoomPresence(roomId).set(uid, { name: ws._name, ts: Date.now() });
      broadcastPresence(roomId);

      // Send joined + current online count back to this client
      ws.send(JSON.stringify({ type: 'joined', roomId, count: getRoomPresence(roomId).size }));
      return;
    }

    // ── SEND a message ───────────────────────────────────────────
    if (msg.type === 'message') {
      if (!joinedRoom) {
        ws.send(JSON.stringify({ type: 'error', error: 'Join a room first.' }));
        return;
      }

      // Rate limiting per connection
      const now = Date.now();
      if (now - windowStart > WS_MSG_WINDOW) { msgCount = 0; windowStart = now; }
      msgCount++;
      if (msgCount > WS_MSG_RATE) {
        ws.send(JSON.stringify({ type: 'error', error: 'Sending too fast. Slow down.' }));
        return;
      }

      const errors = validateChatMessage({ text: msg.text, sender: msg.sender, uid: msg.uid || ws._uid });
      if (errors.length) {
        ws.send(JSON.stringify({ type: 'error', error: errors[0] }));
        return;
      }

      // Sanitize
      const safeText   = xss(msg.text.trim(),   { whiteList: {}, stripIgnoreTag: true });
      const safeSender = xss(msg.sender.trim(),  { whiteList: {}, stripIgnoreTag: true });
      const uid        = msg.uid || ws._uid;

      if (!safeText) return;

      try {
        const saved = await ChatMessage.create({
          roomId: joinedRoom,
          text:   safeText,
          sender: safeSender,
          uid,
          ts: new Date()
        });

        const outgoing = {
          type:   'message',
          _id:    saved._id.toString(),
          roomId: joinedRoom,
          text:   saved.text,
          sender: saved.sender,
          uid,
          ts:     saved.ts.toISOString()
        };

        // Echo back to sender with server timestamp
        ws.send(JSON.stringify({ ...outgoing, mine: true }));

        // Broadcast to all other clients in room
        broadcast(joinedRoom, outgoing, ws);

        // Prune oldest messages if over limit (async, non-blocking)
        pruneMessages(joinedRoom).catch(() => {});
      } catch (e) {
        console.error('[WS message save]', e.message);
        ws.send(JSON.stringify({ type: 'error', error: 'Failed to send message.' }));
      }
      return;
    }

    ws.send(JSON.stringify({ type: 'error', error: 'Unknown message type.' }));
  });

  ws.on('close', () => {
    if (joinedRoom) {
      if (rooms.has(joinedRoom)) {
        rooms.get(joinedRoom).delete(ws);
        if (rooms.get(joinedRoom).size === 0) rooms.delete(joinedRoom);
      }
      // Remove from presence and broadcast offline
      if (roomPresence.has(joinedRoom)) {
        roomPresence.get(joinedRoom).delete(ws._uid);
        broadcastPresence(joinedRoom);
        if (roomPresence.get(joinedRoom).size === 0) roomPresence.delete(joinedRoom);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[WS error]', err.message);
  });
});

// Prune old messages to keep room lean
async function pruneMessages(roomId) {
  const count = await ChatMessage.countDocuments({ roomId });
  if (count > MSG_LIMIT) {
    const excess = count - MSG_LIMIT;
    const oldest = await ChatMessage
      .find({ roomId })
      .sort({ ts: 1 })
      .limit(excess)
      .select('_id')
      .lean();
    const ids = oldest.map(d => d._id);
    await ChatMessage.deleteMany({ _id: { $in: ids } });
  }
}

// ── MongoDB connection ───────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000
})
.then(() => {
  console.log('[MongoDB] Connected');
  server.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT} (${process.env.NODE_ENV})`);
  });
})
.catch(err => {
  console.error('[MongoDB] Connection failed:', err.message);
  process.exit(1);
});

// ── Graceful shutdown ────────────────────────────────────────────
const shutdown = async (signal) => {
  console.log(`[Server] ${signal} received — shutting down gracefully`);
  wss.close();
  server.close(async () => {
    await mongoose.connection.close();
    console.log('[Server] Closed.');
    process.exit(0);
  });
  setTimeout(() => { console.error('[Server] Forced exit'); process.exit(1); }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (err) => { console.error('[uncaughtException]',  err); });
process.on('unhandledRejection', (err) => { console.error('[unhandledRejection]', err); });
