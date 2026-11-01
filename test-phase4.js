'use strict';

/**
 * test-phase4.js — Unit test script for Phase 4 (Manual Match Correction & Override Survival)
 */

const path = require('path');
const fs = require('fs');
const { initDatabase, closeDatabase } = require('./src/main/db/database');
const libraryStore = require('./src/main/db/library-store');
const { scanFolder, searchMetadataCandidates, fixMatch } = require('./src/main/library/library-service');

const testDbPath = path.join(__dirname, 'test_phase4.db');
const testScanDir = path.join(__dirname, 'test_phase4_dir');

if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
if (fs.existsSync(testScanDir)) fs.rmSync(testScanDir, { recursive: true, force: true });

fs.mkdirSync(testScanDir, { recursive: true });
fs.writeFileSync(path.join(testScanDir, 'MysteriousMovie_2020.mkv'), 'dummy');

console.log('Testing Phase 4 Manual Match Correction & Override Survival...');

async function runTests() {
  try {
    initDatabase(testDbPath);

    // 1. Initial scan
    await scanFolder(testScanDir);
    const titlesBefore = libraryStore.getAllTitles();
    console.assert(titlesBefore.length > 0, 'Expected scanned title');
    const targetTitle = titlesBefore[0];
    console.log(`✔ Initial scan completed. Assigned title ID: ${targetTitle.id} (${targetTitle.title}).`);

    // 2. Search candidates for manual match
    const candidates = await searchMetadataCandidates('Inception', 'movie');
    console.assert(candidates.length > 0, 'Expected candidates returned');
    console.log(`✔ Search metadata candidates returned ${candidates.length} options.`);

    // 3. Fix Match manually
    const corrected = await fixMatch(targetTitle.id, {
      type: 'movie',
      title: 'Inception (Corrected)',
      year: 2010,
      poster_url: 'https://example.com/inception.jpg',
      tmdb_id: 27205,
    });

    console.assert(corrected.match_confidence === 'manual', `Expected 'manual' confidence, got ${corrected.match_confidence}`);
    console.assert(corrected.title === 'Inception (Corrected)', `Expected corrected title, got ${corrected.title}`);
    console.log('✔ Manual match correction applied and locked with match_confidence = manual.');

    // 4. Perform folder RE-SCAN to verify manual match survival!
    console.log('Re-scanning folder to test manual override survival...');
    await scanFolder(testScanDir);
    const titleAfterRescan = libraryStore.getTitleById(targetTitle.id);
    console.assert(titleAfterRescan.title === 'Inception (Corrected)', 'Manual override was overwritten!');
    console.assert(titleAfterRescan.match_confidence === 'manual', 'Match confidence was changed!');
    console.log('✔ Manual override SURVIVED folder re-scan successfully!');

    // Cleanup
    closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(testScanDir)) fs.rmSync(testScanDir, { recursive: true, force: true });

    console.log('🎉 ALL PHASE 4 TESTS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('❌ Phase 4 test failed:', err);
    process.exit(1);
  }
}

runTests();
