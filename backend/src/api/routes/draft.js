/**
 * api/routes/draft.js
 * REST endpoints for draft session management.
 * The actual real-time bidding is handled via Socket.io (draft/room.js).
 *
 * Commissioner only:
 *   POST /draft/sessions              — create a draft session for a league
 *   GET  /draft/sessions/:sessionId   — get session state
 *
 * Authenticated:
 *   GET  /draft/sessions/:sessionId/history — bid history for a completed session
 */

const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requirePlayer, requireCommissioner } = require('../middleware/auth');
const { query, run, save } = require('../../db/schema');

// ── Create draft session ──────────────────────────────────────────────────────

router.post('/sessions', requireCommissioner, (req, res) => {
  const { scheduledAt } = req.body;
  const db = req.app.get('db');
  const { league } = req;

  if (league.status === 'complete') {
    return res.status(400).json({ error: 'Draft already complete.' });
  }

  const sessionId = uuid();

  run(db, `
    INSERT INTO draft_sessions (id, league_id, scheduled_at, status)
    VALUES (?, ?, ?, 'scheduled')
  `, [sessionId, league.id, scheduledAt || null]);
  save(db);

  res.status(201).json({
    sessionId,
    message: 'Draft session created. Share the session ID with players.',
    socketInstructions: {
      connect: 'ws://your-server/draft',
      joinEvent: { event: 'draft:join', payload: { token: '<your-auth-token>' } },
      startEvent: { event: 'draft:start', payload: { sessionId } },
    },
  });
});

// ── Get session state ─────────────────────────────────────────────────────────

router.get('/sessions/:sessionId', requirePlayer, (req, res) => {
  const db = req.app.get('db');
  const sessions = query(db,
    `SELECT * FROM draft_sessions WHERE id = ?`, [req.params.sessionId]);

  if (!sessions.length) return res.status(404).json({ error: 'Session not found.' });

  const session = sessions[0];
  if (session.league_id !== req.league.id) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  res.json({ session });
});

// ── Bid history for completed session ────────────────────────────────────────

router.get('/sessions/:sessionId/history', requirePlayer, (req, res) => {
  const db = req.app.get('db');

  const history = query(db, `
    SELECT b.amount, b.placed_at,
           p.name as player_name,
           m.title as movie_title, m.id as movie_id,
           m.tmdb_poster_path, m.owned_by, m.draft_bid
    FROM bids b
    JOIN players p ON p.id = b.player_id
    JOIN movies m ON m.id = b.movie_id
    WHERE b.session_id = ?
    ORDER BY b.placed_at
  `, [req.params.sessionId]);

  // Group by movie
  const byMovie = {};
  for (const bid of history) {
    if (!byMovie[bid.movie_id]) {
      byMovie[bid.movie_id] = {
        movie_id:    bid.movie_id,
        title:       bid.movie_title,
        final_bid:   bid.draft_bid,
        owned_by:    bid.owned_by,
        bids:        [],
      };
    }
    byMovie[bid.movie_id].bids.push({
      player: bid.player_name,
      amount: bid.amount,
      at:     bid.placed_at,
    });
  }

  res.json({ history: Object.values(byMovie) });
});

module.exports = router;
