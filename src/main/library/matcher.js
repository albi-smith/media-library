'use strict';

/**
 * matcher.js — Offline-first title matching engine.
 *
 * Two-phase design:
 *
 *   Phase 1 (PRIMARY, always offline): parse the filename with the local
 *   guessit-equivalent parser, normalize the show/movie name, and group
 *   into a local `titles` entry via {@link groupLocalTitle}. This step never
 *   touches the network and always succeeds — grouping works fully offline.
 *
 *   Phase 2 (OPPORTUNISTIC enrichment): try TMDB/AniList to fill in poster,
 *   description, and external IDs via {@link enrichTitleWithLookup}. Any
 *   network failure, timeout, or low-confidence result is swallowed and the
 *   local grouping is kept as-is. External IDs are optional enrichment
 *   fields added later — never a requirement for grouping.
 *
 * Series identity (the anti-duplication core):
 *   Before a new `titles` row is created, the cleaned show name is compared
 *   against every existing series using, in order of strength:
 *     1. exact normalized-title equality,
 *     2. registered aliases (alternate names, synonyms, folder names),
 *     3. metadata-provided original_title / synonyms,
 *     4. fuzzy word-overlap similarity (typo/spacing variants).
 *   When several series score similarly high the match is treated as
 *   AMBIGUOUS — no duplicate is created; instead the caller is told to ask
 *   the user which series the file belongs to.
 */

const path = require('path');
const { searchAnime } = require('./anilist');
const { searchJikan, getAnimeEpisodes } = require('./jikan');
const { searchMovie, searchSeries, getSeasonEpisodes } = require('./tmdb');
const { normalizeTitle, REVIEW_THRESHOLD } = require('./parser');
const libraryStore = require('../db/library-store');

const ENRICH_TIMEOUT_MS = 10000;
const AUTO_MATCH_THRESHOLD = 0.7;
const FUZZY_MATCH_THRESHOLD = 0.7;   // similarity needed to join an existing series
const STRONG_MATCH_THRESHOLD = 0.9;  // above this, unambiguous
const AMBIGUOUS_NARROW_GAP = 0.12;   // top-2 gap below this => ambiguous
const LEARNED_BONUS = 0.9;           // manual-match training pushes a series past every offline threshold

/**
 * Diagnostic Tracer for the Matching & Grouping Pipeline.
 * Stores detailed decision steps so failure points and series assignments
 * can be audited cleanly.
 */
const pipelineDiagnostics = [];

function logDiagnosticStep(filePath, step, details) {
  const entry = {
    timestamp: new Date().toISOString(),
    filePath: filePath || null,
    step, // 'parse', 'group_key', 'local_match', 'online_lookup', 'decision'
    details,
  };
  pipelineDiagnostics.push(entry);
  if (pipelineDiagnostics.length > 5000) {
    pipelineDiagnostics.shift();
  }
  return entry;
}

function getPipelineDiagnostics() {
  return [...pipelineDiagnostics];
}

function clearPipelineDiagnostics() {
  pipelineDiagnostics.length = 0;
}

/**
 * Session-scoped "manual match" training memory.
 *
 * When the user confirms which series a file belongs to (ambiguity modal,
 * batch review, or fix-match), the mapping is recorded here for the DURATION
 * of the current scan. Subsequent files that share the same parsed title,
 * folder, or folder+season are then resolved straight onto that confirmed
 * series instead of spawning a duplicate or asking again.
 *
 * Training is deliberately NOT permanent: it is just-in-time feedback for the
 * scan that is running right now. Permanent grouping is the job of the
 * `title_aliases` table (folder/alternate/synonym aliases).
 */
const sessionLearnings = {
  byTitle: new Map(),  // normalized title  -> Set<titleId>
  byFolder: new Map(), // normalized folder -> Set<titleId>
  bySeason: new Map(), // folder|S<season>  -> Set<titleId>  (same folder + same season)
};

function learnedSetAdd(map, key, titleId) {
  if (!key || !titleId) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(titleId);
}

/**
 * Record a user-confirmed manual match as training data for the current scan.
 * @param {string} filePath
 * @param {object|string|null} parsed - parser output (or a bare title string)
 * @param {number} titleId - confirmed series id
 */
function rememberManualMatch(filePath, parsed, titleId) {
  if (!titleId || titleId == null) return;
  const titleText = parsed && typeof parsed === 'object' ? parsed.title : parsed;
  const norm = typeof titleText === 'string' ? normalizeTitle(titleText) : '';
  // Only real word-titles are worth learning — noise markers ("s01e01") vary
  // per file and would just pollute the title index with junk keys.
  if (norm && !isNoiseOnlyTitle({ title: titleText }) && norm.length >= 3) {
    learnedSetAdd(sessionLearnings.byTitle, norm, titleId);
  }
  const folder = filePath ? normalizeTitle(getFolderHint(filePath)) : '';
  if (folder.length >= 3) {
    learnedSetAdd(sessionLearnings.byFolder, folder, titleId);
    const season = parsed && typeof parsed === 'object' ? parsed.season : null;
    if (season) learnedSetAdd(sessionLearnings.bySeason, `${folder}|S${season}`, titleId);
  }
}

/**
 * Return the series a file should be trained onto, or null when there is no
 * unique learned mapping for it (or the learned series no longer exists).
 * Priority: exact parsed title → folder+season → folder.
 * @param {object} parsed - parser output
 * @param {string} [filePath]
 * @returns {number|null}
 */
function getLearnedTitleFor(parsed, filePath) {
  const titleText = parsed && typeof parsed === 'object' ? parsed.title : parsed;
  const norm = typeof titleText === 'string' ? normalizeTitle(titleText) : '';
  if (norm) {
    const byTitle = sessionLearnings.byTitle.get(norm);
    if (byTitle && byTitle.size === 1) {
      const id = [...byTitle][0];
      return id; // existence re-checked against the live row set by the caller
    }
  }
  const folder = filePath ? normalizeTitle(getFolderHint(filePath)) : '';
  if (!folder || folder.length < 3) return null;

  const season = parsed && typeof parsed === 'object' ? parsed.season : null;
  if (season) {
    const bySeason = sessionLearnings.bySeason.get(`${folder}|S${season}`);
    if (bySeason && bySeason.size === 1) return [...bySeason][0];
  }
  const byFolder = sessionLearnings.byFolder.get(folder);
  if (byFolder && byFolder.size === 1) return [...byFolder][0];
  return null;
}

/** Forget every learned mapping — called at the start of each scan. */
function clearSessionLearnings() {
  sessionLearnings.byTitle.clear();
  sessionLearnings.byFolder.clear();
  sessionLearnings.bySeason.clear();
}

/**
 * Session-scoped cache of fetched episode metadata, keyed by external series
 * id + season. Prevents re-querying the TMDB season / Jikan episode list for
 * every file of the same show during one reparse pass.
 * @type {Map<string, Array>}
 */
const episodeMetadataCache = new Map();

/** @returns {string} cache key for a season metadata fetch */
function episodeCacheKey(externalKey, season) {
  return `${externalKey}|S${season}`;
}

