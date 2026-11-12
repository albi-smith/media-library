# PRD: Local Media Library App
*(Video Player + Movie/Series/Anime/Manga/Live TV Library)*

## 1. Vision
A single desktop app that plays local video files (via the existing mpv-based
player) and organizes them into a browsable library with posters and metadata
— expanding over time to include a manga reader and live TV, all sharing one
local library database.

## 2. Phased Scope

| Phase | Content types | Status |
|---|---|---|
| **v1 (this PRD's focus)** | Movies, Series, Anime | Build now |
| v2 | Manga (reading + local tracking, YACReader-style) | Planned, not scoped in detail yet |
| v3 | Manga repository/extension sources (Mihon-style) | Planned — **legal model to be deliberately decided when reached**, not copied by default (see Open Risks) |
| v4 | Live TV via iptv-org playlists | Planned — EPG/channel-list approach still undecided |
| Future | Mobile clients, multi-device sync | Explicitly deferred |

## 3. v1 Goals
- Turn the existing mpv-based player into a full local library app for
  Movies, Series, and Anime.
- Auto-match local files to metadata (poster, title, episode/season structure)
  with a manual "fix match" fallback.
- Track watch progress (episodes watched, hours watched) per title.
- Sidebar navigation: **Watching / Library / Manga / TV** (Manga and TV visible
  as nav items but non-functional / "coming soon" in v1, per your UI spec).

## 4. Content Sources (v1)
- **Local files only.** All common video formats supported (inherited from
  the existing mpv/FFmpeg-based player — no format restriction).
- Network shares (NAS), cloud drives: **not in v1**, explicitly deferred.

## 5. Metadata Sources

| Content type | Source | Notes |
|---|---|---|
| Movies | TMDB | Free API, requires attribution per TMDB terms |
| Series | TMDB | Same as above |
| Anime | AniList | Better season/studio handling than TMDB for anime specifically |
| Manga (future) | **MangaDex**, not AniList | Recommended change from earlier discussion — requirement is to recognize manga title and chapter number regardless of which scanlation group produced the downloaded file (not to track/organize by group); MangaDex's manga-specific title and per-chapter data fits this better than AniList's more general-purpose manga entries |
| Live TV (future) | iptv-org playlists; EPG source TBD | You've deferred this — noted as open |

## 6. Filename Matching (v1)
- Use an existing parsing library (e.g. `guessit`) to extract title/season/
  episode from messy local filenames rather than writing custom regex.
- Send parsed result as a search query to TMDB/AniList.
- **Never auto-apply a silent match** — surface the matched result to the
  user for confirm/correct, especially for anime where title variants and
  absolute-vs-season numbering commonly cause mismatches.

## 7. Data Model / Architecture
- **Local SQLite database** — no server, no account, no sync (matches your
  "local only" answer).
- Recommended (not yet decided by you — flagged in Q7 as "no idea"):
  build this as **modular components sharing one library DB**:
  - `player` module (existing mpv engine — unchanged)
  - `library` module (scanning, matching, metadata cache, watch progress)
  - `manga` module (future, separate reader UI, same DB)
  - `livetv` module (future, separate playback path for streams, same DB)

  Rationale: keeps each piece independently debuggable (same reasoning
  already applied to keeping the player and its IPC layer decoupled), and
  means Manga/TV can be built and shipped later without touching the
  player or library-matching code.

## 8. UI Structure (as specified)

**Sidebar:**
- **Watching** — recently played media (movies/series/anime), most-recent-first
- **Library** — Movies, Series, Anime unified, browsable by poster grid
- **Manga** — v1: empty/"coming soon" placeholder
- **TV** — v1: empty/"coming soon" placeholder

**Detail page (on clicking any title in Library):**
- Play button (opens existing player)
- Metadata: poster, title, description, cast/info from TMDB/AniList
- For series/anime: episode count, per-episode watched status
- For movies: hours watched / completion state
- Same detail-page pattern to be reused for Manga once built (chapters
  instead of episodes, pages-read instead of hours-watched)

## 9. Non-Goals for v1
- Manga reading/tracking (any form)
- Live TV / IPTV playback
- Mobile app
- Multi-device sync or accounts
- Monetization (no change from earlier decision — free/open first)

## 10. Open Risks / Decisions Still Needed (flagged, not resolved here)
1. **Manga repository/extension model (v3)** — decide deliberately whether
   to adopt a Mihon-style extension ecosystem, given the legal scrutiny
   that model has drawn industry-wide (Tachiyomi/Mihon lineage). Not a v1
   blocker, but shouldn't be copied by default when you get there.
2. **Live TV legality/scope** — iptv-org aggregates publicly listed streams;
   legality and geo-availability vary by channel/region. Decide whether v4
   scopes this to a curated/regional subset with a disclaimer, or includes
   the full list as-is.
3. **EPG approach** — you've deferred this; iptv-org has a separate EPG repo
   to evaluate when you get to Phase v4.
4. **Architecture** — you had "no idea" on modular vs. integrated; the
   modular recommendation above is a proposal, not a locked decision.

## 11. Success Criteria (v1)
A user can:
1. Point the app at a local folder of movies/series/anime.
2. See it auto-scan, match, and populate the Library with posters/metadata.
3. Correct any wrong matches manually.
4. Click a title, see its detail page, and play it through the existing player.
5. See watch progress reflected (episodes watched / hours watched).
6. See recently-played items surface under "Watching."
