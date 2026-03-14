/**
 * sync/scoring.js
 * Scoring engine — async version for Turso.
 */

const { query, run } = require('../db/schema');

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
  if (s === 'A' || s === 'A-') return 3;
  return 0;
}

async function awardPoints(db, movieId, category, description, points, source, sourceRef = null) {
  if (points === 0) return false;

  const existing = await query(db,
    `SELECT id FROM scoring_events WHERE movie_id = ? AND category = ? AND description = ?`,
    [movieId, category, description]
  );
  if (existing.length > 0) return false;

  await run(db,
    `INSERT INTO scoring_events (movie_id, category, description, points, source, source_ref)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [movieId, category, description, points, source, sourceRef]
  );

  await run(db,
    `UPDATE movies SET total_points = (
       SELECT COALESCE(SUM(points), 0) FROM scoring_events WHERE movie_id = ?
     ), updated_at = datetime('now') WHERE id = ?`,
    [movieId, movieId]
  );

  console.log(`[scoring] +${points} pts → movie ${movieId} (${category}: ${description})`);
  return true;
}

async function scoreBoxOffice(db, movie) {
  const gross = movie.domestic_gross || movie.worldwide_gross;
  const pts   = boxOfficePoints(gross);
  if (!pts) return 0;
  const label = movie.domestic_gross
    ? `Domestic gross $${(movie.domestic_gross / 1_000_000).toFixed(0)}M`
    : `Worldwide gross $${(movie.worldwide_gross / 1_000_000).toFixed(0)}M`;
  await awardPoints(db, movie.id, 'box_office', label, pts, 'omdb');
  return pts;
}

async function scoreProfitability(db, movie) {
  const gross  = movie.domestic_gross || movie.worldwide_gross;
  const budget = movie.tmdb_budget;
  const pts    = profitabilityPoints(gross, budget);
  if (!pts) return 0;
  const ratio = (gross / budget).toFixed(1);
  await awardPoints(db, movie.id, 'profitability', `${ratio}x production budget`, pts, 'omdb+tmdb');
  return pts;
}

async function scoreMetacritic(db, movie) {
  const pts = metacriticPoints(movie.metacritic_score);
  if (!pts) return 0;
  await awardPoints(db, movie.id, 'metacritic', `Metacritic ${movie.metacritic_score}`, pts, 'omdb');
  return pts;
}

async function scoreCinemaScore(db, movie) {
  const pts = cinemaScorePoints(movie.cinema_score);
  if (!pts) return 0;
  await awardPoints(db, movie.id, 'cinema_score', `CinemaScore ${movie.cinema_score}`, pts, 'manual');
  return pts;
}

async function scoreOscars(db, movieId) {
  const noms = await query(db, `SELECT * FROM oscar_data WHERE movie_id = ?`, [movieId]);
  let total = 0;
  for (const nom of noms) {
    const nomAwarded = await awardPoints(db, movieId, 'oscar_nom',
      `Oscar nomination: ${nom.category} (${nom.ceremony_year})`, 2, 'oscar_json');
    if (nomAwarded) total += 2;
    if (nom.won) {
      const winAwarded = await awardPoints(db, movieId, 'oscar_win',
        `Oscar win: ${nom.category} (${nom.ceremony_year})`, 5, 'oscar_json');
      if (winAwarded) total += 5;
      if (nom.category === 'Best Picture') {
        const bpAwarded = await awardPoints(db, movieId, 'oscar_best_picture',
          `Best Picture win bonus (${nom.ceremony_year})`, 10, 'oscar_json');
        if (bpAwarded) total += 10;
      }
    }
  }
  return total;
}

async function scoreFestivalAwards(db, movieId) {
  const awards = await query(db, `SELECT * FROM critics_awards WHERE movie_id = ?`, [movieId]);
  let total = 0;
  for (const award of awards) {
    const awarded = await awardPoints(db, movieId, 'festival_award',
      `${award.award_name} (${award.source.toUpperCase()} ${award.year})`,
      award.points, 'scraper', award.source_url);
    if (awarded) total += award.points;
  }
  return total;
}

async function scoreMovie(db, movieId) {
  const movies = await query(db, `SELECT * FROM movies WHERE id = ?`, [movieId]);
  if (!movies.length) {
    console.warn(`[scoring] Movie ${movieId} not found`);
    return 0;
  }
  const movie = movies[0];
  await scoreBoxOffice(db, movie);
  await scoreProfitability(db, movie);
  await scoreMetacritic(db, movie);
  await scoreCinemaScore(db, movie);
  await scoreOscars(db, movieId);
  await scoreFestivalAwards(db, movieId);

  const rows = await query(db,
    `SELECT COALESCE(SUM(points), 0) as total FROM scoring_events WHERE movie_id = ?`,
    [movieId]
  );
  return rows[0].total;
}

async function scoreAllMovies(db, year) {
  const movies = await query(db,
    `SELECT id, title FROM movies WHERE season_year = ? AND in_draft_pool = 1`, [year]);
  console.log(`\n[scoring] Scoring ${movies.length} movies for ${year}…`);
  let totalNew = 0;
  for (const m of movies) {
    const pts = await scoreMovie(db, m.id);
    if (pts > 0) totalNew++;
  }
  console.log(`[scoring] Done. ${totalNew} movies with points.`);
}

async function getScoringBreakdown(db, movieId) {
  const events = await query(db,
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
  scoreMovie, scoreAllMovies, getScoringBreakdown, awardPoints,
  boxOfficePoints, profitabilityPoints, metacriticPoints, cinemaScorePoints,
};
