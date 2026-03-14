/**
 * draft/room.js
 * Real-time draft room engine — async Turso version.
 */

const { getPlayerByToken, getLeague, getPlayers, getEffectiveMaxBid,
        canAffordBid, getNominationQueue, getLeagueStandings } = require('../db/league');
const { query, run, save } = require('../db/schema');
const tmdb = require('../clients/tmdb');

const BID_WINDOW_SECONDS = 30;
const activeSessions = new Map();

async function buildState(db, leagueId, sessionId, phase, currentMovie = null, bids = [], recentSales = []) {
  const [players, queue, standings] = await Promise.all([
    getPlayers(db, leagueId),
    getNominationQueue(db, leagueId),
    getLeagueStandings(db, leagueId),
  ]);

  const enrichedPlayers = await Promise.all(players.map(async p => {
    const standing = standings.find(s => s.id === p.id);
    return {
      id: p.id, name: p.name, is_commissioner: p.is_commissioner,
      budget_remaining: p.budget_remaining, movies_owned: p.movies_owned,
      effective_max_bid: await getEffectiveMaxBid(db, p.id),
      total_points: standing?.total_points || 0,
    };
  }));

  const topBid = bids.length ? bids.reduce((top, b) => b.amount > top.amount ? b : top) : null;

  return {
    leagueId, sessionId, phase,
    currentMovie: currentMovie ? enrichMovie(db, currentMovie) : null,
    bids, topBid, secondsLeft: BID_WINDOW_SECONDS,
    queue: queue.slice(0, 10),
    players: enrichedPlayers, recentSales,
  };
}

