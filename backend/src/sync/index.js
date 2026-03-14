/**
 * sync/index.js
 * Main sync orchestrator. Coordinates all data sources and writes to the DB.
 *
 * Sync schedule (run via node-cron or manually):
 *   tmdb_pool   — weekly, or on-demand when commissioner edits the pool
 *   omdb        — weekly (box office + Metacritic)
 *   oscar_json  — on-demand: January (nominations) + March (winners)
 *   scrapers    — on-demand: tied to each award body's announcement calendar
 *                 Berlin (Feb), Cannes (May), Venice (Sep), NBR/NYFCC/AFI (Nov–Dec)
 */

require('dotenv').config();
const cron = require('node-cron');

const { getDb, save, query, run } = require('../db/schema');
const tmdb    = require('../clients/tmdb');
const omdb    = require('../clients/omdb');
const oscars  = require('../clients/oscars');
const scrapers = require('../scrapers/awards');
const scoring  = require('./scoring');

// ── Helpers ─────────────────────────────────────────────────────────────────

async function logSync(db, source, status, error = null, records = 0) {
  await run(db,
    `INSERT OR REPLACE INTO sync_log (source, last_synced, last_status, last_error, records_affected)
     VALUES (?, datetime('now'), ?, ?, ?)`,
    [source, status, error, records]
  );
  await save(db);
}

// ── TMDB Pool Sync ───────────────────────────────────────────────────────────

/**
 * Sync upcoming releases from TMDB into the movies table.
 * Upserts records — safe to run repeatedly.
 *
 * @param {Object} db
 * @param {number} year   season year
 */
async function syncTmdbPool(db, year) {
  console.log(`\n[sync:tmdb] Starting TMDB pool sync for ${year}…`);

  try {
    const upcoming = await tmdb.getUpcomingForYear(year);
    let upserted = 0;

    for (const film of upcoming) {
      // Fetch full details (director, cast, runtime, budget)
      let details;
      try {
        details = await tmdb.getMovieDetails(film.id);
        await new Promise(r => setTimeout(r, 200)); // 200ms between detail fetches
      } catch (err) {
        console.warn(`[sync:tmdb] Skipping ${film.id} (${film.title}): ${err.message}`);
        continue;
      }

      await run(db, `
        INSERT INTO movies (
          id, title, release_date, season_year, status,
          tmdb_poster_path, tmdb_backdrop_path, tmdb_overview,
          tmdb_genres, tmdb_director, tmdb_cast, tmdb_runtime, tmdb_budget,
          imdb_id, tmdb_last_synced, in_draft_pool
        ) VALUES (?, ?, ?, ?, ?,  ?, ?, ?,  ?, ?, ?, ?, ?,  ?, datetime('now'), 1)
        ON CONFLICT(id) DO UPDATE SET
          title             = excluded.title,
          release_date      = excluded.release_date,
          tmdb_poster_path  = excluded.tmdb_poster_path,
          tmdb_backdrop_path = excluded.tmdb_backdrop_path,
          tmdb_overview     = excluded.tmdb_overview,
          tmdb_genres       = excluded.tmdb_genres,
          tmdb_director     = excluded.tmdb_director,
          tmdb_cast         = excluded.tmdb_cast,
          tmdb_runtime      = excluded.tmdb_runtime,
          tmdb_budget       = COALESCE(excluded.tmdb_budget, movies.tmdb_budget),
          imdb_id           = COALESCE(excluded.imdb_id, movies.imdb_id),
          tmdb_last_synced  = datetime('now'),
          updated_at        = datetime('now')
      `, [
        details.id, details.title, details.release_date, year, 'upcoming',
        details.tmdb_poster_path, details.tmdb_backdrop_path, details.tmdb_overview,
        details.tmdb_genres, details.tmdb_director, details.tmdb_cast,
        details.tmdb_runtime, details.tmdb_budget,
        details.imdb_id,
      ]);

      upserted++;
    }

    // Mark movies whose release date has shifted out of year as date_shifted
    await run(db,
      `UPDATE movies SET status = 'date_shifted', updated_at = datetime('now')
       WHERE season_year = ?
         AND status = 'upcoming'
         AND release_date NOT LIKE ?`,
      [year, `${year}-%`]
    );

    await logSync(db, 'tmdb_pool', 'success', null, upserted);
    console.log(`[sync:tmdb] Done. ${upserted} movies upserted.`);
    return upserted;

  } catch (err) {
    await logSync(db, 'tmdb_pool', 'error', err.message);
    console.error('[sync:tmdb] Failed:', err.message);
    throw err;
  }
}

// ── OMDb Sync ────────────────────────────────────────────────────────────────

