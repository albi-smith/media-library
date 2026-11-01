---
name: electron-mpv-player-debug
description: Debugging and build guidance for this specific Electron + mpv cross-platform video player project (Option A window architecture — separate managed mpv window synced to the main BrowserWindow, custom MpvIpc over net sockets instead of node-mpv). Use this whenever the user reports the player not working — blank screen, audio-only playback, unresponsive buttons, mpv not found, build/packaging failures — or asks for help extending the app (tracks, subtitles, playlist, streaming). Trigger even if the user just says "it's broken" or pastes an error, without naming Electron or mpv explicitly, as long as the context is this video player project.
---

# Electron + mpv Video Player — Debug & Build Guide

This project's architecture: Electron app shell + a **separate mpv OS window** (Option A)
positioned under the main window's controls, driven by a **custom `MpvIpc` class**
(net socket, JSON IPC — no `node-mpv` dependency). See the project's build spec docs
for full architecture rationale if needed.

Two processes exist and are debugged completely differently — always establish which
one is failing before touching code.

## Step 0: Split the failure by process

| Symptom | Likely process |
|---|---|
| Button clicks do nothing, `window.api` undefined | Renderer (preload/renderer.js) |
| mpv won't launch, "not found", spawn errors | Main process (main.js / mpv-ipc.js) |
| Audio plays, video is blank | Main process (window bounds sync) |
| App crashes / won't build | Main process or build config |

Official reference: [Electron Application Debugging](https://www.electronjs.org/docs/latest/tutorial/application-debugging) — renderer processes use Chromium DevTools; the main process needs `--inspect`/`--inspect-brk` and an external debugger (VS Code launch config or `chrome://inspect`), since DevTools in the app window **cannot** see main-process code.

## Renderer-side debugging (UI, buttons, preload)

1. Open DevTools: `Ctrl+Shift+I`/`Cmd+Option+I`, or add `mainWin.webContents.openDevTools()` in `main.js`.
2. In Console, run `window.api` — if `undefined`, the preload script never loaded. Check:
   - `webPreferences.preload` in `main.js` uses an **absolute path**: `path.join(__dirname, 'preload.js')`
   - `contextIsolation: true` is set (required for `contextBridge` to work)
   - `sandbox: true` is fine — `ipcRenderer.invoke`/`ipcRenderer.on` work fully sandboxed; don't disable sandbox to "fix" this
3. If `window.api` exists but buttons still do nothing: check the Network tab for `renderer.js` (404 = wrong `<script src>` path), then check `<script src="renderer.js" defer>` is present — no `defer`/wrong placement means DOM queries can run before elements exist and silently no-op.
4. No console errors at all is itself informative — it usually means the script isn't attaching listeners rather than throwing. Manually check `getEventListeners(document.getElementById('play-btn'))` in Console.

## Main-process debugging (mpv, IPC, window management)

Main-process `console.log`/errors print **only to the terminal** running `npm start`, never to DevTools. Keep that terminal visible.

1. **mpv not found**: run `mpv --version` in the same terminal — if that fails, mpv isn't installed or isn't on PATH.
   - Windows: `winget install -e --id shinchiro.mpv` (run in the user's own terminal — background/agent-initiated installs fail silently on the UAC prompt) or `choco install mpv` from an elevated shell. Restart the terminal after install so PATH updates.
   - macOS: `brew install mpv`
   - Linux: `sudo apt install mpv` / distro equivalent
2. **mpv launches but IPC never connects**: add `console.log` breadcrumbs in `mpv-ipc.js` around `spawn()` and the socket connection. Confirm the socket path matches OS conventions (`\\.\pipe\electron-mpv-<pid>` on Windows, `/tmp/electron-mpv-<pid>.sock` on Linux/macOS) and that the app waits for the socket to exist before connecting (a race here causes silent connection failures).
3. **Audio plays, video is blank** — this is the signature bug of the Option A architecture: mpv is decoding/rendering correctly (proven by audio) but its OS window is hidden, zero-sized, or mispositioned.
   - Confirm via Alt+Tab/taskbar whether a second (mpv) window exists at all.
   - Log the bounds object right before every `mpvWindow.setBounds(...)` call — width/height of 0 or off-screen x/y confirms the bug.
   - **Common root cause**: the bounds-sync function only runs inside `move`/`resize` event listeners, never once immediately after both windows are created and the file loads. Fix: call the same sync function manually right after the mpv window is shown and after `start-file` fires — don't rely solely on event listeners for the initial position.
   - Quick diagnostic: resize/drag the main window while a video is loaded — if the video suddenly appears, this confirms the bug.

## Build/packaging issues

- `npm start` failing outright → check `package.json` main entry points to `main.js` and `electron` is actually installed (`node_modules/.bin/electron` exists).
- `electron-builder` failures → check `electron-builder.yml` exists and targets are valid for the host OS; cross-platform builds (e.g. building a Windows installer from macOS) need extra setup not covered by default config.
- mpv binary must be present on the **target** machine at runtime for this phase (bundling mpv into the installer is an explicit later-phase task, not yet implemented) — packaging success does not guarantee playback works if mpv isn't installed on the machine testing the build.

## Good external references

- [Electron: Application Debugging](https://www.electronjs.org/docs/latest/tutorial/application-debugging) — renderer DevTools + main-process logging basics
- [Electron: Debugging the Main Process](https://www.electronjs.org/docs/latest/tutorial/debugging-main-process) — `--inspect`/`--inspect-brk`, VS Code launch config
- [Electron: process object reference](https://www.electronjs.org/docs/latest/api/process) — `contextIsolation`, sandbox behavior details
- [mpv manual — JSON IPC](https://mpv.io/manual/stable/#json-ipc) — the wire protocol `mpv-ipc.js` implements directly
- [mpv manual — command line options](https://mpv.io/manual/stable/#options) — authoritative source for `--hwdec`, `--input-ipc-server`, `--keepaspect`, etc.
