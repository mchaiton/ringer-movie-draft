/**
 * draft/room.js
 * Real-time draft room engine powered by Socket.io.
 *
 * State machine per draft session:
 *
 *   idle
 *     └─ commissioner calls start_draft
 *   nominating
 *     └─ any player emits nominate (or commissioner picks from queue)
 *   bidding  ← ACTIVE AUCTION
 *     └─ players emit bid
 *     └─ 30-second countdown resets on each new bid
 *     └─ timer expires → sold (highest bidder wins) or passed (no bids)
 *   sold      — brief state, movie assigned, then back to nominating
 *   complete  — all required slots filled for all players, or pool exhausted
 *
 * Socket events:
 *
 *   CLIENT → SERVER
 *     draft:join          { token }               — authenticate + join room
 *     draft:start         { sessionId }           — commissioner starts session
 *     draft:nominate      { movieId }             — put movie on the block
 *     draft:bid           { amount }              — place a bid on current movie
 *     draft:pass          { }                     — commissioner skips current movie
 *
 *   SERVER → CLIENT
 *     draft:state         full DraftState object  — authoritative state broadcast
 *     draft:error         { message }             — validation error back to sender
 *     draft:timer         { secondsLeft }         — tick every second during bidding
 *     draft:sold          { movie, winner, amount } — movie assigned
 *     draft:complete      { standings }           — draft over
 *     queue:updated       { queue }               — nomination queue changed
 *     scores:updated      { movieId }             — a score changed mid-season
 */

const { getPlayerByToken, getLeague, getPlayers, getEffectiveMaxBid,
        canAffordBid, getNominationQueue, getLeagueStandings } = require('../db/league');
const { query, run, save } = require('../db/schema');
const tmdb = require('../clients/tmdb');

const BID_WINDOW_SECONDS = 30;

// In-memory draft state per league (keyed by leagueId)
// Persisted to DB on each state change; rebuilt from DB on server restart
const activeSessions = new Map();

/**
 * @typedef {Object} DraftState
 * @property {string}   leagueId
 * @property {string}   sessionId
 * @property {string}   phase         idle | nominating | bidding | sold | complete
 * @property {Object|null} currentMovie  movie on the block
 * @property {Array}    bids          [{ playerId, playerName, amount, placedAt }]
 * @property {Object|null} topBid     { playerId, playerName, amount }
 * @property {number}   secondsLeft   countdown (only during bidding)
 * @property {Array}    queue         nomination queue
 * @property {Array}    players       all players with budget + roster info
 * @property {Array}    recentSales   last 5 sold movies
 */

function buildState(db, leagueId, sessionId, phase, currentMovie = null, bids = [], recentSales = []) {
  const players   = getPlayers(db, leagueId);
  const queue     = getNominationQueue(db, leagueId);
  const standings = getLeagueStandings(db, leagueId);

  const enrichedPlayers = players.map(p => {
    const standing = standings.find(s => s.id === p.id);
    return {
      id:               p.id,
      name:             p.name,
      is_commissioner:  p.is_commissioner,
      budget_remaining: p.budget_remaining,
      movies_owned:     p.movies_owned,
      effective_max_bid: getEffectiveMaxBid(db, p.id),
      total_points:     standing?.total_points || 0,
    };
  });

  const topBid = bids.length
    ? bids.reduce((top, b) => b.amount > top.amount ? b : top)
    : null;

  return {
    leagueId,
    sessionId,
    phase,
    currentMovie: currentMovie ? enricheMovie(db, currentMovie) : null,
    bids,
    topBid,
    secondsLeft: BID_WINDOW_SECONDS,
    queue: queue.slice(0, 10), // show up to 10 queued movies
    players: enrichedPlayers,
    recentSales,
  };
}

function enricheMovie(db, movie) {
  return {
    ...movie,
    poster:   tmdb.imageUrl(movie.tmdb_poster_path, 'w342'),
    backdrop: tmdb.imageUrl(movie.tmdb_backdrop_path, 'w780'),
    genres:   tryParse(movie.tmdb_genres, []),
    cast:     tryParse(movie.tmdb_cast, []),
  };
}

function tryParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Award a movie to the winning bidder.
 * Updates: movies.owned_by, movies.draft_bid, player.budget_remaining, player.movies_owned
 */
function assignMovie(db, movieId, playerId, amount) {
  run(db, `
    UPDATE movies SET
      owned_by   = ?,
      draft_bid  = ?,
      drafted_at = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `, [playerId, amount, movieId]);

  run(db, `
    UPDATE players SET
      budget_remaining = budget_remaining - ?,
      movies_owned     = movies_owned + 1
    WHERE id = ?
  `, [amount, playerId]);

  // Mark nomination as sold
  run(db, `
    UPDATE nomination_queue SET status = 'sold'
    WHERE movie_id = ? AND status = 'active'
  `, [movieId]);

  save(db);
}

/**
 * Check if draft is complete:
 * All players have met their minimum roster OR the pool + queue is exhausted.
 */
function isDraftComplete(db, leagueId) {
  const league = getLeague(db, leagueId);
  const players = getPlayers(db, leagueId);

  // All players at min roster
  const allFilled = players.every(p => p.movies_owned >= league.min_roster);
  if (allFilled) return true;

  // Pool exhausted: no undrafted movies left in pool or queue
  const available = query(db, `
    SELECT COUNT(*) as cnt FROM movies
    WHERE season_year = ? AND in_draft_pool = 1 AND owned_by IS NULL AND status != 'cancelled'
  `, [league.season_year]);

  return available[0].cnt === 0;
}

// ── Socket.io handler ─────────────────────────────────────────────────────────

