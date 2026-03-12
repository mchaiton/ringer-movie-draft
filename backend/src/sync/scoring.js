/**
 * sync/scoring.js
 * Scoring engine — calculates and awards points based on the spec rules.
 *
 * Scoring rules (from spec v0.4):
 *
 * BOX OFFICE (domestic gross)
 *   $25M–$99M      →  3 pts
 *   $100M–$249M    →  7 pts
 *   $250M–$499M    → 12 pts
 *   $500M+         → 20 pts
 *
 * PROFITABILITY (gross / reported budget — domestic gross used; worldwide if available)
 *   Profitable (>1x)  →  3 pts
 *   2x budget         →  6 pts
 *   3x+ budget        → 10 pts
 *
 * METACRITIC
 *   40–59   →  1 pt
 *   60–79   →  3 pts
 *   80+     →  6 pts
 *
 * OSCARS
 *   Per nomination  →  2 pts
 *   Per win         →  5 pts
 *   Best Picture win → +10 pts bonus
 *
 * AUDIENCE (CinemaScore)
 *   A– or A  →  3 pts
 *   A+       →  6 pts
 *
 * CRITICS/FESTIVAL (from scrapers)
 *   Points pre-calculated in scraper and stored on critics_awards row
 */

const { query, run, save } = require('../db/schema');

// ── Point thresholds ────────────────────────────────────────────────────────

function boxOfficePoints(gross) {
  if (!gross) return 0;
  if (gross >= 500_000_000) return 20;
  if (gross >= 250_000_000) return 12;
  if (gross >= 100_000_000) return  7;
  if (gross >=  25_000_000) return  3;
  return 0;
}

function profitabilityPoints(gross, budget) {
  if (!gross || !budget || budget === 0) return 0;
  const ratio = gross / budget;
  if (ratio >= 3) return 10;
  if (ratio >= 2) return  6;
  if (ratio >  1) return  3;
  return 0;
}

function metacriticPoints(score) {
  if (!score) return 0;
  if (score >= 80) return 6;
  if (score >= 60) return 3;
  if (score >= 40) return 1;
  return 0;
}

function cinemaScorePoints(score) {
  if (!score) return 0;
  const s = score.trim().toUpperCase();
  if (s === 'A+') return 6;
  if (s === 'A'  || s === 'A-') return 3;
  return 0;
}

// ── Core scoring functions ──────────────────────────────────────────────────

/**
 * Award a scoring event if it hasn't been awarded already.
 * Idempotent — safe to call repeatedly; checks for existing event first.
 *
 * @param {Object} db
 * @param {number} movieId
 * @param {string} category
 * @param {string} description
 * @param {number} points
 * @param {string} source
 * @param {string} [sourceRef]
 * @returns {boolean}  true if newly awarded, false if already existed
 */
