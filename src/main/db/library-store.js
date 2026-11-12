'use strict';

/**
 * library-store.js — Data access layer for local library SQLite operations
 */

const { getDb } = require('./database');

// ─── Folders ─────────────────────────────────────────────────────────────────

function addFolder(folderPath) {
  if (!folderPath || typeof folderPath !== 'string') {
    console.warn('[library-store] addFolder called without a valid path:', folderPath);
    return null;
  }
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO library_folders (folder_path, last_scanned_at)
    VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(folder_path) DO UPDATE SET last_scanned_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(folderPath);
}

function getAllFolders() {
  const db = getDb();
  return db.prepare(`SELECT * FROM library_folders ORDER BY id ASC`).all();
}

function removeFolder(folderPath) {
  const db = getDb();
  return db.prepare(`DELETE FROM library_folders WHERE folder_path = ?`).run(folderPath);
}

/**
 * Reset the whole library: clears opened folders, grouped titles, fetched
 * metadata details, episode/file rows, and watch progress.
 * Schema is preserved — only data rows are deleted (children first).
 * @returns {object} Row counts deleted per table
 */
function resetLibrary() {
  const db = getDb();
  const counts = {};
  for (const table of ['watch_progress', 'files', 'episodes', 'title_aliases', 'titles', 'library_folders']) {
    const info = db.prepare(`DELETE FROM ${table}`).run();
    counts[table] = info.changes ?? 0;
  }
  return counts;
}

// ─── Titles ──────────────────────────────────────────────────────────────────

