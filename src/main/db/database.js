'use strict';

/**
 * database.js — SQLite connection & migration runner.
 *
 * Strategy (in priority order):
 *   1. better-sqlite3  — synchronous native driver.  Works when the binary is
 *      pre-compiled for the running Electron ABI.  On a fresh install without
 *      Visual Studio this throw a binding error.
 *   2. sql.js          — SQLite compiled to WebAssembly.  Zero native deps,
 *      runs everywhere.  initSqlJs() returns a Promise so initDatabase() is
 *      async to accommodate it.
 */

const path = require('path');
const fs   = require('fs');

let rawDb        = null;
let dbPathGlobal = null;
let engineType   = 'none'; // 'better-sqlite3' | 'sql.js'

// ─── WASM persistence helper ─────────────────────────────────────────────────

function _saveWasm() {
  if (engineType !== 'sql.js' || !rawDb || !dbPathGlobal) return;
  try {
    fs.writeFileSync(dbPathGlobal, Buffer.from(rawDb.export()));
  } catch (e) {
    console.warn('[db] sql.js save error:', e.message);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Open (or create) the SQLite database and run schema migrations.
 * @param {string} dbPath  Absolute path to the .db file.
 * @returns {Promise<object>} Unified DB interface.
 */
async function initDatabase(dbPath) {
  if (!dbPath) throw new Error('initDatabase requires a valid database file path.');

  dbPathGlobal = dbPath;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // ── 1. Use sql.js WASM in Electron (better-sqlite3 causes ABI crash) ─────
  //       better-sqlite3 is compiled for Node.js, not Electron's V8 ABI, so
  //       requiring it inside Electron crashes the process without throwing.
  //       We detect Electron via process.versions.electron and skip it.
  const inElectron = !!process.versions.electron;

  if (!inElectron) {
    // ── Try better-sqlite3 only in plain Node (tests, CLI tools) ─────────
    try {
      const Database = require('better-sqlite3');
      rawDb = new Database(dbPath);
      rawDb.pragma('journal_mode = WAL');
      rawDb.pragma('foreign_keys = ON');
      engineType = 'better-sqlite3';
      console.log('[db] engine: better-sqlite3');
    } catch (_err) {
      /* fall through to sql.js below */
    }
  }

  if (!rawDb) {
    // ── sql.js WASM (always used in Electron, fallback in Node) ──────────
    console.log('[db] using sql.js WASM engine');
    const initSqlJs = require('sql.js');
    // Pre-read the .wasm binary and pass it directly.
    // This bypasses Electron's fetch()-based WASM loader that hangs in the main process.
    const wasmPath = path.join(
      path.dirname(require.resolve('sql.js')),
      'sql-wasm.wasm'
    );
    const wasmBinary = fs.readFileSync(wasmPath);
    const SQL = await initSqlJs({ wasmBinary });
    const fileBuffer = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
    rawDb = new SQL.Database(fileBuffer);
    engineType = 'sql.js';
    console.log('[db] engine: sql.js ready');
  }

  _runMigrations();
  return getDb();
}

/**
 * Returns the current unified DB interface (throws if not yet initialised).
 */
function getDb() {
  if (!rawDb) throw new Error('Database not initialised. Call await initDatabase(path) first.');

  if (engineType === 'better-sqlite3') {
    // Expose the native better-sqlite3 instance directly – it already has
    // .exec(), .prepare(), etc.
    return rawDb;
  }

  // ── sql.js shim — adapts its API to look like better-sqlite3 ─────────────
  return {
    exec(sql) {
      rawDb.exec(sql);
      _saveWasm();
    },
    prepare(sql) {
      return {
        run(...args) {
          const params = _normalise(args);
          rawDb.run(sql, params);
          _saveWasm();
          const res = rawDb.exec('SELECT last_insert_rowid() as id');
          const lastId = res?.[0]?.values?.[0]?.[0] ?? 0;
          return { lastInsertRowid: lastId, changes: 1 };
        },
        get(...args) {
          const params = _normalise(args);
          const stmt   = rawDb.prepare(sql);
          params.length && stmt.bind(params);
          const hasRow = stmt.step();
          const result = hasRow ? stmt.getAsObject() : undefined;
          stmt.free();
          return result;
        },
        all(...args) {
          const params  = _normalise(args);
          const stmt    = rawDb.prepare(sql);
          params.length && stmt.bind(params);
          const results = [];
          while (stmt.step()) results.push(stmt.getAsObject());
          stmt.free();
          return results;
        },
      };
    },
    pragma() { /* no-op for sql.js */ },
    close() {
      if (rawDb) { _saveWasm(); rawDb.close(); rawDb = null; }
    },
  };
}

/**
 * Close the database connection (flushes sql.js to disk first).
 */
function closeDatabase() {
  if (!rawDb) return;
  if (engineType === 'sql.js') { _saveWasm(); rawDb.close(); }
  else rawDb.close();
  rawDb = null;
}

// ─── Internals ────────────────────────────────────────────────────────────────

/** Flatten a single-array arg into a plain parameter list. */
function _normalise(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

function _runMigrations() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_path TEXT UNIQUE NOT NULL,
      last_scanned_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS titles (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT    NOT NULL,
      title TEXT   NOT NULL,
      original_title TEXT,
      year INTEGER,
      overview TEXT,
      poster_url TEXT,
      backdrop_url TEXT,
      tmdb_id    INTEGER,
      anilist_id INTEGER,
      mal_id     INTEGER,
      match_confidence TEXT NOT NULL DEFAULT 'auto',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      title_id       INTEGER NOT NULL,
      season_number  INTEGER DEFAULT 1,
      episode_number INTEGER NOT NULL,
      name     TEXT,
      overview TEXT,
      still_url TEXT,
      air_date  TEXT,
      UNIQUE(title_id, season_number, episode_number)
    );

    CREATE TABLE IF NOT EXISTS files (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path      TEXT UNIQUE NOT NULL,
      title_id       INTEGER,
      season_number  INTEGER,
      episode_number INTEGER,
      raw_parse_json TEXT,
      file_size      INTEGER,
      last_modified  DATETIME,
      matched_at     DATETIME
    );

CREATE TABLE IF NOT EXISTS watch_progress (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path      TEXT UNIQUE NOT NULL,
      title_id       INTEGER,
      season_number  INTEGER,
      episode_number INTEGER,
      progress_seconds  REAL    DEFAULT 0,
      duration_seconds  REAL    DEFAULT 0,
      completed         INTEGER DEFAULT 0,
      last_watched_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS title_aliases (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title_id    INTEGER NOT NULL,
      alias       TEXT    NOT NULL,
      alias_type  TEXT    NOT NULL DEFAULT 'alternate',
      UNIQUE(title_id, alias)
    );

    CREATE INDEX IF NOT EXISTS idx_files_title         ON files(title_id);
    CREATE INDEX IF NOT EXISTS idx_episodes_title      ON episodes(title_id);
    CREATE INDEX IF NOT EXISTS idx_wp_title            ON watch_progress(title_id);
    CREATE INDEX IF NOT EXISTS idx_wp_last_watched     ON watch_progress(last_watched_at DESC);
    CREATE INDEX IF NOT EXISTS idx_titles_type         ON titles(type);
    CREATE INDEX IF NOT EXISTS idx_aliases_alias       ON title_aliases(alias);
    CREATE INDEX IF NOT EXISTS idx_aliases_title       ON title_aliases(title_id);
  `);

  // Lightweight migration for pre-existing databases: ADD COLUMN is a
  // no-op error when the column already exists, so try/catch is sufficient
  // on both better-sqlite3 and the sql.js shim (both go through exec()).
  try {
    getDb().exec(`ALTER TABLE titles ADD COLUMN mal_id INTEGER`);
  } catch {
    /* column already present — nothing to do */
  }
}

module.exports = { initDatabase, getDb, closeDatabase };
