# Media Library v1 — Implementation & Task Checklist

> **Note for AI Agents & Developers**: This file tracks the active progress of the Media Library v1 build for Movies, Series, and Anime. Work must strictly proceed **one task at a time**. Mark items as `[x]` as they are completed and verified.

---

## 🏛️ Architecture Overview

- **Modular Design**:
  - `player`: Existing Electron + mpv process manager & IPC bindings (`main.js`, `mpv-manager.js`, `mpv-ipc.js`) remains decoupled.
  - `library`: Main-process service for local SQLite storage, folder scanning, filename parsing, TMDB/AniList metadata matching, and watch progress tracking (`src/main/db/`, `src/main/library/`).
  - `manga` / `livetv`: Reserved for future expansion sharing the same local SQLite database.
- **Database**: Local SQLite database stored at `app.getPath('userData')/library.db`.

---

## 📋 Task Checklist

### Phase 1 — Data Layer Foundation
- [x] **Task 1.1**: Set up local SQLite database connection manager and migration runner (`src/main/db/database.js`).
- [x] **Task 1.2**: Define and execute SQLite schema tables:
  - `library_folders` (id, folder_path, last_scanned_at)
  - `titles` (id, type, title, original_title, year, overview, poster_url, backdrop_url, tmdb_id, anilist_id, match_confidence, created_at, updated_at)
  - `episodes` (id, title_id, season_number, episode_number, name, overview, still_url, air_date)
  - `files` (id, file_path, title_id, season_number, episode_number, raw_parse_json, file_size, last_modified)
  - `watch_progress` (id, file_path, title_id, season_number, episode_number, progress_seconds, duration_seconds, completed, last_watched_at)
- [x] **Task 1.3**: Implement CRUD helper functions for library store (`src/main/db/library-store.js`) and create/run automated unit verification script.

### Phase 2 — File Scanning & Filename Parsing
- [x] **Task 2.1**: Implement recursive video file scanner (`src/main/library/scanner.js`) with folder picker IPC handler.
- [x] **Task 2.2**: Implement filename parser (`src/main/library/parser.js`) for Movies (`Title (Year)`), TV Shows (`S01E02`), and Anime (`[Group] Title - 01`).
- [x] **Task 2.3**: Save scanned files and raw parse results to SQLite `files` table; verify parsing accuracy across test file paths.

### Phase 3 — Metadata Matching (TMDB & AniList)
- [x] **Task 3.1**: Build AniList GraphQL client (`src/main/library/anilist.js`) for anime queries.
- [x] **Task 3.2**: Build TMDB REST client (`src/main/library/tmdb.js`) for movie and series queries.
- [x] **Task 3.3**: Implement title matcher engine (`src/main/library/matcher.js`): query APIs, auto-assign confident matches, flag low-confidence/ambiguous matches (`match_confidence = 'flagged'`).

### Phase 4 — Manual Match Correction
- [x] **Task 4.1**: Build backend IPC handlers (`library:search-metadata`, `library:fix-match`) for manual metadata search & update.
- [x] **Task 4.2**: Add manual match persistence flag (`match_confidence = 'manual'`) so future folder rescans preserve manual overrides.

### Phase 5 — Watch Progress Tracking
- [x] **Task 5.1**: Hook into mpv IPC events (`mpv:property-change` for `time-pos`, `duration`, `end-file`) in `main.js`.
- [x] **Task 5.2**: Persist watch progress in `watch_progress` table; compute episodes watched for series/anime and completion status for movies.

### Phase 6 — Main Layout & Sidebar UI
- [x] **Task 6.1**: Update `renderer/index.html` layout: add left Sidebar (`Watching`, `Library`, `Manga [Coming Soon]`, `TV [Coming Soon]`) with responsive viewport.
- [x] **Task 6.2**: Build **Library View**: poster grid, content filter tabs (All, Movies, Series, Anime), title search bar, and "Add Folder" button.
- [x] **Task 6.3**: Build **Watching View**: recently played titles ordered by `last_watched_at` with progress bars and "Resume" action.

### Phase 7 — Detail View & Manual Correction UI
- [x] **Task 7.1**: Build **Detail View**: poster image, backdrop, title metadata, overview, genres, "Play" button, and episode list with watched indicators.
- [x] **Task 7.2**: Build **Fix Match Modal**: search TMDB/AniList, preview candidates, select correct match, and update UI.

### Phase 8 — End-to-End Integration & PRD Verification
- [x] **Task 8.1**: Full flow test: Scan folder → Match library → Play from detail view → Track progress in real-time → Verify "Watching" update.
- [x] **Task 8.2**: Validate manual match survival after folder re-scan. Re-verify all success criteria against PRD Section 11.

---

## 📌 Guidelines for AI Agents

1. **One Task at a Time**: Never attempt multiple tasks in a single turn without checking and verifying output first.
2. **Status Updates**: Mark `[ ]` as `[x]` in this document immediately upon completing and verifying each task.
3. **Verification**: Always run verification (tests or interactive app check) before marking a task complete.
