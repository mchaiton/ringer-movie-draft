/**
 * api/routes/leagues.js
 * REST endpoints for league management.
 *
 * Public (no auth):
 *   POST /leagues                    — create a new league
 *   POST /leagues/join/:inviteCode   — join via invite code
 *   GET  /leagues/:id/standings      — public standings
 *   GET  /leagues/:id/roster/:playerId — public player roster (for share page)
 *
 * Authenticated (player token required):
 *   GET  /leagues/:id                — full league info + your player state
 *   GET  /leagues/:id/pool           — movie pool with availability
 *   POST /leagues/:id/nominate       — nominate a movie for auction
 *   GET  /leagues/:id/queue          — nomination queue
 *   GET  /leagues/:id/feed           — scoring feed
 *
 * Commissioner only:
 *   PATCH /leagues/:id               — update settings
 *   POST  /leagues/:id/pool/add      — add movie to pool
 *   DELETE /leagues/:id/pool/:movieId — remove movie from pool
 *   POST  /leagues/:id/cinema-score  — enter CinemaScore for a film
 */

const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requirePlayer, requireCommissioner } = require('../middleware/auth');
const league = require('../../db/league');
const { query, run, save } = require('../../db/schema');
const tmdb = require('../../clients/tmdb');
const scoring = require('../../sync/scoring');