/**
 * Fill per-episode metadata (name / overview / still_url / air_date) for a
 * title's season from the online provider, best-effort. Never throws and
 * never re-groups — it only ticks DO UPDATE on existing episode rows and
 * inserts missing ones.
 * @param {number} titleId
 * @param {object} hit - matched online candidate (from matchOnlineTitle)
 * @param {number} [season]
 * @returns {Promise<void>}
 */
async function fillEpisodeMetadata(titleId, hit, season) {
  if (!titleId || !hit) return;
  const seasonNum = season && season > 0 ? season : 1;
  const external =
    (hit.tmdb_id != null ? `tmdb:${hit.tmdb_id}` : null) ||
    (hit.anilist_id != null ? `ani:${hit.anilist_id}` : null) ||
    (hit.mal_id != null ? `mal:${hit.mal_id}` : null);
  if (!external) return;

  const key = episodeCacheKey(external, seasonNum);
  if (episodeMetadataCache.has(key)) return; // already fetched this pass

  let list = [];
  if (hit.tmdb_id != null) {
    const tvSeason = await getSeasonEpisodes(hit.tmdb_id, seasonNum).catch(() => []);
    if (tvSeason && tvSeason.length > 0) list = tvSeason;
  }
  // Jikan's episode endpoint is keyed by MyAnimeList id. AniList ids are a
  // different namespace — never pass an anilist_id there (AniList itself has
  // no per-episode list API, so MAL hits are the only anime episode source).
  if (list.length === 0 && hit.mal_id != null) {
    const anime = await getAnimeEpisodes(hit.mal_id).catch(() => []);
    if (anime && anime.length > 0) list = anime;
  }

  episodeMetadataCache.set(key, list);
  for (const ep of list) {
    if (!ep || ep.episode_number == null) continue;
    try {
      libraryStore.upsertEpisode({
        title_id: titleId,
        season_number: ep.season_number || seasonNum,
        episode_number: ep.episode_number,
        name: ep.name || null,
        overview: ep.overview || null,
        still_url: ep.still_url || null,
        air_date: ep.air_date || null,
      });
    } catch (err) {
      console.warn(`[matcher] fillEpisodeMetadata: upsert failed for ep ${ep.episode_number}:`, err && err.message ? err.message : err);
    }
  }
}

/** Forget fetched episode metadata — reset per reparse pass. */
function clearEpisodeMetadataCache() {
  episodeMetadataCache.clear();
}

/**
 * ONLINE-FIRST matching: query the metadata providers (TMDB/TVMaze + AniList +
 * Jikan) and, when a confident hit is found, return the external-id-keyed
 * title row to group onto. This REPLACES filename-guessing — the online
 * identity (not the normalized filename) is what decides the series row.
 *
 * That means a filename-guess `local` row previously created for the same
 * show gets MERGED into the verified row so the library stays deduplicated.
 *
 * @param {object} parsed - parser output
 * @param {string} [filePath]
 * @returns {Promise<{title, ambiguous, candidates, hit, mergedFrom}|null>}
 *   null when lookup ran but found no confident hit (caller falls back to
 *   offline local grouping), or when there is nothing to search for.
 */
async function matchOnlineTitle(parsed, filePath) {
  if (!parsed || typeof parsed !== 'object' || !parsed.title) return null;
  if (isNoiseOnlyTitle(parsed) || !normalizeTitle(parsed.title)) return null;

  const title = parsed.title;
  const year = parsed.year;
  const isShow = parsed.typeCandidate !== 'movie';
  const queries = isShow
    ? [
        searchSeries(title, year),
        searchAnime(title),
        searchJikan(title),
      ]
    : [
        searchMovie(title, year),
        searchSeries(title, year),
      ];

  let candidates = [];
  try {
    candidates = await gatherCandidates(queries);
  } catch (err) {
    console.warn(`[matcher] matchOnlineTitle: lookup for "${title}" failed — falling back to offline:`, err && err.message ? err.message : err);
    return null;
  }

  // Ignore offline placeholder results that carry no external ID.
  const real = (candidates || []).filter(
    (c) => c && (c.tmdb_id != null || c.anilist_id != null || c.mal_id != null || c.tvmaze_id != null)
  );
  if (real.length === 0) return null;

  let bestMatch = null;
  let highestScore = 0;
  for (const candidate of real) {
    if (!candidate) continue;
    const score = scoreCandidate(title, year, candidate);
    if (score > highestScore) {
      highestScore = score;
      bestMatch = candidate;
    }
  }
  if (!bestMatch || highestScore < AUTO_MATCH_THRESHOLD) return null;

  // Dedup by external id: a verified row that already exists (created by an
  // earlier file, fix-match, or a previous reparse) wins.
  let titleId = null;
  let existing = libraryStore.getTitleByExternalId({
    tmdb_id: bestMatch.tmdb_id,
    anilist_id: bestMatch.anilist_id,
    mal_id: bestMatch.mal_id,
  });
  if (existing) {
    titleId = existing.id;
  } else {
    titleId = libraryStore.upsertTitle({
      type: bestMatch.type || parsed.typeCandidate,
      title: bestMatch.title || title,
      original_title: bestMatch.original_title || null,
      year: bestMatch.year ?? year ?? null,
      overview: bestMatch.overview || null,
      poster_url: bestMatch.poster_url || null,
      backdrop_url: bestMatch.backdrop_url || null,
      tmdb_id: bestMatch.tmdb_id || null,
      anilist_id: bestMatch.anilist_id || null,
      mal_id: bestMatch.mal_id || null,
      match_confidence: 'auto',
    });
    if (!titleId) return null;

    // Register source-provided alt names as aliases so future scans under
    // ANY of those names group onto this verified row.
    const synonyms = Array.isArray(bestMatch.synonyms) ? bestMatch.synonyms : [];
    for (const alias of [bestMatch.original_title, ...synonyms]) {
      if (alias && normalizeTitle(alias) && normalizeTitle(alias) !== normalizeTitle(title)) {
        try { libraryStore.addTitleAlias(titleId, alias, 'synonym'); }
        catch (err) { console.warn(`[matcher] matchOnlineTitle: alias registration failed:`, err && err.message ? err.message : err); }
      }
    }
  }

  return {
    title: libraryStore.getTitleById(titleId),
    ambiguous: false,
    candidates: [],
    hit: bestMatch,
    mergedFrom: null,
  };
}

function isEpisodicType(t) {
  return t === 'series' || t === 'anime';
}

/**
 * Compute similarity string match score between target and candidate (0 to 1)
 */
function computeTitleSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const s1 = str1.toLowerCase().trim();
  const s2 = str2.toLowerCase().trim();

  if (s1 === s2) return 1.0;
  if (s1.includes(s2) || s2.includes(s1)) return 0.85;

  // Word overlap Jaccard index
  const w1 = new Set(s1.split(/\s+/));
  const w2 = new Set(s2.split(/\s+/));
  let intersection = 0;
  for (const w of w1) {
    if (w2.has(w)) intersection++;
  }
  const union = new Set([...w1, ...w2]).size;
  return union > 0 ? intersection / union : 0;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('metadata lookup timed out')), ms)
    ),
  ]);
}

