'use strict';

/**
 * test-series-grouping.js — Verifies that episodes of the same series group
 * onto ONE titles row regardless of filename style, release-group tags,
 * quality/codec noise, alternate names (aliases + original titles), and
 * folder names — and that genuinely ambiguous titles ask for confirmation
 * instead of silently creating duplicates.
 */

const path = require('path');
const fs = require('fs');
const { initDatabase, closeDatabase } = require('./src/main/db/database');
const libraryStore = require('./src/main/db/library-store');
const { matchFileToTitle, resolveLocalTitle, getFolderHint } = require('./src/main/library/matcher');
const { parseFilename } = require('./src/main/library/parser');

const testDbPath = path.join(__dirname, 'test_series_grouping.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; console.log('  ✘ FAIL: ' + label); }
}

async function main() {
  initDatabase(testDbPath);

  console.log('\n── Test 1: same series, different styles → one title ──');
  const styles = [
    ['Breakig.Bad.S01E01.1080p.x265.mkv',        'Breaking.Bad.S01E01.1080p.x265.mkv'],
    ['Breaking Bad.1x02.mkv',                     'Breaking.Bad.1x02.mkv'],
    ['BREAKING-BAD.S1.EP03.HDTV.x264.mkv',        'BREAKING-BAD.S1.EP03.HDTV.x264.mkv'],
    ['Breaking Bad - S01E04.720p.webrip.mkv',     'Breaking.Bad.-.S01E04.720p.webrip.mkv'],
  ];
  const titleIds = new Set();
  for (const [label, fname] of styles) {
    const parsed = parseFilename(fname);
    const matched = await matchFileToTitle(parsed, path.join('/videos/tv', fname), { offline: true });
    ok(!!matched, `matched "${label}"`);
    titleIds.add(matched.id);
  }
  ok(titleIds.size === 1, `all styles → one series (ids: ${[...titleIds].join(', ')})`);
  const bbId = [...titleIds][0];
  const episodes = libraryStore.getEpisodesForTitle(bbId);
  ok(episodes.length === 4, `4 episodes attached to series #${bbId} (got ${episodes.length})`);

  console.log('\n── Test 2: anime with release-group tags → one title ──');
  const animeFiles = [
    '[SubsPlease] Spy x Family S01E01 1080p.mkv',
    'Spy x Family - 02.mkv',
    '[Erai-raws] Spy.x.Family.03.720p.mkv',
  ];
  const animeIds = new Set();
  for (const fname of animeFiles) {
    const parsed = parseFilename(fname);
    const matched = await matchFileToTitle(parsed, path.join('/videos/anime', fname), { offline: true });
    ok(!!matched, `matched "${fname}"`);
    animeIds.add(matched.id);
  }
  ok(animeIds.size === 1, `anime variants → one series (ids: ${[...animeIds].join(', ')})`);

  console.log('\n── Test 3: alias / original-title matching ──');
  // Simulate a metadata-enriched row: canon name + original title/synonym.
  const richId = libraryStore.upsertTitle({
    type: 'anime',
    title: 'Attack on Titan',
    original_title: 'Shingeki no Kyojin',
    year: 2013,
    tmdb_id: 1429,
    match_confidence: 'auto',
  });
  libraryStore.addTitleAlias(richId, 'Attack on Titan', 'alternate');
  libraryStore.addTitleAlias(richId, 'Shingeki no Kyojin', 'synonym');
  libraryStore.addTitleAlias(richId, '進撃の巨人', 'synonym');

  const aliasFiles = [
    'Shingeki no Kyojin S01E01.mkv',
    'Attack on Titan S01E02.mkv',
    '[SubsPlease] 進撃の巨人 - 03.mkv',
  ];
  for (const fname of aliasFiles) {
    const parsed = parseFilename(fname);
    const matched = await matchFileToTitle(parsed, path.join('/videos/anime', fname), { offline: true });
    ok(matched && matched.id === richId, `"${fname}" groups onto enriched series #${richId}`);
  }
  const richEpisodes = libraryStore.getEpisodesForTitle(richId);
  ok(richEpisodes.length === 3, `3 episodes on the enriched series (got ${richEpisodes.length})`);

  console.log('\n── Test 4: folder-name matching ──');
  ok(getFolderHint('/videos/tv/Attack on Titan (2013)/S01E01.mkv') === 'Attack on Titan 2013',
    'folder hint extracts cleaned name');
  // A file whose name is pure episode markers sits in a folder named after
  // the series → the folder name must act as the title signal.
  const parsedFolder = parseFilename('S01E01.mkv');
  ok(parsedFolder.title === 'S01E01', 'bare S01E01 parses with no real title words');
  const resolution = resolveLocalTitle(parsedFolder, '/videos/tv/Attack on Titan (2013)/S01E01.mkv');
  ok(resolution.resolved && resolution.titleId === richId,
    'folder name pushes a bare S01E01 file onto the matching series');

  console.log('\n── Test 5: ambiguous near-ties ask for confirmation ──');
  // Simulate a drifted duplicate: two rows that both claim "One Piece".
  const dupeA = libraryStore.upsertTitle({ type: 'anime', title: 'One Piece', match_confidence: 'local' });
  const dupeB = libraryStore.upsertTitle({ type: 'anime', title: 'One Piece', match_confidence: 'local' });
  const parsedOP = parseFilename('[SubsPlease] One Piece - 1000.mkv');
  const ambiguous = resolveLocalTitle(parsedOP, '/videos/anime/[SubsPlease] One Piece - 1000.mkv');
  ok(ambiguous.ambiguous === true, 'near-tie rows are flagged ambiguous');
  ok(ambiguous.candidates.some((c) => c.titleId === dupeA) && ambiguous.candidates.some((c) => c.titleId === dupeB),
    'both candidates offered for confirmation');
  // Grouping still places the file on the best guess but reports ambiguity.
  const matchedOP = await matchFileToTitle(parsedOP, '/videos/anime/[SubsPlease] One Piece - 1000.mkv', { offline: true });
  ok(matchedOP.ambiguous === true, 'matchFileToTitle propagates ambiguity for user confirmation');
  ok(matchedOP.candidates.length === 2, 'two candidate series exposed to the UI');

  console.log('\n── Test 6: no third series is auto-created on rescan ──');
  const filesForOP = libraryStore.getAllFiles().filter((f) => f.file_path.includes('One Piece'));
  ok(filesForOP.length === 1, 'file exists after scan');
  // A follow-up episode in the same folder must reuse an existing series id —
  // either unambiguously (folder now points at the grouped row) or still
  // ambiguous — but NEVER create a brand-new third "One Piece" row.
  const rescan = resolveLocalTitle(parseFilename('[SubsPlease] One Piece - 1001.mkv'), '/videos/anime/[SubsPlease] One Piece - 1001.mkv');
  ok(rescan.ambiguous || (rescan.resolved && (rescan.titleId === dupeA || rescan.titleId === dupeB)),
    'follow-up episode resolves to an existing series (no duplicate row)');
  ok(!rescan.candidates.some((c) => c.titleId !== dupeA && c.titleId !== dupeB),
    'no third "One Piece" series is offered');

  closeDatabase();
  fs.unlinkSync(testDbPath);

  console.log(`\n${failed === 0 ? '🎉' : '❌'} SERIES GROUPING TESTS: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('❌ test crashed:', err);
  process.exit(1);
});