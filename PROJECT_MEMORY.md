# PROJECT_MEMORY — Media Parser Research & Improvement

**Last updated:** 2026-09-29 — Full source-verified audit + revised plan
**Status:** Research complete. Plan revised. No production code changed yet.

---

## A. Verified findings from actual source code

### Sonarr — `src/NzbDrone.Core/Parser/Parser.cs` + `ParsingService.cs`

**Pre-substitution is structural, not cosmetic.**
Sonarr applies 8 named `RegexReplace` transforms *before* its main regex bank runs.
Every transform normalises a structurally different Chinese/Korean bracket format into
the canonical `[Group] Title - Episode` form. The downstream regexes never see
the raw filename at all.

Key transforms verified in source:
- `[SubGroup][EnglishTitle ChineseTitle][第01話]` → `[SubGroup] EnglishTitle - 01`
- LoliHouse/ZERO/Lilith-Raws/Skymoon-Raws + custom bracket styles each have their own rule
- GM-Team style (multiple CJK sub-group brackets) stripped to canonical form
- Korean drama `.E03.220101.NEXT` → `.S01E03.NEXT`

**Hash capture is a named group in every anime regex, not a strip-and-forget.**
Every `ReportTitleRegex` for anime ends with `(?<hash>[(\\[]\\w{8}[)\\]])?$`.
This means: the hash is *captured* and stored on the result, never confused with
an episode number. The decision of what to do with it is the caller's problem.

**Sonarr is a downloader, NOT a local library manager.**
`ParsingService.GetSeries()` flow:
1. Parse title → get `SeriesTitle`
2. Query `SceneMappingService` for a TVDB ID by scene name + season
3. If no mapping, `FindByTitle()` in local DB (their DB = already-confirmed series)
4. If still null, iterate `AllTitles` from parsed info (for multi-title formats like Chinese/English dual)

This means Sonarr NEVER does fuzzy offline grouping of unknown filenames. It only
resolves titles against a curated set the user already added. **Not applicable to us.**

**What IS applicable:**
- Pre-substitution pipeline (structural)
- Capturing CRC32 as a named field, not stripping it
- `absoluteepisode` as a separate field alongside `season`/`episode`

---

### Jellyfin — `Emby.Naming/TV/EpisodePathParser.cs` + `NamingOptions.cs`

**EpisodeExpressions are partitioned into named vs optimistic — verified.**
`EpisodePathParser.Parse()` accepts `isNamed?` and `isOptimistic?` booleans.
- Named = explicit `S01E01`, `1x05` style
- Optimistic = bare numbers that might be episode numbers

Callers control which pool is used. For series path parsing (`SeriesPathParser`),
the comment explicitly says: *"Optimistic expressions are only meant for [filenames],
not for series detection from paths."*

**CleanStrings is a substitution array, not a token set — verified.**
`NamingOptions.CleanStrings` has 6 regexes:
1. Token-based noise strip (our NOISE_TAGS equivalent — but implemented as regex with lookahead)
2. Strip trailing bracket groups
3. Strip `E01-E05` range markers from title
4. Strip leading `[Group]` prefix from title
5. Strip trailing ` - 123` (absolute number) from title
6. Strip trailer/sample markers

Key difference: #4 strips the release group prefix from the *canonical series title*,
not from the working parse buffer. We never do this separation.

**Season fallback logic — verified via SeriesPathParser comment:**
> "Optimistic expressions are only meant for filenames, not for series detection from paths."
The season folder (`Season 2/`) is resolved by running `EpisodePathParser` on the
*directory name*, not the filename. If that succeeds with a named expression, the season
is overridden. This is done at the media library level above the parser.

**Jellyfin `season = null` by default — confirmed.**
The `EpisodePathParserResult` object starts with `seasonNumber = null`.
Only set if a pattern explicitly captures it. Callers (the library scanner) then fill
season from folder if still null.

**Known Jellyfin bugs confirmed in source comments:**
- Optimistic expressions grab resolution/codec tokens (this is documented as a known issue)
- The fix in recent commits is to only use optimistic expressions when there is other
  evidence it is an episode file (i.e., named expression already matched something else)

