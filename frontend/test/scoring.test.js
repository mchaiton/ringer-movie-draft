/**
 * test/scoring.test.js
 * Tests for the scoring engine — verifiable without API keys.
 *
 * Run with: node test/scoring.test.js
 */

const {
  boxOfficePoints,
  profitabilityPoints,
  metacriticPoints,
  cinemaScorePoints,
  scoreMovie,
  getScoringBreakdown,
} = require('../src/sync/scoring');

const { getDb, save, run, query } = require('../src/db/schema');

let passed = 0;
let failed = 0;

function assert(description, actual, expected) {
  if (actual === expected) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.log(`  ✗ ${description}`);
    console.log(`    Expected: ${expected}`);
    console.log(`    Actual:   ${actual}`);
    failed++;
  }
}

// ── Point calculator unit tests ──────────────────────────────────────────────

console.log('\nBox office points:');
assert('null gross → 0',              boxOfficePoints(null),          0);
assert('$0 → 0',                      boxOfficePoints(0),             0);
assert('$10M → 0',                    boxOfficePoints(10_000_000),    0);
assert('$25M → 3',                    boxOfficePoints(25_000_000),    3);
assert('$99M → 3',                    boxOfficePoints(99_999_999),    3);
assert('$100M → 7',                   boxOfficePoints(100_000_000),   7);
assert('$249M → 7',                   boxOfficePoints(249_999_999),   7);
assert('$250M → 12',                  boxOfficePoints(250_000_000),  12);
assert('$499M → 12',                  boxOfficePoints(499_999_999),  12);
assert('$500M → 20',                  boxOfficePoints(500_000_000),  20);
assert('$1B → 20',                    boxOfficePoints(1_000_000_000),20);

console.log('\nProfitability points:');
assert('null gross → 0',              profitabilityPoints(null, 100_000_000), 0);
assert('null budget → 0',             profitabilityPoints(100_000_000, null), 0);
assert('zero budget → 0',             profitabilityPoints(100_000_000, 0),    0);
assert('0.5x budget → 0 (loss)',      profitabilityPoints(50_000_000, 100_000_000),  0);
assert('1.5x budget → 3 (profitable)',profitabilityPoints(150_000_000, 100_000_000), 3);
assert('2x budget → 6',               profitabilityPoints(200_000_000, 100_000_000), 6);
assert('2.9x budget → 6',             profitabilityPoints(290_000_000, 100_000_000), 6);
assert('3x budget → 10',              profitabilityPoints(300_000_000, 100_000_000), 10);
assert('5x budget → 10',              profitabilityPoints(500_000_000, 100_000_000), 10);

console.log('\nMetacritic points:');
assert('null → 0',    metacriticPoints(null), 0);
assert('0 → 0',       metacriticPoints(0),    0);
assert('39 → 0',      metacriticPoints(39),   0);
assert('40 → 1',      metacriticPoints(40),   1);
assert('59 → 1',      metacriticPoints(59),   1);
assert('60 → 3',      metacriticPoints(60),   3);
assert('79 → 3',      metacriticPoints(79),   3);
assert('80 → 6',      metacriticPoints(80),   6);
assert('100 → 6',     metacriticPoints(100),  6);

console.log('\nCinemaScore points:');
assert('null → 0',    cinemaScorePoints(null),  0);
assert('"B" → 0',     cinemaScorePoints('B'),   0);
assert('"B+" → 0',    cinemaScorePoints('B+'),  0);
assert('"A-" → 3',    cinemaScorePoints('A-'),  3);
assert('"A" → 3',     cinemaScorePoints('A'),   3);
assert('"a" → 3',     cinemaScorePoints('a'),   3); // case insensitive
assert('"A+" → 6',    cinemaScorePoints('A+'),  6);
assert('" A+" → 6',   cinemaScorePoints(' A+'), 6); // whitespace trimmed

// ── Integration test: full movie scoring flow ────────────────────────────────

console.log('\nIntegration: full movie scoring:');

process.env.DB_PATH = './data/test_ringer.db';

(async () => {
  const db = await getDb();

  // Insert a test movie
  run(db, `
    INSERT OR REPLACE INTO movies (
      id, title, release_date, season_year, status,
      domestic_gross, tmdb_budget, metacritic_score, cinema_score, imdb_id
    ) VALUES (99999, 'Test Film', '2026-06-15', 2026, 'released',
      320000000, 80000000, 82, 'A', 'tt9999999')
  `);

  // Insert an Oscar nomination + win
  run(db, `
    INSERT OR REPLACE INTO oscar_data (movie_id, imdb_id, ceremony_year, category, nominees, won)
    VALUES (99999, 'tt9999999', 2027, 'Best Director', '["Jane Smith"]', 0)
  `);
  run(db, `
    INSERT OR REPLACE INTO oscar_data (movie_id, imdb_id, ceremony_year, category, nominees, won)
    VALUES (99999, 'tt9999999', 2027, 'Best Picture', '["Test Film"]', 1)
  `);

  // Insert a festival award
  run(db, `
    INSERT OR REPLACE INTO critics_awards (movie_id, source, award_name, year, won, points, source_url)
    VALUES (99999, 'cannes', "Palme d'Or", 2026, 1, 4, 'https://en.wikipedia.org/wiki/2026_Cannes_Film_Festival')
  `);

  // Score the movie
  const total = scoreMovie(db, 99999);
  const breakdown = getScoringBreakdown(db, 99999);

  // Expected:
  //   box_office:    $320M → 12 pts
  //   profitability: 4x budget → 10 pts
  //   metacritic:    82 → 6 pts
  //   cinema_score:  A → 3 pts
  //   oscar_nom:     Best Director → 2 pts
  //   oscar_nom:     Best Picture → 2 pts
  //   oscar_win:     Best Picture → 5 pts
  //   oscar_bp:      Best Picture bonus → 10 pts
  //   festival:      Palme d'Or → 4 pts
  //                             = 54 pts total

  assert('Total points = 54',            total, 54);
  assert('box_office = 12',              breakdown.byCategory.box_office?.points,         12);
  assert('profitability = 10',           breakdown.byCategory.profitability?.points,       10);
  assert('metacritic = 6',              breakdown.byCategory.metacritic?.points,           6);
  assert('cinema_score = 3',            breakdown.byCategory.cinema_score?.points,         3);
  assert('oscar_nom = 4 (2 noms)',       breakdown.byCategory.oscar_nom?.points,           4);
  assert('oscar_win = 5',               breakdown.byCategory.oscar_win?.points,            5);
  assert('oscar_best_picture = 10',     breakdown.byCategory.oscar_best_picture?.points,  10);
  assert('festival_award = 4',          breakdown.byCategory.festival_award?.points,       4);

  // Test idempotency — scoring again should not add duplicate points
  const total2 = scoreMovie(db, 99999);
  assert('Idempotent: re-scoring returns same total', total2, 54);

  // Clean up test data
  run(db, `DELETE FROM scoring_events WHERE movie_id = 99999`);
  run(db, `DELETE FROM oscar_data WHERE movie_id = 99999`);
  run(db, `DELETE FROM critics_awards WHERE movie_id = 99999`);
  run(db, `DELETE FROM movies WHERE id = 99999`);
  save(db);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('FAILED');
    process.exit(1);
  } else {
    console.log('ALL PASSED');
    process.exit(0);
  }
})();
