'use strict';

/**
 * library-service.js — High-level library service combining DB, scanning, parsing, matching, and manual fix match logic
 */

const libraryStore = require('../db/library-store');
const { scanDirectory } = require('./scanner');
const { parseFilename } = require('./parser');
const {
  matchFileToTitle,
  scoreCandidate,
  findLocalTitleCandidates,
  rememberManualMatch,
  clearSessionLearnings,
  clearEpisodeMetadataCache,
  getFolderHint,
  isNoiseOnlyTitle,
  groupFilesInBatch,
  getPipelineDiagnostics,
  clearPipelineDiagnostics,
} = require('./matcher');
const { searchAnime } = require('./anilist');
const { searchJikan } = require('./jikan');
const { searchMovie, searchSeries } = require('./tmdb');
const connectivity = require('./connectivity');

/**
 * Map raw candidate records ({ titleId, score, confidence }) to the shape the
 * review UI consumes ({ titleId, title, score }), resolving row titles safely.
 * @param {Array<object>} candidates
 * @returns {Array<{titleId:number, title:string, score:number}>}
 */
function annotateCandidates(candidates = []) {
  return candidates
    .filter((c) => c && c.titleId != null)
    .map((c) => ({
      titleId: c.titleId,
      title: (() => {
        const t = libraryStore.getTitleById(c.titleId);
        return t ? t.title : `#${c.titleId}`;
      })(),
      score: c.score || 0,
    }));
}

/**
 * Scan a directory, parse video files, group at the series level, and save into SQLite.
 *
 * Matching order:
 *   1. ONLINE-first (when connected): files are pre-grouped into Series Candidates
 *      and resolved against live metadata providers ONCE per series.
 *   2. OFFLINE fallback: when disconnected (or when the online lookup found
 *      no confident hit), files are parsed and grouped locally at the series level.
 *
 * @param {string} folderPath - Target directory to scan
 * @param {object} [opts] - { offline?: boolean } — force skip all network
 * @returns {Promise<object>} Scan result, including an `ambiguous` array of
 *   matches the user should confirm and `diagnostics` array tracing every decision.
 */
async function scanFolder(folderPath, opts = {}) {
  if (!folderPath || typeof folderPath !== 'string') {
    console.warn('[library-service] scanFolder called without a valid path:', folderPath);
    return { folderPath: folderPath || null, scannedCount: 0, matchedCount: 0, unresolvedCount: 0, errors: [{ file: null, error: 'No scan path provided' }], ambiguous: [], unresolved: [], diagnostics: [] };
  }
  // Fresh training memory & diagnostic trace for THIS scan
  clearSessionLearnings();
  clearPipelineDiagnostics();

  try {
    libraryStore.addFolder(folderPath);
  } catch (err) {
    console.warn(`[library-service] scanFolder: failed to register folder "${folderPath}":`, err && err.message ? err.message : err);
  }
  const foundFiles = scanDirectory(folderPath);

  const batchRes = await groupFilesInBatch(foundFiles, {
    offline: opts.offline === true || !connectivity.isOnline(),
  });

  return {
    folderPath,
    scannedCount: batchRes.scannedCount,
    matchedCount: batchRes.matchedCount,
    unresolvedCount: batchRes.unresolvedCount,
    seriesGroups: batchRes.seriesGroups,
    errors: [],
    ambiguous: batchRes.ambiguous,
    unresolved: batchRes.unresolved,
    diagnostics: batchRes.diagnostics,
  };
}

/**
 * Confirm which existing series an ambiguous file belongs to. Re-points every
 * file + episode that was auto-grouped to the best-guess series onto the
 * confirmed series id, so no duplicate series rows are created.
 *
 * @param {number} filePath - Path of the ambiguous file
 * @param {number} targetTitleId - The series the user confirmed
 * @param {number} [sourceTitleId] - Title id the file currently points at
 *   (optional; defaults to the file's current title_id)
 * @returns {Promise<object>} New title record (or null if not found)
 */