---

### Shoko — `Shoko.Server/Utilities/SeriesSearch.cs`

**Shoko does not parse filenames for identification — confirmed.**
File identification = ED2K hash → AniDB lookup. Filename parsing is for display/renaming only.

**Series search = Sørensen-Dice + OSA edit distance — verified in source:**
```csharp
private static readonly IStringDistance DiceSearch = new SorensenDice();
internal static int GetMaxErrors(int queryLength) => Math.Min(queryLength / 4, 3);
```

The OSA (Optimal String Alignment) Wagner-Fischer implementation is fully present:
- Rolling 3-row DP (not 2-row), tracking transpositions
- **Semi-global matching**: row 0 stays all-zeros, meaning text prefix/suffix skips are free
- This lets "Sousou no Frieren (2023)" match "Sousou no Frieren" without penalty

`NormalizeForIndex()` maps `:`, `,`, `!`, `;`, `/`, `\\`, `(`, `)`, `[`, `]`, `〜`, `~`, `|`
to spaces — NOT removed, just spaced. Diacritics stripped via NFD decomposition.
`IsLatinScript()` uses `c > 'ɏ'` (U+024F) as the boundary for non-Latin detection.

**What is applicable to us:**
- OSA edit distance for similarity scoring (not just Jaccard)
- `GetMaxErrors = min(len/4, 3)` as a tolerance budget
- Semi-global matching (free prefix/suffix skip in the longer string)
- `NormalizeForIndex` char mapping strategy (symbols → space, not removed)

---

## B. Full pipeline audit — our code

### Stage 1: `scanner.js` → file discovery

**No issues.** Flat extension set, correct stat capture, recursive with hidden-dir skip.
One minor gap: no size-zero guard (0-byte video stubs could be scanned).

### Stage 2: `parser.js` → filename → `{title, season, episode, typeCandidate, confidence}`

**Confirmed issues (source-verified):**

| ID | Issue | Confirmed by |
|---|---|---|
| P1 | **No pre-substitution pass.** Chinese dual-title brackets, GM-Team style, LoliHouse formats all go through the general stripper and emerge broken. This is not a regex gap — it is a structural absence. | Sonarr source |
| P2 | **`absSpace` is triggered by `releaseGroup` alone.** The code: `const animeSignals = typeCandidate === 'anime' \|\| releaseGroup \|\| ...`. Having a release group does NOT mean a trailing number is an episode — `[Group] Title 720p` is a counter-example. | Self-audit |
| P3 | **CRC32 captured as strip, not as a named output field.** `stripHashTags` removes `[DEADBEEF]` but never exposes it. Future AniDB hash lookup is blocked. | Sonarr source comparison |
| P4 | **`season` is never returned as `null` from the parser when truly absent; callers use `parsedFile.season \|\| 1`.** This is a call-site problem, not a parser bug — but it means anime with absolute numbering get forced into S1. | Jellyfin comparison |
| P5 | **`cleanSeriesTitle` runs a second S/Part/Cour strip AFTER extraction**, on the already-cleaned title. It is not harmful in normal cases but can corrupt titles ending with legitimate season-like words. | Self-audit |
| P6 | **`unwrapTitleBrackets` leaves brackets whose inner content is a noise tag as-is** — correctly. But its positive case (unwrapping non-noise brackets) fires before the episode/group detection, which means a title-bracket `[Attack on Titan]` gets unwrapped and can collide with group detection. | Self-audit |

**Issues from original plan that are NOT confirmed or are less severe than stated:**

- *"CRC32 false-positive mid-filename"* — `stripHashTags` pattern `[0-9a-f]{8}` with `gi` flag covers uppercase. The actual risk is not false positives but the lost data (no output field). **Partially wrong in original plan.**
- *"Season defaults to 1 too early"* — this is a **call-site** issue, not a parser issue. `parser.js` returns `season: null` when no season found. Callers (`groupFilesInBatch`, `matchFileToTitle`) write `parsedFile.season || 1` to the DB. The fix is in the callers, not the parser.

### Stage 3: `matcher.js` → grouping, local matching, online enrichment

