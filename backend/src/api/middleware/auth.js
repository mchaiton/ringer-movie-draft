/**
 * api/middleware/auth.js
 * Token-based auth middleware. Now fully async for Turso compatibility.
 */

const { getPlayerByToken, getLeague } = require('../../db/league');

async function requirePlayer(req, res, next) {
  const token =
    req.headers.authorization?.replace('Bearer ', '').trim() ||
    req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Include your auth token.' });
  }

  const db = req.app.get('db');
  const player = await getPlayerByToken(db, token);

  if (!player) {
    return res.status(401).json({ error: 'Invalid token.' });
  }

  const league = await getLeague(db, player.league_id);
  req.player = player;
  req.league = league;
  next();
}

async function requireCommissioner(req, res, next) {
  await requirePlayer(req, res, async () => {
    if (!req.player.is_commissioner) {
      return res.status(403).json({ error: 'Commissioner access required.' });
    }
    next();
  });
}

module.exports = { requirePlayer, requireCommissioner };