/**
 * Sync box office + Metacritic data from OMDb for all released movies in a season.
 * Only fetches movies that have a release_date in the past.
 *
 * @param {Object} db
 * @param {number} year
 */
async function syncOmdb(db, year) {
  console.log(`\n[sync:omdb] Starting OMDb sync for ${year}…`);

  const today = new Date().toISOString().slice(0, 10);

  // Only fetch movies that have already released
  const movies = await query(db, `
    SELECT id, title, imdb_id, release_date
    FROM movies
    WHERE season_year = ?
      AND in_draft_pool = 1
      AND release_date <= ?
      AND status != 'cancelled'
    ORDER BY release_date
  `, [year, today]);

  console.log(`[sync:omdb] ${movies.length} released movies to update`);
  let updated = 0;

  for (const movie of movies) {
    await new Promise(r => setTimeout(r, 300)); // stay under 1k req/day free limit

    let data = null;
    if (movie.imdb_id) {
      data = await omdb.getByImdbId(movie.imdb_id);
    }
    if (!data) {
      const releaseYear = movie.release_date?.slice(0, 4);
      data = await omdb.getByTitle(movie.title, releaseYear);
    }

    if (!data) {
      console.warn(`[sync:omdb] No data for: ${movie.title}`);
      continue;
    }

    await run(db, `
      UPDATE movies SET
        domestic_gross    = COALESCE(?, domestic_gross),
        metacritic_score  = COALESCE(?, metacritic_score),
        imdb_rating       = COALESCE(?, imdb_rating),
        imdb_id           = COALESCE(?, imdb_id),
        omdb_last_synced  = datetime('now'),
        updated_at        = datetime('now')
      WHERE id = ?
    `, [
      data.domestic_gross, data.metacritic_score,
      data.imdb_rating, data.imdb_id,
      movie.id,
    ]);

    // Re-score immediately after updating
    await scoring.scoreMovie(db, movie.id);
    updated++;
  }

  await logSync(db, 'omdb', 'success', null, updated);
  await save(db);
  console.log(`[sync:omdb] Done. ${updated} movies updated.`);
  return updated;
}

// ── Oscar Sync ───────────────────────────────────────────────────────────────

/**
 * Sync Oscar nominations/wins from the JSON dataset.
 * Call this manually in January (nominations) and March (winners).
 *
 * @param {Object} db
 * @param {number} ceremonyYear   e.g. 2026 for the 98th Academy Awards
 * @param {boolean} forceRefresh  re-download dataset from GitHub
 */