**Confirmed issues (source-verified):**

| ID | Issue | Confirmed by |
|---|---|---|
| M1 | **`computeTitleSimilarity` is Jaccard word-overlap only.** For short titles (< 3 words) this is meaningless. "91 Days" vs "91-Days" = 0.0 Jaccard after normalization strips the dash. Shoko uses OSA edit distance + Dice. | Shoko source |
| M2 | **`getFolderHint` only reads the immediate parent folder** (`path.basename(dir)`). Structure `Anime/Attack on Titan/Season 2/ep.mkv` → hint = "Season 2", losing the series name entirely. Jellyfin runs `EpisodePathParser` on each ancestor folder. | Jellyfin source |
| M3 | **`findLocalTitleCandidates` loads ALL titles from DB on every call**, then loops through each one building variants. For a library of 500+ series this is an O(N) SQLite scan + O(N) string comparison loop, called once per unique groupKey in the batch. Not catastrophic but unnecessary — a normalized alias index would be O(1). | Self-audit |
| M4 | **Online fallback placeholder results leak into scoring.** `tmdb.js` and `anilist.js` return placeholder records with `tmdb_id: null` when offline/keyless. The `real` filter in `matchOnlineTitle` correctly filters these. But `searchSeries` TVMaze fallback assigns `tmdb_id: s.id` (TVMaze ID, not TMDB). This makes TVMaze results appear as "real" TMDB results with wrong IDs. | Self-audit (tmdb.js line 149) |
| M5 | **`LEARNED_BONUS = 0.9` added to score can push total above `STRONG_MATCH_THRESHOLD` even for zero-similarity cases.** If a filename resolves to a zero-score candidate but the learned map points there, `0 + 0.9 = 0.9 >= 0.9`. This could incorrectly force a completely different show onto a learned series. | Self-audit |
| M6 | **`AUTO_MATCH_THRESHOLD = 0.7` and `FUZZY_MATCH_THRESHOLD = 0.7` are both calibrated for Jaccard.** After introducing OSA/edit-distance these will need re-tuning. | Confirmed |

**Issues from original plan that needed correction:**

- *"Online-first fires per file in matchFileToTitle"* — this is a legacy path. The primary scan path is `groupFilesInBatch` which fires once per *group*, not per file. `matchFileToTitle` still fires per-file but is only used for re-match/confirm flows, not bulk scanning. **Less severe than stated.**

### Stage 4: API clients → `anilist.js`, `tmdb.js`, `jikan.js`

**Critical bug confirmed — tmdb.js TVMaze fallback:**
```js
// Line 149 in tmdb.js:
tmdb_id: s.id,  // ← This is a TVMaze ID, NOT a TMDB ID
```
When TMDB is unavailable/no key, TVMaze results are returned with `tmdb_id` set to a
TVMaze integer ID. These then survive the `real` filter in `matchOnlineTitle` (because
`c.tmdb_id != null`), score against the title, can hit `AUTO_MATCH_THRESHOLD`,
and get stored as a TMDB external ID in the `titles` table — which is wrong.

**`getTitleByExternalId` will then match the wrong row** on the next scan using a
spurious TVMaze ID stored as `tmdb_id`.

**AniList `searchAnime` uses page limit 8, Jikan uses default.** No validation
that the returned results are actually anime (not movies). AniList filters by `type: ANIME`
but Kitsu fallback and Jikan do not constrain type. Jikan can return movies under anime
results. This is fine for grouping but affects `type` field stored in DB.

### Stage 5: `library-store.js` → SQLite persistence

**No critical bugs found.**

One structural observation: `upsertFile` uses:
```sql
ON CONFLICT DO UPDATE SET
  title_id = COALESCE(excluded.title_id, files.title_id)
```
This means a re-scan that *doesn't* produce a title_id will NOT clear an existing title_id.
That is correct and intentional. But it also means a file that was wrongly matched and
then had its title set to NULL (by a fix operation) will have its title_id restored
on the next scan if the scan produces a non-null result. This is a minor UX gap.

