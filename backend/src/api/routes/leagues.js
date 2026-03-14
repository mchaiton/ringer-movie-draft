/**
 * api/routes/leagues.js
 * REST endpoints for league management — async Turso version.
 */

const router = require('express').Router();
const { v4: uuid } = require('uuid');
const { requirePlayer, requireCommissioner } = require('../middleware/auth');
const league  = require('../../db/league');
const { query, run, save } = require('../../db/schema');
const tmdb    = require('../../clients/tmdb');
const scoring = require('../../sync/scoring');

// ── Create league ─────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { name, seasonYear, commissionerName, budgetPerPlayer, minRoster, maxRoster } = req.body;
  if (!name || !seasonYear || !commissionerName) {
    return res.status(400).json({ error: 'name, seasonYear, and commissionerName are required.' });
  }
  const db = req.app.get('db');
  const leagueId      = uuid();
  const commissionerId = uuid();
  try {
    const { inviteCode, authToken } = await league.createLeague(db, {
      id: leagueId, name, seasonYear: parseInt(seasonYear),
      commissionerId, commissionerName,
      budgetPerPlayer: budgetPerPlayer || 1000,
      minRoster: minRoster || 6, maxRoster: maxRoster || 10,
    });
    res.status(201).json({
      leagueId, commissionerId, inviteCode, authToken,
      leagueName: name,
      message: `League "${name}" created. Share invite code: ${inviteCode}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Join league ───────────────────────────────────────────────────────────────

router.post('/join/:inviteCode', async (req, res) => {
  const { playerName } = req.body;
  const { inviteCode } = req.params;
  if (!playerName) return res.status(400).json({ error: 'playerName is required.' });
  const db = req.app.get('db');
  const leagueRow = await league.getLeagueByInvite(db, inviteCode);
  if (!leagueRow) return res.status(404).json({ error: 'Invalid invite code.' });
  try {
    const playerId = uuid();
    const { authToken } = await league.joinLeague(db, { leagueId: leagueRow.id, playerId, playerName });
    res.status(201).json({
      leagueId: leagueRow.id, leagueName: leagueRow.name, playerId, authToken,
      message: `Joined "${leagueRow.name}". Save your auth token — you'll need it.`,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Get league (authenticated) ────────────────────────────────────────────────

router.get('/:id', requirePlayer, async (req, res) => {
  const db = req.app.get('db');
  const { league: leagueRow, player } = req;
  if (leagueRow.id !== req.params.id) return res.status(403).json({ error: 'Access denied.' });
  const [players, standings, queue, maxBid] = await Promise.all([
    league.getPlayers(db, leagueRow.id),
    league.getLeagueStandings(db, leagueRow.id),
    league.getNominationQueue(db, leagueRow.id),
    league.getEffectiveMaxBid(db, player.id),
  ]);
  res.json({ league: leagueRow, you: { ...player, effective_max_bid: maxBid }, standings, nominationQueue: queue });
});

// ── Standings (public) ────────────────────────────────────────────────────────

router.get('/:id/standings', async (req, res) => {
  const db = req.app.get('db');
  const leagueRow = await league.getLeague(db, req.params.id);
  if (!leagueRow) return res.status(404).json({ error: 'League not found.' });
  const standings = await league.getLeagueStandings(db, req.params.id);
  res.json({ league: { name: leagueRow.name, season_year: leagueRow.season_year }, standings });
});

// ── Public player roster ──────────────────────────────────────────────────────

router.get('/:id/roster/:playerId', async (req, res) => {
  const db = req.app.get('db');
  const leagueRow = await league.getLeague(db, req.params.id);
  if (!leagueRow) return res.status(404).json({ error: 'League not found.' });
  const players = await league.getPlayers(db, req.params.id);
  const player  = players.find(p => p.id === req.params.playerId);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  const [roster, standings] = await Promise.all([
    league.getPlayerRoster(db, req.params.playerId),
    league.getLeagueStandings(db, req.params.id),
  ]);
  const rank = standings.findIndex(s => s.id === req.params.playerId) + 1;
  const rosterWithScores = await Promise.all(roster.map(async m => ({
    id: m.id, title: m.title, release_date: m.release_date,
    poster:    tmdb.imageUrl(m.tmdb_poster_path, 'w342'),
    backdrop:  tmdb.imageUrl(m.tmdb_backdrop_path, 'w780'),
    genres:    tryParse(m.tmdb_genres, []),
    director:  m.tmdb_director, status: m.status,
    draft_bid: m.draft_bid, metacritic_score: m.metacritic_score,
    domestic_gross: m.domestic_gross, total_points: m.total_pts || 0,
    scoring: await scoring.getScoringBreakdown(db, m.id),
  })));
  res.json({
    player: { id: player.id, name: player.name },
    league: { id: leagueRow.id, name: leagueRow.name, season_year: leagueRow.season_year },
    rank, totalPlayers: players.length,
    totalPoints: standings.find(s => s.id === req.params.playerId)?.total_points || 0,
    roster: rosterWithScores,
  });
});

// ── Movie pool ────────────────────────────────────────────────────────────────

router.get('/:id/pool', requirePlayer, async (req, res) => {
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
    LEFT JOIN nomination_queue nq ON nq.movie_id = m.id AND nq.league_id = ? AND nq.status = 'queued'
    WHERE m.season_year = ? AND m.in_draft_pool = 1
  `;
  const params = [leagueRow.id, leagueRow.season_year];
  if (status) { sql += ` AND m.status = ?`; params.push(status); }
  if (search)  { sql += ` AND LOWER(m.title) LIKE LOWER(?)`; params.push(`%${search}%`); }
  sql += ` ORDER BY m.release_date`;
  const movies = await query(db, sql, params);
  res.json({
    total: movies.length,
    movies: movies.map(m => ({ ...m, poster: tmdb.imageUrl(m.tmdb_poster_path, 'w342'), genres: tryParse(m.tmdb_genres, []), cast: tryParse(m.tmdb_cast, []) })),
  });
});

// ── Movie detail ──────────────────────────────────────────────────────────────

router.get('/:id/movies/:movieId', requirePlayer, async (req, res) => {
  const db = req.app.get('db');
  const movies = await query(db, `SELECT * FROM movies WHERE id = ?`, [parseInt(req.params.movieId)]);
  if (!movies.length) return res.status(404).json({ error: 'Movie not found.' });
  const m = movies[0];
  const [oscarsData, awards, breakdown] = await Promise.all([
    query(db, `SELECT * FROM oscar_data WHERE movie_id = ? ORDER BY category`, [m.id]),
    query(db, `SELECT * FROM critics_awards WHERE movie_id = ? ORDER BY year`, [m.id]),
    scoring.getScoringBreakdown(db, m.id),
  ]);
  let owner = null;
  if (m.owned_by) {
    const ownerRows = await query(db, `SELECT id, name FROM players WHERE id = ?`, [m.owned_by]);
    owner = ownerRows[0] || null;
  }
  res.json({
    movie: { ...m, poster: tmdb.imageUrl(m.tmdb_poster_path, 'w500'), backdrop: tmdb.imageUrl(m.tmdb_backdrop_path, 'w1280'), genres: tryParse(m.tmdb_genres, []), cast: tryParse(m.tmdb_cast, []) },
    owner, scoring: breakdown, oscars: oscarsData, criticsAwards: awards,
  });
});

// ── Nominate movie ────────────────────────────────────────────────────────────

router.post('/:id/nominate', requirePlayer, async (req, res) => {
  const { movieId } = req.body;
  if (!movieId) return res.status(400).json({ error: 'movieId is required.' });
  const db = req.app.get('db');
  const { player, league: leagueRow } = req;
  if (leagueRow.id !== req.params.id) return res.status(403).json({ error: 'Access denied.' });
  try {
    await league.nominateMovie(db, { leagueId: leagueRow.id, movieId: parseInt(movieId), playerId: player.id });
    const io = req.app.get('io');
    if (io) {
      const queue = await league.getNominationQueue(db, leagueRow.id);
      io.to(leagueRow.id).emit('queue:updated', { queue });
    }
    res.json({ message: 'Movie added to nomination queue.' });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ── Nomination queue ──────────────────────────────────────────────────────────

router.get('/:id/queue', requirePlayer, async (req, res) => {
  const db = req.app.get('db');
  const queue = await league.getNominationQueue(db, req.params.id);
  res.json({ queue });
});

// ── Scoring feed ──────────────────────────────────────────────────────────────

router.get('/:id/feed', requirePlayer, async (req, res) => {
  const db = req.app.get('db');
  const feed = await league.getRecentScoringFeed(db, req.params.id);
  res.json({ feed });
});

// ── Commissioner: update settings ─────────────────────────────────────────────

router.patch('/:id', requireCommissioner, async (req, res) => {
  const db = req.app.get('db');
  const { name, minRoster, maxRoster, status } = req.body;
  await run(db, `
    UPDATE leagues SET
      name       = COALESCE(?, name),
      min_roster = COALESCE(?, min_roster),
      max_roster = COALESCE(?, max_roster),
      status     = COALESCE(?, status),
      updated_at = datetime('now')
    WHERE id = ?
  `, [name, minRoster, maxRoster, status, req.params.id]);
  res.json({ message: 'League updated.' });
});

// ── Commissioner: add movie to pool ───────────────────────────────────────────

router.post('/:id/pool/add', requireCommissioner, async (req, res) => {
  const { tmdbId } = req.body;
  if (!tmdbId) return res.status(400).json({ error: 'tmdbId required.' });
  const db = req.app.get('db');
  const leagueRow = req.league;
  try {
    const details = await tmdb.getMovieDetails(parseInt(tmdbId));
    await run(db, `
      INSERT INTO movies (
        id, title, release_date, season_year, status,
        tmdb_poster_path, tmdb_overview, tmdb_genres, tmdb_director,
        tmdb_cast, tmdb_runtime, tmdb_budget, imdb_id, in_draft_pool
      ) VALUES (?, ?, ?, ?, 'upcoming', ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET in_draft_pool = 1, updated_at = datetime('now')
    `, [details.id, details.title, details.release_date, leagueRow.season_year,
        details.tmdb_poster_path, details.tmdb_overview, details.tmdb_genres,
        details.tmdb_director, details.tmdb_cast, details.tmdb_runtime,
        details.tmdb_budget, details.imdb_id]);
    res.json({ message: `Added "${details.title}" to pool.`, movie: details });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Commissioner: remove movie from pool ──────────────────────────────────────

router.delete('/:id/pool/:movieId', requireCommissioner, async (req, res) => {
  const db = req.app.get('db');
  await run(db, `UPDATE movies SET in_draft_pool = 0, updated_at = datetime('now') WHERE id = ?`, [parseInt(req.params.movieId)]);
  res.json({ message: 'Movie removed from pool.' });
});

// ── Commissioner: enter CinemaScore ──────────────────────────────────────────

router.post('/:id/cinema-score', requireCommissioner, async (req, res) => {
  const db = req.app.get('db');
  const { movieId, cinemaScore } = req.body;
  const valid = ['A+', 'A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'];
  if (!valid.includes(cinemaScore)) {
    return res.status(400).json({ error: `cinemaScore must be one of: ${valid.join(', ')}` });
  }
  await run(db, `UPDATE movies SET cinema_score = ?, updated_at = datetime('now') WHERE id = ?`, [cinemaScore, parseInt(movieId)]);
  await scoring.scoreMovie(db, parseInt(movieId));
  const io = req.app.get('io');
  if (io) io.to(req.params.id).emit('scores:updated', { movieId: parseInt(movieId) });
  res.json({ message: `CinemaScore ${cinemaScore} recorded.` });
});

function tryParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

module.exports = router;