async function confirmAmbiguousSeries(filePath, targetTitleId, sourceTitleId) {
  const file = libraryStore.getFileByPath(filePath);
  if (!file) return null;
  const parsed = parseFilename(filePath);

  const fromId = sourceTitleId || file.title_id;
  const target = libraryStore.getTitleById(targetTitleId);
  if (!target || fromId === targetTitleId) return target;

  // Re-point the file first.
  libraryStore.upsertFile({
    file_path: filePath,
    title_id: targetTitleId,
    season_number: file.season_number,
    episode_number: file.episode_number,
    raw_parse_json: file.raw_parse_json,
  });

  // Re-point any watch progress tied to the file.
  const progress = libraryStore.getWatchProgressByPath(filePath);
  if (progress) {
    libraryStore.updateWatchProgress({
      file_path: filePath,
      title_id: targetTitleId,
      season_number: file.season_number,
      episode_number: file.episode_number,
      progress_seconds: progress.progress_seconds,
      duration_seconds: progress.duration_seconds,
      completed: progress.completed,
    });
  }

  // Re-point the episode metadata row too, since the episodes table is
  // keyed by (title_id, season, episode).
  if (file.season_number != null && file.episode_number != null) {
    const existing = libraryStore
      .getEpisodesForTitle(fromId)
      .find((e) => e.season_number === file.season_number && e.episode_number === file.episode_number);

    if (existing) {
      try {
        libraryStore.upsertEpisode({
          title_id: targetTitleId,
          season_number: file.season_number,
          episode_number: file.episode_number,
          name: existing.name,
          overview: existing.overview,
          still_url: existing.still_url,
          air_date: existing.air_date,
        });
        // Remove the orphan episode row on the source series.
        const db = require('../db/database').getDb();
        db.prepare(
          `DELETE FROM episodes WHERE title_id = ? AND season_number = ? AND episode_number = ?`
        ).run(fromId, file.season_number, file.episode_number);
      } catch {
        /* non-fatal */
      }
    } else if (file.episode_number != null) {
      libraryStore.upsertEpisode({
        title_id: targetTitleId,
        season_number: file.season_number,
        episode_number: file.episode_number,
        name: `Episode ${file.episode_number}`,
      });
    }
  }

  // If the source series no longer has any files, adopt a neutral holiday:
  // move its aliases onto the confirmed series so discovery of the same show
  // under another name keeps grouping to the confirmed row.
  const remainingFiles = libraryStore.getFilesForTitle(fromId).filter((f) => f.file_path !== filePath);
  if (fromId !== targetTitleId && remainingFiles.length === 0) {
    const aliasList = libraryStore.getAliasesForTitle(fromId);
    for (const a of aliasList) {
      libraryStore.addTitleAlias(targetTitleId, a.alias, a.alias_type);
    }
    libraryStore.deleteTitle(fromId);
  }

  // Persist folder / parsed-title aliases on the confirmed row so FUTURE scans
  // (not just this one) group similar files onto it.
  const parsedTitle = parsed.title || '';
  if (parsedTitle && !isNoiseOnlyTitle(parsed)) {
    try {
      libraryStore.addTitleAlias(targetTitleId, parsedTitle, 'alternate');
    } catch (err) {
      console.warn('[library-service] confirmAmbiguousSeries: alias registration failed:', err && err.message ? err.message : err);
    }
  }
  const fileFolder = filePath ? getFolderHint(filePath) : '';
  if (fileFolder) {
    try {
      libraryStore.addTitleAlias(targetTitleId, fileFolder, 'folder');
    } catch (err) {
      console.warn('[library-service] confirmAmbiguousSeries: folder alias registration failed:', err && err.message ? err.message : err);
    }
  }

  // Use the confirmation as training data for the CURRENT scan — similar
  // files (same parsed title / folder / folder+season) re-resolve onto this
  // series without asking again.
  rememberManualMatch(filePath, parsed, targetTitleId);

  return libraryStore.getTitleById(targetTitleId);
}

