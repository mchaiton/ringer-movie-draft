/**
 * db/schema.js
 * SQLite schema via @libsql/client (Turso).
 * Falls back to a local file when TURSO_DATABASE_URL is not set.
 */

const { createClient } = require('@libsql/client');

let _client = null;

async function getDb() {
  if (_client) return _client;

  _client = createClient({
    url:       process.env.TURSO_DATABASE_URL || 'file:./data/ringer_draft.db',
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  await applySchema(_client);
  return _client;
}

/** No-op — Turso persists automatically. Kept for API compatibility. */
async function save() {}

async function applySchema(db) {
  await db.batch([
    { sql: `CREATE TABLE IF NOT EXISTS movies (
        id                INTEGER PRIMARY KEY,
        imdb_id           TEXT UNIQUE,
        title             TEXT NOT NULL,
        release_date      TEXT,
        season_year       INTEGER,
        status            TEXT DEFAULT 'upcoming',
        tmdb_poster_path  TEXT,
        tmdb_backdrop_path TEXT,
        tmdb_overview     TEXT,
        tmdb_genres       TEXT,
        tmdb_director     TEXT,
        tmdb_cast         TEXT,
        tmdb_runtime      INTEGER,
        tmdb_budget       INTEGER,
        tmdb_last_synced  TEXT,
        domestic_gross    INTEGER,
        worldwide_gross   INTEGER,
        metacritic_score  INTEGER,
        imdb_rating       REAL,
        cinema_score      TEXT,
        omdb_last_synced  TEXT,
        is_streaming_only INTEGER DEFAULT 0,
        streaming_views   INTEGER,
        streaming_platform TEXT,
        in_draft_pool     INTEGER DEFAULT 1,
        owned_by          TEXT,
        draft_bid         INTEGER,
        drafted_at        TEXT,
        total_points      INTEGER DEFAULT 0,
        created_at        TEXT DEFAULT (datetime('now')),
        updated_at        TEXT DEFAULT (datetime('now'))
      )`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_movies_season ON movies(season_year)`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_movies_status ON movies(status)`,     args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_movies_owner  ON movies(owned_by)`,   args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS scoring_events (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        movie_id     INTEGER NOT NULL REFERENCES movies(id),
        category     TEXT NOT NULL,
        description  TEXT NOT NULL,
        points       INTEGER NOT NULL,
        awarded_at   TEXT DEFAULT (datetime('now')),
        source       TEXT,
        source_ref   TEXT
      )`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_scoring_movie ON scoring_events(movie_id)`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_scoring_cat   ON scoring_events(category)`, args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS oscar_data (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        movie_id      INTEGER REFERENCES movies(id),
        imdb_id       TEXT,
        ceremony_year INTEGER NOT NULL,
        category      TEXT NOT NULL,
        nominees      TEXT,
        won           INTEGER DEFAULT 0,
        created_at    TEXT DEFAULT (datetime('now'))
      )`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_oscar_movie ON oscar_data(movie_id)`,       args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_oscar_year  ON oscar_data(ceremony_year)`,  args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS critics_awards (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        movie_id   INTEGER REFERENCES movies(id),
        source     TEXT NOT NULL,
        award_name TEXT NOT NULL,
        year       INTEGER NOT NULL,
        won        INTEGER DEFAULT 1,
        points     INTEGER NOT NULL,
        scraped_at TEXT DEFAULT (datetime('now')),
        source_url TEXT
      )`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_awards_movie  ON critics_awards(movie_id)`, args: [] },
    { sql: `CREATE INDEX IF NOT EXISTS idx_awards_source ON critics_awards(source)`,   args: [] },
    { sql: `CREATE TABLE IF NOT EXISTS sync_log (
        source           TEXT PRIMARY KEY,
        last_synced      TEXT,
        last_status      TEXT,
        last_error       TEXT,
        records_affected INTEGER DEFAULT 0
      )`, args: [] },
  ], 'write');

  console.log('[db] Schema applied');
}

/** Run a SELECT and return rows as plain objects. */
async function query(db, sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return result.rows.map(row =>
    Object.fromEntries(result.columns.map((col, i) => [col, row[i]]))
  );
}

/** Run INSERT/UPDATE/DELETE. */
async function run(db, sql, params = []) {
  const result = await db.execute({ sql, args: params });
  return { changes: result.rowsAffected };
}

module.exports = { getDb, save, query, run };