function enrichMovie(db, movie) {
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

async function assignMovie(db, movieId, playerId, amount) {
  await run(db, `UPDATE movies SET owned_by = ?, draft_bid = ?, drafted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`, [playerId, amount, movieId]);
  await run(db, `UPDATE players SET budget_remaining = budget_remaining - ?, movies_owned = movies_owned + 1 WHERE id = ?`, [amount, playerId]);
  await run(db, `UPDATE nomination_queue SET status = 'sold' WHERE movie_id = ? AND status = 'active'`, [movieId]);
}

async function isDraftComplete(db, leagueId) {
  const league  = await getLeague(db, leagueId);
  const players = await getPlayers(db, leagueId);
  if (players.every(p => p.movies_owned >= league.min_roster)) return true;
  const rows = await query(db, `SELECT COUNT(*) as cnt FROM movies WHERE season_year = ? AND in_draft_pool = 1 AND owned_by IS NULL AND status != 'cancelled'`, [league.season_year]);
  return rows[0].cnt === 0;
}

function registerDraftHandlers(io, db) {
  io.on('connection', (socket) => {
    let currentPlayer   = null;
    let currentLeagueId = null;

    socket.on('draft:join', async ({ token }) => {
      try {
        const player = await getPlayerByToken(db, token);
        if (!player) { socket.emit('draft:error', { message: 'Invalid token.' }); return; }
        currentPlayer   = player;
        currentLeagueId = player.league_id;
        socket.join(currentLeagueId);
        console.log(`[draft] ${player.name} joined room ${currentLeagueId}`);
        const session = activeSessions.get(currentLeagueId);
        if (session) {
          socket.emit('draft:state', session.state);
        } else {
          const idleState = await buildState(db, currentLeagueId, null, 'idle');
          socket.emit('draft:state', idleState);
        }
      } catch (err) { console.error('[draft] join error:', err); }
    });

    socket.on('draft:start', async ({ sessionId }) => {
      try {
        if (!currentPlayer?.is_commissioner) { socket.emit('draft:error', { message: 'Only the commissioner can start the draft.' }); return; }
        if (activeSessions.has(currentLeagueId)) { socket.emit('draft:error', { message: 'Draft already in progress.' }); return; }
        await run(db, `UPDATE leagues SET status = 'drafting' WHERE id = ?`, [currentLeagueId]);
        await run(db, `UPDATE draft_sessions SET status = 'active', started_at = datetime('now') WHERE id = ?`, [sessionId]);
        const state = await buildState(db, currentLeagueId, sessionId, 'nominating');
        activeSessions.set(currentLeagueId, { sessionId, state, timer: null, recentSales: [] });
        io.to(currentLeagueId).emit('draft:state', state);
        console.log(`[draft] Draft started for league ${currentLeagueId}`);
      } catch (err) { console.error('[draft] start error:', err); }
    });

    socket.on('draft:nominate', async ({ movieId }) => {
      try {
        if (!currentPlayer) { socket.emit('draft:error', { message: 'Not authenticated.' }); return; }
        const session = activeSessions.get(currentLeagueId);
        if (!session) { socket.emit('draft:error', { message: 'No active draft session.' }); return; }
        if (session.state.phase !== 'nominating') { socket.emit('draft:error', { message: 'Not in nomination phase.' }); return; }
        const movies = await query(db, `SELECT * FROM movies WHERE id = ? AND in_draft_pool = 1 AND owned_by IS NULL`, [movieId]);
        if (!movies.length) { socket.emit('draft:error', { message: 'Movie not available.' }); return; }
        const movie = movies[0];
        await run(db, `UPDATE nomination_queue SET status = 'active' WHERE league_id = ? AND movie_id = ? AND status = 'queued'`, [currentLeagueId, movieId]);
        session.state = await buildState(db, currentLeagueId, session.sessionId, 'bidding', movie, [], session.recentSales);
        session.state.secondsLeft = BID_WINDOW_SECONDS;
        startBidTimer(io, db, currentLeagueId, session, movie);
        io.to(currentLeagueId).emit('draft:state', session.state);
        console.log(`[draft] "${movie.title}" nominated by ${currentPlayer.name}`);
      } catch (err) { console.error('[draft] nominate error:', err); }
    });

    socket.on('draft:bid', async ({ amount }) => {
      try {
        if (!currentPlayer) { socket.emit('draft:error', { message: 'Not authenticated.' }); return; }
        const session = activeSessions.get(currentLeagueId);
        if (!session) { socket.emit('draft:error', { message: 'No active draft.' }); return; }
        if (session.state.phase !== 'bidding') { socket.emit('draft:error', { message: 'No active auction.' }); return; }
        const bidAmount = parseInt(amount);
        if (session.state.topBid && bidAmount <= session.state.topBid.amount) {
          socket.emit('draft:error', { message: `Bid must exceed current top bid of $${session.state.topBid.amount}.` }); return;
        }
        if (!await canAffordBid(db, currentPlayer.id, bidAmount)) {
          const maxBid = await getEffectiveMaxBid(db, currentPlayer.id);
          socket.emit('draft:error', { message: `Bid exceeds your effective max of $${maxBid}.` }); return;
        }
        await run(db, `INSERT INTO bids (session_id, movie_id, player_id, amount) VALUES (?, ?, ?, ?)`,
          [session.sessionId, session.state.currentMovie.id, currentPlayer.id, bidAmount]);
        const newBid = { playerId: currentPlayer.id, playerName: currentPlayer.name, amount: bidAmount, placedAt: new Date().toISOString() };
        session.state.bids.push(newBid);
        session.state.topBid = newBid;
        session.state.secondsLeft = BID_WINDOW_SECONDS;
        restartBidTimer(io, db, currentLeagueId, session);
        io.to(currentLeagueId).emit('draft:state', session.state);
        console.log(`[draft] $${bidAmount} bid on "${session.state.currentMovie.title}" by ${currentPlayer.name}`);
      } catch (err) { console.error('[draft] bid error:', err); }
    });

    socket.on('draft:pass', async () => {
      try {
        if (!currentPlayer?.is_commissioner) { socket.emit('draft:error', { message: 'Only the commissioner can pass.' }); return; }
        const session = activeSessions.get(currentLeagueId);
        if (!session || !['bidding', 'nominating'].includes(session.state.phase)) { socket.emit('draft:error', { message: 'Nothing to pass on.' }); return; }
        clearBidTimer(session);
        if (session.state.currentMovie) {
          await run(db, `UPDATE nomination_queue SET status = 'passed' WHERE movie_id = ? AND status = 'active'`, [session.state.currentMovie.id]);
          console.log(`[draft] "${session.state.currentMovie.title}" passed`);
        }
        await advanceToNextNomination(io, db, currentLeagueId, session);
      } catch (err) { console.error('[draft] pass error:', err); }
    });

    socket.on('disconnect', () => {
      if (currentPlayer) console.log(`[draft] ${currentPlayer.name} disconnected from ${currentLeagueId}`);
    });
  });
}

function startBidTimer(io, db, leagueId, session, movie) {
  clearBidTimer(session);
  let seconds = BID_WINDOW_SECONDS;
  session.state.secondsLeft = seconds;
  session.timer = setInterval(async () => {
    try {
      seconds--;
      session.state.secondsLeft = seconds;
      io.to(leagueId).emit('draft:timer', { secondsLeft: seconds });
      if (seconds <= 0) {
        clearBidTimer(session);
        await handleAuctionEnd(io, db, leagueId, session, movie);
      }
    } catch (err) { console.error('[draft] timer error:', err); }
  }, 1000);
}

function restartBidTimer(io, db, leagueId, session) {
  startBidTimer(io, db, leagueId, session, session.state.currentMovie);
}

function clearBidTimer(session) {
  if (session.timer) { clearInterval(session.timer); session.timer = null; }
}

async function handleAuctionEnd(io, db, leagueId, session, movie) {
  const { topBid } = session.state;
  if (!topBid) {
    await run(db, `UPDATE nomination_queue SET status = 'passed' WHERE movie_id = ? AND status = 'active'`, [movie.id]);
    console.log(`[draft] "${movie.title}" — no bids, passed`);
    await advanceToNextNomination(io, db, leagueId, session);
    return;
  }
  await assignMovie(db, movie.id, topBid.playerId, topBid.amount);
  session.recentSales.unshift({ movie: enrichMovie(db, movie), winner: topBid.playerName, amount: topBid.amount });
  session.recentSales = session.recentSales.slice(0, 5);
  io.to(leagueId).emit('draft:sold', { movie: enrichMovie(db, movie), winner: topBid.playerName, amount: topBid.amount });
  console.log(`[draft] "${movie.title}" SOLD to ${topBid.playerName} for $${topBid.amount}`);
  if (await isDraftComplete(db, leagueId)) { await endDraft(io, db, leagueId, session); return; }
  setTimeout(() => advanceToNextNomination(io, db, leagueId, session), 3000);
}

async function advanceToNextNomination(io, db, leagueId, session) {
  const queue = await getNominationQueue(db, leagueId);
  if (queue.length > 0) {
    const next   = queue[0];
    const movies = await query(db, `SELECT * FROM movies WHERE id = ?`, [next.movie_id]);
    if (movies.length && !movies[0].owned_by) {
      await run(db, `UPDATE nomination_queue SET status = 'active' WHERE id = ?`, [next.id]);
      session.state = await buildState(db, leagueId, session.sessionId, 'bidding', movies[0], [], session.recentSales);
      session.state.secondsLeft = BID_WINDOW_SECONDS;
      startBidTimer(io, db, leagueId, session, movies[0]);
      io.to(leagueId).emit('draft:state', session.state);
      console.log(`[draft] Auto-advancing to "${movies[0].title}" from queue`);
      return;
    }
  }
  session.state = await buildState(db, leagueId, session.sessionId, 'nominating', null, [], session.recentSales);
  io.to(leagueId).emit('draft:state', session.state);
}

async function endDraft(io, db, leagueId, session) {
  clearBidTimer(session);
  await run(db, `UPDATE leagues SET status = 'active' WHERE id = ?`, [leagueId]);
  await run(db, `UPDATE draft_sessions SET status = 'complete', ended_at = datetime('now') WHERE id = ?`, [session.sessionId]);
  const standings = await getLeagueStandings(db, leagueId);
  session.state = { ...session.state, phase: 'complete' };
  io.to(leagueId).emit('draft:complete', { standings });
  activeSessions.delete(leagueId);
  console.log(`[draft] Draft complete for league ${leagueId}`);
}

module.exports = { registerDraftHandlers };
