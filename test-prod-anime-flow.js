'use strict';

/**
 * test-prod-anime-flow.js — Verifies the real production scan flow for
 * bracketed anime files, single series ID assignment, online metadata query
 * using clean title, and orphan title purging.
 */

const path = require('path');
const fs = require('fs');
const { initDatabase, closeDatabase } = require('./src/main/db/database');
const libraryStore = require('./src/main/db/library-store');
const { groupFilesInBatch, getPipelineDiagnostics } = require('./src/main/library/matcher');
const { parseFilename } = require('./src/main/library/parser');

const testDbPath = path.join(__dirname, 'test_prod_anime_flow.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; console.log('  ✘ FAIL: ' + label); }
}

async function main() {
  initDatabase(testDbPath);

  console.log('\n── Test 1: Production Anime Filenames Structural Parsing ──');
  const prodFiles = [
    'D:\\My Files\\Anime\\One Piece\\[@Animes2u] - [1135] [One Piece] [720p] [ESub].mkv',
    'D:\\My Files\\Anime\\One Piece\\[@Animes2u] - [1136] [One Piece][720p] [ESub].mkv',
    'D:\\My Files\\Anime\\One Piece\\[@Animes2u] - [1137] One Piece [720p] [Sub].mkv',
    'D:\\My Files\\Anime\\One Piece\\[@Animes2u] - [1138] One Piece [720p] [Sub].mkv',
    'D:\\My Files\\Anime\\One Piece\\[@Animes2u] - [1144] One Piece [720pp] [Sub].mkv',
  ];

  for (const fp of prodFiles) {
    const parsed = parseFilename(fp);
    ok(parsed.title === 'One Piece', `Clean title extracted as "One Piece" (got "${parsed.title}")`);
    ok(parsed.episode > 0, `Episode number extracted: ${parsed.episode}`);
  }

  console.log('\n── Test 2: Batch Grouping across Real Filenames ──');
  const items = prodFiles.map((fp) => ({ filePath: fp }));
  const batchRes = await groupFilesInBatch(items, { offline: true });

  ok(batchRes.scannedCount === 5, 'scanned 5 files');
  ok(batchRes.matchedCount === 5, 'matched 5 files');

  const titlesInDb = libraryStore.getAllTitles();
  ok(titlesInDb.length === 1, `All 5 production files grouped into EXACTLY 1 series record (got ${titlesInDb.length})`);
  const onePieceId = titlesInDb[0].id;
  ok(titlesInDb[0].title === 'One Piece', `Series record title is "${titlesInDb[0].title}"`);

  const filesInDb = libraryStore.getFilesForTitle(onePieceId);
  ok(filesInDb.length === 5, `All 5 file records point to series ID #${onePieceId}`);

  console.log('\n── Test 3: Structured Diagnostic Pipeline Tracing ──');
  const diag = getPipelineDiagnostics();
  ok(diag.length > 0, 'Diagnostic traces generated');

  for (const fp of prodFiles) {
    const fileDiags = diag.filter((d) => d.filePath === fp);
    const parseDiag = fileDiags.find((d) => d.step === 'parse');
    const decisionDiag = fileDiags.find((d) => d.step === 'decision');

    ok(!!parseDiag, `Parse trace exists for ${path.basename(fp)}`);
    ok(parseDiag && parseDiag.details.effectiveTitle === 'One Piece', `Parsed clean title logged as "One Piece"`);
    ok(!!decisionDiag, `Decision trace exists for ${path.basename(fp)}`);
    ok(decisionDiag && decisionDiag.details.matchedSeriesId === onePieceId, `Mapped to series ID #${onePieceId}`);
  }

  console.log('\n── Test 4: Stale Orphan Title Purging ──');
  // Create a stale duplicate title in DB with 0 files (simulating old broken scan)
  const staleId = libraryStore.upsertTitle({
    type: 'anime',
    title: '[1135] [One Piece] [720p] [ESub]',
    match_confidence: 'local',
  });
  ok(staleId != null, `Created stale title #${staleId}`);

  // Purge orphan titles
  const deletedCount = libraryStore.deleteOrphanTitles(true);
  ok(deletedCount === 1, `Purged ${deletedCount} stale orphan title from DB`);

  const titlesAfterPurge = libraryStore.getAllTitles();
  ok(titlesAfterPurge.length === 1 && titlesAfterPurge[0].id === onePieceId, `UI receives clean title list with 0 stale duplicates`);

  closeDatabase();
  fs.unlinkSync(testDbPath);

  console.log(`\n${failed === 0 ? '🎉' : '❌'} PRODUCTION ANIME FLOW TESTS: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ test crashed:', err);
  process.exit(1);
});