/**
 * Apply a batch of user-confirmed matches (from the group review modal) and
 * use them as training data for the current scan.
 *
 * For each match:
 *   - attach the file (and its episode) to the chosen existing series, OR
 *   - create a brand-new series when the user explicitly says so
 *   - record the mapping in the matcher's session memory (parsed title +
 *     folder + folder/season) and register persistent aliases.
 *
 * Afterwards it RE-CHECKS every previously unmatched file (and every other
 * uncertain file passed via `opts.recheckPaths`): similar files now snap onto
 * the confirmed series instead of asking again. Whatever is still unresolved
 * is returned so the UI can ask once more, as a group.
 *
 * @param {Array<{filePath:string, titleId?:number,
 *   createNew?:{title:string, type?:string, year?:number}}>} matches
 * @param {object} [opts] - { recheckPaths?: string[] }
 * @returns {Promise<{ applied:object[], resolved:string[], stillUnresolved:object[] }>}
 */
async function applyManualMatches(matches = [], opts = {}) {
  const explicitPaths = new Set();
  const applied = [];
  const recheckPaths = new Set((opts.recheckPaths || []).filter((p) => p));

  for (const m of matches) {
    if (!m || !m.filePath) {
      console.warn('[library-service] applyManualMatches: match without filePath — skipped');
      continue;
    }
    explicitPaths.add(m.filePath);
    const parsed = parseFilename(m.filePath);
    const existingFile = libraryStore.getFileByPath(m.filePath);

    let targetId = m.titleId != null ? m.titleId : null;

    // Explicit "this is a brand-new series" from the user is strong intent:
    // create the row here instead of letting the scanner guess.
    if (!targetId && m.createNew && (m.createNew.title || parsed.title)) {
      targetId = libraryStore.upsertTitle({
        type: m.createNew.type || parsed.typeCandidate || 'series',
        title: m.createNew.title || parsed.title,
        year: (m.createNew.year != null ? m.createNew.year : parsed.year) || null,
        match_confidence: 'manual',
      });
    }

    if (!targetId) {
      console.warn(`[library-service] applyManualMatches: no target for "${m.filePath}" — left as-is`);
      continue;
    }
    const target = libraryStore.getTitleById(targetId);
    if (!target) {
      console.warn(`[library-service] applyManualMatches: target series #${targetId} not found — skipped`);
      continue;
    }

    // Re-point the file (and episode/progress) onto the confirmed series.
    // Files that were never matched yet (pending review, title_id NULL) are
    // upgraded in place with the freshly-parsed episode so the confirmation
    // also records what episode this file is.
    if (existingFile && existingFile.title_id) {
      await confirmAmbiguousSeries(m.filePath, targetId, existingFile.title_id || (m.sourceTitleId != null ? m.sourceTitleId : undefined));
    } else {
      // File row missing (e.g. resolved in-memory before record) OR still
      // pending — write the file + its episode now.
      libraryStore.upsertFile({
        file_path: m.filePath,
        title_id: targetId,
        season_number: parsed.season || (existingFile && existingFile.season_number) || 1,
        episode_number: parsed.episode || (existingFile && existingFile.episode_number) || null,
        raw_parse_json: JSON.stringify(parsed),
      });
      if (parsed.episode) {
        libraryStore.upsertEpisode({
          title_id: targetId,
          season_number: parsed.season || 1,
          episode_number: parsed.episode,
          name: `Episode ${parsed.episode}`,
        });
      }
    }

    // Persist folder + real-title aliases so FUTURE scans group onto this row.
    if (parsed.title && !isNoiseOnlyTitle(parsed)) {
      try { libraryStore.addTitleAlias(targetId, parsed.title, 'alternate'); }
      catch (err) { console.warn('[library-service] applyManualMatches: alias registration failed:', err && err.message ? err.message : err); }
    }
    const appliedFolder = m.filePath ? getFolderHint(m.filePath) : '';
    if (appliedFolder) {
      try { libraryStore.addTitleAlias(targetId, appliedFolder, 'folder'); }
      catch (err) { console.warn('[library-service] applyManualMatches: folder alias registration failed:', err && err.message ? err.message : err); }
    }

    applied.push({ filePath: m.filePath, titleId: targetId });
    // Current-scan training — the core of "use the manual match as training data".
    rememberManualMatch(m.filePath, parsed, targetId);
  }

  // ── Recheck previously unmatched / still-uncertain files ──────────────────
  // Every file with title_id IS NULL from ANY scan counts as "previously
  // unmatched"; plus the other files from THIS round that were left uncertain.
  const dbUnmatched = libraryStore.getUnmatchedFiles();
  for (const f of dbUnmatched) if (f && f.file_path) recheckPaths.add(f.file_path);
  for (const p of explicitPaths) recheckPaths.delete(p); // user already decided

  const resolved = [];
  const stillUnresolved = [];

  for (const p of recheckPaths) {
    try {
      const file = libraryStore.getFileByPath(p);
      const currentTitleId = file && file.title_id ? file.title_id : null;
      const parsed = parseFilename(p);

      // Files skipped (e.g. manually locked) are left untouched.
      if (currentTitleId) {
        const cur = libraryStore.getTitleById(currentTitleId);
        if (cur && cur.match_confidence === 'manual') continue;
      }

      const result = await matchFileToTitle(parsed, p, { offline: true });
      if (!result || !result.id) {
        stillUnresolved.push({
          filePath: p,
          parsedTitle: parsed.title,
          currentTitleId,
          candidates: annotateCandidates(findLocalTitleCandidates(parsed, p)),
          ambiguous: false,
        });
        continue;
      }

      if (result.id !== currentTitleId && currentTitleId != null) {
        // Training re-pointed a previously-ambiguous file onto the confirmed
        // series — move it (episode + progress + alias cleanup included).
        await confirmAmbiguousSeries(p, result.id, currentTitleId);
        resolved.push(p);
      } else if (currentTitleId == null) {
        // A previously unmatched file found its series → already written by
        // matchFileToTitle; record it as resolved.
        resolved.push(p);
      }
    } catch (err) {
      console.warn(`[library-service] applyManualMatches: recheck failed for "${p}":`, err && err.message ? err.message : err);
      const parsed = parseFilename(p);
      stillUnresolved.push({
        filePath: p,
        parsedTitle: parsed.title,
        currentTitleId: (() => { const f = libraryStore.getFileByPath(p); return f && f.title_id ? f.title_id : null; })(),
        candidates: annotateCandidates(findLocalTitleCandidates(parsed, p)),
        ambiguous: false,
      });
    }
  }

  return { applied, resolved, stillUnresolved };
}

