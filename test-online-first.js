'use strict';

/**
 * test-online-first.js — Verifies the online-first matching pipeline and the
 * offline fallback.
 *
 * Metadata providers are stubbed BEFORE the matcher is loaded so its
 * destructured imports pick up the fakes. This keeps the suite deterministic
 * and fully offline while still exercising the real matching code paths.
 *
 * Covered:
 *   1. Offline mode never touches the network and still groups locally.
 *   2. A confident online hit creates/reuses an externally-keyed row, attaches
 *      the file, and fills per-episode metadata.
 *   3. A pre-existing filename-guess row is merged into the verified row
 *      (replace & merge) and deleted.
 *   4. A weak/no online hit falls back to local grouping (no external id).
 *   5. External-id dedup reuses an existing verified row.
 *   6. store.mergeTitle moves files/episodes/progress/aliases and deletes the
 *      source; target episode data wins on conflict.
 *   7. getTitleByExternalId / getTitlesNeedingReparse honour manual + verified.
 *   8. reparseIncompleteTitles(enriched, merged, unmatched) end-to-end.
 *   9. Re-scanning an already-verified file does NOT re-query the providers.
 */

const path = require('path');
const fs = require('fs');

// ── Stub metadata providers BEFORE requiring the matcher ────────────────────
const tmdb = require('./src/main/library/tmdb');
const anilist = require('./src/main/library/anilist');
const jikan = require('./src/main/library/jikan');

let fakeSeries = [];
let fakeMovie = [];
let fakeSeasonEpisodes = [];
let fakeAnime = [];
let fakeJikan = [];
let fakeAnimeEpisodes = [];
let seriesCalls = 0;
let animeCalls = 0;
let movieCalls = 0;

tmdb.searchSeries = async () => { seriesCalls++; return fakeSeries.slice(); };
tmdb.searchMovie = async () => { movieCalls++; return fakeMovie.slice(); };
tmdb.getSeasonEpisodes = async () => fakeSeasonEpisodes.slice();
anilist.searchAnime = async () => { animeCalls++; return fakeAnime.slice(); };
jikan.searchJikan = async () => fakeJikan.slice();
jikan.getAnimeEpisodes = async () => fakeAnimeEpisodes.slice();

const { initDatabase } = require('./src/main/db/database');
const libraryStore = require('./src/main/db/library-store');
const matcher = require('./src/main/library/matcher');
const libraryService = require('./src/main/library/library-service');
const connectivity = require('./src/main/library/connectivity');
const { parseFilename } = require('./src/main/library/parser');

const testDbPath = path.join(__dirname, 'test_online_first.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

let passed = 0;
let failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log('  ✔ ' + label); }
  else { failed++; console.log('  ✘ FAIL: ' + label); }
}

function resetFixtures() {
  fakeSeries = [];
  fakeMovie = [];
  fakeSeasonEpisodes = [];
  fakeAnime = [];
  fakeJikan = [];
  fakeAnimeEpisodes = [];
  seriesCalls = 0;
  animeCalls = 0;
  movieCalls = 0;
}

function seriesCand(over = {}) {
  return {
    id: 7001,
    type: 'series',
    title: 'Breaking Bad',
    original_title: 'Breaking Bad',
    synonyms: [],
    year: 2008,
    overview: 'A chemistry teacher turns to crime.',
    poster_url: 'https://img/bb.jpg',
    backdrop_url: null,
    rating: 9.5,
    tmdb_id: 7001,
    ...over,
  };
}

function movieCand(over = {}) {
  return {
    id: 7707,
    type: 'movie',
    title: 'Reparse Movie',
    original_title: 'Reparse Movie',
    synonyms: [],
    year: 2019,
    overview: 'A movie that was only guessed offline.',
    poster_url: 'https://img/movie.jpg',
    backdrop_url: null,
    rating: 7.1,
    tmdb_id: 7707,
    ...over,
  };
}

function ep(number, name) {
  return {
    episode_number: number,
    season_number: 1,
    name,
    overview: 'episode overview',
    still_url: 'https://img/ep.jpg',
    air_date: '2008-01-20',
  };
}

const win = (p) => path.join('D:\\vids', p);

