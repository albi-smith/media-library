'use strict';

/**
 * anilist.js — Anime Metadata Client (AniList GraphQL with Kitsu API Fallback)
 */

const ANILIST_GRAPHQL_URL = 'https://graphql.anilist.co';
const KITSU_API_URL = 'https://kitsu.io/api/edge';

/**
 * Search anime on AniList (with Kitsu fallback if AniList API is offline)
 * @param {string} title - Anime search query
 * @returns {Promise<Array<object>>} Formatted search results
 */
async function searchAnime(title) {
  if (!title || typeof title !== 'string' || !title.trim()) {
    console.warn('[anilist] searchAnime called without a valid title');
    return [];
  }
  // 1. Try AniList GraphQL API first
  try {
    const query = `
      query ($search: String) {
        Page (page: 1, perPage: 8) {
          media (search: $search, type: ANIME) {
            id
            title { romaji english native }
            synonyms
            countryOfOrigin
            coverImage { extraLarge large }
            bannerImage
            startDate { year }
            description
            episodes
            genres
            meanScore
          }
        }
      }
    `;

    const response = await fetch(ANILIST_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VideoPlayerApp/1.0',
      },
      body: JSON.stringify({ query, variables: { search: title } }),
    });

    if (response.ok) {
      const json = await response.json();
      if (json.data && json.data.Page && json.data.Page.media && json.data.Page.media.length > 0) {
        return json.data.Page.media.map(m => ({
          id: m.id,
          title: m.title.english || m.title.romaji || m.title.native,
          original_title: m.title.romaji || m.title.native,
          synonyms: [...(m.synonyms || []), m.title.romaji, m.title.english, m.title.native].filter(Boolean),
          originCountry: m.countryOfOrigin || null, // 'CN' for donghua, 'JP', 'KR', ...
          year: m.startDate?.year || null,
          overview: m.description ? m.description.replace(/<[^>]*>?/gm, '') : '',
          poster_url: m.coverImage?.extraLarge || m.coverImage?.large || null,
          backdrop_url: m.bannerImage || null,
          episodes_count: m.episodes || null,
          genres: m.genres || [],
          rating: m.meanScore ? m.meanScore / 10 : null,
          type: 'anime',
          anilist_id: m.id,
        }));
      }
    }
  } catch (err) {
    console.warn('AniList API error, trying Kitsu fallback:', err.message);
  }

  // 2. Kitsu API Fallback (Free, public, open)
  try {
    const url = `${KITSU_API_URL}/anime?filter[text]=${encodeURIComponent(title)}`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/vnd.api+json' },
    });

    if (response.ok) {
      const json = await response.json();
      if (json.data && json.data.length > 0) {
        return json.data.slice(0, 5).map(item => {
          const attr = item.attributes;
          const engTitle = attr.titles?.en || attr.titles?.en_us;
          const romajiTitle = attr.canonicalTitle || attr.titles?.en_jp;
          return {
            id: item.id,
            title: engTitle || romajiTitle,
            original_title: romajiTitle || attr.titles?.ja_jp || null,
            year: attr.startDate ? parseInt(attr.startDate.substring(0, 4), 10) : null,
            overview: attr.synopsis || '',
            poster_url: attr.posterImage?.original || attr.posterImage?.large || attr.posterImage?.medium || null,
            backdrop_url: attr.coverImage?.original || attr.coverImage?.large || null,
            episodes_count: attr.episodeCount || null,
            genres: [],
            rating: attr.averageRating ? parseFloat(attr.averageRating) / 10 : null,
            type: 'anime',
            anilist_id: parseInt(item.id, 10),
          };
        });
      }
    }
  } catch (kitsuErr) {
    console.warn('Kitsu API fallback error:', kitsuErr.message);
  }

  return [];
}

/**
 * Get detailed anime info by ID
 */
async function getAnimeDetails(id) {
  const results = await searchAnime(String(id));
  return results.length > 0 ? results[0] : null;
}

module.exports = {
  searchAnime,
  getAnimeDetails,
};