`deleteOrphanTitles()` is called from `getAllTitles()` — this is a side-effect in a
getter, which is fragile. If the orphan delete races with a just-created title before
files are attached, it can delete valid new titles. The window is small (~1 minute
guard) but exists.

---

## C. Corrections to the previous plan

| Item | Original claim | Corrected finding |
|---|---|---|
| "CRC32 false-positive in stripHashTags" | Strip regex misses uppercase variants | The `gi` flag covers uppercase. Real problem is absence of output field, not stripping. |
| "Season defaults to 1 in parser" | Parser bug | Call-site bug: `parsedFile.season \|\| 1` in `groupFilesInBatch` line 1354 and `matchFileToTitle` line 1044. Fix is in callers. |
| "Online-first fires per file" | Claimed as high severity | Only the legacy `matchFileToTitle` path; `groupFilesInBatch` (the scan path) already fires once per group. Medium severity at most. |
| "CJK pre-substitution needed" | Claimed as high | Still high, but the mechanism is not "a few new regexes" — it needs a proper pre-pass function that applies substitutions in order before any other processing. |
| "Jellyfin season = null default" | Season returned null by parser | Confirmed: the fix is in callers (`|| 1`), not parser. Parser already returns null. |

---

## D. Revised implementation plan

### Priority order (re-ranked after audit)

**Must fix (broken or data-corrupting):**

1. **[BUG] TVMaze ID stored as `tmdb_id`** (`tmdb.js`)
   - TVMaze fallback results must either be excluded from `real` filter or stored with a
     separate `tvmaze_id` field / tagged differently so they don't corrupt the external-ID index.
   - Simplest fix: filter out candidates where `tmdb_id != null && mal_id == null && anilist_id == null`
     from the TVMaze path by setting `tvmaze_id` field instead of `tmdb_id`.

2. **[BUG] `season || 1` in callers forces S1 onto absolute-numbered anime** (`matcher.js` lines 1044, 1354; `groupFilesInBatch` line 1354)
   - These call sites must not default season to 1 when the parser returned `null`.
   - For episodic content with `episode != null` but `season == null`, season should stay null
     in the DB row (or be stored as 0 for "unknown/absolute").

**Should fix (correctness, not data-corrupting):**

3. **[ARCH] `absSpace` guard tightening** (`parser.js`)
   - Current: `const animeSignals = typeCandidate === 'anime' || releaseGroup || ...`
   - Fix: require `typeCandidate === 'anime'` (explicitly anime) OR a `releaseGroup` AND
     the trailing number is ≤ 3 digits (not a resolution like 720/1080). Not a new pattern,
     just a tighter condition.

4. **[ARCH] Pre-substitution pass for CJK/Chinese bracket formats** (`parser.js`)
   - Implement as a `preSubstitute(filename)` function that runs 4-5 ordered transforms
     before any bracket processing. Port Sonarr's approach in JS.
   - Must be applied to the raw filename string, before `stripSocialHandles`.

5. **[ARCH] Multi-level folder walk in `getFolderHint`** (`matcher.js`)
   - Walk up 2 folder levels: if immediate parent is `Season N`/`S0N`/`Series N`, use
     grandparent as series hint, and extract the season number from the folder name.
   - Pass extracted folder-season back to the caller as a separate field so it can
     override `parsed.season` when `parsed.season === null`.