async function main() {
  initDatabase(testDbPath);

  // ── Test 1: offline mode never touches the network ───────────────────────
  console.log('\n── Test 1: offline mode groups locally, no provider calls ──');
  resetFixtures();
  libraryStore.resetLibrary();
  const p1 = win('Breaking Bad S01E01.mkv');
  const r1 = await matcher.matchFileToTitle(parseFilename(p1), p1, { offline: true });
  ok(r1 && r1.id != null, 'offline match produced a title');
  ok(!r1.tmdb_id && !r1.anilist_id && !r1.mal_id, 'offline row has no external id');
  ok(seriesCalls + animeCalls + movieCalls === 0, 'no provider was queried while offline');
  const f1 = libraryStore.getFileByPath(p1);
  ok(f1 && f1.title_id === r1.id, 'offline file attached to the local row');

  // ── Test 2: confident online hit → verified row + episode metadata ───────
  console.log('\n── Test 2: online-first creates a verified row and fills episodes ──');
  resetFixtures();
  libraryStore.resetLibrary();
  fakeSeries = [seriesCand()];
  fakeSeasonEpisodes = [ep(1, 'Pilot')];
  const p2 = win('Breaking Bad S01E02.mkv');
  const r2 = await matcher.matchFileToTitle(parseFilename(p2), p2); // no offline → online-first
  ok(r2 && r2.tmdb_id === 7001, 'file resolved to the verified TMDB row');
  ok(r2.match_confidence === 'auto', 'verified row marked auto');
  const f2 = libraryStore.getFileByPath(p2);
  ok(f2 && f2.title_id === r2.id, 'file attached to the verified row');
  const eps2 = libraryStore.getEpisodesForTitle(r2.id);
  ok(eps2.some((e) => e.name === 'Pilot' && e.still_url), 'per-episode metadata filled from the provider');
  ok(seriesCalls >= 1, 'series provider was consulted');

  // ── Test 3: re-scan of a verified file does NOT re-query providers ───────
  console.log('\n── Test 3: already-verified files skip the network on re-scan ──');
  const beforeCalls = seriesCalls + animeCalls + movieCalls;
  const r3 = await matcher.matchFileToTitle(parseFilename(p2), p2);
  ok(r3 && r3.id === r2.id, 're-scan keeps the same verified row');
  ok(seriesCalls + animeCalls + movieCalls === beforeCalls, 'no provider call on re-scan');

  // ── Test 4: filename-guess row is merged into the verified row ───────────
  console.log('\n── Test 4: replace & merge a prior filename-guess row ──');
  resetFixtures();
  libraryStore.resetLibrary();
  const p4 = win('Breaking Bad S01E03.mkv');
  const guess = await matcher.matchFileToTitle(parseFilename(p4), p4, { offline: true });
  ok(guess && !guess.tmdb_id, 'offline scan created a filename-guess row');
  const guessId = guess.id;
  const guessFile = libraryStore.getFileByPath(p4);
  ok(guessFile.title_id === guessId, 'file started on the guess row');

  fakeSeries = [seriesCand({ id: 8888, tmdb_id: 8888 })];
  const verified = await matcher.matchFileToTitle(parseFilename(p4), p4);
  ok(verified && verified.tmdb_id === 8888, 'online pass resolved the verified row');
  ok(verified.id !== guessId, 'verified row is a different row');
  ok(libraryStore.getTitleById(guessId) == null, 'filename-guess row merged away and deleted');
  ok(libraryStore.getFileByPath(p4).title_id === verified.id, 'file re-pointed to the verified row');

  // ── Test 5: weak online hit → local fallback, no external id ─────────────
  console.log('\n── Test 5: no confident online hit falls back to local grouping ──');
  resetFixtures();
  libraryStore.resetLibrary();
  fakeSeries = [seriesCand({ id: 1, tmdb_id: 999999, title: 'Totally Unrelated Show' })];
  const p5 = win('Some Obscure Show S01E01.mkv');
  const r5 = await matcher.matchFileToTitle(parseFilename(p5), p5);
  ok(r5 && r5.id != null, 'fallback still produced a title');
  ok(!r5.tmdb_id && !r5.anilist_id && !r5.mal_id, 'fallback row is local-only (no external id)');
  ok(libraryStore.getFileByPath(p5).title_id === r5.id, 'file attached to the local fallback row');

  // ── Test 6: external-id dedup ────────────────────────────────────────────
  console.log('\n── Test 6: external-id dedup reuses the verified row ──');
  resetFixtures();
  libraryStore.resetLibrary();
  const existingId = libraryStore.upsertTitle({
    type: 'series', title: 'Dedup Show', tmdb_id: 5555, match_confidence: 'auto',
  });
  ok(libraryStore.getTitleByExternalId({ tmdb_id: 5555 }).id === existingId, 'getTitleByExternalId finds the row');
  ok(libraryStore.getTitleByExternalId({ tmdb_id: 999 }) === null, 'getTitleByExternalId misses unknown id');
  fakeSeries = [seriesCand({ id: 5555, tmdb_id: 5555, title: 'Dedup Show' })];
  const p6 = win('Dedup Show S01E01.mkv');
  const r6 = await matcher.matchFileToTitle(parseFilename(p6), p6);
  ok(r6.id === existingId, 'online match reused the existing row instead of duplicating');

  // ── Test 7: store.mergeTitle moves everything and deletes the source ─────
  console.log('\n── Test 7: mergeTitle moves files/episodes/progress/aliases ──');
  resetFixtures();
  libraryStore.resetLibrary();
  const srcId = libraryStore.upsertTitle({ type: 'series', title: 'Guess A', match_confidence: 'local' });
  const dstId = libraryStore.upsertTitle({ type: 'series', title: 'Verified B', tmdb_id: 4242, match_confidence: 'auto' });
  libraryStore.upsertFile({ file_path: win('a1.mkv'), title_id: srcId, season_number: 1, episode_number: 1 });
  libraryStore.upsertFile({ file_path: win('a2.mkv'), title_id: srcId, season_number: 1, episode_number: 2 });
  libraryStore.upsertEpisode({ title_id: srcId, season_number: 1, episode_number: 1, name: 'placeholder' });
  libraryStore.upsertEpisode({ title_id: dstId, season_number: 1, episode_number: 1, name: 'real name' });
  libraryStore.addTitleAlias(srcId, 'Guess Alias', 'synonym');
  libraryStore.updateWatchProgress({
    file_path: win('a1.mkv'), title_id: srcId, season_number: 1, episode_number: 1,
    progress_seconds: 10, duration_seconds: 100,
  });
  const merged = libraryStore.mergeTitle(srcId, dstId);
  ok(merged === 1, 'mergeTitle reports success');
  ok(libraryStore.getTitleById(srcId) == null, 'source title deleted');
  ok(libraryStore.getFilesForTitle(dstId).length === 2, 'both files moved to the target');
  ok(libraryStore.getAliasesForTitle(dstId).some((a) => a.alias === 'guess alias'), 'alias copied to the target');
  const dstEps = libraryStore.getEpisodesForTitle(dstId);
  ok(dstEps.length === 1 && dstEps[0].name === 'real name', 'target episode data wins on conflict');
  const wp = libraryStore.getWatchProgressByPath(win('a1.mkv'));
  ok(wp && wp.title_id === dstId, 'watch progress re-pointed to the target');

  // ── Test 8: getTitlesNeedingReparse filtering ────────────────────────────
  console.log('\n── Test 8: getTitlesNeedingReparse excludes verified & manual ──');
  resetFixtures();
  libraryStore.resetLibrary();
  const localT = libraryStore.upsertTitle({ type: 'series', title: 'Local Only', match_confidence: 'local' });
  const manualT = libraryStore.upsertTitle({ type: 'series', title: 'Manual Lock', match_confidence: 'manual' });
  const verifiedT = libraryStore.upsertTitle({ type: 'series', title: 'Verified', tmdb_id: 1111, match_confidence: 'auto' });
  const needing = libraryStore.getTitlesNeedingReparse().map((t) => t.id);
  ok(needing.includes(localT), 'unverified local row is queued for reparse');
  ok(!needing.includes(manualT), 'manual row is never reparsed');
  ok(!needing.includes(verifiedT), 'externally-keyed row is never reparsed');

  // ── Test 9: reparseIncompleteTitles end-to-end ───────────────────────────
  console.log('\n── Test 9: reparseIncompleteTitles enriches + merges + resolves ──');
  resetFixtures();
  libraryStore.resetLibrary();
  const p9 = win('Reparse Show S01E01.mkv');
  const local9 = await matcher.matchFileToTitle(parseFilename(p9), p9, { offline: true });
  ok(local9 && !local9.tmdb_id, 'offline pre-condition: local row exists');
  const strayMovie = win('Reparse Movie 2019.mkv');
  libraryStore.upsertFile({ file_path: strayMovie, title_id: null });

  fakeSeries = [seriesCand({ id: 6606, tmdb_id: 6606, title: 'Reparse Show' })];
  fakeMovie = [movieCand()];
  fakeSeasonEpisodes = [ep(1, 'Reparse Ep')];

  const summary = await libraryService.reparseIncompleteTitles({ force: true });
  ok(summary.online === true, 'reparse reports online');
  ok(summary.titlesEnriched >= 1, `at least one title enriched (got ${summary.titlesEnriched})`);
  const p9File = libraryStore.getFileByPath(p9);
  const p9Title = libraryStore.getTitleById(p9File.title_id);
  ok(p9Title && p9Title.tmdb_id === 6606, 'local show merged into its verified row');
  ok(libraryStore.getTitleById(local9.id) == null, 'old local row removed by the merge');
  const movieFile = libraryStore.getFileByPath(strayMovie);
  const movieTitle = movieFile ? libraryStore.getTitleById(movieFile.title_id) : null;
  ok(movieTitle && movieTitle.tmdb_id === 7707, 'unmatched movie resolved during reparse');

  // ── Test 10: connectivity helper basics (no network assertions) ──────────
  console.log('\n── Test 10: connectivity helper surface ──');
  ok(typeof connectivity.isOnline() === 'boolean', 'isOnline() returns a boolean');
  let fired = false;
  const off = connectivity.on('online', () => { fired = true; });
  off();
  ok(!fired, 'unsubscribe removes the listener');

  console.log(`\n🎉 ONLINE-FIRST TESTS: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('\n💥 Test crashed:', err);
  process.exitCode = 1;
});