/**
 * Score a parsed title against one metadata candidate (0 to ~1.15).
 * Matches against the main title, the original-language title, and every
 * known synonym (AniList synonyms, MAL title_synonyms) so romanized,
 * translated, and CJK-native names all hit.
 */
function scoreCandidate(parsedTitle, parsedYear, candidate) {
  if (!candidate) return 0;
  const names = [candidate.title, candidate.original_title, ...(Array.isArray(candidate.synonyms) ? candidate.synonyms : [])];
  let score = 0;
  for (const name of names) {
    if (name) score = Math.max(score, computeTitleSimilarity(parsedTitle, name));
  }
  if (parsedYear && candidate.year && parsedYear === candidate.year) {
    score += 0.15;
  }
  return score;
}

/**
 * Run every lookup, swallowing individual failures. Returns the merged
 * candidate pool — never throws.
 */
async function gatherCandidates(queries) {
  if (!Array.isArray(queries)) return [];
  const settled = await Promise.all(
    queries
      .filter((q) => q && typeof q.then === 'function')
      .map((q) => withTimeout(q, ENRICH_TIMEOUT_MS).catch(() => []))
  );
  return settled.flat().filter(Boolean);
}

/**
 * Extract a usable "title hint" from the parent folder of a file path.
 * The folder is the strongest signal for series identity that offline
 * matching has beyond the filename itself: a folder named
 * "Attack on Titan (2009)" groups every season's files together.
 * @param {string} filePath
 * @returns {string} Cleaned folder name, or ''
 */
