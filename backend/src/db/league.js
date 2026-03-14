/**
 * db/league.js
 * Database schema extensions and queries for leagues, players, and rosters.
 */

const { run, query, save } = require('./schema');

async function applyLeagueSchema(db) {
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS leagues (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL,
        season_year       INTEGER NOT NULL,
        commissioner_id   TEXT NOT NULL,
        budget_per_player INTEGER DEFAULT 1000,
        min_roster        INTEGER DEFAULT 6,
        max_roster        INTEGER DEFAULT 10,
        invite_code       TEXT UNIQUE NOT NULL,
        status            TEXT DEFAULT 'setup',
        created_at        TEXT DEFAULT (datetime('now')),
        updated_at        TEXT DEFAULT (datetime('now'))
      )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS players (
        id               TEXT PRIMARY KEY,
        league_id        TEXT NOT NULL REFERENCES leagues(id),
        name             TEXT NOT NULL,
        auth_token       TEXT UNIQUE NOT NULL,
        is_commissioner  INTEGER DEFAULT 0,
        budget_remaining INTEGER,
        movies_owned     INTEGER DEFAULT 0,
        total_points     INTEGER DEFAULT 0,
        joined_at        TEXT DEFAULT (datetime('now'))
      )`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_players_league ON players(league_id)`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_players_token  ON players(auth_token)`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS draft_sessions (
        id               TEXT PRIMARY KEY,
        league_id        TEXT NOT NULL REFERENCES leagues(id),
        scheduled_at     TEXT,
        started_at       TEXT,
        ended_at         TEXT,
        status           TEXT DEFAULT 'scheduled',
        current_movie_id INTEGER,
        bid_deadline     TEXT,
        created_at       TEXT DEFAULT (datetime('now'))
      )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS nomination_queue (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        league_id    TEXT NOT NULL REFERENCES leagues(id),
        movie_id     INTEGER NOT NULL REFERENCES movies(id),
        nominated_by TEXT NOT NULL REFERENCES players(id),
        nominated_at TEXT DEFAULT (datetime('now')),
        status       TEXT DEFAULT 'queued',
        UNIQUE(league_id, movie_id)
      )`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS bids (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES draft_sessions(id),
        movie_id   INTEGER NOT NULL REFERENCES movies(id),
        player_id  TEXT NOT NULL REFERENCES players(id),
        amount     INTEGER NOT NULL,
        placed_at  TEXT DEFAULT (datetime('now'))
      )`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_bids_session ON bids(session_id)`,            args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_bids_movie   ON bids(session_id, movie_id)`,  args: [] },
  ], 'write');
}

async function createLeague(db, { id, name, seasonYear, commissionerId, commissionerName, budgetPerPlayer = 1000, minRoster = 6, maxRoster = 10 }) {
  const inviteCode = require('crypto').randomBytes(3).toString('hex').toUpperCase();
  const token      = require('crypto').randomBytes(24).toString('hex');

  await run(db, `
    INSERT INTO leagues (id, name, season_year, commissioner_id, budget_per_player, min_roster, max_roster, invite_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, name, seasonYear, commissionerId, budgetPerPlayer, minRoster, maxRoster, inviteCode]);

  await run(db, `
    INSERT INTO players (id, league_id, name, auth_token, is_commissioner, budget_remaining)
    VALUES (?, ?, ?, ?, 1, ?)
  `, [commissionerId, id, commissionerName, token, budgetPerPlayer]);

  return { inviteCode, authToken: token };
}

async function getLeague(db, leagueId) {
  const rows = await query(db, `SELECT * FROM leagues WHERE id = ?`, [leagueId]);
  return rows[0] || null;
}

async function getLeagueByInvite(db, inviteCode) {
  const rows = await query(db, `SELECT * FROM leagues WHERE invite_code = ?`, [inviteCode.toUpperCase()]);
  return rows[0] || null;
}

async function joinLeague(db, { leagueId, playerId, playerName }) {
  const league = await getLeague(db, leagueId);
  if (!league) throw new Error('League not found');
  if (league.status !== 'setup') throw new Error('League is not accepting new players');

  const token = require('crypto').randomBytes(24).toString('hex');

  await run(db, `
    INSERT INTO players (id, league_id, name, auth_token, budget_remaining)
    VALUES (?, ?, ?, ?, ?)
  `, [playerId, leagueId, playerName, token, league.budget_per_player]);

  return { authToken: token };
}

async function getPlayers(db, leagueId) {
  return query(db, `SELECT * FROM players WHERE league_id = ? ORDER BY joined_at`, [leagueId]);
}

async function getPlayerByToken(db, token) {
  const rows = await query(db, `SELECT * FROM players WHERE auth_token = ?`, [token]);
  return rows[0] || null;
}

async function getEffectiveMaxBid(db, playerId) {
  const players = await query(db, `
    SELECT p.budget_remaining, p.movies_owned, l.min_roster
    FROM players p JOIN leagues l ON p.league_id = l.id
    WHERE p.id = ?
  `, [playerId]);

  if (!players.length) return 0;
  const { budget_remaining, movies_owned, min_roster } = players[0];
  const slotsRemaining = Math.max(0, min_roster - movies_owned);
  return Math.max(0, budget_remaining - slotsRemaining);
}

async function canAffordBid(db, playerId, amount) {
  const maxBid = await getEffectiveMaxBid(db, playerId);
  return amount <= maxBid && amount >= 1;
}

async function getPlayerRoster(db, playerId) {
  return query(db, `
    SELECT m.*, se_summary.total_pts, m.draft_bid, m.drafted_at
    FROM movies m
    LEFT JOIN (
      SELECT movie_id, SUM(points) as total_pts
      FROM scoring_events GROUP BY movie_id
    ) se_summary ON se_summary.movie_id = m.id
    WHERE m.owned_by = ?
    ORDER BY m.release_date
  `, [playerId]);
}

async function getLeagueStandings(db, leagueId) {
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

async function nominateMovie(db, { leagueId, movieId, playerId }) {
  const movies = await query(db, `SELECT * FROM movies WHERE id = ? AND in_draft_pool = 1`, [movieId]);
  if (!movies.length) throw new Error('Movie not in draft pool');
  if (movies[0].owned_by) throw new Error('Movie already owned');

  const existing = await query(db,
    `SELECT id FROM nomination_queue WHERE league_id = ? AND movie_id = ? AND status = 'queued'`,
    [leagueId, movieId]
  );
  if (existing.length) throw new Error('Movie already in nomination queue');

  await run(db, `
    INSERT INTO nomination_queue (league_id, movie_id, nominated_by)
    VALUES (?, ?, ?)
  `, [leagueId, movieId, playerId]);
}

async function getNominationQueue(db, leagueId) {
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

async function getRecentScoringFeed(db, leagueId, limit = 20) {
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