function upsertTitle(titleData) {
  if (!titleData || typeof titleData !== 'object') {
    console.warn('[library-store] upsertTitle called without valid data:', titleData);
    return null;
  }
  const db = getDb();
  const {
    id,
    type,
    title,
    original_title = null,
    year = null,
    overview = null,
    poster_url = null,
    backdrop_url = null,
    tmdb_id = null,
    anilist_id = null,
    mal_id = null,
    match_confidence = 'auto',
  } = titleData;

  // A row without any displayable title is meaningless — fail gracefully
  // instead of letting the schema's NOT NULL constraint abort a scan.
  if (!title || typeof title !== 'string' || !title.trim()) {
    console.warn('[library-store] upsertTitle refused: missing/empty title for', titleData.id ? `title #${titleData.id}` : 'new row');
    return null;
  }

  if (id) {
    const stmt = db.prepare(`
      UPDATE titles SET
        type = ?, title = ?, original_title = ?, year = ?, overview = ?,
        poster_url = ?, backdrop_url = ?, tmdb_id = ?, anilist_id = ?,
        mal_id = ?, match_confidence = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    stmt.run(type, title, original_title, year, overview, poster_url, backdrop_url, tmdb_id, anilist_id, mal_id, match_confidence, id);
    return id;
  } else {
    const stmt = db.prepare(`
      INSERT INTO titles (type, title, original_title, year, overview, poster_url, backdrop_url, tmdb_id, anilist_id, mal_id, match_confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(type, title, original_title, year, overview, poster_url, backdrop_url, tmdb_id, anilist_id, mal_id, match_confidence);
    return info.lastInsertRowid;
  }
}

function getTitleById(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM titles WHERE id = ?`).get(id);
}

/**
 * Purge orphan title records from database (titles with 0 files pointing to them
 * that are not user-locked or verified).
 * @param {boolean} [force=false] - if true, purges immediately regardless of created_at age
 * @returns {number} number of orphan titles deleted
 */
function deleteOrphanTitles(force = false) {
  const db = getDb();
  const timeClause = force ? '' : `AND (created_at < datetime('now', '-1 minute') OR created_at IS NULL)`;
  const info = db.prepare(`
    DELETE FROM titles
    WHERE match_confidence NOT IN ('manual', 'auto')
      ${timeClause}
      AND id NOT IN (SELECT DISTINCT title_id FROM files WHERE title_id IS NOT NULL)
  `).run();
  if (info.changes > 0) {
    console.log(`[library-store] Purged ${info.changes} orphan title(s) from database.`);
  }
  return info.changes ?? 0;
}

function getAllTitles(filterType = null) {
  deleteOrphanTitles();
  const db = getDb();
  if (filterType && ['movie', 'series', 'anime'].includes(filterType)) {
    return db.prepare(`SELECT * FROM titles WHERE type = ? ORDER BY title ASC`).all(filterType);
  }
  return db.prepare(`SELECT * FROM titles ORDER BY title ASC`).all();
}

/**
 * Retrieve all titles that have been enriched with external metadata
 * (i.e. have at least one external ID). Returns only the fields needed
 * for alias-based matching: id, title, original_title, type, year, and
 * all external IDs.
 * @returns {object[]}
 */
function getEnrichedTitles() {
  const db = getDb();
  return db.prepare(`
    SELECT id, title, original_title, type, year, tmdb_id, anilist_id, mal_id
    FROM titles
    WHERE tmdb_id IS NOT NULL OR anilist_id IS NOT NULL OR mal_id IS NOT NULL
  `).all();
}

/**
 * Find an existing title row by any external metadata id (dedup key).
 * Used so an online-verified lookup groups onto the SAME row instead of
 * spawning a duplicate, even when the local alias name differs.
 * @param {{tmdb_id?:number|null, anilist_id?:number|null, mal_id?:number|null}} ids
 * @returns {object|null} matching title row (prefers tmdb, then anilist, then mal)
 */
function getTitleByExternalId(ids = {}) {
  const db = getDb();
  const checks = [
    ['tmdb_id', ids.tmdb_id],
    ['anilist_id', ids.anilist_id],
    ['mal_id', ids.mal_id],
  ];
  for (const [col, val] of checks) {
    if (val == null) continue;
    const row = db.prepare(`SELECT * FROM titles WHERE ${col} = ? LIMIT 1`).get(val);
    if (row) return row;
  }
  return null;
}

/**
 * Titles that were matched via filename parsing but never confirmed by an
 * online metadata lookup. These are the candidates for background reparse
 * when the connection returns: their external ID is still NULL and they are
 * not user-locked.
 * @returns {object[]} Title rows needing verification/merge
 */
function getTitlesNeedingReparse() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM titles
    WHERE tmdb_id IS NULL AND anilist_id IS NULL AND mal_id IS NULL
      AND match_confidence != 'manual'
    ORDER BY updated_at DESC
  `).all();
}

/**
 * Retrieve all file paths for a given title, used to infer folder-based
 * title aliases (the parent directory name of any file in the series).
 * @param {number} titleId
 * @returns {string[]}
 */
function getFilePathsForTitle(titleId) {
  const db = getDb();
  return db.prepare(`SELECT file_path FROM files WHERE title_id = ?`).all(titleId)
    .map((r) => r.file_path);
}

/**
 * Titles flagged by the parser as uncertain (low filename confidence) and
 * still awaiting a manual fix match. Drives the "Needs Review" queue.
 * @returns {object[]} Flagged title rows, newest first
 */
function getFlaggedTitles() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM titles
    WHERE match_confidence IN ('flagged', 'unmatched')
    ORDER BY updated_at DESC
  `).all();
}

function deleteTitle(id) {
  const db = getDb();
  return db.prepare(`DELETE FROM titles WHERE id = ?`).run(id);
}

/**
 * Merge a filename-guessed (or orphaned) title row into a verified one:
 * move its files, watch progress, episodes and aliases onto the target,
 * then delete the empty source row. Used by online-first matching / reparse
 * so the library never keeps duplicate rows after a real metadata hit.
 * Manual rows are never merged (caller guards that).
 *
 * Episode conflicts resolve in the target's favor: an episode the target
 * already knows about is kept; only missing episodes are inserted, and a
 * source episode row that is richer than the target's placeholder name is
 * allowed to upgrade it.
 *
 * @param {number} sourceId
 * @param {number} targetId
 * @returns {number} 1 when merged, 0 when nothing was done
 */
function mergeTitle(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return 0;
  const db = getDb();

  // Episodes: move only non-conflicting rows; enrich lives on the target.
  const srcEps = db.prepare(`SELECT * FROM episodes WHERE title_id = ?`).all(sourceId);
  for (const e of srcEps) {
    const existing = e && e.season_number != null && e.episode_number != null
      ? db.prepare(`SELECT id, name FROM episodes WHERE title_id = ? AND season_number = ? AND episode_number = ?`)
          .get(targetId, e.season_number, e.episode_number)
      : null;
    if (!existing) {
      db.prepare(`
        INSERT INTO episodes (title_id, season_number, episode_number, name, overview, still_url, air_date)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(targetId, e.season_number, e.episode_number, e.name, e.overview, e.still_url, e.air_date);
    } else if (e && e.name && !existing.name) {
      db.prepare(`UPDATE episodes SET name = ? WHERE id = ?`).run(e.name, existing.id);
    }
  }
  db.prepare(`DELETE FROM episodes WHERE title_id = ?`).run(sourceId);

  // Files + watch progress simply re-point to the verified row.
  db.prepare(`UPDATE files SET title_id = ? WHERE title_id = ?`).run(targetId, sourceId);
  db.prepare(`UPDATE watch_progress SET title_id = ? WHERE title_id = ?`).run(targetId, sourceId);

  // Keep every alias claim so future differently-named scans still group on.
  const aliases = db.prepare(`SELECT alias, alias_type FROM title_aliases WHERE title_id = ?`).all(sourceId);
  for (const a of aliases) {
    if (!a) continue;
    try { addTitleAlias(targetId, a.alias, a.alias_type || 'alternate'); }
    catch (err) { console.warn('[library-store] mergeTitle: alias copy failed:', err && err.message ? err.message : err); }
  }

  deleteTitle(sourceId);
  return 1;
}

