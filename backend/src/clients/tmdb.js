/**
 * clients/tmdb.js
 * Thin wrapper around the TMDB v3 API.
 *
 * Key endpoints used:
 *   /movie/upcoming          — auto-populate the draft pool
 *   /movie/{id}              — full movie details
 *   /movie/{id}/credits      — director + cast
 *   /search/movie            — commissioner manual add
 *
 * TMDB image base URL: https://image.tmdb.org/t/p/{size}{poster_path}
 *   Poster sizes:  w92, w154, w185, w342, w500, w780, original
 *   Backdrop sizes: w300, w780, w1280, original
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.TMDB_BASE_URL || 'https://api.themoviedb.org/3';
const API_KEY  = process.env.TMDB_API_KEY;
const IMAGE_BASE = 'https://image.tmdb.org/t/p';

if (!API_KEY || API_KEY === 'your_tmdb_api_key_here') {
  console.warn('[tmdb] WARNING: TMDB_API_KEY not set. Set it in .env before syncing.');
}

const client = axios.create({
  baseURL: BASE_URL,
  params: { api_key: API_KEY, language: 'en-US' },
  timeout: 10_000,
});

// Simple exponential backoff for rate limit (HTTP 429) responses
async function request(path, params = {}) {
  let attempts = 0;
  while (attempts < 4) {
    try {
      const res = await client.get(path, { params });
      return res.data;
    } catch (err) {
      if (err.response?.status === 429) {
        const wait = Math.pow(2, attempts) * 1000;
        console.warn(`[tmdb] Rate limited. Waiting ${wait}ms…`);
        await new Promise(r => setTimeout(r, wait));
        attempts++;
      } else {
        throw err;
      }
    }
  }
  throw new Error(`[tmdb] Max retries exceeded for ${path}`);
}

/**
 * Fetch all upcoming US wide releases for a given year.
 * TMDB paginates at 20 results/page; we collect all pages.
 *
 * @param {number} year  e.g. 2026
 * @returns {Array}      raw TMDB movie objects
 */
async function getUpcomingForYear(year) {
  const startDate = `${year}-01-01`;
  const endDate   = `${year}-12-31`;
  const movies = [];
  let page = 1;
  let totalPages = 1;

  console.log(`[tmdb] Fetching upcoming releases for ${year}…`);

  while (page <= totalPages) {
    const data = await request('/discover/movie', {
      'primary_release_date.gte': startDate,
      'primary_release_date.lte': endDate,
      'with_release_type': '3|2',   // 3 = theatrical, 2 = limited
      'region': 'US',
      'sort_by': 'popularity.desc',
      'vote_count.gte': 0,
      'page': page,
    });

    movies.push(...data.results);
    totalPages = Math.min(data.total_pages, 20); // cap at 400 movies — enough for any pool
    console.log(`[tmdb]   page ${page}/${totalPages} (${data.results.length} films)`);
    page++;

    // Be polite — small delay between pages
    if (page <= totalPages) await new Promise(r => setTimeout(r, 250));
  }

  console.log(`[tmdb] Found ${movies.length} total upcoming films for ${year}`);
  return movies;
}

/**
 * Fetch full details for a single movie, including credits.
 * Returns a merged object with movie details + director + top cast.
 *
 * @param {number} tmdbId
 * @returns {Object}
 */
async function getMovieDetails(tmdbId) {
  const [details, credits] = await Promise.all([
    request(`/movie/${tmdbId}`),
    request(`/movie/${tmdbId}/credits`),
  ]);

  const director = credits.crew
    ?.filter(p => p.job === 'Director')
    .map(p => p.name)
    .join(', ') || null;

  const cast = credits.cast
    ?.slice(0, 5)
    .map(p => p.name) || [];

  return {
    id: details.id,
    imdb_id: details.imdb_id,
    title: details.title,
    release_date: details.release_date,
    tmdb_poster_path: details.poster_path,
    tmdb_backdrop_path: details.backdrop_path,
    tmdb_overview: details.overview,
    tmdb_genres: JSON.stringify(details.genres?.map(g => g.name) || []),
    tmdb_director: director,
    tmdb_cast: JSON.stringify(cast),
    tmdb_runtime: details.runtime || null,
    tmdb_budget: details.budget > 0 ? details.budget : null, // TMDB often has 0 for unknown
  };
}

/**
 * Search for a movie by title (for commissioner manual add).
 *
 * @param {string} query
 * @param {number} [year]  optional release year to narrow results
 * @returns {Array}        top results
 */
async function searchMovies(query, year = null) {
  const params = { query };
  if (year) params.year = year;
  const data = await request('/search/movie', params);
  return data.results?.slice(0, 10) || [];
}

/**
 * Build a full image URL from a TMDB path.
 *
 * @param {string} path    e.g. "/abc123.jpg"
 * @param {string} size    e.g. "w500" (poster) or "w1280" (backdrop)
 * @returns {string|null}
 */
function imageUrl(path, size = 'w500') {
  if (!path) return null;
  return `${IMAGE_BASE}/${size}${path}`;
}

module.exports = { getUpcomingForYear, getMovieDetails, searchMovies, imageUrl };