// ── Create league ────────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  const { name, seasonYear, commissionerName, budgetPerPlayer, minRoster, maxRoster } = req.body;

  if (!name || !seasonYear || !commissionerName) {
    return res.status(400).json({ error: 'name, seasonYear, and commissionerName are required.' });
  }

  const db = req.app.get('db');
  const leagueId = uuid();
  const commissionerId = uuid();

  try {
    const { inviteCode, authToken } = league.createLeague(db, {
      id: leagueId,
      name,
      seasonYear: parseInt(seasonYear),
      commissionerId,
      commissionerName,
      budgetPerPlayer: budgetPerPlayer || 1000,
      minRoster: minRoster || 6,
      maxRoster: maxRoster || 10,
    });

    res.status(201).json({
      leagueId,
      inviteCode,
      authToken,
      message: `League "${name}" created. Share invite code: ${inviteCode}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Join league ──────────────────────────────────────────────────────────────

router.post('/join/:inviteCode', (req, res) => {
  const { playerName } = req.body;
  const { inviteCode } = req.params;

  if (!playerName) return res.status(400).json({ error: 'playerName is required.' });

  const db = req.app.get('db');
  const leagueRow = league.getLeagueByInvite(db, inviteCode);
  if (!leagueRow) return res.status(404).json({ error: 'Invalid invite code.' });

  try {
    const playerId = uuid();
    const { authToken } = league.joinLeague(db, {
      leagueId: leagueRow.id,
      playerId,
      playerName,
    });

    res.status(201).json({
      leagueId: leagueRow.id,
      leagueName: leagueRow.name,
      playerId,
      authToken,
      message: `Joined "${leagueRow.name}". Save your auth token — you'll need it.`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Get league (authenticated) ────────────────────────────────────────────────

router.get('/:id', requirePlayer, (req, res) => {
  const db = req.app.get('db');
  const { league: leagueRow, player } = req;

  if (leagueRow.id !== req.params.id) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  const players   = league.getPlayers(db, leagueRow.id);
  const standings = league.getLeagueStandings(db, leagueRow.id);
  const queue     = league.getNominationQueue(db, leagueRow.id);
  const maxBid    = league.getEffectiveMaxBid(db, player.id);

  res.json({
    league: leagueRow,
    you: { ...player, effective_max_bid: maxBid },
    standings,
    nominationQueue: queue,
  });
});

// ── Standings (public) ────────────────────────────────────────────────────────

router.get('/:id/standings', (req, res) => {
  const db = req.app.get('db');
  const leagueRow = league.getLeague(db, req.params.id);
  if (!leagueRow) return res.status(404).json({ error: 'League not found.' });

  const standings = league.getLeagueStandings(db, req.params.id);
  res.json({ league: { name: leagueRow.name, season_year: leagueRow.season_year }, standings });
});

// ── Public player roster (for share page) ─────────────────────────────────────

router.get('/:id/roster/:playerId', (req, res) => {
  const db = req.app.get('db');
  const leagueRow = league.getLeague(db, req.params.id);
  if (!leagueRow) return res.status(404).json({ error: 'League not found.' });

  const players = league.getPlayers(db, req.params.id);
  const player  = players.find(p => p.id === req.params.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });

  const roster = league.getPlayerRoster(db, req.params.playerId);
  const standings = league.getLeagueStandings(db, req.params.id);
  const rank = standings.findIndex(s => s.id === req.params.playerId) + 1;

  res.json({
    player: { id: player.id, name: player.name },
    league: { id: leagueRow.id, name: leagueRow.name, season_year: leagueRow.season_year },
    rank,
    totalPlayers: players.length,
    totalPoints: standings.find(s => s.id === req.params.playerId)?.total_points || 0,
    roster: roster.map(m => ({
      id: m.id,
      title: m.title,
      release_date: m.release_date,
      poster: tmdb.imageUrl(m.tmdb_poster_path, 'w342'),
      backdrop: tmdb.imageUrl(m.tmdb_backdrop_path, 'w780'),
      genres: tryParse(m.tmdb_genres, []),
      director: m.tmdb_director,
      status: m.status,
      draft_bid: m.draft_bid,
      metacritic_score: m.metacritic_score,
      domestic_gross: m.domestic_gross,
      total_points: m.total_pts || 0,
      scoring: scoring.getScoringBreakdown(db, m.id),
    })),
  });
});

// ── Movie pool ────────────────────────────────────────────────────────────────

router.get('/:id/pool', requirePlayer, (req, res) => {
  const db = req.app.get('db');
  const { league: leagueRow } = req;
  const { status, search } = req.query;

  let sql = `
    SELECT m.*,
           p.name as owner_name,
           COALESCE(se.total_pts, 0) as total_points,
           CASE WHEN nq.id IS NOT NULL THEN 1 ELSE 0 END as in_queue
    FROM movies m
    LEFT JOIN players p ON p.id = m.owned_by
    LEFT JOIN (SELECT movie_id, SUM(points) as total_pts FROM scoring_events GROUP BY movie_id) se
           ON se.movie_id = m.id
    LEFT JOIN nomination_queue nq
           ON nq.movie_id = m.id AND nq.league_id = ? AND nq.status = 'queued'
    WHERE m.season_year = ? AND m.in_draft_pool = 1
  `;
  const params = [leagueRow.id, leagueRow.season_year];

  if (status) { sql += ` AND m.status = ?`; params.push(status); }
  if (search) { sql += ` AND LOWER(m.title) LIKE LOWER(?)`; params.push(`%${search}%`); }

  sql += ` ORDER BY m.release_date`;

  const movies = query(db, sql, params);
  res.json({
    total: movies.length,
    movies: movies.map(m => ({
      ...m,
      poster: tmdb.imageUrl(m.tmdb_poster_path, 'w342'),
      genres: tryParse(m.tmdb_genres, []),
      cast: tryParse(m.tmdb_cast, []),
    })),
  });
});

// ── Movie detail ──────────────────────────────────────────────────────────────

router.get('/:id/movies/:movieId', requirePlayer, (req, res) => {
  const db = req.app.get('db');
  const movies = query(db, `SELECT * FROM movies WHERE id = ?`, [parseInt(req.params.movieId)]);
  if (!movies.length) return res.status(404).json({ error: 'Movie not found.' });

  const m = movies[0];
  const oscarsData = query(db, `SELECT * FROM oscar_data WHERE movie_id = ? ORDER BY category`, [m.id]);
  const awards = query(db, `SELECT * FROM critics_awards WHERE movie_id = ? ORDER BY year`, [m.id]);
  const breakdown = scoring.getScoringBreakdown(db, m.id);

  // Owner info
  let owner = null;
  if (m.owned_by) {
    const players = query(db, `SELECT id, name FROM players WHERE id = ?`, [m.owned_by]);
    owner = players[0] || null;
  }

  res.json({
    movie: {
      ...m,
      poster: tmdb.imageUrl(m.tmdb_poster_path, 'w500'),
      backdrop: tmdb.imageUrl(m.tmdb_backdrop_path, 'w1280'),
      genres: tryParse(m.tmdb_genres, []),
      cast: tryParse(m.tmdb_cast, []),
    },
    owner,
    scoring: breakdown,
    oscars: oscarsData,
    criticsAwards: awards,
  });
});

// ── Nominate movie ────────────────────────────────────────────────────────────

router.post('/:id/nominate', requirePlayer, (req, res) => {
  const { movieId } = req.body;
  if (!movieId) return res.status(400).json({ error: 'movieId is required.' });

  const db = req.app.get('db');
  const { player, league: leagueRow } = req;

  if (leagueRow.id !== req.params.id) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  try {
    league.nominateMovie(db, {
      leagueId: leagueRow.id,
      movieId: parseInt(movieId),
      playerId: player.id,
    });

    // Emit nomination event to all players in this league via socket
    const io = req.app.get('io');
    if (io) {
      const queue = league.getNominationQueue(db, leagueRow.id);
      io.to(leagueRow.id).emit('queue:updated', { queue });
    }

    res.json({ message: 'Movie added to nomination queue.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Nomination queue ──────────────────────────────────────────────────────────

router.get('/:id/queue', requirePlayer, (req, res) => {
  const db = req.app.get('db');
  const queue = league.getNominationQueue(db, req.params.id);
  res.json({ queue });
});

// ── Scoring feed ──────────────────────────────────────────────────────────────

router.get('/:id/feed', requirePlayer, (req, res) => {
  const db = req.app.get('db');
  const feed = league.getRecentScoringFeed(db, req.params.id);
  res.json({ feed });
});

// ── Commissioner: update settings ────────────────────────────────────────────

router.patch('/:id', requireCommissioner, (req, res) => {
  const db = req.app.get('db');
  const { name, minRoster, maxRoster, status } = req.body;

  run(db, `
    UPDATE leagues SET
      name       = COALESCE(?, name),
      min_roster = COALESCE(?, min_roster),
      max_roster = COALESCE(?, max_roster),
      status     = COALESCE(?, status),
      updated_at = datetime('now')
    WHERE id = ?
  `, [name, minRoster, maxRoster, status, req.params.id]);

  save(db);
  res.json({ message: 'League updated.' });
});

// ── Commissioner: add movie to pool (manual) ──────────────────────────────────

router.post('/:id/pool/add', requireCommissioner, async (req, res) => {
  const { tmdbId } = req.body;
  if (!tmdbId) return res.status(400).json({ error: 'tmdbId required.' });

  const db = req.app.get('db');
  const leagueRow = req.league;

  try {
    const details = await tmdb.getMovieDetails(parseInt(tmdbId));
    run(db, `
      INSERT INTO movies (
        id, title, release_date, season_year, status,
        tmdb_poster_path, tmdb_overview, tmdb_genres, tmdb_director,
        tmdb_cast, tmdb_runtime, tmdb_budget, imdb_id, in_draft_pool
      ) VALUES (?, ?, ?, ?, 'upcoming', ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET in_draft_pool = 1, updated_at = datetime('now')
    `, [
      details.id, details.title, details.release_date, leagueRow.season_year,
      details.tmdb_poster_path, details.tmdb_overview, details.tmdb_genres,
      details.tmdb_director, details.tmdb_cast, details.tmdb_runtime,
      details.tmdb_budget, details.imdb_id,
    ]);
    save(db);
    res.json({ message: `Added "${details.title}" to pool.`, movie: details });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Commissioner: remove movie from pool ──────────────────────────────────────

router.delete('/:id/pool/:movieId', requireCommissioner, (req, res) => {
  const db = req.app.get('db');
  run(db, `UPDATE movies SET in_draft_pool = 0, updated_at = datetime('now') WHERE id = ?`,
    [parseInt(req.params.movieId)]);
  save(db);
  res.json({ message: 'Movie removed from pool.' });
});

// ── Commissioner: enter CinemaScore ──────────────────────────────────────────

router.post('/:id/cinema-score', requireCommissioner, (req, res) => {
  const db = req.app.get('db');
  const { movieId, cinemaScore } = req.body;

  const valid = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'];
  if (!valid.includes(cinemaScore)) {
    return res.status(400).json({ error: `cinemaScore must be one of: ${valid.join(', ')}` });
  }

  run(db, `UPDATE movies SET cinema_score = ?, updated_at = datetime('now') WHERE id = ?`,
    [cinemaScore, parseInt(movieId)]);

  // Re-score
  scoring.scoreMovie(db, parseInt(movieId));
  save(db);

  // Emit score update
  const io = req.app.get('io');
  if (io) {
    io.to(req.params.id).emit('scores:updated', { movieId: parseInt(movieId) });
  }

  res.json({ message: `CinemaScore ${cinemaScore} recorded.` });
});

// ── Util ──────────────────────────────────────────────────────────────────────

function tryParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
