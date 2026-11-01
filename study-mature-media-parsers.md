Study the open-source implementations of **Sonarr, Shoko Server, and Jellyfin** for media filename parsing, file identification, series grouping, and metadata matching.

Repositories:

* Sonarr: https://github.com/Sonarr/Sonarr
* Shoko Server: https://github.com/ShokoAnime/ShokoServer
* Jellyfin: https://github.com/jellyfin/jellyfin

Study how they handle filename parsing, anime episode numbering, release/technical tags, title extraction, folder context, series identification, metadata matching, confidence/fallbacks, and file hashes where applicable.

Then compare them with our `parser.js`, `matcher.js`, and scan pipeline.

**Do not blindly copy code or keep expanding noise tags.** Identify the architectural weaknesses and adapt the useful concepts to our existing JavaScript/Tauri/SQLite stack.

### Important: persistent progress

Update `PROJECT_MEMORY.md` **regularly throughout the work**, not only when finished. After each major research, analysis, implementation, or testing step, record:

* What was discovered
* What was changed
* Why
* Tests/results
* Problems still remaining
* Exact next step

If the session ends unexpectedly, the next agent must be able to continue from `PROJECT_MEMORY.md` without relying on this conversation.

Before coding, give me a concise plan covering:

1. What Sonarr/Shoko/Jellyfin do differently.
2. Problems in our current implementation.
3. What should be adopted.
4. Files that need changes.

Then implement the approved approach incrementally, updating `PROJECT_MEMORY.md` after every major step.
