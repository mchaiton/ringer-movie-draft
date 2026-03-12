/**
 * db/league.js
 * Database schema extensions and queries for leagues, players, and rosters.
 *
 * Tables:
 *   leagues       — one per season group, created by commissioner
 *   players       — users within a league
 *   draft_sessions — scheduled draft events
 *   nomination_queue — movies queued for the next draft session
 */

const { run, query, save } = require('./schema');

// ── Schema ───────────────────────────────────────────────────────────────────

function applyLeagueSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS leagues (
      id            TEXT PRIMARY KEY,        -- UUID
      name          TEXT NOT NULL,
      season_year   INTEGER NOT NULL,
      commissioner_id TEXT NOT NULL,         -- player ID
      budget_per_player INTEGER DEFAULT 1000,
      min_roster    INTEGER DEFAULT 6,
      max_roster    INTEGER DEFAULT 10,
      invite_code   TEXT UNIQUE NOT NULL,    -- short shareable code
      status        TEXT DEFAULT 'setup',    -- setup | drafting | active | complete
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS players (
      id            TEXT PRIMARY KEY,        -- UUID
      league_id     TEXT NOT NULL REFERENCES leagues(id),
      name          TEXT NOT NULL,
      auth_token    TEXT UNIQUE NOT NULL,    -- session token (simple auth)
      is_commissioner INTEGER DEFAULT 0,
      budget_remaining INTEGER,              -- set to league budget_per_player on join
      movies_owned  INTEGER DEFAULT 0,
      total_points  INTEGER DEFAULT 0,
      joined_at     TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_players_league ON players(league_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_players_token  ON players(auth_token);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS draft_sessions (
      id            TEXT PRIMARY KEY,        -- UUID
      league_id     TEXT NOT NULL REFERENCES leagues(id),
      scheduled_at  TEXT,                   -- ISO timestamp
      started_at    TEXT,
      ended_at      TEXT,
      status        TEXT DEFAULT 'scheduled', -- scheduled | active | complete
      current_movie_id INTEGER,             -- movie currently on the block
      bid_deadline  TEXT,                   -- ISO timestamp of current bid expiry
      created_at    TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS nomination_queue (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      league_id     TEXT NOT NULL REFERENCES leagues(id),
      movie_id      INTEGER NOT NULL REFERENCES movies(id),
      nominated_by  TEXT NOT NULL REFERENCES players(id),
      nominated_at  TEXT DEFAULT (datetime('now')),
      status        TEXT DEFAULT 'queued',  -- queued | active | sold | passed
      UNIQUE(league_id, movie_id)
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bids (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL REFERENCES draft_sessions(id),
      movie_id      INTEGER NOT NULL REFERENCES movies(id),
      player_id     TEXT NOT NULL REFERENCES players(id),
      amount        INTEGER NOT NULL,
      placed_at     TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_bids_session ON bids(session_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_bids_movie   ON bids(session_id, movie_id);`);
}

// ── League queries ────────────────────────────────────────────────────────────

function createLeague(db, { id, name, seasonYear, commissionerId, commissionerName, budgetPerPlayer = 1000, minRoster = 6, maxRoster = 10 }) {
  const inviteCode = Math.random().toString(36).slice(2, 8).toUpperCase();
  const token = require('crypto').randomBytes(24).toString('hex');

  run(db, `
    INSERT INTO leagues (id, name, season_year, commissioner_id, budget_per_player, min_roster, max_roster, invite_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, name, seasonYear, commissionerId, budgetPerPlayer, minRoster, maxRoster, inviteCode]);

  // Commissioner is also a player
  run(db, `
    INSERT INTO players (id, league_id, name, auth_token, is_commissioner, budget_remaining)
    VALUES (?, ?, ?, ?, 1, ?)
  `, [commissionerId, id, commissionerName, token, budgetPerPlayer]);

  save(db);
  return { inviteCode, authToken: token };
}

function getLeague(db, leagueId) {
  const rows = query(db, `SELECT * FROM leagues WHERE id = ?`, [leagueId]);
  return rows[0] || null;
}

function getLeagueByInvite(db, inviteCode) {
  const rows = query(db, `SELECT * FROM leagues WHERE invite_code = ?`, [inviteCode.toUpperCase()]);
  return rows[0] || null;
}

function joinLeague(db, { leagueId, playerId, playerName }) {
  const league = getLeague(db, leagueId);
  if (!league) throw new Error('League not found');
  if (league.status !== 'setup') throw new Error('League is not accepting new players');

  const token = require('crypto').randomBytes(24).toString('hex');

  run(db, `
    INSERT INTO players (id, league_id, name, auth_token, budget_remaining)
    VALUES (?, ?, ?, ?, ?)
  `, [playerId, leagueId, playerName, token, league.budget_per_player]);

  save(db);
  return { authToken: token };
}

function getPlayers(db, leagueId) {
  return query(db, `SELECT * FROM players WHERE league_id = ? ORDER BY joined_at`, [leagueId]);
}

function getPlayerByToken(db, token) {
  const rows = query(db, `SELECT * FROM players WHERE auth_token = ?`, [token]);
  return rows[0] || null;
}

// ── Budget enforcement ─────────────────────────────────────────────────────
// Spec rule 7.4:
//   effective_max_bid = budget_remaining − ($1 × remaining_required_slots)
//   remaining_required_slots = max(0, min_roster − movies_owned)

function getEffectiveMaxBid(db, playerId) {
  const players = query(db, `
    SELECT p.budget_remaining, p.movies_owned, l.min_roster
    FROM players p JOIN leagues l ON p.league_id = l.id
    WHERE p.id = ?
  `, [playerId]);

  if (!players.length) return 0;
  const { budget_remaining, movies_owned, min_roster } = players[0];
  const slotsRemaining = Math.max(0, min_roster - movies_owned);
  return Math.max(0, budget_remaining - slotsRemaining);
}

function canAffordBid(db, playerId, amount) {
  return amount <= getEffectiveMaxBid(db, playerId) && amount >= 1;
}

// ── Roster queries ────────────────────────────────────────────────────────────

function getPlayerRoster(db, playerId) {
  return query(db, `
    SELECT m.*, se_summary.total_pts,
           m.draft_bid, m.drafted_at
    FROM movies m
    LEFT JOIN (
      SELECT movie_id, SUM(points) as total_pts
      FROM scoring_events GROUP BY movie_id
    ) se_summary ON se_summary.movie_id = m.id
    WHERE m.owned_by = ?
    ORDER BY m.release_date
  `, [playerId]);
}

function getLeagueStandings(db, leagueId) {
  return query(db, `
    SELECT
      p.id, p.name, p.budget_remaining, p.movies_owned,
      COALESCE(SUM(se.points), 0) as total_points
    FROM players p
    LEFT JOIN movies m ON m.owned_by = p.id
    LEFT JOIN scoring_events se ON se.movie_id = m.id
    WHERE p.league_id = ?
    GROUP BY p.id
    ORDER BY total_points DESC, p.budget_remaining ASC
  `, [leagueId]);
}

// ── Nomination queue ──────────────────────────────────────────────────────────

function nominateMovie(db, { leagueId, movieId, playerId }) {
  // Check movie is in pool and not already owned
  const movies = query(db, `SELECT * FROM movies WHERE id = ? AND in_draft_pool = 1`, [movieId]);
  if (!movies.length) throw new Error('Movie not in draft pool');
  if (movies[0].owned_by) throw new Error('Movie already owned');

  // Check not already queued
  const existing = query(db,
    `SELECT id FROM nomination_queue WHERE league_id = ? AND movie_id = ? AND status = 'queued'`,
    [leagueId, movieId]
  );
  if (existing.length) throw new Error('Movie already in nomination queue');

  run(db, `
    INSERT INTO nomination_queue (league_id, movie_id, nominated_by)
    VALUES (?, ?, ?)
  `, [leagueId, movieId, playerId]);

  save(db);
}

function getNominationQueue(db, leagueId) {
  return query(db, `
    SELECT nq.*, m.title, m.release_date, m.tmdb_poster_path,
           p.name as nominated_by_name
    FROM nomination_queue nq
    JOIN movies m ON m.id = nq.movie_id
    JOIN players p ON p.id = nq.nominated_by
    WHERE nq.league_id = ? AND nq.status = 'queued'
    ORDER BY nq.nominated_at
  `, [leagueId]);
}

// ── Recent scoring feed ───────────────────────────────────────────────────────

function getRecentScoringFeed(db, leagueId, limit = 20) {
  return query(db, `
    SELECT se.description, se.points, se.category, se.awarded_at,
           m.title as movie_title, m.id as movie_id,
           p.name as player_name, p.id as player_id
    FROM scoring_events se
    JOIN movies m ON m.id = se.movie_id
    JOIN players p ON p.id = m.owned_by
    WHERE p.league_id = ?
    ORDER BY se.awarded_at DESC
    LIMIT ?
  `, [leagueId, limit]);
}

module.exports = {
  applyLeagueSchema,
  createLeague,
  getLeague,
  getLeagueByInvite,
  joinLeague,
  getPlayers,
  getPlayerByToken,
  getEffectiveMaxBid,
  canAffordBid,
  getPlayerRoster,
  getLeagueStandings,
  nominateMovie,
  getNominationQueue,
  getRecentScoringFeed,
};
