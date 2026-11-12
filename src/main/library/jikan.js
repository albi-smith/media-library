'use strict';

/**
 * jikan.js — MyAnimeList metadata client via the free Jikan API (no key).
 *
 * Third fallback for anime/donghua enrichment after AniList + Kitsu.
 * Useful for Chinese donghua and obscure titles that AniList's search
 * ranking misses. Rate limits: ~3 req/sec — call sparingly (one lookup
 * per local title, already the case via enrichTitleWithLookup).
 */

const JIKAN_BASE_URL = 'https://api.jikan.moe/v4';

/**
 * Search anime on MyAnimeList (covers Japanese anime + Chinese donghua).
 * @param {string} title - Search query
 * @returns {Promise<Array<object>>} Candidates in the shared metadata shape
 */
async function searchJikan(title) {
  if (!title) return [];
  try {
    const url = `${JIKAN_BASE_URL}/anime?q=${encodeURIComponent(title)}&limit=5&sfw=true`;
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const json = await response.json();
    if (!json.data || json.data.length === 0) return [];
    return json.data.slice(0, 5).map((a) => ({
      id: `mal-${a.mal_id}`,
      title: a.title_english || a.title,
      original_title: a.title_japanese || a.title,
      synonyms: [...(a.title_synonyms || []), a.title, a.title_english].filter(Boolean),
      year: a.aired?.from ? parseInt(a.aired.from.substring(0, 4), 10) : null,
      overview: a.synopsis || '',
      poster_url: a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || null,
      backdrop_url: null,
      episodes_count: a.episodes || null,
      genres: (a.genres || []).map((g) => g.name),
      rating: a.score || null,
      type: 'anime',
      mal_id: a.mal_id,
    }));
  } catch (err) {
    console.warn('Jikan API error:', err.message);
    return [];
  }
}

/**
 * Fetch the episode list for an anime via Jikan (per-episode titles, air
 * dates, filler flags). Best-effort; fills episode metadata like TMDB's
 * season endpoint does for series. Jikan limits to 100 rows per page — we
 * paginate a few pages and stop early.
 * @param {number} malId - MyAnimeList id (may be a "mal-123" string id)
 * @returns {Promise<Array<{episode_number:number, season_number:number,
 *   name:string, overview:string|null, air_date:string|null}>>}
 */
async function getAnimeEpisodes(malId) {
  let id = malId;
  if (typeof id === 'string' && id.startsWith('mal-')) id = id.slice(4);
  id = parseInt(id, 10);
  if (!Number.isFinite(id) || id <= 0) return [];

  const results = [];
  try {
    for (let page = 1; page <= 3; page++) {
      const url = `${JIKAN_BASE_URL}/anime/${id}/episodes?page=${page}`;
      const response = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!response.ok) break;
      const json = await response.json();
      const data = (json && json.data) || [];
      if (data.length === 0) break;
      results.push(...data);
      if ((json.pagination && json.pagination.has_next_page) !== true) break;
    }
  } catch (err) {
    console.warn('Jikan episode fetch error:', err.message);
    return [];
  }

  return (results || []).map((ep, i) => ({
    episode_number: ep.episode_number != null ? parseInt(ep.episode_number, 10) : i + 1,
    season_number: 1,
    name: (ep.title_romanji || ep.title) || `Episode ${ep.episode_number != null ? ep.episode_number : i + 1}`,
    overview: ep.synopsis || null,
    air_date: ep.aired || null,
  }));
}

module.exports = { searchJikan, getAnimeEpisodes };
