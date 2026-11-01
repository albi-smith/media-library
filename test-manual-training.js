'use strict';

/**
 * test-manual-training.js — Verifies that a user's manual match is used as
 * training data for the CURRENT scan:
 *
 *   1. Files with no strong series evidence are kept unmatched (no junk series
 *      auto-created) so the user can confirm them as a group.
 *   2. Applying a batch of confirmations re-points the confirmed files AND
 *      teaches the matcher, so similar remaining files (same parsed title /
 *      folder / folder+season) resolve onto the confirmed series.
 *   3. Previously unmatched files are re-checked after each confirmation.
 *   4. An explicitly "create new series" action from the batch modal creates a
 *      manual series instead of letting the scanner guess.
 *   5. fixMatch on a series also trains the current scan from its own files.
 */

const path = require('path');
const fs = require('fs');
const { initDatabase, closeDatabase } = require('./src/main/db/database');
const libraryStore = require('./src/main/db/library-store');
const libraryService = require('./src/main/library/library-service');
const {
  matchFileToTitle,
  rememberManualMatch,
  getLearnedTitleFor,
  clearSessionLearnings,
} = require('./src/main/library/matcher');
const { parseFilename } = require('./src/main/library/parser');

const testDbPath = path.join(__dirname, 'test_manual_training.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; console.log('  ✘ FAIL: ' + label); }
}

