/**
 * api/middleware/auth.js
 * Simple token-based auth. No passwords or JWTs — players receive an auth_token
 * when they join a league (via invite link). They include it in every request.
 *
 * Header: Authorization: Bearer <token>
 *   OR
 * Query:  ?token=<token>
 *
 * Sets req.player and req.league on success.
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
  const player = getPlayerByToken(db, token);

  if (!player) {
    return res.status(401).json({ error: 'Invalid token.' });
  }

  const league = getLeague(db, player.league_id);
  req.player = player;
  req.league = league;
  next();
}

function requireCommissioner(req, res, next) {
  requirePlayer(req, res, () => {
    if (!req.player.is_commissioner) {
      return res.status(403).json({ error: 'Commissioner access required.' });
    }
    next();
  });
}

module.exports = { requirePlayer, requireCommissioner };