function awardPoints(db, movieId, category, description, points, source, sourceRef = null) {
  if (points === 0) return false;

  // Check for existing event with same movie + category + description
  const existing = query(db,
    `SELECT id FROM scoring_events
     WHERE movie_id = ? AND category = ? AND description = ?`,
    [movieId, category, description]
  );

  if (existing.length > 0) return false; // already awarded

  run(db,
    `INSERT INTO scoring_events (movie_id, category, description, points, source, source_ref)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [movieId, category, description, points, source, sourceRef]
  );

  // Update cached total on movie row
  run(db,
    `UPDATE movies SET total_points = (
       SELECT COALESCE(SUM(points), 0) FROM scoring_events WHERE movie_id = ?
     ), updated_at = datetime('now') WHERE id = ?`,
    [movieId, movieId]
  );

  console.log(`[scoring] +${points} pts → movie ${movieId} (${category}: ${description})`);
  return true;
}

/**
 * Score a movie's box office performance.
 * Uses domestic_gross; falls back to worldwide_gross for streaming/international films.
 */
function scoreBoxOffice(db, movie) {
  const gross = movie.domestic_gross || movie.worldwide_gross;
  const pts   = boxOfficePoints(gross);
  if (!pts) return 0;

  const label = movie.domestic_gross
    ? `Domestic gross $${(movie.domestic_gross / 1_000_000).toFixed(0)}M`
    : `Worldwide gross $${(movie.worldwide_gross / 1_000_000).toFixed(0)}M`;

  awardPoints(db, movie.id, 'box_office', label, pts, 'omdb');
  return pts;
}

/**
 * Score profitability.
 * Uses domestic gross vs. reported production budget (per spec rule 7.3).
 * Falls back to worldwide gross if domestic not available.
 */
function scoreProfitability(db, movie) {
  const gross  = movie.domestic_gross || movie.worldwide_gross;
  const budget = movie.tmdb_budget;
  const pts    = profitabilityPoints(gross, budget);
  if (!pts) return 0;

  const ratio = (gross / budget).toFixed(1);
  awardPoints(db, movie.id, 'profitability', `${ratio}x production budget`, pts, 'omdb+tmdb');
  return pts;
}

/**
 * Score Metacritic score.
 */
function scoreMetacritic(db, movie) {
  const pts = metacriticPoints(movie.metacritic_score);
  if (!pts) return 0;

  awardPoints(db, movie.id, 'metacritic', `Metacritic ${movie.metacritic_score}`, pts, 'omdb');
  return pts;
}

/**
 * Score CinemaScore (manually entered by commissioner).
 */
function scoreCinemaScore(db, movie) {
  const pts = cinemaScorePoints(movie.cinema_score);
  if (!pts) return 0;

  awardPoints(db, movie.id, 'cinema_score', `CinemaScore ${movie.cinema_score}`, pts, 'manual');
  return pts;
}

/**
 * Score Oscar nominations and wins for a movie.
 * Reads from the oscar_data table.
 */
function scoreOscars(db, movieId) {
  const noms = query(db, `SELECT * FROM oscar_data WHERE movie_id = ?`, [movieId]);
  let total = 0;

  for (const nom of noms) {
    // 2 pts per nomination
    const nomPts = awardPoints(
      db, movieId,
      'oscar_nom',
      `Oscar nomination: ${nom.category} (${nom.ceremony_year})`,
      2, 'oscar_json'
    );
    if (nomPts) total += 2;

    if (nom.won) {
      // 5 pts per win
      const winPts = awardPoints(
        db, movieId,
        'oscar_win',
        `Oscar win: ${nom.category} (${nom.ceremony_year})`,
        5, 'oscar_json'
      );
      if (winPts) total += 5;

      // +10 bonus for Best Picture win
      if (nom.category === 'Best Picture') {
        const bpPts = awardPoints(
          db, movieId,
          'oscar_best_picture',
          `Best Picture win bonus (${nom.ceremony_year})`,
          10, 'oscar_json'
        );
        if (bpPts) total += 10;
      }
    }
  }

  return total;
}

/**
 * Score festival/critics awards for a movie.
 * Reads from the critics_awards table.
 */
function scoreFestivalAwards(db, movieId) {
  const awards = query(db, `SELECT * FROM critics_awards WHERE movie_id = ?`, [movieId]);
  let total = 0;

  for (const award of awards) {
    const awarded = awardPoints(
      db, movieId,
      'festival_award',
      `${award.award_name} (${award.source.toUpperCase()} ${award.year})`,
      award.points,
      'scraper',
      award.source_url
    );
    if (awarded) total += award.points;
  }

  return total;
}

/**
 * Recalculate all scoring for a single movie.
 * Safe to call at any time — awardPoints is idempotent.
 *
 * @param {Object} db
 * @param {number} movieId
 * @returns {number}  total points after scoring
 */
function scoreMovie(db, movieId) {
  const movies = query(db, `SELECT * FROM movies WHERE id = ?`, [movieId]);
  if (!movies.length) {
    console.warn(`[scoring] Movie ${movieId} not found`);
    return 0;
  }

  const movie = movies[0];
  scoreBoxOffice(db, movie);
  scoreProfitability(db, movie);
  scoreMetacritic(db, movie);
  scoreCinemaScore(db, movie);
  scoreOscars(db, movieId);
  scoreFestivalAwards(db, movieId);

  const [{ total }] = query(db,
    `SELECT COALESCE(SUM(points), 0) as total FROM scoring_events WHERE movie_id = ?`,
    [movieId]
  );

  return total;
}

/**
 * Recalculate scoring for all movies in a season.
 *
 * @param {Object} db
 * @param {number} year
 */
function scoreAllMovies(db, year) {
  const movies = query(db,
    `SELECT id, title FROM movies WHERE season_year = ? AND in_draft_pool = 1`,
    [year]
  );

  console.log(`\n[scoring] Scoring ${movies.length} movies for ${year}…`);
  let totalNew = 0;

  for (const m of movies) {
    const pts = scoreMovie(db, m.id);
    if (pts > 0) totalNew++;
  }

  console.log(`[scoring] Done. ${totalNew} movies with points.`);
}

/**
 * Get a full scoring breakdown for a movie.
 * Returns point events grouped by category.
 *
 * @param {Object} db
 * @param {number} movieId
 * @returns {Object}
 */
function getScoringBreakdown(db, movieId) {
  const events = query(db,
    `SELECT category, description, points, source, awarded_at
     FROM scoring_events WHERE movie_id = ?
     ORDER BY awarded_at`,
    [movieId]
  );

  const byCategory = {};
  let total = 0;

  for (const e of events) {
    if (!byCategory[e.category]) byCategory[e.category] = { points: 0, events: [] };
    byCategory[e.category].points += e.points;
    byCategory[e.category].events.push(e);
    total += e.points;
  }

  return { total, byCategory };
}

module.exports = {
  scoreMovie,
  scoreAllMovies,
  getScoringBreakdown,
  awardPoints,
  // export point calculators for testing
  boxOfficePoints,
  profitabilityPoints,
  metacriticPoints,
  cinemaScorePoints,
};