/**
 * Search metadata sources for candidates (used by Fix Match Modal UI).
 * Queries every relevant source and returns the merged pool re-ranked by
 * similarity to the query, so Asian titles are found regardless of the
 * type hint (e.g. a donghua found via AniList/Jikan for a 'series' hint).
 * @param {string} query - Search term
 * @param {string} typeHint - 'movie', 'series', or 'anime'
 */
async function searchMetadataCandidates(query, typeHint = 'movie') {
  if (!query || typeof query !== 'string' || !query.trim()) {
    console.warn('[library-service] searchMetadataCandidates called without a valid query:', query);
    return [];
  }
  const jobs =
    typeHint === 'anime'
      ? [searchAnime(query), searchJikan(query), searchSeries(query)]
      : typeHint === 'series'
        ? [searchSeries(query), searchAnime(query), searchJikan(query)]
        : [searchMovie(query), searchSeries(query), searchAnime(query)];

  const settled = await Promise.all(jobs.map((j) => j.catch(() => [])));
  const pool = settled.flat().filter(Boolean);

  // De-duplicate by external id, keeping first occurrence (source priority).
  const seen = new Set();
  const unique = [];
  for (const c of pool) {
    const key = c.tmdb_id != null ? `tmdb:${c.tmdb_id}` : c.anilist_id != null ? `ani:${c.anilist_id}` : c.mal_id != null ? `mal:${c.mal_id}` : c.tvmaze_id != null ? `tvm:${c.tvmaze_id}` : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    unique.push(c);
  }

  // Re-rank by similarity so the closest match surfaces first.
  unique.sort((a, b) => scoreCandidate(query, null, b) - scoreCandidate(query, null, a));
  return unique;
}

