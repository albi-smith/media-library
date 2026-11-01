'use strict';

/**
 * test-phase2.js — Unit test script for Phase 2 (File Scanning & Filename Parsing)
 */

const path = require('path');
const fs = require('fs');
const { initDatabase, closeDatabase } = require('./src/main/db/database');
const libraryStore = require('./src/main/db/library-store');
const { scanDirectory } = require('./src/main/library/scanner');
const { parseFilename } = require('./src/main/library/parser');

const testDbPath = path.join(__dirname, 'test_phase2.db');
const testScanDir = path.join(__dirname, 'test_videos_dir');

// Clean old files if present
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
if (fs.existsSync(testScanDir)) fs.rmSync(testScanDir, { recursive: true, force: true });

// Create dummy folder structure with test video files
fs.mkdirSync(path.join(testScanDir, 'Movies'), { recursive: true });
fs.mkdirSync(path.join(testScanDir, 'TV Shows', 'Breaking Bad'), { recursive: true });
fs.mkdirSync(path.join(testScanDir, 'Anime', 'Jujutsu Kaisen'), { recursive: true });

fs.writeFileSync(path.join(testScanDir, 'Movies', 'Inception.2010.1080p.mkv'), 'dummy');
fs.writeFileSync(path.join(testScanDir, 'TV Shows', 'Breaking Bad', 'Breaking.Bad.S01E01.720p.mp4'), 'dummy');
fs.writeFileSync(path.join(testScanDir, 'Anime', 'Jujutsu Kaisen', '[SubsPlease] Jujutsu Kaisen - 01 (1080p).mkv'), 'dummy');

console.log('Testing Phase 2 File Scanning & Filename Parsing...');

try {
  // 1. Init DB
  initDatabase(testDbPath);

  // 2. Test Scanner
  const scannedFiles = scanDirectory(testScanDir);
  console.assert(scannedFiles.length === 3, `Expected 3 scanned files, got ${scannedFiles.length}`);
  console.log('✔ Recursive file scanning verified.');

  // 3. Test Filename Parser
  const movieParse = parseFilename(scannedFiles.find(f => f.filePath.includes('Inception')).filePath);
  console.assert(movieParse.title === 'Inception', `Expected 'Inception', got '${movieParse.title}'`);
  console.assert(movieParse.year === 2010, `Expected year 2010, got ${movieParse.year}`);
  console.assert(movieParse.typeCandidate === 'movie', `Expected type candidate movie, got ${movieParse.typeCandidate}`);

  const seriesParse = parseFilename(scannedFiles.find(f => f.filePath.includes('Breaking')).filePath);
  console.assert(seriesParse.title === 'Breaking Bad', `Expected 'Breaking Bad', got '${seriesParse.title}'`);
  console.assert(seriesParse.season === 1, `Expected season 1, got ${seriesParse.season}`);
  console.assert(seriesParse.episode === 1, `Expected episode 1, got ${seriesParse.episode}`);
  console.assert(seriesParse.typeCandidate === 'series', `Expected type candidate series, got ${seriesParse.typeCandidate}`);

  const animeParse = parseFilename(scannedFiles.find(f => f.filePath.includes('Jujutsu')).filePath);
  console.assert(animeParse.title === 'Jujutsu Kaisen', `Expected 'Jujutsu Kaisen', got '${animeParse.title}'`);
  console.assert(animeParse.episode === 1, `Expected episode 1, got ${animeParse.episode}`);
  console.assert(animeParse.releaseGroup === 'SubsPlease', `Expected releaseGroup 'SubsPlease', got '${animeParse.releaseGroup}'`);
  console.assert(animeParse.typeCandidate === 'anime', `Expected type candidate anime, got ${animeParse.typeCandidate}`);

  console.log('✔ Filename parsing for Movies, Series, and Anime verified.');

  // 4. Save scanned files to DB
  for (const item of scannedFiles) {
    const parse = parseFilename(item.filePath);
    libraryStore.upsertFile({
      file_path: item.filePath,
      season_number: parse.season,
      episode_number: parse.episode,
      raw_parse_json: JSON.stringify(parse),
      file_size: item.size,
      last_modified: item.mtime,
    });
  }

  const dbFiles = libraryStore.getAllFiles();
  console.assert(dbFiles.length === 3, `Expected 3 files in DB, got ${dbFiles.length}`);
  console.log('✔ Storing scanned & parsed files in SQLite verified.');

  // Cleanup
  closeDatabase();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  if (fs.existsSync(testScanDir)) fs.rmSync(testScanDir, { recursive: true, force: true });

  console.log('🎉 ALL PHASE 2 TESTS PASSED SUCCESSFULLY!');
} catch (err) {
  console.error('❌ Phase 2 test failed:', err);
  process.exit(1);
}
