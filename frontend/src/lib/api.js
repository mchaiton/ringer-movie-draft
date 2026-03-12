/**
 * src/lib/api.js
 * Thin fetch wrapper around the Ringer Draft REST API.
 * Reads VITE_API_URL from the environment (set in .env.local).
 *
 * Auth token is stored in localStorage under 'rdr_token'.
 * All authenticated requests include: Authorization: Bearer <token>
 */

const BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001';

// ── Token storage ─────────────────────────────────────────────────────────────

export const auth = {
  getToken:   ()        => localStorage.getItem('rdr_token'),
  setToken:   (token)   => localStorage.setItem('rdr_token', token),
  getLeague:  ()        => JSON.parse(localStorage.getItem('rdr_league') || 'null'),
  setLeague:  (league)  => localStorage.setItem('rdr_league', JSON.stringify(league)),
  getPlayer:  ()        => JSON.parse(localStorage.getItem('rdr_player') || 'null'),
  setPlayer:  (player)  => localStorage.setItem('rdr_player', JSON.stringify(player)),
  clear:      ()        => { localStorage.removeItem('rdr_token'); localStorage.removeItem('rdr_league'); localStorage.removeItem('rdr_player'); },
  isLoggedIn: ()        => !!localStorage.getItem('rdr_token'),
};

// ── Core fetch helper ─────────────────────────────────────────────────────────

async function request(method, path, body, authenticated = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (authenticated) {
    const token = auth.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const get    = (path, auth = true) => request('GET',    path, null, auth);
const post   = (path, body, auth = true) => request('POST',   path, body, auth);
const patch  = (path, body) => request('PATCH',  path, body);
const del    = (path) => request('DELETE', path);

// ── League ────────────────────────────────────────────────────────────────────

export const leagueApi = {
  /** Create a new league. Returns { leagueId, inviteCode, authToken } */
  create: ({ name, seasonYear, commissionerName, budgetPerPlayer, minRoster, maxRoster }) =>
    post('/api/leagues', { name, seasonYear, commissionerName, budgetPerPlayer, minRoster, maxRoster }, false),

  /** Join via invite code. Returns { leagueId, leagueName, playerId, authToken } */
  join: (inviteCode, playerName) =>
    post(`/api/leagues/join/${inviteCode}`, { playerName }, false),

  /** Full league data for the authenticated player */
  get: (leagueId) => get(`/api/leagues/${leagueId}`),

  /** Public standings (no auth required) */
  standings: (leagueId) => get(`/api/leagues/${leagueId}/standings`, false),

  /** Public roster for share page (no auth required) */
  roster: (leagueId, playerId) => get(`/api/leagues/${leagueId}/roster/${playerId}`, false),

  /** Movie pool with optional ?status= and ?search= filters */
  pool: (leagueId, { status, search } = {}) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (search) params.set('search', search);
    const qs = params.toString() ? `?${params}` : '';
    return get(`/api/leagues/${leagueId}/pool${qs}`);
  },

  /** Movie detail */
  movie: (leagueId, movieId) => get(`/api/leagues/${leagueId}/movies/${movieId}`),

  /** Nominate a movie for auction */
  nominate: (leagueId, movieId) =>
    post(`/api/leagues/${leagueId}/nominate`, { movieId }),

  /** Nomination queue */
  queue: (leagueId) => get(`/api/leagues/${leagueId}/queue`),

  /** Scoring feed */
  feed: (leagueId) => get(`/api/leagues/${leagueId}/feed`),

  // Commissioner only
  update: (leagueId, data) => patch(`/api/leagues/${leagueId}`, data),
  addMovie: (leagueId, tmdbId) => post(`/api/leagues/${leagueId}/pool/add`, { tmdbId }),
  removeMovie: (leagueId, movieId) => del(`/api/leagues/${leagueId}/pool/${movieId}`),
  cinemaScore: (leagueId, movieId, cinemaScore) =>
    post(`/api/leagues/${leagueId}/cinema-score`, { movieId, cinemaScore }),
};

// ── Draft sessions ─────────────────────────────────────────────────────────────

export const draftApi = {
  /** Create a draft session (commissioner only). Returns { sessionId } */
  createSession: (scheduledAt) =>
    post('/api/draft/sessions', { scheduledAt }),

  /** Get session metadata */
  getSession: (sessionId) => get(`/api/draft/sessions/${sessionId}`),

  /** Full bid history for a completed session */
  history: (sessionId) => get(`/api/draft/sessions/${sessionId}/history`),
};

// ── Health check ──────────────────────────────────────────────────────────────

export const healthCheck = () => get('/health', false);