// ─── Aliases ─────────────────────────────────────────────────────────────────

/**
 * Register an alternate title (normalized form) for a title entry. Used to
 * tie romanized/translated/synonym names and folder names back to the
 * canonical series so future scans of differently-named files group onto
 * the same series row.
 * @param {number} titleId
 * @param {string} alias    - Raw alias string (normalized before storing)
 * @param {string} aliasType - 'alternate'|'folder'|'synonym'
 */
function addTitleAlias(titleId, alias, aliasType = 'alternate') {
  if (!titleId || !alias) return null;
  const normalized = alias.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO title_aliases (title_id, alias, alias_type)
    VALUES (?, ?, ?)
    ON CONFLICT(title_id, alias) DO NOTHING
  `);
  stmt.run(titleId, normalized, aliasType);
  return normalized;
}

function getAliasesForTitle(titleId) {
  const db = getDb();
  return db.prepare(`
    SELECT alias, alias_type FROM title_aliases WHERE title_id = ?
  `).all(titleId);
}

/**
 * Find all title ids that claim the given normalized alias. Returns the
 * matching rows (id + alias_type) so callers can detect collisions
 * (two series sharing an alias) and resolve them manually.
 * @param {string} alias
 * @returns {object[]}
 */
function findTitleIdsByAlias(alias) {
  const normalized = alias.normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return [];
  const db = getDb();
  return db.prepare(`
    SELECT title_id, alias_type FROM title_aliases WHERE alias = ?
  `).all(normalized);
}

/**
 * Get every alias-to-title mapping for building an in-memory match index.
 * @returns {object[]} ({ title_id, alias, alias_type })
 */
function getAllAliases() {
  const db = getDb();
  return db.prepare(`
    SELECT title_id, alias, alias_type FROM title_aliases
  `).all();
}

function getAliasesForTitles(titleIds) {
  if (!titleIds || titleIds.length === 0) return [];
  const db = getDb();
  const placeholders = titleIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT title_id, alias, alias_type FROM title_aliases
    WHERE title_id IN (${placeholders})
  `).all(...titleIds);
}

// ─── Episodes ────────────────────────────────────────────────────────────────

