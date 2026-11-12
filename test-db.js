'use strict';

/**
 * test-db.js — Unit test script for Phase 1 Data Layer Foundation
 */

const path = require('path');
const fs = require('fs');
const { initDatabase, closeDatabase } = require('./src/main/db/database');
const libraryStore = require('./src/main/db/library-store');

const testDbPath = path.join(__dirname, 'test_temp.db');

// Clean up old test db if present
if (fs.existsSync(testDbPath)) {
  fs.unlinkSync(testDbPath);
}

console.log('Testing Phase 1 Data Layer Foundation...');

try {
  // 1. Initialize database
  initDatabase(testDbPath);
  console.log('✔ SQLite Database initialized with WAL mode & foreign keys enabled.');

  // 2. Folders CRUD
  libraryStore.addFolder('/videos/anime');
  libraryStore.addFolder('/videos/movies');
  const folders = libraryStore.getAllFolders();
  console.assert(folders.length === 2, 'Folder count should be 2');
  console.log('✔ Folder CRUD operations verified.');

  // 3. Titles CRUD
  const titleId = libraryStore.upsertTitle({
    type: 'anime',
    title: 'Attack on Titan',
    original_title: 'Shingeki no Kyojin',
    year: 2013,
    overview: 'Humanity fights against giant humanoids.',
    poster_url: 'https://example.com/poster.jpg',
    backdrop_url: 'https://example.com/backdrop.jpg',
    anilist_id: 16498,
    match_confidence: 'auto',
  });
  console.assert(titleId > 0, 'Title ID should be greater than 0');

  const title = libraryStore.getTitleById(titleId);
  console.assert(title.title === 'Attack on Titan', 'Title mismatch');
  console.log('✔ Title CRUD operations verified.');

  // 4. Episodes CRUD
  const epId = libraryStore.upsertEpisode({
    title_id: titleId,
    season_number: 1,
    episode_number: 1,
    name: 'To You, 2,000 Years in the Future',
    overview: 'The Titans breach the wall.',
  });
  console.assert(epId > 0, 'Episode ID should be greater than 0');

  const episodes = libraryStore.getEpisodesForTitle(titleId);
  console.assert(episodes.length === 1, 'Episodes count should be 1');
  console.assert(episodes[0].name === 'To You, 2,000 Years in the Future', 'Episode name mismatch');
  console.log('✔ Episode CRUD operations verified.');

  // 5. Files CRUD
  const fileId = libraryStore.upsertFile({
    file_path: '/videos/anime/Attack on Titan S01E01.mkv',
    title_id: titleId,
    season_number: 1,
    episode_number: 1,
    raw_parse_json: JSON.stringify({ title: 'Attack on Titan', season: 1, episode: 1 }),
    file_size: 1048576000,
    last_modified: new Date().toISOString(),
  });
  console.assert(fileId > 0, 'File ID should be > 0');

  const fileInfo = libraryStore.getFileByPath('/videos/anime/Attack on Titan S01E01.mkv');
  console.assert(fileInfo.title_id === titleId, 'File title_id mismatch');
  console.log('✔ File CRUD operations verified.');

  // 6. Watch Progress CRUD
  libraryStore.updateWatchProgress({
    file_path: '/videos/anime/Attack on Titan S01E01.mkv',
    title_id: titleId,
    season_number: 1,
    episode_number: 1,
    progress_seconds: 600,
    duration_seconds: 1420,
    completed: 0,
  });

  const progress = libraryStore.getWatchProgressByPath('/videos/anime/Attack on Titan S01E01.mkv');
  console.assert(progress.progress_seconds === 600, 'Progress seconds mismatch');

  const recentlyWatched = libraryStore.getRecentlyWatched();
  console.assert(recentlyWatched.length === 1, 'Recently watched should have 1 item');
  console.assert(recentlyWatched[0].title === 'Attack on Titan', 'Recently watched title mismatch');
  console.log('✔ Watch progress operations verified.');

  closeDatabase();
  if (fs.existsSync(testDbPath)) {
    fs.unlinkSync(testDbPath);
  }
  console.log('🎉 ALL PHASE 1 TESTS PASSED SUCCESSFULLY!');
} catch (err) {
  console.error('❌ Phase 1 test failed:', err);
  process.exit(1);
}