function getFolderHint(filePath) {
  const dir = path.dirname(filePath || '');
  const folder = path.basename(dir);
  if (!folder || folder === '.' || folder === '\\' || folder === '/') return '';
  const cleaned = folder
    .replace(/[\[\]()]/g, ' ')
    .replace(/[._\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned;
}

/**
 * A "noise-only" title is one where the filename carried no real words —
 * pure episode markers like "S01E01", "E01", "01", hashes, or is empty.
 * In that case the parent-folder name is the only reliable title signal.
 * @param {object} parsed
 * @returns {boolean}
 */
function isNoiseOnlyTitle(parsed) {
  if (!parsed || !parsed.title) return true;
  const norm = normalizeTitle(parsed.title);
  if (!norm) return true;
  if (norm.length < 3) return true;
  if (/^(?:s\d{1,2}e\d{1,4}|e\d{1,4}|ep?\d{1,4}|\d{1,4})$/.test(norm)) return true;
  if (/^[0-9a-f]{16,}$/i.test(norm)) return true; // hash-like
  return false;
}

/**
 * Build the set of name variants that a file's title should be matched
 * against for a given local title row: the canonical title, the metadata
 * original title, and every registered alias.
 * @param {object} row - titles row
 * @param {Array<{alias:string}|string>} [aliases] - optional pre-fetched alias rows
 * @returns {string[]}
 */
function nameVariantsFor(row, aliases = []) {
  const variants = new Set();
  if (row && row.title) variants.add(normalizeTitle(row.title));
  if (row && row.original_title) variants.add(normalizeTitle(row.original_title));
  if (Array.isArray(aliases)) {
    for (const a of aliases) {
      const v = typeof a === 'string' ? a : a && a.alias;
      if (v) variants.add(normalizeTitle(v));
    }
  }
  return [...variants].filter(Boolean);
}

/**
 * Score an existing local title row against a parsed file.
 * Combines filename similarity, alias matching, folder-name matching and a
 * year bonus — the offline equivalent of scoreCandidate().
 * @param {object} row - titles row
 * @param {string[]} variants - normalized name variants for the row
 * @param {object} parsed - parser output
 * @param {Array<{title_id:number, column:string}|*=>} [aliasRows] - alias rows for the row
 * @returns {number} 0..~1.15
 */
function scoreLocalRow(row, variants, parsed) {
  if (!row || !parsed) return 0;
  const wantShow = parsed.typeCandidate !== 'movie';
  const rowShow = isEpisodicType(row.type);
  if (wantShow !== rowShow) return 0;

  const cleanTitle = normalizeTitle(parsed.title);
  let score = 0;

  for (const v of variants) {
    if (!v) continue;
    // Exact normalized match on any variant is a perfect signal.
    if (v === cleanTitle) return 1.0;
    score = Math.max(score, computeTitleSimilarity(cleanTitle, v));
  }

  // Year bonus: an exact year agreement nudges the score above plain fuzzy.
  if (parsed.year && row.year && parsed.year === row.year) {
    score += 0.15;
  }

  return score;
}

/**
 * Find candidate local title entries for a parsed file.
 *
 * Returns a ranked list, NOT just a single id. A single confident hit
 * returns one entry; a tail of near-ties returns a set of candidates the
 * caller should put to the user for confirmation instead of auto-merging.
 *
 * @param {object} parsed - Result from parser.parseFilename()
 * @param {string} [filePath] - Full file path (used for folder-name matching)
 * @returns {Array<{titleId:number, score:number, confidence:string}>}
 */
function findLocalTitleCandidates(parsed, filePath) {
  if (!parsed || typeof parsed !== 'object' || !parsed.title) return [];

  const norm = normalizeTitle(parsed.title);
  if (!norm) return [];

  let rows = [];
  try {
    rows = libraryStore.getAllTitles();
  } catch (err) {
    console.warn('[matcher] findLocalTitleCandidates: failed to load titles:', err && err.message ? err.message : err);
    return [];
  }
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Build a variant cache per row (guarded query — a bad alias query must
  // never abort matching).
  let aliasRows = [];
  try {
    aliasRows = libraryStore.getAliasesForTitles(rows.map((r) => r && r.id).filter(Boolean)) || [];
  } catch (err) {
    console.warn('[matcher] findLocalTitleCandidates: alias lookup failed:', err && err.message ? err.message : err);
  }
  const aliasesByTitle = new Map();
  if (Array.isArray(aliasRows)) {
    for (const a of aliasRows) {
      if (!a || a.title_id == null) continue;
      if (!aliasesByTitle.has(a.title_id)) aliasesByTitle.set(a.title_id, []);
      aliasesByTitle.get(a.title_id).push(a);
    }
  }

  // Build a variant cache per row.
  const rowsWithVariants = rows
    .filter((row) => row && row.id != null)
    .map((row) => ({
      row,
      variants: nameVariantsFor(row, aliasesByTitle.get(row.id) || []),
    }));

  // Per-title folder aliases (parents of files already attached to each series).
  const folderMap = new Map();
  for (const rw of rowsWithVariants) {
    if (!rw || rw.row.id == null) continue;
    try {
      const pathsRaw = libraryStore.getFilePathsForTitle(rw.row.id);
      const paths = Array.isArray(pathsRaw) ? pathsRaw : [];
      const folders = new Set(paths.map((p) => normalizeTitle(getFolderHint(p))).filter(Boolean));
      if (folders.size) folderMap.set(rw.row.id, folders);
    } catch (err) {
      console.warn(`[matcher] findLocalTitleCandidates: folder lookup for title #${rw.row.id} failed:`, err && err.message ? err.message : err);
    }
  }

  const folderHint = normalizeTitle(getFolderHint(filePath));
  const learnedTitleId = getLearnedTitleFor(parsed, filePath);

  const scored = [];
  for (const rw of rowsWithVariants) {
    if (!rw) continue;
    let score = scoreLocalRow(rw.row, rw.variants, parsed);

    // Manual-match training bonus: the user told us similar files belong to
    // THIS series during the current scan — push it over every offline
    // threshold unless genuinely-strong evidence (>= STRONG_MATCH_THRESHOLD)
    // for a different series competes, which then surfaces as ambiguity.
    if (learnedTitleId != null && rw.row.id === learnedTitleId) {
      score += LEARNED_BONUS;
    }

    if (!(score > 0)) continue;

    // Folder-name bonus: a series whose stored files live in a folder that
    // shares the current file's folder gets a strong boost.
    if (folderHint) {
      const folded = folderMap.get(rw.row.id) || new Set();
      if ([...folded].some((f) => f === folderHint)) {
        score += 0.3;
      } else if ([...folded].some((f) => computeTitleSimilarity(f, folderHint) >= FUZZY_MATCH_THRESHOLD)) {
        score += 0.15;
      }
    }

    scored.push({ titleId: rw.row.id, score: Math.round(score * 100) / 100, confidence: rw.row.match_confidence });
  }

  scored.sort((a, b) => b.score - a.score);

  // Fold logically-equivalent rows by external id: if two local rows already
  // hold the same tmdb/anilist/mal id they're the same series and only the
  // best-scoring one should ever be returned (prevents matched-pairs dupes).
  const seenExt = new Map();
  const deduped = [];
  for (const c of scored) {
    const row = rows.find((r) => r && r.id === c.titleId);
    if (!row) { deduped.push(c); continue; }
    const extKey = row.tmdb_id || row.anilist_id || row.mal_id;
    if (extKey) {
      if (seenExt.has(extKey)) continue;
      seenExt.set(extKey, true);
    }
    deduped.push(c);
  }

  return deduped;
}

/**
 * Resolve the best local title candidate(s) for a file.
 *
 * Returns:
 *   { resolved: true,  titleId }           — an unambiguous match
 *   { resolved: false, ambiguous: true,
 *     candidates: [...], reason }          — near-ties → ask the user
 *   { resolved: false, ambiguous: false }  — no candidate → create new
 *
 * @param {object} parsed
 * @param {string} [filePath]
 * @returns {object}
 */
/**
 * Replace a noise-only parsed title with the parent-folder name, which is
 * the only reliable offline signal when a filename is pure episode markers.
 * A folder name describes a show → the effective type is a series/anime.
 * @param {object} parsed
 * @param {string} [filePath]
 * @returns {object} Effective parse result (possibly unchanged)
 */
function applyFolderFallback(parsed, filePath) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const folderName = filePath ? getFolderHint(filePath) : '';
  if (folderName && isNoiseOnlyTitle(parsed) && normalizeTitle(folderName).length >= 3) {
    return {
      ...parsed,
      title: folderName,
      typeCandidate: parsed.typeCandidate === 'anime' ? 'anime' : 'series',
    };
  }
  return parsed;
}

function resolveLocalTitle(parsed, filePath) {
  if (!parsed || typeof parsed !== 'object' || !parsed.title) {
    console.warn('[matcher] resolveLocalTitle called with invalid parsed data:', parsed);
    return { resolved: false, ambiguous: false, candidates: [], effectiveParsed: parsed };
  }
  const effectiveParsed = applyFolderFallback(parsed, filePath);
  const candidates = findLocalTitleCandidates(effectiveParsed, filePath);
  if (candidates.length === 0) {
    return { resolved: false, ambiguous: false, candidates: [], effectiveParsed };
  }

  const best = candidates[0];
  const second = candidates[1];

  // Dominant, high-confidence winner → unambiguously the match.
  if (best.score >= STRONG_MATCH_THRESHOLD &&
      (!second || best.score - second.score >= AMBIGUOUS_NARROW_GAP)) {
    return { resolved: true, titleId: best.titleId, candidates: [best], effectiveParsed };
  }

  // A single plausible candidate (or a clear winner over the rest) is still
  // resolved — with no near-tie there is no duplicate risk in grouping onto it.
  if (best.score >= FUZZY_MATCH_THRESHOLD &&
      (!second || best.score - second.score > AMBIGUOUS_NARROW_GAP)) {
    return { resolved: true, titleId: best.titleId, candidates: [best], effectiveParsed };
  }

  // Several candidates are close together → genuinely ambiguous. Ask the
  // user which series the file belongs to so we never spawn a duplicate.
  const near = candidates.filter((c) => best.score - c.score <= AMBIGUOUS_NARROW_GAP);
  if (near.length >= 2) {
    return {
      resolved: false,
      ambiguous: true,
      candidates: near,
      effectiveParsed,
      reason:
        'Multiple existing series match this title closely. Pick the right one to avoid duplicates.',
    };
  }

  // A single weak candidate carries too little evidence — create a new entry
  // rather than corrupting an existing series with a wrong merge.
  return { resolved: false, ambiguous: false, candidates: [], effectiveParsed };
}

/**
 * Find an existing local title entry for parsed file metadata.
 * Compatible shim over resolveLocalTitle — returns the best exact-born id
 * or null (kept for callers that only need a single id).
 * @param {object} parsed - Result from parser.parseFilename()
 * @returns {number|null} Existing title id, or null
 */
function findLocalTitleId(parsed) {
  const resolved = findLocalTitleCandidates(parsed);
  if (resolved.length === 0) return null;
  const best = resolved[0];
  return best.score >= FUZZY_MATCH_THRESHOLD ? best.titleId : null;
}

/**
 * Phase 1 — Group a parsed file into a local title entry.
 * Pure database + string work, no network. Always succeeds (offline-safe).
 *
 * Filenames whose parser confidence is below {@link REVIEW_THRESHOLD} are
 * registered with match_confidence `flagged` so the UI can route them to the
 * "Needs Review" queue instead of silently showing a mistyped title.
 * @param {object} parsed - Result from parser.parseFilename()
 * @param {string} [filePath] - Full path (for folder-based aliases)
 * @returns {object} { title, ambiguous, candidates } — when ambiguous the
 *   title is the best-guess row (still grouped) and candidates lists the
 *   near-ties for the caller to offer as alternatives.
 */
function groupLocalTitle(parsed, filePath) {
  if (!parsed || typeof parsed !== 'object' || !parsed.title) {
    console.warn('[matcher] groupLocalTitle called with invalid parsed data:', parsed);
    return { title: null, ambiguous: false, candidates: [] };
  }
  const resolution = resolveLocalTitle(parsed, filePath);

  let titleId = null;
  let ambiguous = false;
  let candidates = [];

  if (resolution.resolved) {
    titleId = resolution.titleId;
  } else if (resolution.ambiguous) {
    ambiguous = true;
    candidates = resolution.candidates;
    // Best-effort: still group onto the strongest candidate so the file
    // always has a home — the caller may later re-point it via fixMatch.
    titleId = resolution.candidates && resolution.candidates.length ? resolution.candidates[0].titleId : null;
  }

  if (titleId) {
    const existing = libraryStore.getTitleById(titleId);
    // Backfill a missing year from a later, better-parsed file — but never
    // mutate a user-locked (manual) row.
    if (existing && !existing.year && parsed.year && existing.match_confidence !== 'manual') {
      try {
        libraryStore.upsertTitle({ ...existing, year: parsed.year });
      } catch (err) {
        console.warn('[matcher] groupLocalTitle: year backfill failed:', err && err.message ? err.message : err);
      }
    }
    return { title: libraryStore.getTitleById(titleId) || existing || null, ambiguous, candidates };
  }

  const lowConfidence = typeof parsed.confidence === 'number' && parsed.confidence < REVIEW_THRESHOLD;
  const effectiveTitle = (resolution.effectiveParsed && resolution.effectiveParsed.title) || parsed.title;
  const effectiveType = (resolution.effectiveParsed && resolution.effectiveParsed.typeCandidate) || parsed.typeCandidate;

  // Do NOT auto-create a series without strong evidence it is a distinct one.
  // A real, word-based title (or a usable parent-folder name) is strong
  // evidence; pure episode markers / junk at a drive root is not. Weak files
  // are kept unmatched (`title_id = null`) and routed to the batch-review
  // modal, where the user can attach them to an existing series or explicitly
  // create a new one — instead of quietly spawning duplicate/junk series.
  const folderName = filePath ? getFolderHint(filePath) : '';
  const hasFolder = !!folderName && normalizeTitle(folderName).length >= 3;
  const strongTitle = !isNoiseOnlyTitle(parsed) && normalizeTitle(parsed.title).length >= 3;
  if (!hasFolder && !strongTitle) {
    console.warn(`[matcher] groupLocalTitle: "${parsed.title || filePath || '(no title)'}" has no strong series evidence — kept unmatched (pending user review)`);
    return { title: null, ambiguous: false, candidates: [], pending: true };
  }

  const createdTitle = effectiveTitle;
  const createdType = effectiveType;
  const createdId = libraryStore.upsertTitle({
    type: createdType,
    title: createdTitle,
    year: parsed.year || null,
    match_confidence: lowConfidence ? 'flagged' : 'local',
  });

  // Register the parsed title and (when available) the folder name as aliases
  // so a different fan-sub name of the same series groups onto THIS row later.
  try {
    libraryStore.addTitleAlias(createdId, parsed.title, 'alternate');
    if (folderName && normalizeTitle(folderName) !== normalizeTitle(createdTitle)) {
      libraryStore.addTitleAlias(createdId, folderName, 'folder');
    }
  } catch (err) {
    console.warn('[matcher] groupLocalTitle: alias registration failed:', err && err.message ? err.message : err);
  }

  return { title: libraryStore.getTitleById(createdId) || null, ambiguous: false, candidates: [] };
}

/**
 * Phase 2 — Opportunistically enrich a local title with external metadata.
 * Best-effort only: never throws, never re-groups, never overwrites a
 * `manual` match and never queries for `flagged` (uncertain) ones — those
 * are left for the user to fix in the review queue. Offline / timeout /
 * low-confidence ⇒ local entry kept.
 * @param {number} titleId - Local title id from groupLocalTitle()
 * @param {object} parsed - Result from parser.parseFilename()
 * @returns {Promise<object>} Final title record (enriched or still local)
 */
async function enrichTitleWithLookup(titleId, parsed) {
  let current;
  try {
    current = libraryStore.getTitleById(titleId);
  } catch (err) {
    console.warn(`[matcher] enrichTitleWithLookup: failed to load title #${titleId}:`, err && err.message ? err.message : err);
    return null;
  }
  if (!current) {
    console.warn(`[matcher] enrichTitleWithLookup: title #${titleId} not found — skipping enrichment`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.title) {
    console.warn('[matcher] enrichTitleWithLookup: invalid parsed data — skipping enrichment');
    return current;
  }
  if (current.match_confidence === 'manual' || current.match_confidence === 'flagged') return current;
  // Already enriched — one lookup per title is enough.
  if (current.tmdb_id || current.anilist_id || current.mal_id) return current;

  const title = parsed.title;
  const year = parsed.year;
  const typeCandidate = parsed.typeCandidate;

  // Never query metadata with an empty/noise-only title — nothing useful
  // can be found and it would just echo a placeholder back.
  if (isNoiseOnlyTitle(parsed) || !normalizeTitle(title)) {
    return current;
  }

  // Score ALL relevant sources and keep the best hit instead of stopping at
  // the first source that returns anything. This is what makes Asian media
  // work: a fansubbed K-drama (`[Viki] Crash Landing on You - 01`, guessed
  // `anime`) is scored against TMDB *and* AniList/Jikan, so TMDB's correct
  // K-drama entry wins over a weak anime match. CJK-native queries work
  // because AniList matches native titles and TMDB gets a script-based
  // locale (ko-KR/zh-CN/ja-JP) via detectLocale().
  const isShow = typeCandidate !== 'movie';
  const queries = isShow
    ? [
        searchSeries(title, year), // TMDB (+TVMaze fallback), best for K/C-drama
        searchAnime(title), // AniList (+Kitsu fallback), best for anime/donghua
        searchJikan(title), // MyAnimeList, extra donghua/obscure coverage
      ]
    : [
        searchMovie(title, year),
        searchSeries(title, year),
      ];

  let candidates = [];
  try {
    candidates = await gatherCandidates(queries);
  } catch (err) {
    // Offline, DNS failure, timeout — keep local grouping.
    console.warn(`[matcher] enrichTitleWithLookup: metadata lookup for "${title}" failed:`, err && err.message ? err.message : err);
    return libraryStore.getTitleById(titleId);
  }

  // Ignore offline placeholder results that carry no external ID:
  // they are not real metadata, just an echo of the query.
  const real = (candidates || []).filter(
    (c) => c && (c.tmdb_id != null || c.anilist_id != null || c.mal_id != null || c.tvmaze_id != null)
  );
  if (real.length === 0) return libraryStore.getTitleById(titleId);

  let bestMatch = null;
  let highestScore = 0;
  for (const candidate of real) {
    if (!candidate) continue;
    const score = scoreCandidate(title, year, candidate);
    if (score > highestScore) {
      highestScore = score;
      bestMatch = candidate;
    }
  }

  // Only high-confidence hits enrich the entry. Anything weaker keeps the
  // local grouping untouched so a later manual fix-match can refine it.
  if (bestMatch && highestScore >= AUTO_MATCH_THRESHOLD) {
    try {
      libraryStore.upsertTitle({
        id: titleId,
        type: bestMatch.type,
        title: bestMatch.title || current.title,
        original_title: bestMatch.original_title || null,
        year: bestMatch.year ?? year ?? null,
        overview: bestMatch.overview || null,
        poster_url: bestMatch.poster_url || null,
        backdrop_url: bestMatch.backdrop_url || null,
        tmdb_id: bestMatch.tmdb_id || null,
        anilist_id: bestMatch.anilist_id || null,
        mal_id: bestMatch.mal_id || null,
        match_confidence: 'auto',
      });

      // Register the metadata-provided alt names and synonyms as aliases so
      // future files scanned under ANY of those names group onto this series
      // instead of spawning a duplicate row.
      const synonymList = Array.isArray(bestMatch.synonyms) ? bestMatch.synonyms : [];
      const aliasCandidates = [bestMatch.original_title, ...synonymList];
      for (const alias of aliasCandidates) {
        if (alias && bestMatch.title && normalizeTitle(alias) !== normalizeTitle(bestMatch.title)) {
          try {
            libraryStore.addTitleAlias(titleId, alias, 'synonym');
          } catch (err) {
            console.warn(`[matcher] enrichTitleWithLookup: alias registration for "${alias}" failed:`, err && err.message ? err.message : err);
          }
        }
      }
    } catch (err) {
      // local row is still valid — enrichment is best-effort
      console.warn(`[matcher] enrichTitleWithLookup: enrichment write for "${title}" failed:`, err && err.message ? err.message : err);
    }
  } else if (bestMatch && highestScore < AUTO_MATCH_THRESHOLD) {
    console.warn(`[matcher] enrichTitleWithLookup: "${title}" only reached ${highestScore.toFixed(2)} with "${bestMatch.title}" — keeping local entry (pending user fix).`);
  } else {
    console.warn(`[matcher] enrichTitleWithLookup: no usable metadata candidates for "${title}".`);
  }

  return libraryStore.getTitleById(titleId) || current;
}

/**
 * Match a parsed file to a title record: local grouping first (offline),
 * external enrichment second (opportunistic), then episode + file rows.
 *
 * The `title_id` stored on the episodes/files rows is the SERIES id — every
 * episode of the same show points at the same titles row, so series and
 * episodes can never drift apart.
 *
 * @param {object} parsedFile - Result from parser.parseFilename(filePath)
 * @param {string} filePath - Absolute file path (also used for folder-name
 *   alias inference)
 * @param {object} [opts] - { offline?: boolean, fileSize?: number, lastModified?: string }
 * @returns {Promise<object>} The final title record, with two extra
 *   properties when the match was ambiguous:
 *     - `ambiguous` (boolean): matched several existing series nearly equally
 *     - `candidates` (array): the near-ties for the UI to confirm
 */
async function matchFileToTitle(parsedFile, filePath, opts = {}) {
  if (!parsedFile || typeof parsedFile !== 'object') {
    console.warn(`[matcher] matchFileToTitle: invalid parsed data for "${filePath || '(no path)'}" — recording as ungrouped`);
    parsedFile = { rawName: filePath || '', title: '', year: null, season: null, episode: null, typeCandidate: 'movie', releaseGroup: null, confidence: 0, needsReview: true };
    opts = opts || {};
    if (filePath) {
      try {
        libraryStore.upsertFile({
          file_path: filePath,
          title_id: null,
          season_number: null,
          episode_number: null,
          raw_parse_json: JSON.stringify(parsedFile),
          file_size: opts.fileSize ?? null,
          last_modified: opts.lastModified ?? null,
        });
      } catch (err) {
        console.warn('[matcher] matchFileToTitle: failed to record ungrouped file:', err && err.message ? err.message : err);
      }
    }
    return null;
  }

  // ── Phase 0 — online-first matching ────────────────────────────────────
  // When not explicitly offline, attempt to resolve the file against the
  // live metadata providers first. If a confident match is found, the
  // filename-guess local row is MERGED into the verified online row so the
  // library stays deduplicated.
  let grouped = null;
  let onlineHit = null;
  let mergedFrom = null;
  const offline = opts.offline === true;

  // Skip the online lookup entirely for files that already live on a
  // verified (externally keyed) or user-manual title: they were matched in a
  // previous online pass and re-querying every file on every re-scan would
  // cost a network call each. The offline local grouping below re-anchors
  // them and is a no-op for manual (they are skipped by the caller anyway).
  let alreadyVerified = false;
  if (!offline && filePath) {
    try {
      const existingFile = libraryStore.getFileByPath(filePath);
      if (existingFile && existingFile.title_id) {
        const t = libraryStore.getTitleById(existingFile.title_id);
        alreadyVerified = !!(
          t &&
          (t.match_confidence === 'manual' || t.tmdb_id || t.anilist_id || t.mal_id)
        );
      }
    } catch (err) {
      console.warn('[matcher] matchFileToTitle: title check for existing file failed:', err && err.message ? err.message : err);
    }
  }

  const onlineAttempted = !offline && !alreadyVerified;
  if (onlineAttempted) {
    try {
      onlineHit = await matchOnlineTitle(parsedFile, filePath);
    } catch (err) {
      console.warn(`[matcher] matchFileToTitle: online lookup for "${parsedFile.title || filePath || ''}" failed:`, err && err.message ? err.message : err);
    }
  }

  if (onlineHit && onlineHit.title && onlineHit.title.id != null) {
    const targetId = onlineHit.title.id;

    // Replace & merge any prior filename-guess row this file pointed at.
    if (filePath) {
      try {
        const existingFile = libraryStore.getFileByPath(filePath);
        const sourceId = existingFile && existingFile.title_id;
        if (sourceId && sourceId !== targetId) {
          const source = libraryStore.getTitleById(sourceId);
          if (source &&
              source.match_confidence !== 'manual' &&
              source.tmdb_id == null && source.anilist_id == null && source.mal_id == null) {
            libraryStore.mergeTitle(sourceId, targetId);
            mergedFrom = sourceId;
          }
        }
      } catch (err) {
        console.warn(`[matcher] matchFileToTitle: merge failed for "${filePath}":`, err && err.message ? err.message : err);
      }
    }

    // Online episode metadata (names / stills / air dates) — best-effort.
    try {
      await fillEpisodeMetadata(targetId, onlineHit.hit, parsedFile.season || 1);
    } catch (err) {
      console.warn(`[matcher] matchFileToTitle: online episode fill failed for "${filePath || ''}":`, err && err.message ? err.message : err);
    }

    // File record — pointed directly at the verified row.
    try {
      libraryStore.upsertFile({
        file_path: filePath,
        title_id: targetId,
        season_number: parsedFile.season || 1,
        episode_number: parsedFile.episode || null,
        raw_parse_json: JSON.stringify(parsedFile),
        file_size: opts.fileSize ?? null,
        last_modified: opts.lastModified ?? null,
      });
    } catch (err) {
      console.warn('[matcher] matchFileToTitle: file record failed:', err && err.message ? err.message : err);
    }

    let finalTitle = null;
    try { finalTitle = libraryStore.getTitleById(targetId); } catch { finalTitle = onlineHit.title; }
    if (finalTitle && typeof finalTitle === 'object') {
      finalTitle.ambiguous = false;
      finalTitle.candidates = [];
    }
    return finalTitle;
  }

  // ── Phase 1 — offline-local grouping (also the fallback when online
  //    lookup found no confident hit) ──────────────────────────────────────
  try {
    grouped = groupLocalTitle(parsedFile, filePath);
  } catch (err) {
    console.warn(`[matcher] matchFileToTitle: local grouping failed for "${filePath || parsedFile.rawName || ''}":`, err && err.message ? err.message : err);
    grouped = { title: null, ambiguous: false, candidates: [] };
  }
  let title = grouped.title || null;
  let titleId = title && title.id != null ? title.id : null;

  // Phase 2 — legacy best-effort enrichment. Runs only when no online pass
  // was attempted (offline mode with an explicit network-enrich request from
  // legacy callers). Online-first mode already performed the network lookup
  // in Phase 0, so re-enriching here would just hit the network twice.
  if (titleId && !offline && !onlineAttempted) {
    try {
      const enriched = await enrichTitleWithLookup(titleId, parsedFile);
      title = enriched || title;
      titleId = title && title.id != null ? title.id : titleId;
    } catch (err) {
      console.warn(`[matcher] matchFileToTitle: enrichment failed for "${parsedFile.title || filePath || ''}":`, err && err.message ? err.message : err);
      try {
        title = libraryStore.getTitleById(titleId);
      } catch {
        title = null;
      }
    }
  }

  // Episode structure for episodic content (local data only).
  if (parsedFile.episode && titleId) {
    try {
      libraryStore.upsertEpisode({
        title_id: titleId,
        season_number: parsedFile.season || 1,
        episode_number: parsedFile.episode,
        name: `Episode ${parsedFile.episode}`,
      });
    } catch (err) {
      console.warn(`[matcher] matchFileToTitle: episode upsert failed for "${filePath || ''}":`, err && err.message ? err.message : err);
    }
  }

  // File record always written — this is what makes the library work offline.
  // title_id here is the matched SERIES id, so every file of a season points
  // at one series row (never a per-episode series). A null title_id records
  // the file as unmatched/pending review instead of being dropped.
  try {
    libraryStore.upsertFile({
      file_path: filePath,
      title_id: titleId,
      season_number: parsedFile.season || 1,
      episode_number: parsedFile.episode || null,
      raw_parse_json: JSON.stringify(parsedFile),
      file_size: opts.fileSize ?? null,
      last_modified: opts.lastModified ?? null,
    });
  } catch (err) {
    console.warn(`[matcher] matchFileToTitle: file record failed for "${filePath || ''}":`, err && err.message ? err.message : err);
  }

  if (!titleId) {
    console.warn(`[matcher] matchFileToTitle: "${filePath || parsedFile.rawName || ''}" left unmatched — will be shown as pending.`);
  }

  if (titleId) {
    try {
      title = libraryStore.getTitleById(titleId);
    } catch (err) {
      console.warn(`[matcher] matchFileToTitle: reload of title #${titleId} failed:`, err && err.message ? err.message : err);
      title = null;
    }
  }
  if (title && typeof title === 'object') {
    title.ambiguous = !!grouped.ambiguous &&
      (!title.match_confidence || title.match_confidence !== 'manual');
    title.candidates = grouped.candidates || [];
  }
  return title;
}

/**
 * Group a collection of scanned files into Series Candidates BEFORE matching & enrichment.
 * This is the series-level pre-grouping engine.
 *
 * @param {Array<{filePath: string, size?: number, mtime?: number, parsed?: object}>} items
 * @param {object} [opts] - { offline?: boolean }
 * @returns {Promise<{
 *   scannedCount: number,
 *   matchedCount: number,
 *   unresolvedCount: number,
 *   seriesGroups: Array<object>,
 *   ambiguous: Array<object>,
 *   unresolved: Array<object>,
 *   diagnostics: Array<object>
 * }>}
 */
async function groupFilesInBatch(items, opts = {}) {
  if (!Array.isArray(items)) return { scannedCount: 0, matchedCount: 0, unresolvedCount: 0, seriesGroups: [], ambiguous: [], unresolved: [], diagnostics: [] };

  const offline = opts.offline === true;
  const { parseFilename, getGroupKey } = require('./parser');

  // Step 1. Parse all items and compute group keys + folder hints
  const parsedItems = [];
  for (const item of items) {
    if (!item || !item.filePath) continue;
    const parsed = item.parsed || parseFilename(item.filePath);
    const effectiveParsed = applyFolderFallback(parsed, item.filePath);
    const folderHint = getFolderHint(item.filePath);
    const groupKey = getGroupKey(effectiveParsed);

    logDiagnosticStep(item.filePath, 'parse', {
      rawName: parsed.rawName,
      parsedTitle: parsed.title,
      effectiveTitle: effectiveParsed.title,
      season: parsed.season,
      episode: parsed.episode,
      typeCandidate: parsed.typeCandidate,
      confidence: parsed.confidence,
      groupKey,
      folderHint,
    });

    parsedItems.push({
      filePath: item.filePath,
      size: item.size ?? item.fileSize ?? null,
      mtime: item.mtime ?? item.lastModified ?? null,
      parsed,
      effectiveParsed,
      folderHint,
      groupKey,
    });
  }

  // Step 2. Group items into Series Candidates by groupKey + folderHint
  const candidatesByKey = new Map();
  for (const pItem of parsedItems) {
    let key = pItem.groupKey;
    
    // If key is weak (e.g. show| bare marker) but folderHint exists, key by folderHint
    if ((!pItem.effectiveParsed.title || isNoiseOnlyTitle(pItem.effectiveParsed)) && pItem.folderHint) {
      key = `show|${normalizeTitle(pItem.folderHint)}`;
    }

    if (!candidatesByKey.has(key)) {
      candidatesByKey.set(key, {
        groupKey: key,
        canonicalTitle: pItem.effectiveParsed.title || pItem.folderHint || pItem.parsed.rawName,
        folderHint: pItem.folderHint,
        typeCandidate: pItem.effectiveParsed.typeCandidate || 'series',
        year: pItem.effectiveParsed.year || null,
        files: [],
        seasons: new Set(),
      });
    }

    const candidateGroup = candidatesByKey.get(key);
    candidateGroup.files.push(pItem);
    if (pItem.parsed.season) candidateGroup.seasons.add(pItem.parsed.season);

    // Pick the most descriptive canonical title if candidate currently has a weaker one
    if (isNoiseOnlyTitle({ title: candidateGroup.canonicalTitle }) && !isNoiseOnlyTitle(pItem.effectiveParsed)) {
      candidateGroup.canonicalTitle = pItem.effectiveParsed.title;
    }
  }

  const seriesGroups = [];
  const ambiguous = [];
  const unresolved = [];
  let matchedCount = 0;

  // Step 3. For each Series Candidate, perform local matching and (if online) single enrichment lookup
  for (const [key, group] of candidatesByKey.entries()) {
    logDiagnosticStep(null, 'group_candidate', {
      groupKey: key,
      canonicalTitle: group.canonicalTitle,
      fileCount: group.files.length,
      seasons: [...group.seasons],
    });

    const sampleFile = group.files[0];
    const sampleParsed = group.files.find((f) => !isNoiseOnlyTitle(f.effectiveParsed))?.effectiveParsed || sampleFile.effectiveParsed;

    // Check online-first resolution if online
    let onlineHit = null;

    // Check if the title is already verified / manual in DB for sampleFile
    let existingFileVerified = false;
    if (!offline && sampleFile.filePath) {
      try {
        const existingFile = libraryStore.getFileByPath(sampleFile.filePath);
        if (existingFile && existingFile.title_id) {
          const t = libraryStore.getTitleById(existingFile.title_id);
          existingFileVerified = !!(t && (t.match_confidence === 'manual' || t.tmdb_id || t.anilist_id || t.mal_id));
        }
      } catch { /* ignore */ }
    }

    if (!offline && !existingFileVerified) {
      try {
        onlineHit = await matchOnlineTitle(sampleParsed, sampleFile.filePath);
        logDiagnosticStep(sampleFile.filePath, 'online_lookup', {
          queriedTitle: sampleParsed.title,
          hitFound: !!onlineHit,
          matchedTitle: onlineHit && onlineHit.title ? onlineHit.title.title : null,
          externalId: onlineHit && onlineHit.hit ? (onlineHit.hit.tmdb_id || onlineHit.hit.anilist_id || onlineHit.hit.mal_id) : null,
        });
      } catch (err) {
        logDiagnosticStep(sampleFile.filePath, 'online_lookup_error', { error: err && err.message ? err.message : String(err) });
      }
    }

    let targetTitleId = null;
    let isAmbiguous = false;
    let matchCandidates = [];
    let decisionReason = '';

    if (onlineHit && onlineHit.title && onlineHit.title.id != null) {
      targetTitleId = onlineHit.title.id;
      decisionReason = `Grouped onto verified online series "${onlineHit.title.title}" (ID #${targetTitleId})`;
    } else {
      // Local DB matching
      const resolution = resolveLocalTitle(sampleParsed, sampleFile.filePath);
      logDiagnosticStep(sampleFile.filePath, 'local_match', {
        resolved: resolution.resolved,
        ambiguous: resolution.ambiguous,
        candidateCount: resolution.candidates ? resolution.candidates.length : 0,
        topScore: resolution.candidates && resolution.candidates[0] ? resolution.candidates[0].score : 0,
      });

      if (resolution.resolved) {
        targetTitleId = resolution.titleId;
        const matchedRow = libraryStore.getTitleById(targetTitleId);
        decisionReason = `Joined existing local series "${matchedRow ? matchedRow.title : ''}" (ID #${targetTitleId})`;
      } else if (resolution.ambiguous) {
        isAmbiguous = true;
        matchCandidates = resolution.candidates || [];
        targetTitleId = matchCandidates.length > 0 ? matchCandidates[0].titleId : null;
        decisionReason = `Ambiguous match across ${matchCandidates.length} existing series; assigned best guess ID #${targetTitleId}`;
      } else {
        // Create new series row if strong title evidence exists
        const folderName = sampleFile.filePath ? getFolderHint(sampleFile.filePath) : '';
        const hasFolder = !!folderName && normalizeTitle(folderName).length >= 3;
        const strongTitle = !isNoiseOnlyTitle(sampleParsed) && normalizeTitle(sampleParsed.title).length >= 3;

        if (!hasFolder && !strongTitle) {
          decisionReason = `Left unmatched — title "${sampleParsed.title || '(none)'}" lacks strong series evidence`;
          for (const f of group.files) {
            unresolved.push({
              filePath: f.filePath,
              parsedTitle: f.parsed.title,
              currentTitleId: null,
              candidates: findLocalTitleCandidates(f.parsed, f.filePath),
              ambiguous: false,
            });
            logDiagnosticStep(f.filePath, 'decision', {
              action: 'left_unmatched',
              reason: decisionReason,
            });
          }
          continue; // skip DB persistence of title for this group
        }

        const lowConfidence = typeof sampleParsed.confidence === 'number' && sampleParsed.confidence < REVIEW_THRESHOLD;
        const createdId = libraryStore.upsertTitle({
          type: sampleParsed.typeCandidate || 'series',
          title: group.canonicalTitle,
          year: sampleParsed.year || null,
          match_confidence: lowConfidence ? 'flagged' : 'local',
        });
        targetTitleId = createdId;
        decisionReason = `Created new series record "#${createdId}" for "${group.canonicalTitle}" (no existing series matched above threshold)`;

        try {
          libraryStore.addTitleAlias(createdId, sampleParsed.title, 'alternate');
          if (folderName && normalizeTitle(folderName) !== normalizeTitle(group.canonicalTitle)) {
            libraryStore.addTitleAlias(createdId, folderName, 'folder');
          }
        } catch { /* ignore */ }
      }
    }

    // Step 4. Attach all member files & episodes to targetTitleId
    if (targetTitleId) {
      for (const f of group.files) {
        try {
          libraryStore.upsertFile({
            file_path: f.filePath,
            title_id: targetTitleId,
            season_number: f.parsed.season || 1,
            episode_number: f.parsed.episode || null,
            raw_parse_json: JSON.stringify(f.parsed),
            file_size: f.size,
            last_modified: f.mtime,
          });

          if (f.parsed.episode) {
            libraryStore.upsertEpisode({
              title_id: targetTitleId,
              season_number: f.parsed.season || 1,
              episode_number: f.parsed.episode,
              name: `Episode ${f.parsed.episode}`,
            });
          }

          matchedCount++;

          logDiagnosticStep(f.filePath, 'decision', {
            action: isAmbiguous ? 'ambiguous_grouping' : 'joined_series',
            matchedSeriesId: targetTitleId,
            reason: decisionReason,
          });

          if (isAmbiguous) {
            ambiguous.push({
              filePath: f.filePath,
              parsedTitle: f.parsed.title,
              candidates: matchCandidates,
              currentTitleId: targetTitleId,
            });
          }
        } catch (err) {
          logDiagnosticStep(f.filePath, 'error', { error: err && err.message ? err.message : String(err) });
        }
      }

      // Step 5. Fill per-episode online metadata once per season if online hit
      if (onlineHit && onlineHit.hit) {
        const seasonSet = group.seasons.size > 0 ? group.seasons : new Set([1]);
        for (const seasonNum of seasonSet) {
          try {
            await fillEpisodeMetadata(targetTitleId, onlineHit.hit, seasonNum);
          } catch (err) {
            logDiagnosticStep(null, 'episode_metadata_error', { season: seasonNum, error: err && err.message ? err.message : String(err) });
          }
        }
      }

      const finalTitleRow = libraryStore.getTitleById(targetTitleId);
      seriesGroups.push({
        canonicalTitle: group.canonicalTitle,
        groupKey: key,
        folderHint: group.folderHint,
        type: group.typeCandidate,
        matchedTitle: finalTitleRow,
        ambiguous: isAmbiguous,
        candidates: matchCandidates,
        fileCount: group.files.length,
        decisionReason,
      });
    }
  }

  return {
    scannedCount: items.length,
    matchedCount,
    unresolvedCount: unresolved.length,
    seriesGroups,
    ambiguous,
    unresolved,
    diagnostics: getPipelineDiagnostics(),
  };
}

module.exports = {
  computeTitleSimilarity,
  scoreCandidate,
  matchFileToTitle,
  matchOnlineTitle,
  fillEpisodeMetadata,
  clearEpisodeMetadataCache,
  groupLocalTitle,
  enrichTitleWithLookup,
  findLocalTitleId,
  findLocalTitleCandidates,
  resolveLocalTitle,
  getFolderHint,
  isNoiseOnlyTitle,
  rememberManualMatch,
  getLearnedTitleFor,
  clearSessionLearnings,
  groupFilesInBatch,
  logDiagnosticStep,
  getPipelineDiagnostics,
  clearPipelineDiagnostics,
};