function upsertEpisode(episodeData) {
  if (!episodeData || typeof episodeData !== 'object') {
    console.warn('[library-store] upsertEpisode called without valid data');
    return null;
  }
  const {
    title_id,
    season_number = 1,
    episode_number,
    name = null,
    overview = null,
    still_url = null,
    air_date = null,
  } = episodeData;

  // The episodes table is keyed on (title_id, season, episode) — both are
  // mandatory. Without them the insert would violate the schema.
  if (!title_id || episode_number == null || typeof episode_number !== 'number') {
    console.warn(`[library-store] upsertEpisode refused: missing title_id or episode_number (title_id=${title_id}, ep=${episode_number})`);
    return null;
  }

  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO episodes (title_id, season_number, episode_number, name, overview, still_url, air_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(title_id, season_number, episode_number) DO UPDATE SET
      name = excluded.name,
      overview = excluded.overview,
      still_url = excluded.still_url,
      air_date = excluded.air_date
  `);
  const info = stmt.run(title_id, season_number, episode_number, name, overview, still_url, air_date);
  return info.lastInsertRowid;
}

function getEpisodesForTitle(titleId) {
  const db = getDb();
  return db.prepare(`
    SELECT e.*, wp.progress_seconds, wp.duration_seconds, wp.completed, wp.last_watched_at, f.file_path
    FROM episodes e
    LEFT JOIN files f ON f.title_id = e.title_id AND f.season_number = e.season_number AND f.episode_number = e.episode_number
    LEFT JOIN watch_progress wp ON wp.file_path = f.file_path
    WHERE e.title_id = ?
    ORDER BY e.season_number ASC, e.episode_number ASC
  `).all(titleId);
}

// ─── Files ───────────────────────────────────────────────────────────────────

function upsertFile(fileData) {
  if (!fileData || typeof fileData !== 'object' || !fileData.file_path) {
    console.warn('[library-store] upsertFile refused: missing file_path', fileData && fileData.file_path);
    return null;
  }
  const db = getDb();
  const {
    file_path,
    title_id = null,
    season_number = null,
    episode_number = null,
    raw_parse_json = null,
    file_size = null,
    last_modified = null,
  } = fileData;

  const stmt = db.prepare(`
    INSERT INTO files (file_path, title_id, season_number, episode_number, raw_parse_json, file_size, last_modified, matched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(file_path) DO UPDATE SET
      title_id = COALESCE(excluded.title_id, files.title_id),
      season_number = COALESCE(excluded.season_number, files.season_number),
      episode_number = COALESCE(excluded.episode_number, files.episode_number),
      raw_parse_json = COALESCE(excluded.raw_parse_json, files.raw_parse_json),
      file_size = excluded.file_size,
      last_modified = excluded.last_modified
  `);
  const info = stmt.run(file_path, title_id, season_number, episode_number, raw_parse_json, file_size, last_modified);
  return info.lastInsertRowid;
}

function getFileByPath(filePath) {
  const db = getDb();
  return db.prepare(`SELECT * FROM files WHERE file_path = ?`).get(filePath);
}

function getFilesForTitle(titleId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM files WHERE title_id = ? ORDER BY season_number ASC, episode_number ASC`).all(titleId);
}

/**
 * Files not yet attached to any series (title_id IS NULL). These are the
 * "unmatched / pending review" files that the batch-confirm flow re-checks
 * after each user confirmation.
 * @returns {object[]}
 */
function getUnmatchedFiles() {
  const db = getDb();
  return db.prepare(`SELECT * FROM files WHERE title_id IS NULL`).all();
}

function getAllFiles() {
  const db = getDb();
  return db.prepare(`SELECT * FROM files`).all();
}

// ─── Watch Progress ──────────────────────────────────────────────────────────

function updateWatchProgress(progressData) {
  if (!progressData || typeof progressData !== 'object' || !progressData.file_path) {
    console.warn('[library-store] updateWatchProgress refused: missing file_path', progressData && progressData.file_path);
    return null;
  }
  const db = getDb();
  const {
    file_path,
    title_id = null,
    season_number = null,
    episode_number = null,
    progress_seconds,
    duration_seconds,
    completed = 0,
  } = progressData;

  const stmt = db.prepare(`
    INSERT INTO watch_progress (file_path, title_id, season_number, episode_number, progress_seconds, duration_seconds, completed, last_watched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(file_path) DO UPDATE SET
      title_id = COALESCE(excluded.title_id, watch_progress.title_id),
      season_number = COALESCE(excluded.season_number, watch_progress.season_number),
      episode_number = COALESCE(excluded.episode_number, watch_progress.episode_number),
      progress_seconds = excluded.progress_seconds,
      duration_seconds = excluded.duration_seconds,
      completed = excluded.completed,
      last_watched_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(file_path, title_id, season_number, episode_number, progress_seconds, duration_seconds, completed);
}

function getWatchProgressByPath(filePath) {
  const db = getDb();
  return db.prepare(`SELECT * FROM watch_progress WHERE file_path = ?`).get(filePath);
}

function getRecentlyWatched(limit = 20) {
  const db = getDb();
  return db.prepare(`
    SELECT wp.*, t.title, t.type, t.poster_url, t.backdrop_url
    FROM watch_progress wp
    LEFT JOIN titles t ON t.id = wp.title_id
    ORDER BY wp.last_watched_at DESC
    LIMIT ?
  `).all(limit);
}

module.exports = {
  addFolder,
  getAllFolders,
  removeFolder,
  resetLibrary,
  upsertTitle,
  getTitleById,
  getAllTitles,
  getEnrichedTitles,
  getTitleByExternalId,
  getTitlesNeedingReparse,
  getFilePathsForTitle,
  getFlaggedTitles,
  deleteTitle,
  deleteOrphanTitles,
  mergeTitle,
  addTitleAlias,
  getAliasesForTitle,
  findTitleIdsByAlias,
  getAllAliases,
  getAliasesForTitles,
  upsertEpisode,
  getEpisodesForTitle,
  upsertFile,
  getFileByPath,
  getFilesForTitle,
  getUnmatchedFiles,
  getAllFiles,
  updateWatchProgress,
  getWatchProgressByPath,
  getRecentlyWatched,
};
