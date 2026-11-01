'use strict';

/**
 * test-series-pipeline-diagnostics.js — Verifies series-level pre-grouping,
 * normalization handling across season/punctuation variants, and pipeline diagnostics.
 */

const path = require('path');
const fs = require('fs');
const { initDatabase, closeDatabase } = require('./src/main/db/database');
const libraryStore = require('./src/main/db/library-store');
const { parseFilename, normalizeTitle, cleanSeriesTitle, getGroupKey } = require('./src/main/library/parser');
const { groupFilesInBatch, getPipelineDiagnostics, clearPipelineDiagnostics } = require('./src/main/library/matcher');
const { scanFolder } = require('./src/main/library/library-service');

const testDbPath = path.join(__dirname, 'test_series_pipeline_diagnostics.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; console.log('  ✘ FAIL: ' + label); }
}

async function main() {
  initDatabase(testDbPath);

  console.log('\n── Test 1: Punctuation & Apostrophe Normalization ──');
  const s1 = normalizeTitle("JoJo's Bizarre Adventure");
  const s2 = normalizeTitle("JoJos Bizarre Adventure");
  const s3 = normalizeTitle("JoJo’s Bizarre Adventure");
  ok(s1 === s2 && s2 === s3, `Apostrophe variants normalize identically ("${s1}")`);

  console.log('\n── Test 2: Clean Series Title & Season Extraction ──');
  const t1 = cleanSeriesTitle("Attack on Titan Season 2");
  const t2 = cleanSeriesTitle("Attack on Titan 2nd Season");
  const t3 = cleanSeriesTitle("Attack on Titan S02");
  ok(t1.cleanTitle === "Attack on Titan" && t1.extractedSeason === 2, `Season 2 cleaned ("${t1.cleanTitle}", season ${t1.extractedSeason})`);
  ok(t2.cleanTitle === "Attack on Titan" && t2.extractedSeason === 2, `2nd Season cleaned ("${t2.cleanTitle}", season ${t2.extractedSeason})`);
  ok(t3.cleanTitle === "Attack on Titan" && t3.extractedSeason === 2, `S02 cleaned ("${t3.cleanTitle}", season ${t3.extractedSeason})`);

  const key1 = getGroupKey(parseFilename("Attack.on.Titan.S01E01.1080p.mkv"));
  const key2 = getGroupKey(parseFilename("Attack.on.Titan.Season.2.-.01.mkv"));
  const key3 = getGroupKey(parseFilename("[SubsPlease] Attack on Titan 2nd Season - 05.mkv"));
  ok(key1 === key2 && key2 === key3, `Group keys across multi-seasons match ("${key1}")`);

  console.log('\n── Test 3: Series-Level Pre-Grouping in Batch ──');
  clearPipelineDiagnostics();

  const filesToBatch = [
    { filePath: '/videos/anime/Jujutsu.Kaisen.S01E01.1080p.mkv' },
    { filePath: '/videos/anime/Jujutsu.Kaisen.S01E02.1080p.mkv' },
    { filePath: '/videos/anime/Jujutsu.Kaisen.Season.2.-.01.mkv' },
    { filePath: '/videos/anime/[SubsPlease] Jujutsu Kaisen 2nd Season - 02.mkv' },
  ];

  const batchRes = await groupFilesInBatch(filesToBatch, { offline: true });
  ok(batchRes.scannedCount === 4, 'scanned 4 files');
  ok(batchRes.matchedCount === 4, 'matched 4 files');

  const allTitles = libraryStore.getAllTitles();
  ok(allTitles.length === 1, `All 4 files pre-grouped onto EXACTLY 1 series record (got ${allTitles.length})`);
  const seriesId = allTitles[0].id;
  const dbEpisodes = libraryStore.getEpisodesForTitle(seriesId);
  ok(dbEpisodes.length === 4, `4 episodes attached to series #${seriesId}`);

  console.log('\n── Test 4: Pipeline Diagnostics & Tracing ──');
  const diagnostics = getPipelineDiagnostics();
  ok(diagnostics.length > 0, `Diagnostics recorded (${diagnostics.length} entries)`);

  const parseSteps = diagnostics.filter((d) => d.step === 'parse');
  ok(parseSteps.length === 4, `4 parse steps traced`);

  const decisionSteps = diagnostics.filter((d) => d.step === 'decision');
  ok(decisionSteps.length === 4, `4 decision steps logged`);
  for (const d of decisionSteps) {
    ok(d.details.matchedSeriesId === seriesId, `File "${path.basename(d.filePath)}" mapped to series ID #${seriesId}`);
    ok(typeof d.details.reason === 'string' && d.details.reason.length > 0, `Reason logged: "${d.details.reason}"`);
  }

  console.log('\n── Test 5: Scan Folder Diagnostics API Integration ──');
  const tempDir = path.join(__dirname, 'temp_test_anime_dir');
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(path.join(tempDir, 'Demon Slayer S01E01.mkv'), 'dummy');
  fs.writeFileSync(path.join(tempDir, 'Demon Slayer Season 2 - 01.mkv'), 'dummy');

  const scanFolderRes = await scanFolder(tempDir, { offline: true });
  ok(Array.isArray(scanFolderRes.diagnostics), 'scanFolder returns diagnostics array');
  ok(scanFolderRes.diagnostics.length > 0, 'scanFolder contains non-empty diagnostic trace');
  ok(scanFolderRes.matchedCount === 2, 'scanFolder matched both episodes in temp dir');
  ok(scanFolderRes.seriesGroups.length === 1, 'scanFolder grouped both Demon Slayer episodes into 1 series');

  fs.rmSync(tempDir, { recursive: true, force: true });
  closeDatabase();
  fs.unlinkSync(testDbPath);

  console.log(`\n${failed === 0 ? '🎉' : '❌'} DIAGNOSTICS & GROUPING TESTS: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ test crashed:', err);
  process.exit(1);
});
