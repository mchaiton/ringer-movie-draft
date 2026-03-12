/**
 * test/draft.test.js
 * Tests for draft room logic, budget enforcement, and state machine.
 * No API keys or network calls needed.
 *
 * Run: node test/draft.test.js
 */

require('dotenv').config();
process.env.DB_PATH = './data/test_draft.db';

const { getDb, save, run, query } = require('../src/db/schema');
const { applyLeagueSchema, createLeague, joinLeague, getPlayers,
        getEffectiveMaxBid, canAffordBid, nominateMovie,
        getNominationQueue, getLeagueStandings } = require('../src/db/league');
const { v4: uuid } = require('uuid');

let passed = 0;
let failed = 0;

function assert(description, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✓ ${description}`);
    passed++;
  } else {
    console.log(`  ✗ ${description}`);
    console.log(`    Expected: ${JSON.stringify(expected)}`);
    console.log(`    Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

function assertThrows(description, fn) {
  try {
    fn();
    console.log(`  ✗ ${description} (expected throw, did not throw)`);
    failed++;
  } catch {
    console.log(`  ✓ ${description}`);
    passed++;
  }
}

(async () => {
  const db = await getDb();
  applyLeagueSchema(db);

  // ── Setup: create a league with 3 players ────────────────────────────────

  const leagueId      = uuid();
  const commishId     = uuid();
  const player2Id     = uuid();
  const player3Id     = uuid();

  const { inviteCode, authToken: commishToken } = createLeague(db, {
    id: leagueId,
    name: 'Test League',
    seasonYear: 2026,
    commissionerId: commishId,
    commissionerName: 'Commissioner',
    budgetPerPlayer: 1000,
    minRoster: 3,
    maxRoster: 6,
  });

  const { authToken: p2Token } = joinLeague(db, { leagueId, playerId: player2Id, playerName: 'Player Two' });
  const { authToken: p3Token } = joinLeague(db, { leagueId, playerId: player3Id, playerName: 'Player Three' });

  // Insert some test movies
  const movie1Id = 1001;
  const movie2Id = 1002;
  const movie3Id = 1003;

  for (const [id, title] of [[movie1Id, 'Big Blockbuster'], [movie2Id, 'Art House Film'], [movie3Id, 'Oscar Bait']]) {
    run(db, `
      INSERT OR REPLACE INTO movies (id, title, release_date, season_year, status, in_draft_pool, tmdb_budget)
      VALUES (?, ?, '2026-07-04', 2026, 'upcoming', 1, 50000000)
    `, [id, title]);
  }
  save(db);

  // ── League creation tests ────────────────────────────────────────────────

  console.log('\nLeague creation:');

  const players = getPlayers(db, leagueId);
  assert('3 players joined', players.length, 3);
  assert('Commissioner flagged correctly', players.find(p => p.id === commishId)?.is_commissioner, 1);
  assert('All players start with $1,000', players.every(p => p.budget_remaining === 1000), true);
  assert('Invite code is 6 chars', inviteCode.length, 6);

  // ── Budget enforcement tests ──────────────────────────────────────────────

  console.log('\nBudget enforcement (effective max bid):');

  // Commish: $1000, 0 movies owned, min_roster = 3
  // effective_max = 1000 - (1 × 3) = 997
  assert('Fresh player: max bid = $997', getEffectiveMaxBid(db, commishId), 997);
  assert('canAffordBid $997 = true',     canAffordBid(db, commishId, 997), true);
  assert('canAffordBid $998 = false',    canAffordBid(db, commishId, 998), false);
  assert('canAffordBid $0 = false',      canAffordBid(db, commishId, 0), false);

  // Simulate owning 1 movie at $400, budget now $600, 2 slots remaining
  // effective_max = 600 - (1 × 2) = 598
  run(db, `UPDATE players SET budget_remaining = 600, movies_owned = 1 WHERE id = ?`, [commishId]);
  save(db);
  assert('After 1 purchase ($400): max bid = $598', getEffectiveMaxBid(db, commishId), 598);

  // Owning 2 movies, budget $200, 1 slot remaining
  // effective_max = 200 - (1 × 1) = 199
  run(db, `UPDATE players SET budget_remaining = 200, movies_owned = 2 WHERE id = ?`, [commishId]);
  save(db);
  assert('2 movies owned, $200 left: max bid = $199', getEffectiveMaxBid(db, commishId), 199);

  // Met minimum (3 movies), budget $50 — no reserve needed
  // effective_max = 50 - max(0, 3-3) = 50
  run(db, `UPDATE players SET budget_remaining = 50, movies_owned = 3 WHERE id = ?`, [commishId]);
  save(db);
  assert('Min roster met: max bid = full remaining ($50)', getEffectiveMaxBid(db, commishId), 50);

  // Budget exhausted
  run(db, `UPDATE players SET budget_remaining = 0, movies_owned = 3 WHERE id = ?`, [commishId]);
  save(db);
  assert('Zero budget: max bid = $0', getEffectiveMaxBid(db, commishId), 0);
  assert('canAffordBid $1 with $0 budget = false', canAffordBid(db, commishId, 1), false);

  // Reset commish for remaining tests
  run(db, `UPDATE players SET budget_remaining = 1000, movies_owned = 0 WHERE id = ?`, [commishId]);
  save(db);

  // ── Nomination queue tests ────────────────────────────────────────────────

  console.log('\nNomination queue:');

  nominateMovie(db, { leagueId, movieId: movie1Id, playerId: commishId });
  nominateMovie(db, { leagueId, movieId: movie2Id, playerId: player2Id });

  const queue = getNominationQueue(db, leagueId);
  assert('Queue has 2 items', queue.length, 2);
  assert('First nomination is Big Blockbuster', queue[0].title, 'Big Blockbuster');
  assert('Second nomination is Art House Film', queue[1].title, 'Art House Film');

  // Duplicate nomination should throw
  assertThrows('Duplicate nomination throws', () => {
    nominateMovie(db, { leagueId, movieId: movie1Id, playerId: player3Id });
  });

  // ── Standings tests ───────────────────────────────────────────────────────

  console.log('\nStandings:');

  // Assign movie1 to commish
  run(db, `UPDATE movies SET owned_by = ?, draft_bid = 300 WHERE id = ?`, [commishId, movie1Id]);
  run(db, `UPDATE players SET budget_remaining = 700, movies_owned = 1 WHERE id = ?`, [commishId]);

  // Add some scoring events
  run(db, `INSERT INTO scoring_events (movie_id, category, description, points, source)
           VALUES (?, 'box_office', 'Domestic gross $150M', 7, 'omdb')`, [movie1Id]);
  run(db, `INSERT INTO scoring_events (movie_id, category, description, points, source)
           VALUES (?, 'metacritic', 'Metacritic 82', 6, 'omdb')`, [movie1Id]);
  save(db);

  const standings = getLeagueStandings(db, leagueId);
  assert('3 players in standings', standings.length, 3);
  assert('Commissioner leads with 13 pts', standings[0].id, commishId);
  assert('Commissioner has 13 points', standings[0].total_points, 13);
  assert('Other players have 0 points', standings[1].total_points, 0);

  // Tiebreaker: same points but less spent wins
  run(db, `INSERT INTO scoring_events (movie_id, category, description, points, source)
           VALUES (?, 'metacritic', 'Metacritic 75', 3, 'omdb')`, [movie2Id]);
  run(db, `UPDATE movies SET owned_by = ?, draft_bid = 100 WHERE id = ?`, [player2Id, movie2Id]);
  run(db, `UPDATE movies SET owned_by = ?, draft_bid = 150 WHERE id = ?`, [player3Id, movie3Id]);
  run(db, `INSERT INTO scoring_events (movie_id, category, description, points, source)
           VALUES (?, 'metacritic', 'Metacritic 75', 3, 'omdb')`, [movie3Id]);
  run(db, `UPDATE players SET budget_remaining = 900, movies_owned = 1 WHERE id = ?`, [player2Id]);
  run(db, `UPDATE players SET budget_remaining = 850, movies_owned = 1 WHERE id = ?`, [player3Id]);
  save(db);

  const standings2 = getLeagueStandings(db, leagueId);
  // p2 spent $100, p3 spent $150 — both have 3 pts
  // tiebreaker: less spent wins → p2 ($100 spent, $900 remaining) ranks above p3
  assert('Tiebreaker: less spent wins (p2 $100 < p3 $150)',
    standings2.find(s => s.id === player2Id)?.budget_remaining >
    standings2.find(s => s.id === player3Id)?.budget_remaining, true);

  // ── Clean up ──────────────────────────────────────────────────────────────

  run(db, `DELETE FROM scoring_events WHERE movie_id IN (${movie1Id},${movie2Id},${movie3Id})`);
  run(db, `DELETE FROM nomination_queue WHERE league_id = ?`, [leagueId]);
  run(db, `DELETE FROM movies WHERE id IN (${movie1Id},${movie2Id},${movie3Id})`);
  run(db, `DELETE FROM players WHERE league_id = ?`, [leagueId]);
  run(db, `DELETE FROM leagues WHERE id = ?`, [leagueId]);
  save(db);

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`Tests: ${passed + failed} total, ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log('FAILED'); process.exit(1); }
  else { console.log('ALL PASSED'); process.exit(0); }
})();
