'use strict';

/**
 * tmdb.js — Movies & TV Series Metadata Client (TMDB API with TVMaze Fallback)
 */

const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';
const TVMAZE_BASE_URL = 'https://api.tvmaze.com';

let apiKey = process.env.TMDB_API_KEY || '';

function setApiKey(key) {
  apiKey = key || '';
}

function hasApiKey() {
  return apiKey.length > 0;
}

/**
 * Guess a TMDB locale from the title script so Asian titles match
 * original-language entries (ko-KR / zh-CN / ja-JP). Falls back to en-US.
 * @param {string} title
 * @returns {string}
 */
function detectLocale(title) {
  if (!title) return 'en-US';
  if (/[\uAC00-\uD7AF]/.test(title)) return 'ko-KR'; // Hangul
  if (/[\u3040-\u30FF]/.test(title)) return 'ja-JP'; // Hiragana/Katakana
  if (/[\u4E00-\u9FFF]/.test(title)) return 'zh-CN'; // Han (no kana/hangul seen)
  return 'en-US';
}

/**
 * Helper to fetch from TMDB REST API
 */
async function fetchTMDB(endpoint, params = {}) {
  if (!apiKey) return null;
  try {
    const url = new URL(`${TMDB_BASE_URL}${endpoint}`);
    url.searchParams.append('api_key', apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== null && v !== undefined) {
        url.searchParams.append(k, v);
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VideoPlayerApp/1.0',
      },
    });

    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    return null;
  }
}

/**
 * Search Movies on TMDB
 */
async function searchMovie(query, year = null) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    console.warn('[tmdb] searchMovie called without a valid query');
    return [];
  }
  const language = detectLocale(query);
  const data = await fetchTMDB('/search/movie', { query, year, language });
  if (data && data.results && data.results.length > 0) {
    return data.results.slice(0, 5).map(m => ({
      id: m.id,
      type: 'movie',
      title: m.title,
      original_title: m.original_title,
      year: m.release_date ? parseInt(m.release_date.substring(0, 4), 10) : year,
      overview: m.overview || '',
      poster_url: m.poster_path ? `${TMDB_IMAGE_BASE}/w500${m.poster_path}` : null,
      backdrop_url: m.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${m.backdrop_path}` : null,
      rating: m.vote_average || null,
      tmdb_id: m.id,
    }));
  }

  // Fallback placeholder formatting for movies when TMDB key isn't provided or offline
  return [{
    id: Date.now(),
    type: 'movie',
    title: query,
    original_title: null,
    year: year,
    overview: `Local media file: ${query}`,
    poster_url: null,
    backdrop_url: null,
    rating: null,
    tmdb_id: null,
  }];
}

/**
 * Search TV Series on TMDB (with TVMaze open API fallback)
 */
async function searchSeries(query, year = null) {
  if (!query || typeof query !== 'string' || !query.trim()) {
    console.warn('[tmdb] searchSeries called without a valid query');
    return [];
  }
  // 1. Try TMDB if key available
  if (apiKey) {
    const language = detectLocale(query);
    const data = await fetchTMDB('/search/tv', { query, first_air_date_year: year, language });
    if (data && data.results && data.results.length > 0) {
      return data.results.slice(0, 5).map(s => ({
        id: s.id,
        type: 'series',
        title: s.name,
        original_title: s.original_name,
        year: s.first_air_date ? parseInt(s.first_air_date.substring(0, 4), 10) : year,
        overview: s.overview || '',
        poster_url: s.poster_path ? `${TMDB_IMAGE_BASE}/w500${s.poster_path}` : null,
        backdrop_url: s.backdrop_path ? `${TMDB_IMAGE_BASE}/w1280${s.backdrop_path}` : null,
        rating: s.vote_average || null,
        tmdb_id: s.id,
      }));
    }
  }

  // 2. TVMaze Open API Fallback (Free, public, no key required)
  try {
    const response = await fetch(`${TVMAZE_BASE_URL}/search/shows?q=${encodeURIComponent(query)}`);
    if (response.ok) {
      const data = await response.json();
      if (data && data.length > 0) {
        return data.slice(0, 5).map(item => {
          const s = item.show;
          return {
            id: s.id,
            type: 'series',
            title: s.name,
            original_title: s.name,
            year: s.premiered ? parseInt(s.premiered.substring(0, 4), 10) : year,
            overview: s.summary ? s.summary.replace(/<[^>]*>?/gm, '') : '',
            poster_url: s.image?.original || s.image?.medium || null,
            backdrop_url: s.image?.original || null,
            rating: s.rating?.average || null,
            // tvmaze_id is a display-only field — NOT a TMDB ID.
            // Do NOT set tmdb_id here: storing a TVMaze integer as tmdb_id would
            // cause getTitleByExternalId() to dedup future scans against a spurious
            // TMDB row and corrupt the external-ID index.
            tvmaze_id: s.id,
            tmdb_id: null,
          };
        });
      }
    }
  } catch (err) {
    console.warn('TVMaze fallback error:', err.message);
  }

  return [{
    id: Date.now(),
    type: 'series',
    title: query,
    original_title: null,
    year: year,
    overview: `Local series: ${query}`,
    poster_url: null,
    backdrop_url: null,
    rating: null,
    tmdb_id: null,
  }];
}

/**
 * Get detailed TV series info
 */
async function getSeriesDetails(tmdbId) {
  const results = await searchSeries(String(tmdbId));
  return results.length > 0 ? results[0] : null;
}

/**
 * Fetch the episode list for a TV series season (episode names, stills,
 * overviews, air dates). Best-effort — needs a TMDB API key.
 * @param {number} tmdbId
 * @param {number} season - Season number (usually starts at 1)
 * @returns {Promise<Array<{episode_number:number, season_number:number,
 *   name:string, overview:string|null, still_url:string|null, air_date:string|null}>>}
 */
async function getSeasonEpisodes(tmdbId, season) {
  if (tmdbId == null || season == null) return [];
  if (!apiKey) return [];
  const data = await fetchTMDB(`/tv/${tmdbId}/season/${season}`);
  if (!data || !Array.isArray(data.episodes)) return [];
  return data.episodes.map((ep) => ({
    episode_number: ep.episode_number,
    season_number: data.season_number ?? season,
    name: ep.name || `Episode ${ep.episode_number}`,
    overview: ep.overview || null,
    still_url: ep.still_path ? `${TMDB_IMAGE_BASE}/w300${ep.still_path}` : null,
    air_date: ep.air_date || null,
  }));
}

module.exports = {
  setApiKey,
  hasApiKey,
  detectLocale,
  searchMovie,
  searchSeries,
  getSeriesDetails,
  getSeasonEpisodes,
};
