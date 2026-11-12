# Build Prompt: Full Cross-Platform Video Player (Functional UI — Design Later)

## Objective
Build a complete, fully working desktop video player for Windows, macOS, and Linux with universal format compatibility and unmodified original video/audio quality. UI should be functional and unstyled/minimal — plain HTML controls are fine. Visual design and UX polish will be redone in a later pass, so do not spend time on styling, themes, or layout polish now.

## Core Stack
- **Electron** — cross-platform app shell and windowing
- **mpv** (system binary, auto-detected per OS, with instructions to bundle later) — playback engine, built on FFmpeg/libavcodec
- **node-mpv** — Node wrapper controlling mpv via JSON IPC socket
- React is fine for structure but no styling/component library needed yet — plain divs/buttons are acceptable

## Non-Negotiable Quality/Compatibility Requirements
1. **No transcoding, ever.** mpv decodes and renders natively — never pipe through ffmpeg to convert before playback.
2. **Hardware-accelerated decode by default, per OS**, with automatic software fallback:
   - Windows: `--hwdec=d3d11va`
   - macOS: `--hwdec=videotoolbox`
   - Linux: `--hwdec=vaapi` → fallback `auto-safe`
3. **Native resolution rendering** — video output renders into a real embedded OS window handle (`--wid`), not a Chromium `<video>` tag, so format support isn't limited to what Chromium ships with.
4. **No frame re-sampling/scaling that reduces source quality** — only display scaling, never quality-reducing resampling of decoded frames.

## Full Feature Set

### Playback engine
- Open file via OS file dialog — no format filtering (support all containers/codecs mpv/FFmpeg handles: MP4, MKV, AVI, WebM, MOV, FLV, TS, WMV, MPEG-2/4, ProRes, etc.)
- Open via drag-and-drop of a file onto the window
- Open via command-line argument (double-click a video file → opens in app)
- Play / Pause / Stop
- Seek bar with click-to-seek and drag-to-seek
- Frame-accurate seeking on arrow key press (small increments) and larger jumps (e.g. 10s) on longer press/shortcut
- Volume control + mute toggle
- Playback speed control (0.5x–2x minimum)
- Current time / total duration display

- Fullscreen toggle (keyboard shortcut + button)
- Aspect ratio handling — preserve source aspect ratio by default, with an option to change it later

### Format & track support
- Automatic detection and listing of available audio tracks (for multi-audio files) with a way to switch
- Automatic detection and listing of subtitle tracks embedded in the file, with on/off toggle
- Load external subtitle files (.srt, .ass/.ssa, .vtt) via file dialog or drag-and-drop, matched by filename convention where possible
- Subtitle rendering via mpv's built-in libass support (styling comes for free from mpv, no need to build a renderer)

### Playlist
- Add multiple files to a queue
- Next / Previous controls
- Auto-advance to next file on playback end
- Remove items from playlist
- (Reordering/drag-sort can be a stretch goal, not blocking)

### Streaming/network (basic)
- Support opening a network stream URL (RTSP/HTTP/HLS) via a simple "Open URL" input — mpv handles these protocols natively, so this is mostly UI plumbing, not new engine work

### Error handling
- Unsupported/corrupt file → visible error message, not a silent failure or crash
- mpv binary not found → clear message with instructions, not a crash
- Playback stall/buffering state shown distinctly from "paused"

### Window/app behavior
- Standard window controls (resize, minimize, maximize, close) — no custom frameless chrome yet, that's a design-phase task
- Remember last volume level and window size between launches (simple local JSON config file is fine)
- Basic keyboard shortcuts: space (play/pause), arrows (seek), up/down (volume), F (fullscreen), M (mute)

## Explicitly Out of Scope for This Build
- Visual design, themes, skins, custom title bar, animations
- Advanced playlist UX (drag reordering, thumbnails)
- Video filters/effects (color adjustment, deinterlacing UI, etc.)
- Torrent streaming or plugin architecture
- Auto-update mechanism
- Packaging/installer polish (basic `electron-builder` config is enough, not signed installers)

## Deliverable Structure
```
/main.js            → Electron main process: window creation, mpv lifecycle, file/URL opening, IPC handlers
/preload.js         → contextBridge exposing safe IPC methods to renderer
/mpv-manager.js      → wraps node-mpv: launch, load file/URL, command passthrough, track/subtitle handling, event forwarding
/config.js           → simple local settings persistence (volume, window size, last playlist)
/renderer/
  index.html         → minimal unstyled controls: play/pause, seek bar, volume, time display, track/subtitle selectors, playlist panel, open-file/open-URL buttons
  renderer.js         → wires all controls to IPC calls, listens for mpv state/track/error events, manages playlist state
```

## Success Criteria
A user can:
1. Open (via dialog or drag-and-drop) virtually any common video file and have it play at full native quality with hardware-accelerated decode
2. Control playback fully (play/pause/seek/volume/speed/fullscreen) via keyboard and buttons
3. Switch audio tracks and toggle subtitles (embedded or externally loaded) on a multi-track file
4. Queue multiple files into a playlist and have them auto-advance
5. Open a network stream URL and have it play
6. See a clear error instead of a crash on unsupported input

Once all of the above works reliably, the app is feature-complete for this phase — the next phase is a full UI/UX redesign on top of this working core (no changes to the playback engine itself should be needed at that point).