6. **[ARCH] OSA edit distance in `computeTitleSimilarity`** (`matcher.js`)
   - Add OSA implementation (Shoko's approach, simple to port to JS).
   - Use `min(len/4, 3)` as error budget for a "fuzzy pass".
   - Score = `max(Jaccard, 1 - editDist/maxLen)` — take the best of both metrics.
   - DO NOT change thresholds yet; first measure impact on test outputs.

7. **[ARCH] Expose `crc32` as a parser output field** (`parser.js`)
   - `stripHashTags` already finds `[DEADBEEF]` patterns. Capture it instead of just removing.
   - Add `crc32: null` to the returned parse object. Set when found.

**Nice to fix (minor correctness/robustness):**

8. **[MINOR] `deleteOrphanTitles` called from getter** (`library-store.js`)
   - Move to an explicit `pruneOrphans()` call in `scanFolder` after the batch is complete,
     not inside `getAllTitles()`.

9. **[MINOR] `LEARNED_BONUS` can force match on zero-score candidates** (`matcher.js`)
   - Guard: only apply `LEARNED_BONUS` when base score > 0.1 (some minimum evidence),
     otherwise the learned bonus is noise.

10. **[MINOR] CRC32 output field** — requires Step 7. No DB change needed (not persisted yet).

---

## E. Revised implementation sequence

```
Step 1 — BUG: tmdb.js TVMaze ID stored as tmdb_id [DONE]
  Files: src/main/library/tmdb.js, src/main/library/matcher.js, src/main/library/library-service.js
  Change: renamed tmdb_id to tvmaze_id in TVMaze fallback result objects;
          updated filter in matcher.js and pool dedup in library-service.js to recognise tvmaze_id as "real" candidate

Step 2 — BUG: season || 1 call-site defaults
  Files: src/main/library/matcher.js (lines 1044, 1115, 1354)
  Change: do not coerce null season to 1 when writing files/episodes;
          allow season_number = null in DB for absolute-numbered content

Step 3 — ARCH: absSpace guard tighten
  Files: src/main/library/parser.js (absSpace block, ~line 400-448)
  Change: tighten animeSignals condition; add resolution-number exclusion

Step 4 — ARCH: CJK pre-substitution pass
  Files: src/main/library/parser.js
  Change: add preSubstitute() function; call before stripSocialHandles

Step 5 — ARCH: multi-level folder walk
  Files: src/main/library/matcher.js
  Change: getFolderHint returns {seriesHint, seasonHint};
          callers use seasonHint to fill season when parsed.season === null

Step 6 — ARCH: OSA edit distance in computeTitleSimilarity
  Files: src/main/library/matcher.js
  Change: add osa() helper; update computeTitleSimilarity to max(Jaccard, osaNorm)

Step 7 — Integration tests & threshold review
  Files: existing test-*.js files
  Action: run all tests, compare parse output before/after, document regressions

Step 8 — MINOR: deleteOrphanTitles moved out of getter
  Files: src/main/db/library-store.js, src/main/library/library-service.js

Step 9 — MINOR: LEARNED_BONUS base-score guard
  Files: src/main/library/matcher.js
```

---

## F. Unresolved issues

1. **Threshold recalibration** — After Step 6, `FUZZY_MATCH_THRESHOLD` and
   `AUTO_MATCH_THRESHOLD` need measured data to re-tune. Cannot be predicted in advance.
   Plan: after Step 7, run tests on a real library snapshot and tune based on false-match
   vs missed-match counts.

2. **TVMaze permanent storage** — Should TVMaze IDs eventually get their own `tvmaze_id`
   DB column, or should TVMaze results only be used for title/poster/year enrichment without
   storing an external ID? Recommend: use TVMaze for display enrichment only (title, overview,
   poster_url, year), set `tmdb_id = null`. The `getTitleByExternalId` dedup key then cannot
   be TVMaze-keyed, which is correct.

3. **Season = null storage** — Current `upsertEpisode` sets `season_number = 1` as default.
   Changing this to null will affect `getEpisodesForTitle` ordering. Need to decide if
   absolute-episode mode stores `season_number = null` or `season_number = 0`.

4. **Episode metadata stub refresh** — stubs written as `name: "Episode N"` are never refreshed.
   Not addressed in this plan; depends on background-refresh task design.

5. **CRC32 → future AniDB integration** — Step 7 captures the CRC32 field but nothing
   consumes it. AniDB hash lookup is out of scope for this plan.

---

## G. Exact next step

**Step 1 is COMPLETED**:
- In `tmdb.js`, TVMaze fallback results now return `tvmaze_id: s.id` and `tmdb_id: null`.
- In `matcher.js` (`real` filter) and `library-service.js` (pool dedup key), `tvmaze_id != null` is recognized as a valid external candidate ID.
- Tested & verified with `test-online-first.js`, `test-null-safety.js`, and `test-series-grouping.js` (119 total assertions passed).

**Proceed to Step 2 (season || 1 call-site defaults)** in `matcher.js`.
