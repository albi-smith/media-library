'use strict';

/**
 * test-null-safety.js — Verifies the scanner, matcher, parser, and store
 * never crash when handed missing/undefined data. Every guard below would
 * previously throw (TypeError / SQLite constraint) and abort an entire scan;
 * now each returns a safe fallback and logs which stage failed.
 */

const path = require('path');
const fs = require('fs');
const { initDatabase, closeDatabase } = require('./src/main/db/database');
const libraryStore = require('./src/main/db/library-store');
const libraryService = require('./src/main/library/library-service');
const {
  matchFileToTitle,
  scoreCandidate,
  groupLocalTitle,
  resolveLocalTitle,
  findLocalTitleCandidates,
  enrichTitleWithLookup,
} = require('./src/main/library/matcher');
const { parseFilename, getGroupKey } = require('./src/main/library/parser');
const { searchMovie, searchSeries } = require('./src/main/library/tmdb');
const { searchAnime } = require('./src/main/library/anilist');

const testDbPath = path.join(__dirname, 'test_null_safety.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; console.log('  ✘ FAIL: ' + label); }
}

async function main() {
  initDatabase(testDbPath);

  console.log('\n── Parser guards: null / undefined / empty input ──');
  for (const bad of [null, undefined, '', 42, {}, []]) {
    const p = parseFilename(bad);
    ok(p && typeof p === 'object', `parseFilename(${JSON.stringify(bad)}) returns a safe object`);
    ok(typeof p.title === 'string', `  title is a string (got ${typeof p.title})`);
  }
  ok(getGroupKey(null) === 'show|', 'getGroupKey(null) -> "show|"');
  ok(getGroupKey(undefined) === 'show|', 'getGroupKey(undefined) -> "show|"');

  console.log('\n── Matcher guards ──');
  ok(scoreCandidate('Test Title', null, null) === 0, 'scoreCandidate with null candidate -> 0');
  ok(scoreCandidate('Test Title', null, undefined) === 0, 'scoreCandidate with undefined candidate -> 0');
  ok(scoreCandidate('Test', null, { title: 'Test', synonyms: null, original_title: undefined }) > 0,
    'scoreCandidate with null synonyms still scores');
  ok(Array.isArray(findLocalTitleCandidates(null, '/x')), 'findLocalTitleCandidates(null) -> []');
  ok(Array.isArray(findLocalTitleCandidates({}, '/x')), 'findLocalTitleCandidates({}) -> []');

  const r1 = resolveLocalTitle(null, '/videos/x');
  ok(r1 && typeof r1 === 'object' && r1.resolved === false, 'resolveLocalTitle(null) does not throw');
  const r2 = resolveLocalTitle({}, '/videos/x');
  ok(r2 && r2.resolved === false, 'resolveLocalTitle({}) does not throw');

  const g1 = groupLocalTitle(null, '/videos/x');
  ok(g1 && g1.title === null, 'groupLocalTitle(null) -> { title: null }');
  ok(g1 && Array.isArray(g1.candidates), 'groupLocalTitle(null) candidates is an array');
  const g2 = groupLocalTitle(undefined, '/videos/x');
  ok(g2 && g2.title === null, 'groupLocalTitle(undefined) -> { title: null }');

  let threw = false;
  try {
    await matchFileToTitle(null, '/videos/ungrouped/file.mkv', { offline: true });
  } catch (e) {
    threw = true;
  }
  ok(!threw, 'matchFileToTitle(null, path) does not throw');
  const orphan = libraryStore.getFileByPath('/videos/ungrouped/file.mkv');
  ok(!!orphan, 'null-parsed file still recorded as ungrouped row');
  ok(orphan && orphan.title_id === null, '  recorded with title_id = null (pending)');

  threw = false;
  try {
    await matchFileToTitle(undefined, '/videos/ungrouped/file2.mkv', { offline: true });
  } catch (e) {
    threw = true;
  }
  ok(!threw, 'matchFileToTitle(undefined, path) does not throw');

  console.log('\n── Store guards ──');
  ok(libraryStore.upsertTitle(null) === null, 'upsertTitle(null) -> null');
  ok(libraryStore.upsertTitle(undefined) === null, 'upsertTitle(undefined) -> null');
  ok(libraryStore.upsertTitle({ title: '' }) === null, 'upsertTitle({title:""}) -> null');
  ok(libraryStore.upsertTitle({ title: '   ' }) === null, 'upsertTitle({title:"   "}) -> null');
  ok(libraryStore.upsertEpisode(null) === null, 'upsertEpisode(null) -> null');
  ok(libraryStore.upsertEpisode({ title_id: 1 }) === null, 'upsertEpisode missing episode_number -> null');
  ok(libraryStore.upsertEpisode({ title_id: null, episode_number: 1 }) === null, 'upsertEpisode missing title_id -> null');
  ok(libraryStore.upsertFile(null) === null, 'upsertFile(null) -> null');
  ok(libraryStore.upsertFile({}) === null, 'upsertFile({}) -> null');
  ok(libraryStore.updateWatchProgress(null) === null, 'updateWatchProgress(null) -> null');
  ok(libraryStore.addFolder(null) === null, 'addFolder(null) -> null');

  console.log('\n── Service guards ──');
  const scan1 = await libraryService.scanFolder(null);
  ok(scan1 && scan1.scannedCount === 0, 'scanFolder(null) returns empty result');
  ok(Array.isArray(scan1.ambiguous), '  scanFolder(null).ambiguous is an array');
  ok(Array.isArray(scan1.errors), '  scanFolder(null).errors is an array');

  const scan2 = await libraryService.scanFolder(42);
  ok(scan2 && scan2.scannedCount === 0, 'scanFolder(42) returns empty result');

  const none = await libraryService.searchMetadataCandidates(null);
  ok(Array.isArray(none), 'searchMetadataCandidates(null) -> []');
  const none2 = await libraryService.searchMetadataCandidates(undefined);
  ok(Array.isArray(none2), 'searchMetadataCandidates(undefined) -> []');

  ok((await libraryService.fixMatch(null, null)) === null, 'fixMatch(null, null) -> null');

  const goodTitleId = libraryStore.upsertTitle({ type: 'movie', title: 'Gravity', match_confidence: 'local' });
  ok(goodTitleId != null, 'created a control title for fixMatch');
  const fixed = await libraryService.fixMatch(goodTitleId, null);
  ok(fixed && fixed.id === goodTitleId, 'fixMatch(id, null) returns existing title untouched');
  const fixedNone = await libraryService.fixMatch(999999, null);
  ok(fixedNone === null, 'fixMatch(missing id, null) -> null');

  console.log('\n── Enrichment guard ──');
  const enriched = await enrichTitleWithLookup(999999, null);
  ok(enriched === null, 'enrichTitleWithLookup(missing id, null) -> null');
  const enrichedNull = await enrichTitleWithLookup(goodTitleId, null);
  ok(enrichedNull && enrichedNull.id === goodTitleId, 'enrichTitleWithLookup(id, null) keeps current row');
  const enrichedEmpty = await enrichTitleWithLookup(goodTitleId, { title: '   ', typeCandidate: 'movie', year: null });
  ok(enrichedEmpty && enrichedEmpty.id === goodTitleId, 'enrichTitleWithLookup with noise-only title keeps current row');

  console.log('\n── API client guards (no network) ──');
  const m = await searchMovie(null);
  ok(Array.isArray(m) && m.length === 0, 'searchMovie(null) -> []');
  const s = await searchSeries(null);
  ok(Array.isArray(s) && s.length === 0, 'searchSeries(null) -> []');
  const a = await searchAnime(null);
  ok(Array.isArray(a) && a.length === 0, 'searchAnime(null) -> []');

  closeDatabase();
  fs.unlinkSync(testDbPath);

  console.log(`\n🎉 NULL-SAFETY TESTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Uncaught error in test:', err);
  process.exit(1);
});