/**
 * clients/omdb.js
 * Wrapper around the OMDb API.
 *
 * Used for:
 *   - Domestic box office gross
 *   - Metacritic score (Metascore)
 *   - IMDb rating
 *   - IMDb ID confirmation
 *
 * Free tier: 1,000 requests/day — sufficient for weekly batch updates
 * of a ~80 movie pool.
 *
 * OMDb returns box office as a formatted string: "$123,456,789"
 * We parse it to an integer.
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.OMDB_BASE_URL || 'https://www.omdbapi.com';
const API_KEY  = process.env.OMDB_API_KEY;

if (!API_KEY || API_KEY === 'your_omdb_api_key_here') {
  console.warn('[omdb] WARNING: OMDB_API_KEY not set. Set it in .env before syncing.');
}

const client = axios.create({
  baseURL: BASE_URL,
  timeout: 8_000,
});

/**
 * Parse OMDb's formatted dollar string to integer.
 * "$123,456,789" → 123456789
 * "N/A" → null
 */
function parseDollars(str) {
  if (!str || str === 'N/A') return null;
  return parseInt(str.replace(/[$,]/g, ''), 10) || null;
}

/**
 * Parse OMDb's integer string to number.
 * "85" → 85, "N/A" → null
 */
function parseNum(str) {
  if (!str || str === 'N/A') return null;
  const n = parseFloat(str);
  return isNaN(n) ? null : n;
}

/**
 * Fetch movie data from OMDb by IMDb ID (most reliable lookup).
 *
 * @param {string} imdbId  e.g. "tt1234567"
 * @returns {Object|null}  parsed fields, or null if not found
 */
async function getByImdbId(imdbId) {
  if (!imdbId) return null;

  try {
    const res = await client.get('/', {
      params: { apikey: API_KEY, i: imdbId, plot: 'short', r: 'json' },
    });

    const d = res.data;

    if (d.Response === 'False') {
      console.warn(`[omdb] Not found: ${imdbId} — ${d.Error}`);
      return null;
    }

    return {
      imdb_id:         d.imdbID,
      domestic_gross:  parseDollars(d.BoxOffice),
      metacritic_score: parseNum(d.Metascore),
      imdb_rating:     parseNum(d.imdbRating),
      // OMDb doesn't provide worldwide gross — that requires a separate source
      // (Box Office Mojo or The Numbers). Noted for future enhancement.
      worldwide_gross: null,
    };
  } catch (err) {
    console.error(`[omdb] Request failed for ${imdbId}:`, err.message);
    return null;
  }
}

/**
 * Fetch movie data from OMDb by title + year (fallback when IMDb ID unknown).
 *
 * @param {string} title
 * @param {number} [year]
 * @returns {Object|null}
 */
async function getByTitle(title, year = null) {
  try {
    const params = { apikey: API_KEY, t: title, plot: 'short', r: 'json' };
    if (year) params.y = year;

    const res = await client.get('/', { params });
    const d = res.data;

    if (d.Response === 'False') {
      console.warn(`[omdb] Not found: "${title}" (${year}) — ${d.Error}`);
      return null;
    }

    return {
      imdb_id:          d.imdbID,
      domestic_gross:   parseDollars(d.BoxOffice),
      metacritic_score: parseNum(d.Metascore),
      imdb_rating:      parseNum(d.imdbRating),
      worldwide_gross:  null,
    };
  } catch (err) {
    console.error(`[omdb] Request failed for "${title}":`, err.message);
    return null;
  }
}

module.exports = { getByImdbId, getByTitle };
