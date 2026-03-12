/**
 * db/schema.js
 * SQLite schema and database initialization via sql.js (pure WASM, no native bindings).
 *
 * Tables:
 *   movies          — master film records, enriched from TMDB + OMDb
 *   scoring_events  — immutable log of every point award
 *   oscar_data      — nominations and wins from the JSON dataset
 *   critics_awards  — festival prizes and critics poll appearances (scraped)
 *   sync_log        — tracks last successful sync per data source
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || './data/ringer_draft.db';

let _db = null;

async function getDb() {
  if (_db) return _db;

  const SQL = await initSqlJs();

  // Load existing DB from disk, or create fresh
  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    _db = new SQL.Database(fileBuffer);
  } else {
    _db = new SQL.Database();
  }

  _db._path = DB_PATH;
  applySchema(_db);
  return _db;
}

function save(db) {
  const data = db.export();
  fs.writeFileSync(db._path, Buffer.from(data));
}

function applySchema(db) {
  db.run(`PRAGMA journal_mode = WAL;`);
  db.run(`PRAGMA foreign_keys = ON;`);

  // ── movies ─────────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS movies (
      id                INTEGER PRIMARY KEY,   -- TMDB movie ID (canonical)
      imdb_id           TEXT UNIQUE,           -- tt1234567 — used for OMDb lookups
      title             TEXT NOT NULL,
      release_date      TEXT,                  -- ISO 8601: YYYY-MM-DD
      season_year       INTEGER,               -- which draft season this belongs to
      status            TEXT DEFAULT 'upcoming',
        -- upcoming | released | streaming_only | date_shifted | cancelled

      -- TMDB fields
      tmdb_poster_path  TEXT,                  -- e.g. /abc123.jpg (prepend base URL)
      tmdb_backdrop_path TEXT,
      tmdb_overview     TEXT,
      tmdb_genres       TEXT,                  -- JSON array: ["Drama","Thriller"]
      tmdb_director     TEXT,
      tmdb_cast         TEXT,                  -- JSON array, top 5 billed
      tmdb_runtime      INTEGER,               -- minutes
      tmdb_budget       INTEGER,               -- reported production budget (USD)
      tmdb_last_synced  TEXT,                  -- ISO timestamp

      -- OMDb / box office fields
      domestic_gross    INTEGER,               -- USD
      worldwide_gross   INTEGER,               -- USD
      metacritic_score  INTEGER,               -- 0–100
      imdb_rating       REAL,                  -- 0.0–10.0
      cinema_score      TEXT,                  -- A+, A, A-, B+, B, etc. (manual)
      omdb_last_synced  TEXT,                  -- ISO timestamp

      -- Streaming (for direct-to-streaming releases)
      is_streaming_only INTEGER DEFAULT 0,     -- boolean
      streaming_views   INTEGER,               -- weekly views in millions (manual/platform)
      streaming_platform TEXT,                 -- Netflix, Apple TV+, etc.

      -- Pool/draft metadata
      in_draft_pool     INTEGER DEFAULT 1,     -- commissioner can remove
      owned_by          TEXT,                  -- player ID, null if undrafted
      draft_bid         INTEGER,               -- winning bid amount
      drafted_at        TEXT,                  -- ISO timestamp

      -- Computed score cache (recalculated on each scoring event)
      total_points      INTEGER DEFAULT 0,

      created_at        TEXT DEFAULT (datetime('now')),
      updated_at        TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_movies_season ON movies(season_year);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_movies_status ON movies(status);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_movies_owner  ON movies(owned_by);`);

  // ── scoring_events ──────────────────────────────────────────────────────────
  // Immutable append-only log. Total score is always sum of this table per movie.
  db.run(`
    CREATE TABLE IF NOT EXISTS scoring_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id     INTEGER NOT NULL REFERENCES movies(id),
      category     TEXT NOT NULL,
        -- box_office | profitability | metacritic | oscar_nom | oscar_win |
        -- oscar_best_picture | cinema_score | festival_award | critics_poll
      description  TEXT NOT NULL,              -- human-readable label
      points       INTEGER NOT NULL,
      awarded_at   TEXT DEFAULT (datetime('now')),
      source       TEXT,                       -- omdb | tmdb | oscar_json | scraper | manual
      source_ref   TEXT                        -- e.g. OMDb field name, Wikipedia URL
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_scoring_movie ON scoring_events(movie_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_scoring_cat   ON scoring_events(category);`);

  // ── oscar_data ──────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS oscar_data (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id     INTEGER REFERENCES movies(id),
      imdb_id      TEXT,                       -- for matching before movie_id is known
      ceremony_year INTEGER NOT NULL,          -- e.g. 2026 = 98th ceremony
      category     TEXT NOT NULL,              -- "Best Picture", "Best Director", etc.
      nominees     TEXT,                       -- JSON array of nominee names
      won          INTEGER DEFAULT 0,          -- boolean
      created_at   TEXT DEFAULT (datetime('now'))
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_oscar_movie  ON oscar_data(movie_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_oscar_year   ON oscar_data(ceremony_year);`);

  // ── critics_awards ──────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS critics_awards (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      movie_id     INTEGER REFERENCES movies(id),
      source       TEXT NOT NULL,
        -- cannes | venice | berlin | afi_top10 | nyfcc | nbr
      award_name   TEXT NOT NULL,              -- e.g. "Palme d'Or", "AFI Top 10 Film"
      year         INTEGER NOT NULL,
      won          INTEGER DEFAULT 1,          -- 1 = winner/listee, 0 = nominee only
      points       INTEGER NOT NULL,           -- pre-calculated per scoring rules
      scraped_at   TEXT DEFAULT (datetime('now')),
      source_url   TEXT
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_awards_movie  ON critics_awards(movie_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_awards_source ON critics_awards(source);`);

  // ── sync_log ────────────────────────────────────────────────────────────────
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_log (
      source       TEXT PRIMARY KEY,           -- tmdb_upcoming | omdb | oscar_json | scraper_*
      last_synced  TEXT,                       -- ISO timestamp
      last_status  TEXT,                       -- success | error
      last_error   TEXT,
      records_affected INTEGER DEFAULT 0
    );
  `);

  console.log('[db] Schema applied');
}

/**
 * Run a SELECT and return all rows as plain objects.
 * sql.js returns column names separately from row arrays, so we zip them.
 */
function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const cols = stmt.getColumnNames();
  const rows = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    rows.push(row);
  }
  stmt.free();
  return rows;
}

/**
 * Run an INSERT/UPDATE/DELETE and return { changes, lastInsertRowid }.
 */
function run(db, sql, params = []) {
  db.run(sql, params);
  return {
    changes: db.getRowsModified(),
  };
}

module.exports = { getDb, save, query, run };
