/**
 * clients/oscars.js
 * Loads Oscar nomination/win data from the delventhalz/json-nominations dataset.
 *
 * Dataset: https://github.com/delventhalz/json-nominations
 * Each record: { category, year, nominees[], movies[{ title, tmdb_id, imdb_id }], won }
 *
 * We fetch the raw JSON from GitHub (or load from a local cache file).
 * The dataset is updated annually after nominations are announced each January.
 *
 * Usage:
 *   - On first run: fetch from GitHub, cache locally at data/oscar_nominations.json
 *   - On subsequent runs: use local cache unless forceRefresh = true
 *   - After ingestion: creates oscar_data rows and fires scoring events for owned movies
 */

require('dotenv').config();
const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const CACHE_PATH = path.resolve('./data/oscar_nominations.json');
const DATASET_URL = 'https://raw.githubusercontent.com/delventhalz/json-nominations/main/nominations.json';

/**
 * Load the nominations dataset.
 * Returns the full array of nomination objects.
 *
 * @param {boolean} forceRefresh  skip cache and re-fetch from GitHub
 * @returns {Array}
 */
async function loadNominations(forceRefresh = false) {
  if (!forceRefresh && fs.existsSync(CACHE_PATH)) {
    console.log('[oscars] Loading from local cache:', CACHE_PATH);
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  }

  console.log('[oscars] Fetching nominations dataset from GitHub…');
  try {
    const res = await axios.get(DATASET_URL, { timeout: 15_000 });
    const data = res.data;

    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
    console.log(`[oscars] Cached ${data.length} nominations to ${CACHE_PATH}`);
    return data;
  } catch (err) {
    console.error('[oscars] Failed to fetch dataset:', err.message);
    if (fs.existsSync(CACHE_PATH)) {
      console.warn('[oscars] Falling back to local cache');
      return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    }
    throw err;
  }
}

/**
 * Filter nominations to a specific ceremony year.
 * Note: dataset uses award year (e.g. "2026" for the 98th ceremony in March 2026).
 *
 * @param {Array}  nominations  full dataset
 * @param {number} year         ceremony year (e.g. 2026)
 * @returns {Array}
 */
function nominationsForYear(nominations, year) {
  return nominations.filter(n => String(n.year) === String(year));
}

/**
 * Build a lookup map: imdb_id → array of nomination records.
 * Used when syncing oscar_data rows against the movies table.
 *
 * @param {Array} nominations
 * @returns {Map<string, Array>}
 */
function buildImdbIndex(nominations) {
  const index = new Map();
  for (const nom of nominations) {
    for (const movie of (nom.movies || [])) {
      if (!movie.imdb_id) continue;
      if (!index.has(movie.imdb_id)) index.set(movie.imdb_id, []);
      index.get(movie.imdb_id).push({
        category:      nom.category,
        year:          nom.year,
        nominees:      nom.nominees,
        won:           nom.won,
        tmdb_id:       movie.tmdb_id,
        imdb_id:       movie.imdb_id,
        movie_title:   movie.title,
      });
    }
  }
  return index;
}

module.exports = { loadNominations, nominationsForYear, buildImdbIndex };
