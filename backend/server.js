/**
 * server.js
 * Express + Socket.io server.
 *
 * Start: node server.js
 * Default port: 3001
 *
 * REST API:  http://localhost:3001/api/...
 * WebSocket: ws://localhost:3001  (Socket.io)
 *
 * Quick start:
 *   1. cp .env.example .env && fill in API keys
 *   2. npm install
 *   3. node src/sync/index.js tmdb 2026   ← populate movie pool
 *   4. node server.js                     ← start the server
 */

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const { getDb, save }          = require('./src/db/schema');
const { applyLeagueSchema }    = require('./src/db/league');
const { registerDraftHandlers } = require('./src/draft/room');
const { startScheduler, syncTmdbPool, syncOmdb } = require('./src/sync/index');

const leagueRoutes = require('./src/api/routes/leagues');
const draftRoutes  = require('./src/api/routes/draft');

const PORT = process.env.PORT || 3001;
const SEASON_YEAR = parseInt(process.env.SEASON_YEAR || new Date().getFullYear());
const CORS_ORIGIN = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : ['https://ringer-movie-draft.vercel.app', 'http://localhost:5173'];

// ── App setup ─────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
  pingTimeout: 60000,
});

// ── Middleware ────────────────────────────────────────────────────────────────

app.set('trust proxy', 1); // required when running behind Railway / Vercel proxies
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// Rate limiting — generous for a private league tool
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── Database ──────────────────────────────────────────────────────────────────

let db;

async function bootstrap() {
  db = await getDb();
  await applyLeagueSchema(db);
  await save(db);

  // Make db and io available to route handlers
  app.set('db', db);
  app.set('io', io);

  // ── Routes ──────────────────────────────────────────────────────────────────

  app.get('/health', (req, res) => res.json({
    status: 'ok',
    season: SEASON_YEAR,
    uptime: process.uptime(),
  }));

  app.use('/api/leagues', leagueRoutes);
  app.use('/api/draft',   draftRoutes);

  // 404
  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  // Error handler
  app.use((err, req, res, next) => {
    console.error('[server] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
  });

  // ── Socket.io ────────────────────────────────────────────────────────────────

  registerDraftHandlers(io, db);

  // ── Cron syncs ────────────────────────────────────────────────────────────────

  startScheduler(SEASON_YEAR);

  // ── Listen ────────────────────────────────────────────────────────────────────

  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════╗
║       🎬  Ringer Movie Draft Server          ║
╠══════════════════════════════════════════════╣
║  REST API : http://localhost:${PORT}/api        ║
║  Health   : http://localhost:${PORT}/health     ║
║  WebSocket: ws://localhost:${PORT}              ║
║  Season   : ${SEASON_YEAR}                          ║
╚══════════════════════════════════════════════╝
    `);

    // Run initial data sync in the background so the server is immediately
    // available. Uses the same in-memory DB instance as the running server.
    (async () => {
      try {
        await syncTmdbPool(db, SEASON_YEAR);
        await syncOmdb(db, SEASON_YEAR);
        console.log('[server] Initial sync complete.');
      } catch (err) {
        console.error('[server] Initial sync failed (non-fatal):', err.message);
      }
    })();
  });
}

bootstrap().catch(err => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});

module.exports = { app, server, io };