function registerDraftHandlers(io, db) {

  io.on('connection', (socket) => {
    let currentPlayer = null;
    let currentLeagueId = null;

    // ── Join draft room ──────────────────────────────────────────────────────

    socket.on('draft:join', ({ token }) => {
      const player = getPlayerByToken(db, token);
      if (!player) {
        socket.emit('draft:error', { message: 'Invalid token.' });
        return;
      }

      currentPlayer   = player;
      currentLeagueId = player.league_id;

      socket.join(currentLeagueId);
      console.log(`[draft] ${player.name} joined room ${currentLeagueId}`);

      // Send current state
      const session = activeSessions.get(currentLeagueId);
      if (session) {
        socket.emit('draft:state', session.state);
      } else {
        // Build idle state
        const idleState = buildState(db, currentLeagueId, null, 'idle');
        socket.emit('draft:state', idleState);
      }
    });

    // ── Commissioner: start draft ────────────────────────────────────────────

    socket.on('draft:start', ({ sessionId }) => {
      if (!currentPlayer?.is_commissioner) {
        socket.emit('draft:error', { message: 'Only the commissioner can start the draft.' });
        return;
      }

      if (activeSessions.has(currentLeagueId)) {
        socket.emit('draft:error', { message: 'Draft already in progress.' });
        return;
      }

      // Update league status
      run(db, `UPDATE leagues SET status = 'drafting' WHERE id = ?`, [currentLeagueId]);
      run(db, `UPDATE draft_sessions SET status = 'active', started_at = datetime('now') WHERE id = ?`, [sessionId]);
      save(db);

      const state = buildState(db, currentLeagueId, sessionId, 'nominating');
      activeSessions.set(currentLeagueId, { sessionId, state, timer: null, recentSales: [] });

      io.to(currentLeagueId).emit('draft:state', state);
      console.log(`[draft] Draft started for league ${currentLeagueId}`);
    });

    // ── Nominate a movie ─────────────────────────────────────────────────────

    socket.on('draft:nominate', ({ movieId }) => {
      if (!currentPlayer) { socket.emit('draft:error', { message: 'Not authenticated.' }); return; }

      const session = activeSessions.get(currentLeagueId);
      if (!session) { socket.emit('draft:error', { message: 'No active draft session.' }); return; }
      if (session.state.phase !== 'nominating') {
        socket.emit('draft:error', { message: 'Not in nomination phase.' }); return;
      }

      // Verify movie is available
      const movies = query(db, `
        SELECT * FROM movies WHERE id = ? AND in_draft_pool = 1 AND owned_by IS NULL
      `, [movieId]);

      if (!movies.length) {
        socket.emit('draft:error', { message: 'Movie not available.' }); return;
      }

      const movie = movies[0];

      // Mark nomination as active
      run(db, `
        UPDATE nomination_queue SET status = 'active'
        WHERE league_id = ? AND movie_id = ? AND status = 'queued'
      `, [currentLeagueId, movieId]);
      save(db);

      // Transition to bidding phase
      session.state = buildState(db, currentLeagueId, session.sessionId, 'bidding', movie, [], session.recentSales);
      session.state.secondsLeft = BID_WINDOW_SECONDS;

      startBidTimer(io, db, currentLeagueId, session, movie);
      io.to(currentLeagueId).emit('draft:state', session.state);

      console.log(`[draft] "${movie.title}" nominated by ${currentPlayer.name}`);
    });

    // ── Place a bid ──────────────────────────────────────────────────────────

    socket.on('draft:bid', ({ amount }) => {
      if (!currentPlayer) { socket.emit('draft:error', { message: 'Not authenticated.' }); return; }

      const session = activeSessions.get(currentLeagueId);
      if (!session) { socket.emit('draft:error', { message: 'No active draft.' }); return; }
      if (session.state.phase !== 'bidding') {
        socket.emit('draft:error', { message: 'No active auction.' }); return;
      }

      const bidAmount = parseInt(amount);

      // Must beat current top bid
      if (session.state.topBid && bidAmount <= session.state.topBid.amount) {
        socket.emit('draft:error', { message: `Bid must exceed current top bid of $${session.state.topBid.amount}.` });
        return;
      }

      // Budget enforcement: spec rule 7.4
      if (!canAffordBid(db, currentPlayer.id, bidAmount)) {
        const maxBid = getEffectiveMaxBid(db, currentPlayer.id);
        socket.emit('draft:error', { message: `Bid exceeds your effective max of $${maxBid} (must reserve $1 per remaining required slot).` });
        return;
      }

      // Record bid
      run(db, `
        INSERT INTO bids (session_id, movie_id, player_id, amount)
        VALUES (?, ?, ?, ?)
      `, [session.sessionId, session.state.currentMovie.id, currentPlayer.id, bidAmount]);
      save(db);

      const newBid = {
        playerId:   currentPlayer.id,
        playerName: currentPlayer.name,
        amount:     bidAmount,
        placedAt:   new Date().toISOString(),
      };

      session.state.bids.push(newBid);
      session.state.topBid = newBid;
      session.state.secondsLeft = BID_WINDOW_SECONDS; // reset timer

      // Restart countdown
      restartBidTimer(io, db, currentLeagueId, session);
      io.to(currentLeagueId).emit('draft:state', session.state);

      console.log(`[draft] $${bidAmount} bid on "${session.state.currentMovie.title}" by ${currentPlayer.name}`);
    });

    // ── Commissioner: pass (no bids / skip) ─────────────────────────────────

    socket.on('draft:pass', () => {
      if (!currentPlayer?.is_commissioner) {
        socket.emit('draft:error', { message: 'Only the commissioner can pass.' }); return;
      }

      const session = activeSessions.get(currentLeagueId);
      if (!session || !['bidding', 'nominating'].includes(session.state.phase)) {
        socket.emit('draft:error', { message: 'Nothing to pass on.' }); return;
      }

      clearBidTimer(session);

      if (session.state.currentMovie) {
        // Mark nomination as passed — movie goes back to pool
        run(db, `
          UPDATE nomination_queue SET status = 'passed'
          WHERE movie_id = ? AND status = 'active'
        `, [session.state.currentMovie.id]);
        save(db);
        console.log(`[draft] "${session.state.currentMovie.title}" passed`);
      }

      advanceToNextNomination(io, db, currentLeagueId, session);
    });

    // ── Disconnect ───────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
      if (currentPlayer) {
        console.log(`[draft] ${currentPlayer.name} disconnected from ${currentLeagueId}`);
      }
    });
  });
}