async function main() {
  initDatabase(testDbPath);

  console.log('\n── Test 1: weak/junk evidence stays unmatched (no auto-series) ──');
  const titlesBefore = libraryStore.getAllTitles().length;
  const junk = await matchFileToTitle(parseFilename('E01.mkv'), 'E01.mkv', { offline: true });
  ok(junk === null, 'root-level noise file ("E01.mkv") stays unmatched (returns null)');
  const junkFile = libraryStore.getFileByPath('E01.mkv');
  ok(junkFile && junkFile.title_id === null, '  recorded with title_id = null (pending review)');
  ok(libraryStore.getAllTitles().length === titlesBefore, '  no series row was auto-created for junk');

  console.log('\n── Test 2: real titles still auto-create (strong evidence) ──');
  const real = await matchFileToTitle(parseFilename('Inception 2010.mkv'), 'Inception 2010.mkv', { offline: true });
  ok(!!real && real.id != null, 'real title ("Inception 2010") creates/joins a series');
  const inceptionId = real.id;
  ok(libraryStore.getAllTitles().length === titlesBefore + 1, '  exactly one new series created');
  const inceptionRow = libraryStore.getTitleById(inceptionId);
  ok(inceptionRow && inceptionRow.title === 'Inception', '  parsed core title is "Inception" (noise stripped)');

  console.log('\n── Test 3: fixMatch trains the current scan from its own files ──');
  await libraryService.fixMatch(inceptionId, {
    title: 'Inception (2010)', type: 'movie', year: 2010,
    original_title: 'Inception', synonyms: ['Inception 2010'], overview: '', poster_url: null,
  });
  const trainedId = getLearnedTitleFor(parseFilename('Inception 2010.mkv'), 'Inception 2010.mkv');
  ok(trainedId === inceptionId, 'fixMatch registered a parsed-title mapping for its files');

  clearSessionLearnings();
  ok(getLearnedTitleFor(parseFilename('Inception 2010.mkv'), 'Inception 2010.mkv') === null,
    'clearSessionLearnings() forgets the mapping');

  console.log('\n── Test 4: batch confirmation trains & re-checks similar files ──');
  libraryService.resetLibrary(); // clean slate, learnings cleared too

  const seriesA = libraryStore.upsertTitle({ type: 'series', title: 'One Piece', match_confidence: 'local' });
  const seriesB = libraryStore.upsertTitle({ type: 'series', title: 'One Piece Redux', match_confidence: 'local' });
  libraryStore.addTitleAlias(seriesB, 'One Piece', 'alternate'); // make B an exact near-tie too

  const file1 = '/Anime/One Piece/One Piece S01E01.mkv';
  const file2 = '/Anime/One Piece/One Piece S01E02.mkv';

  // Simulate the scanner having grouped file #1 onto the WRONG series (B)
  // while file #2 remains unscanned/unmatched.
  libraryStore.upsertFile({
    file_path: file1, title_id: seriesB, season_number: 1, episode_number: 1, raw_parse_json: '{}',
  });

  const res = await libraryService.applyManualMatches(
    [{ filePath: file1, titleId: seriesA }],
    { recheckPaths: [file2] }
  );
  ok(res.resolved.includes(file2), 'previously-unmatched file #2 auto-resolved after the confirmation');
  ok(res.stillUnresolved.length === 0, 'no files still unresolved');

  const f1after = libraryStore.getFileByPath(file1);
  const f2after = libraryStore.getFileByPath(file2);
  ok(f1after && f1after.title_id === seriesA, 'confirmed file #1 re-pointed onto the chosen series');
  ok(f2after && f2after.title_id === seriesA, 'similar file #2 grouped onto the SAME series (training)');

  // seriesB had only file1 — moving it away cleans up the empty series (correct).
  ok(!libraryStore.getTitleById(seriesB), 'abandoned series with no remaining files is cleaned up');

  const breakup = libraryStore.getFilesForTitle(seriesB).filter((f) => f.file_path === file1).length;
  ok(breakup === 0, 'file #1 no longer points at the abandoned series');

  const file3 = '/Anime/One Piece/One Piece S01E03.mkv';
  const m3 = await matchFileToTitle(parseFilename('One Piece S01E03.mkv'), file3, { offline: true });
  ok(m3 && m3.id === seriesA, 'a later similar file resolves straight to the trained series');
  ok(!m3.ambiguous, '  and is no longer ambiguous (no modal needed)');

  console.log('\n── Test 5: explicit "create new series" from the batch modal ──');
  const junkPath = 'S01E02.mkv'; // pure episode marker → pending (no auto-series)
  const junk2 = await matchFileToTitle(parseFilename('S01E02.mkv'), junkPath, { offline: true });
  ok(junk2 === null, 'a bare episode-marker file stays unmatched');
  const created = await libraryService.applyManualMatches(
    [{ filePath: junkPath, createNew: { title: 'My Custom Show', type: 'series' } }],
    { recheckPaths: [] }
  );
  ok(created.applied.length === 1, 'create-new match was applied');
  const createdFile = libraryStore.getFileByPath(junkPath);
  ok(createdFile && createdFile.title_id != null, '  file attached to the new series');
  const createdTitle = libraryStore.getTitleById(createdFile.title_id);
  ok(createdTitle && createdTitle.title === 'My Custom Show', '  new series row exists');
  ok(createdTitle && createdTitle.match_confidence === 'manual', '  user-created series is marked manual (locked)');
  const createdEpisodes = libraryStore.getEpisodesForTitle(createdFile.title_id);
  ok(createdEpisodes.length === 1, '  appended the episode row for the standalone episode marker');

  console.log('\n── Test 6: memory API helpers (title / folder / folder+season) ──');
  clearSessionLearnings();
  const helperPath = '/A/B/Show Name/Show.Name.S01E01.mkv';
  rememberManualMatch(helperPath, parseFilename('Show.Name.S01E01.mkv'), 77);
  ok(getLearnedTitleFor(parseFilename('Show Name S01E02.mkv'), helperPath) === 77,
    'parsed-title learning maps a variant of the same show');
  ok(getLearnedTitleFor(parseFilename('E03.mkv'), '/A/B/Show Name/Does.Not.Matter.mkv') === 77,
    'folder learning maps a noise file in the same folder');
  ok(getLearnedTitleFor(parseFilename('E03.mkv'), '/A/B/Show Name/Does.Not.Matter.mkv', { season: 1 }) === 77,
    'folder+season learning maps too');
  ok(getLearnedTitleFor(parseFilename('E03.mkv'), '/A/B/Other Folder/E03.mkv') === null,
    'different folder is not learned');
  clearSessionLearnings();
  ok(getLearnedTitleFor(parseFilename('Show Name S03E01.mkv'), helperPath) === null,
    'cleared before the next scan');

  closeDatabase();
  fs.unlinkSync(testDbPath);

  console.log(`\n🎉 MANUAL-TRAINING TESTS: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Uncaught error in test:', err);
  process.exit(1);
});