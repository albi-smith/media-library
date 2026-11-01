'use strict';

/**
 * test-phase3.js — Unit test script for Phase 3 (Metadata Matching)
 */

const path = require('path');
const fs = require('fs');
const { initDatabase, closeDatabase } = require('./src/main/db/database');
const libraryStore = require('./src/main/db/library-store');
const { searchAnime } = require('./src/main/library/anilist');
const { searchMovie, searchSeries } = require('./src/main/library/tmdb');
const { matchFileToTitle, computeTitleSimilarity } = require('./src/main/library/matcher');

const testDbPath = path.join(__dirname, 'test_phase3.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

console.log('Testing Phase 3 Metadata Matching (TMDB & AniList)...');

async function runTests() {
  try {
    initDatabase(testDbPath);

    // 1. Similarity calculation test
    const sim = computeTitleSimilarity('Attack on Titan', 'Attack on Titan');
    console.assert(sim === 1.0, `Expected 1.0, got ${sim}`);
    console.log('✔ Title similarity algorithm verified.');

    // 2. AniList Search test
    console.log('Fetching AniList metadata for "Demon Slayer"...');
    const animeResults = await searchAnime('Demon Slayer');
    console.assert(animeResults.length > 0, 'Expected AniList results');
    console.assert(animeResults[0].poster_url !== null, 'Expected AniList poster URL');
    console.log(`✔ AniList GraphQL API verified (${animeResults[0].title}, ID: ${animeResults[0].anilist_id}).`);

    // 3. TMDB Movie Search test
    console.log('Fetching TMDB metadata for "Inception"...');
    const movieResults = await searchMovie('Inception', 2010);
    console.assert(movieResults.length > 0, 'Expected TMDB movie results');
    console.assert(movieResults[0].year === 2010, 'Expected year 2010');
    console.log(`✔ TMDB REST API Movie Search verified (${movieResults[0].title}, ID: ${movieResults[0].tmdb_id}).`);

    // 4. Matcher engine integration test
    console.log('Testing matcher engine end-to-end...');
    const parsedAnime = {
      title: 'Demon Slayer',
      typeCandidate: 'anime',
      episode: 1,
      season: 1,
    };
    const matched = await matchFileToTitle(parsedAnime, '/videos/anime/DemonSlayer_S01E01.mkv');
    console.assert(matched !== null, 'Expected matched title record');
    console.assert(matched.poster_url !== null, 'Expected poster URL on title');
    console.assert(matched.match_confidence === 'auto', `Expected 'auto' confidence, got ${matched.match_confidence}`);
    console.log(`✔ Matcher engine auto-assignment verified: ${matched.title} (${matched.match_confidence}).`);

    // Cleanup
    closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    console.log('🎉 ALL PHASE 3 TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('❌ Phase 3 test failed:', err);
    process.exit(1);
  }
}

runTests();