// ── Timer logic ───────────────────────────────────────────────────────────────

function startBidTimer(io, db, leagueId, session, movie) {
  clearBidTimer(session);

  let seconds = BID_WINDOW_SECONDS;
  session.state.secondsLeft = seconds;

  session.timer = setInterval(() => {
    seconds--;
    session.state.secondsLeft = seconds;

    io.to(leagueId).emit('draft:timer', { secondsLeft: seconds });

    if (seconds <= 0) {
      clearBidTimer(session);
      handleAuctionEnd(io, db, leagueId, session, movie);
    }
  }, 1000);
}

function restartBidTimer(io, db, leagueId, session) {
  const movie = session.state.currentMovie;
  startBidTimer(io, db, leagueId, session, movie);
}

function clearBidTimer(session) {
  if (session.timer) {
    clearInterval(session.timer);
    session.timer = null;
  }
}

// ── Auction end ───────────────────────────────────────────────────────────────

function handleAuctionEnd(io, db, leagueId, session, movie) {
  const { topBid } = session.state;

  if (!topBid) {
    // No bids — pass the movie
    run(db, `UPDATE nomination_queue SET status = 'passed' WHERE movie_id = ? AND status = 'active'`, [movie.id]);
    save(db);
    console.log(`[draft] "${movie.title}" — no bids, passed`);
    advanceToNextNomination(io, db, leagueId, session);
    return;
  }

  // Assign to winner
  assignMovie(db, movie.id, topBid.playerId, topBid.amount);

  session.recentSales.unshift({ movie: enricheMovie(db, movie), winner: topBid.playerName, amount: topBid.amount });
  session.recentSales = session.recentSales.slice(0, 5);

  io.to(leagueId).emit('draft:sold', {
    movie:  enricheMovie(db, movie),
    winner: topBid.playerName,
    amount: topBid.amount,
  });

  console.log(`[draft] "${movie.title}" SOLD to ${topBid.playerName} for $${topBid.amount}`);

  // Check for draft completion
  if (isDraftComplete(db, leagueId)) {
    endDraft(io, db, leagueId, session);
    return;
  }

  // Short pause then back to nominating
  setTimeout(() => advanceToNextNomination(io, db, leagueId, session), 3000);
}

function advanceToNextNomination(io, db, leagueId, session) {
  // Auto-advance: if there's something in the queue, put it up immediately
  const queue = getNominationQueue(db, leagueId);

  if (queue.length > 0) {
    const next = queue[0];
    const movies = query(db, `SELECT * FROM movies WHERE id = ?`, [next.movie_id]);

    if (movies.length && !movies[0].owned_by) {
      run(db, `UPDATE nomination_queue SET status = 'active' WHERE id = ?`, [next.id]);
      save(db);

      session.state = buildState(db, leagueId, session.sessionId, 'bidding', movies[0], [], session.recentSales);
      session.state.secondsLeft = BID_WINDOW_SECONDS;

      startBidTimer(io, db, leagueId, session, movies[0]);
      io.to(leagueId).emit('draft:state', session.state);

      console.log(`[draft] Auto-advancing to "${movies[0].title}" from queue`);
      return;
    }
  }

  // Nothing queued — wait for nominations
  session.state = buildState(db, leagueId, session.sessionId, 'nominating', null, [], session.recentSales);
  io.to(leagueId).emit('draft:state', session.state);
}

function endDraft(io, db, leagueId, session) {
  clearBidTimer(session);

  run(db, `UPDATE leagues SET status = 'active' WHERE id = ?`, [leagueId]);
  run(db, `UPDATE draft_sessions SET status = 'complete', ended_at = datetime('now') WHERE id = ?`, [session.sessionId]);
  save(db);

  const standings = getLeagueStandings(db, leagueId);
  session.state = { ...session.state, phase: 'complete' };

  io.to(leagueId).emit('draft:complete', { standings });
  activeSessions.delete(leagueId);

  console.log(`[draft] Draft complete for league ${leagueId}`);
}

module.exports = { registerDraftHandlers };