/**
 * Manually fix/update a title match in the database
 * @param {number} titleId - Existing title ID in database
 * @param {object} selectedCandidate - Selected metadata candidate
 */
async function fixMatch(titleId, selectedCandidate) {
  if (!titleId) {
    console.warn('[library-service] fixMatch called without a title id');
    return null;
  }
  if (!selectedCandidate) {
    console.warn(`[library-service] fixMatch called without a candidate for title #${titleId}`);
    return libraryStore.getTitleById(titleId) || null;
  }
  const updatedId = libraryStore.upsertTitle({
    id: titleId,
    type: selectedCandidate.type || 'movie',
    title: selectedCandidate.title,
    original_title: selectedCandidate.original_title || null,
    year: selectedCandidate.year || null,
    overview: selectedCandidate.overview || '',
    poster_url: selectedCandidate.poster_url || null,
    backdrop_url: selectedCandidate.backdrop_url || null,
    tmdb_id: selectedCandidate.tmdb_id || null,
    anilist_id: selectedCandidate.anilist_id || null,
    mal_id: selectedCandidate.mal_id || null,
    match_confidence: 'manual', // Lock in manual match!
  });

  // Register aliases so later scans of the same series under an alt name
  // find this (now manual) row instead of duplicating it.
  const synonymList = Array.isArray(selectedCandidate.synonyms) ? selectedCandidate.synonyms : [];
  const aliasCandidates = [selectedCandidate.original_title, ...synonymList];
  for (const alias of aliasCandidates) {
    if (alias && selectedCandidate.title && alias !== selectedCandidate.title) {
      try {
        libraryStore.addTitleAlias(updatedId, alias, 'synonym');
      } catch (err) {
        console.warn('[library-service] fixMatch: alias registration failed:', err && err.message ? err.message : err);
      }
    }
  }

  // Use the manual match as training data for the current scan: every file
  // attached to this series teaches the matcher that its title / folder maps
  // here, so similar ungrouped files resolve without asking again.
  try {
    const filesOf = libraryStore.getFilesForTitle(updatedId);
    for (const f of filesOf) {
      if (!f || !f.file_path) continue;
      rememberManualMatch(f.file_path, parseFilename(f.file_path), updatedId);
    }
  } catch (err) {
    console.warn('[library-service] fixMatch: training registration failed:', err && err.message ? err.message : err);
  }

  return libraryStore.getTitleById(updatedId);
}

/**
 * Titles the parser flagged as uncertain (match_confidence flagged/unmatched).
 * The renderer shows these in the "Needs Review" queue so the user can
 * confirm or re-match them instead of living with a guessed title.
 */
function getFlaggedTitles() {
  return libraryStore.getFlaggedTitles();
}

/**
 * Reset the whole library: clears opened folders and all fetched metadata
 * details (titles, episodes, files, watch progress).
 */
function resetLibrary() {
  clearSessionLearnings();
  return libraryStore.resetLibrary();
}

/**
 * Background re-parse when the connection comes back. Walks every title that
 * was grouped via filename parsing but never verified online (no external id,
 * not user-locked) plus every unmatched file, re-runs online-first matching
 * against the live metadata providers, and fills in the missing series +
 * episode details. Filename-guess rows are merged into the verified rows.
 *
 * Best-effort and non-blocking by nature: a failure, a timeout, or a stale
 * connectivity cache never throws — it just leaves that row for the next
 * reparse pass.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] - reparse even while offline/unchecked
 *   (used by tests; production relies on connectivity.status)
 * @returns {Promise<{online:boolean, titlesEnriched:number,
 *   filesReparsed:number, merged:number, errors:object[]}>}
 */
