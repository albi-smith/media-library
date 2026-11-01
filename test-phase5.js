'use strict';

/**
 * test-phase5.js — Unit test script for Phase 5 (Watch Progress Tracking)
 */

const path = require('path');
const fs = require('fs');
const { initDatabase, closeDatabase } = require('./src/main/db/database');
const libraryStore = require('./src/main/db/library-store');
const progressTracker = require('./src/main/library/progress-tracker');

const testDbPath = path.join(__dirname, 'test_phase5.db');
if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

console.log('Testing Phase 5 Watch Progress Tracking...');

try {
  initDatabase(testDbPath);

  const titleId = libraryStore.upsertTitle({
    type: 'series',
    title: 'Breaking Bad',
    match_confidence: 'auto',
  });

  const filePath = '/videos/tv/BreakingBad_S01E01.mp4';
  libraryStore.upsertFile({
    file_path: filePath,
    title_id: titleId,
    season_number: 1,
    episode_number: 1,
  });

  // Simulate video playback events
  progressTracker.onFileStarted(filePath);
  progressTracker.onPropertyChange('duration', 3000);
  progressTracker.onPropertyChange('time-pos', 1500); // 50% watched

  let progress = libraryStore.getWatchProgressByPath(filePath);
  console.assert(progress.progress_seconds === 1500, `Expected 1500, got ${progress.progress_seconds}`);
  console.assert(progress.completed === 0, 'Should not be marked completed at 50%');
  console.log('✔ Mid-playback progress persisted (50%).');

  // Simulate end of playback (95% completion threshold)
  progressTracker.onPropertyChange('time-pos', 2850); // 95%
  progress = libraryStore.getWatchProgressByPath(filePath);
  console.assert(progress.completed === 1, 'Should be marked completed at 95%');
  console.log('✔ Playback completion auto-detected at 95%.');

  // Verify Recently Watched API
  const recentlyWatched = libraryStore.getRecentlyWatched();
  console.assert(recentlyWatched.length === 1, 'Expected 1 item in recently watched');
  console.assert(recentlyWatched[0].title === 'Breaking Bad', 'Expected Breaking Bad in recently watched');
  console.log('✔ Recently watched querying verified.');

  closeDatabase();
  if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

  console.log('🎉 ALL PHASE 5 TESTS PASSED SUCCESSFULLY!');
} catch (err) {
  console.error('❌ Phase 5 test failed:', err);
  process.exit(1);
}