async function syncOscars(db, ceremonyYear, forceRefresh = false) {
  console.log(`\n[sync:oscars] Syncing Oscar data for ceremony year ${ceremonyYear}…`);

  try {
    const allNoms   = await oscars.loadNominations(forceRefresh);
    const yearNoms  = oscars.nominationsForYear(allNoms, ceremonyYear);
    const imdbIndex = oscars.buildImdbIndex(yearNoms);

    console.log(`[sync:oscars] ${yearNoms.length} nominations for ${ceremonyYear}`);
    let inserted = 0;

    for (const [imdbId, noms] of imdbIndex) {
      // Find matching movie in our DB
      const movies = await query(db,
        `SELECT id FROM movies WHERE imdb_id = ?`, [imdbId]
      );

      const movieId = movies[0]?.id || null;

      for (const nom of noms) {
        // Upsert oscar_data row
        const existing = await query(db,
          `SELECT id FROM oscar_data WHERE imdb_id = ? AND category = ? AND ceremony_year = ?`,
          [imdbId, nom.category, ceremonyYear]
        );

        if (existing.length === 0) {
          await run(db,
            `INSERT INTO oscar_data (movie_id, imdb_id, ceremony_year, category, nominees, won)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [movieId, imdbId, ceremonyYear, nom.category,
             JSON.stringify(nom.nominees), nom.won ? 1 : 0]
          );
          inserted++;
        } else {
          // Update won status (dataset gets updated after ceremony)
          await run(db,
            `UPDATE oscar_data SET won = ?, movie_id = COALESCE(?, movie_id)
             WHERE imdb_id = ? AND category = ? AND ceremony_year = ?`,
            [nom.won ? 1 : 0, movieId, imdbId, nom.category, ceremonyYear]
          );
        }

        // Re-score the movie if it's in our pool
        if (movieId) await scoring.scoreMovie(db, movieId);
      }
    }

    await logSync(db, 'oscar_json', 'success', null, inserted);
    await save(db);
    console.log(`[sync:oscars] Done. ${inserted} new records inserted.`);

  } catch (err) {
    await logSync(db, 'oscar_json', 'error', err.message);
    console.error('[sync:oscars] Failed:', err.message);
    throw err;
  }
}

// ── Awards Scraper Sync ──────────────────────────────────────────────────────

/**
 * Run award scrapers and store results in critics_awards table.
 * Matches scraped film titles to movies table using fuzzy title matching.
 *
 * @param {Object} db
 * @param {number} year
 * @param {string[]} [sources]  optionally limit to specific sources
 */
async function syncAwardScrapers(db, year, sources = null) {
  console.log(`\n[sync:scrapers] Running award scrapers for ${year}…`);

  try {
    let awards = await scrapers.scrapeAllAwards(year);

    if (sources) {
      awards = awards.filter(a => sources.includes(a.source));
    }

    let matched = 0;
    let unmatched = 0;

    for (const award of awards) {
      // Match to movie — try exact title first, then case-insensitive
      let movies = await query(db,
        `SELECT id FROM movies WHERE LOWER(title) = LOWER(?) AND season_year = ?`,
        [award.title, year]
      );

      // Fuzzy fallback: title contains the award title or vice versa
      if (!movies.length) {
        movies = await query(db,
          `SELECT id FROM movies
           WHERE season_year = ?
             AND (LOWER(title) LIKE LOWER(?) OR LOWER(?) LIKE LOWER('%' || title || '%'))`,
          [year, `%${award.title}%`, award.title]
        );
      }

      const movieId = movies[0]?.id || null;

      if (!movieId) {
        console.warn(`[sync:scrapers] No match for "${award.title}" (${award.source})`);
        unmatched++;
      } else {
        matched++;
      }

      // Check for duplicate
      const existing = await query(db,
        `SELECT id FROM critics_awards
         WHERE source = ? AND award_name = ? AND year = ? AND (movie_id = ? OR (movie_id IS NULL AND ? IS NULL))`,
        [award.source, award.award_name, award.year, movieId, movieId]
      );

      if (existing.length === 0) {
        await run(db,
          `INSERT INTO critics_awards (movie_id, source, award_name, year, won, points, source_url)
           VALUES (?, ?, ?, ?, 1, ?, ?)`,
          [movieId, award.source, award.award_name, award.year, award.points, award.source_url]
        );

        if (movieId) await scoring.scoreMovie(db, movieId);
      }
    }

    await logSync(db, 'scrapers', 'success', null, matched);
    await save(db);
    console.log(`[sync:scrapers] Done. ${matched} matched, ${unmatched} unmatched.`);

  } catch (err) {
    await logSync(db, 'scrapers', 'error', err.message);
    console.error('[sync:scrapers] Failed:', err.message);
    throw err;
  }
}

// ── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Register all cron jobs. Call this once on app startup.
 *
 * Schedules:
 *   TMDB pool  — every Monday at 2am
 *   OMDb       — every Tuesday at 3am (after TMDB has updated)
 *
 * Award scrapers are NOT on a cron — they run on-demand because they're
 * tied to specific annual announcement dates.
 */
function startScheduler(year) {
  console.log('[scheduler] Starting cron jobs…');

  // TMDB: every Monday at 2:00am
  cron.schedule('0 2 * * 1', async () => {
    const db = await getDb();
    await syncTmdbPool(db, year);
    await save(db);
  });

  // OMDb: every Tuesday at 3:00am
  cron.schedule('0 3 * * 2', async () => {
    const db = await getDb();
    await syncOmdb(db, year);
    await save(db);
  });

  console.log('[scheduler] TMDB sync: Mondays 2am | OMDb sync: Tuesdays 3am');
}

// ── Manual run entrypoint ────────────────────────────────────────────────────

/**
 * Run a specific sync manually from the command line:
 *   node src/sync/index.js tmdb 2026
 *   node src/sync/index.js omdb 2026
 *   node src/sync/index.js oscars 2026
 *   node src/sync/index.js scrapers 2026
 *   node src/sync/index.js all 2026
 */
if (require.main === module) {
  const [,, command, yearArg] = process.argv;
  const year = parseInt(yearArg, 10) || new Date().getFullYear();

  if (!command) {
    console.log('Usage: node src/sync/index.js <tmdb|omdb|oscars|scrapers|all> <year>');
    process.exit(1);
  }

  (async () => {
    const db = await getDb();

    if (command === 'tmdb'     || command === 'all') await syncTmdbPool(db, year);
    if (command === 'omdb'     || command === 'all') await syncOmdb(db, year);
    if (command === 'oscars'   || command === 'all') await syncOscars(db, year, true);
    if (command === 'scrapers' || command === 'all') await syncAwardScrapers(db, year);

    await save(db);
    console.log('\n[sync] All done.');
    process.exit(0);
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { syncTmdbPool, syncOmdb, syncOscars, syncAwardScrapers, startScheduler };