async function reparseIncompleteTitles(opts = {}) {
  const online = opts.force === true ? true : connectivity.isOnline();
  const errors = [];

  let titles = [];
  try { titles = libraryStore.getTitlesNeedingReparse() || []; } catch (err) {
    errors.push({ target: 'titles', error: err && err.message ? err.message : String(err) });
  }
  let unmatched = [];
  try { unmatched = libraryStore.getUnmatchedFiles() || []; } catch (err) {
    errors.push({ target: 'unmatched', error: err && err.message ? err.message : String(err) });
  }

  if (titles.length === 0 && unmatched.length === 0) {
    return { online, titlesEnriched: 0, filesReparsed: 0, merged: 0, errors };
  }

  // Fresh per-pass caches: re-fetch season episode lists and learned maps
  // only once per pass, not once per file.
  clearEpisodeMetadataCache();
  try {
    clearSessionLearnings();
  } catch (err) {
    errors.push({ target: 'learnings', error: err && err.message ? err.message : String(err) });
  }

  let titlesEnriched = 0;
  let filesReparsed = 0;
  let merged = 0;

  for (const t of titles) {
    if (!t || !t.id) continue;
    try {
      const reparseRes = await reparseOneTitle(t, opts);
      titlesEnriched += reparseRes.enriched;
      filesReparsed += reparseRes.files;
      merged += reparseRes.merged;
      errors.push(...reparseRes.errors);
    } catch (err) {
      errors.push({ target: `title:${t.id}`, error: err && err.message ? err.message : String(err) });
    }
  }

  for (const f of unmatched) {
    if (!f || !f.file_path) continue;
    try {
      const fileRes = await reparseOneFile(f.file_path, opts);
      filesReparsed += fileRes.files;
      merged += fileRes.merged;
      errors.push(...fileRes.errors);
    } catch (err) {
      errors.push({ target: `file:${f.file_path}`, error: err && err.message ? err.message : String(err) });
    }
  }

  return { online, titlesEnriched, filesReparsed, merged, errors };
}

/**
 * Reparse a single title needing verification: take its first file, run the
 * normal online-first match flow, and report what changed.
 * @param {object} titleRow
 * @param {object} opts
 * @returns {Promise<{enriched:number, files:number, merged:number, errors:object[]}>}
 */
async function reparseOneTitle(titleRow, opts) {
  const errors = [];
  let files = 0;
  let enriched = 0;
  let merged = 0;

  const paths = libraryStore.getFilePathsForTitle(titleRow.id) || [];
  if (paths.length === 0) return { enriched, files, merged, errors };

  const target = opts.force === true ? { offline: false } : { offline: !connectivity.isOnline() };
  for (const p of paths) {
    if (!p) continue;
    files++;
    try {
      const parsed = parseFilename(p);
      const result = await matchFileToTitle(parsed, p, target);
      if (result && result.id) {
        const after = libraryStore.getTitleById(result.id);
        if (after && (after.tmdb_id || after.anilist_id || after.mal_id) && after.match_confidence !== 'manual') {
          enriched++;
        }
        if (result.id !== titleRow.id) merged++;
      }
    } catch (err) {
      errors.push({ target: `file:${p}`, error: err && err.message ? err.message : String(err) });
    }
  }
  return { enriched, files, merged, errors };
}

/**
 * Reparse a single unmatched file (title_id NULL) via online-first matching.
 * @param {string} filePath
 * @param {object} opts
 * @returns {Promise<{files:number, merged:number, errors:object[]}>}
 */
async function reparseOneFile(filePath, opts) {
  const errors = [];
  try {
    const parsed = parseFilename(filePath);
    const result = await matchFileToTitle(parsed, filePath, opts.force === true ? { offline: false } : { offline: !connectivity.isOnline() });
    return { files: result && result.id ? 1 : 0, merged: 0, errors };
  } catch (err) {
    errors.push({ target: `file:${filePath}`, error: err && err.message ? err.message : String(err) });
    return { files: 0, merged: 0, errors };
  }
}

module.exports = {
  scanFolder,
  applyManualMatches,
  searchMetadataCandidates,
  fixMatch,
  confirmAmbiguousSeries,
  getFlaggedTitles,
  resetLibrary,
  reparseIncompleteTitles,
  getPipelineDiagnostics,
  clearPipelineDiagnostics,
  libraryStore,
};
