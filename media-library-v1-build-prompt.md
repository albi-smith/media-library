# Build Prompt: Media Library v1 (Movies, Series, Anime)

## Objective
Extend the existing Electron + mpv video player into a local media library
app for Movies, Series, and Anime — auto-matching local files to metadata,
tracking watch progress, and presenting them through a sidebar-navigated UI.
Full detail and rationale live in the attached PRD (`prd-media-library-app.md`)
— treat that as the source of truth for scope and reasoning; this prompt
translates it into an execution plan.

## Process Requirement (important)
**Break this into small phases and a task list. Complete and report back on
one task at a time — do not proceed to the next task until the current one
is confirmed working.** After each task, state what was built, how it was
verified, and what's next. This mirrors how the player itself was debugged
successfully — small, checkable steps rather than one large batch of changes.

## Architecture Decision Needed First
Before Phase 1 begins: confirm the modular structure from PRD Section 7 —
`player` (existing, unchanged), `library` (scanning/matching/metadata/progress),
with `manga` and `livetv` as separate future modules sharing the same local
SQLite database. State any reasons to deviate from this before writing code,
not after.

## Suggested Phase Breakdown

### Phase 1 — Data layer foundation
- [ ] Set up local SQLite database (new, separate from player's `config.json`)
- [ ] Define schema: titles, episodes/seasons, watch progress, metadata cache,
      match-confidence/manual-override flag
- [ ] Basic CRUD functions for the library module — no UI yet, verify via
      direct queries/tests

### Phase 2 — File scanning + parsing
- [ ] Folder picker → recursive scan for video files
- [ ] Integrate `guessit` (or equivalent) to parse filenames into
      title/season/episode candidates
- [ ] Store raw parse results against each file in the DB (no metadata
      lookup yet — verify parsing accuracy first, in isolation)

### Phase 3 — Metadata matching
- [ ] TMDB integration for Movies/Series
- [ ] AniList integration for Anime
- [ ] Match parsed filename data → metadata API query → store result
      (poster URL, title, description, season/episode structure)
- [ ] Flag low-confidence/ambiguous matches rather than silently accepting them

### Phase 4 — Manual match correction UI
- [ ] Simple UI to review a flagged/incorrect match and search/select the
      correct title manually
- [ ] Persist manual corrections so they aren't overwritten on re-scan

### Phase 5 — Watch progress tracking
- [ ] Hook into existing player IPC events (`playback-time`, `duration`,
      `end-file`) to record progress per title/episode
- [ ] Compute and store: episodes watched (series/anime), hours watched (movies)

### Phase 6 — Library UI
- [ ] Sidebar: Watching / Library / Manga (placeholder) / TV (placeholder)
- [ ] Library view: poster grid for Movies/Series/Anime, populated from DB
- [ ] Watching view: recently played, most-recent-first

### Phase 7 — Detail page
- [ ] Click-through from Library grid to a detail page per title
- [ ] Show: poster, metadata, Play button (opens existing player), episode
      list with watched status (series/anime) or watched-hours (movies)

### Phase 8 — Integration pass
- [ ] Full flow test: scan folder → matched library → play from detail page
      → progress reflected → appears in Watching
- [ ] Confirm manual-match corrections survive a re-scan

## Explicitly Out of Scope for This Build
Everything in PRD Section 9 — Manga, Live TV, mobile, multi-device sync,
accounts, monetization. Placeholders only for Manga/TV nav items, no
functionality behind them.

## Success Criteria
Matches PRD Section 11 exactly — re-verify against that list at the end of
Phase 8 before calling v1 done.
