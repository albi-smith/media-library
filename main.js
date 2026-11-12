'use strict';

/**
 * main.js — Electron main process.
 *
 * Responsibilities:
 *  - Create main BrowserWindow and mpv child window (Option A architecture)
 *  - Track mpv window bounds to the video area in the main window
 *  - Start MpvManager and wire all ipcMain handlers
 *  - Handle CLI file arguments and single-instance lock
 *  - Persist/restore config (volume, window size)
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  screen,
  Menu,
} = require('electron');
const path = require('path');

// Set app name and user data path explicitly to avoid locking/permissions issues
app.name = 'VideoPlayerApp';
app.setPath('userData', path.join(app.getPath('appData'), 'VideoPlayerApp'));

let config, MpvManager, initDatabase, libraryService, progressTracker, tmdbClient, connectivity;
try {
  config          = require('./config');
  MpvManager      = require('./mpv-manager').MpvManager;
  initDatabase    = require('./src/main/db/database').initDatabase;
  libraryService  = require('./src/main/library/library-service');
  progressTracker = require('./src/main/library/progress-tracker');
  tmdbClient      = require('./src/main/library/tmdb');
  connectivity    = require('./src/main/library/connectivity');
} catch (e) {
  console.error('[main] Failed to load module at startup:', e);
  process.exit(1);
}

// ─── Single-instance lock ────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ─── Globals ─────────────────────────────────────────────────────────────────

let mainWin  = null;
let mpvWin   = null;   // frameless OS window that mpv renders into
let manager  = null;   // MpvManager — created after modules load

// Height of the controls bar rendered in the main BrowserWindow.
// Updated dynamically when the renderer reports its measured height.
// 0 when the library views are shown (no top bar); measured value in player view.
let CONTROLS_HEIGHT = 0; // px — renderer reports actual value when player view is active

// ─── App ready ───────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  try {
    manager = new MpvManager();
    config.init(app.getPath('userData'));
    const dbPath = path.join(app.getPath('userData'), 'library.db');

    // Apply the persisted TMDB API key (Settings → sidebar footer).
    // Without a key, drama/movie enrichment falls back to TVMaze/placeholders.
    try {
      tmdbClient.setApiKey(config.get('tmdbApiKey') || process.env.TMDB_API_KEY || '');
      console.log(`[main] TMDB ${tmdbClient.hasApiKey() ? 'connected' : 'key missing — drama/movie posters will be limited'}.`);
    } catch (err) {
      console.warn('[main] Could not apply TMDB key:', err.message);
    }

    console.log('[main] Initialising database...');
    await initDatabase(dbPath);
    console.log('[main] Database ready.');

    // Remove the default File/Edit/View/Window/Help menu bar
    Menu.setApplicationMenu(null);

    createWindows();
    registerIpcHandlers();

    console.log('[main] Starting mpv...');
    await startMpv();
    console.log('[main] mpv ready.');

    handleSecondInstance();

    // CLI: open file passed as argument (e.g. double-clicking a video file)
    const cliFile = getCliFile(process.argv);
    if (cliFile) {
      // Give the renderer a moment to set up event listeners
      setTimeout(() => openFile(cliFile), 800);
    }
  } catch (err) {
    console.error('[main] FATAL startup error:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    manager.stop().finally(() => app.quit());
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindows();
});

app.on('before-quit', () => {
  config.flush();
  manager.stop();
});

// ─── Window creation ──────────────────────────────────────────────────────────

function createWindows() {
  const saved = config.get('windowBounds') || {};
  const { x, y, width = 1024, height = 640 } = saved;

  // Main window — standard chrome, hosts the UI controls
  mainWin = new BrowserWindow({
    x, y, width, height,
    minWidth: 480,
    minHeight: 320,
    title: 'Video Player',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Ensure no native menu bar is ever shown (Windows/Linux)
  mainWin.setMenu(null);

  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWin.once('ready-to-show', () => {
    mainWin.show();
    syncMpvWindow();
  });

  // mpv window — frameless, sits inside the main window's video area
  mpvWin = new BrowserWindow({
    parent: mainWin,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    focusable: false,
    show: false,

    // Transparent: Chromium must not paint an opaque background over the
    // surface mpv renders into via --wid, or the video is hidden beneath it.
    transparent: true,
    backgroundColor: '#00000000',
    // No webPreferences needed — mpv owns the surface, not Chromium
    webPreferences: { sandbox: true },
  });

  // Pass mouse events through mpvWin to mainWin so controls and video listeners stay interactive & focused
  mpvWin.setIgnoreMouseEvents(true, { forward: true });

  // Load a blank page so the window exists but shows nothing (mpv will take over)
  mpvWin.loadURL('about:blank');

  // Track main window geometry changes
  mainWin.on('move', syncMpvWindow);
  mainWin.on('resize', syncMpvWindow);
  mainWin.on('restore', () => { mpvWin.show(); syncMpvWindow(); });
  mainWin.on('minimize', () => mpvWin.hide());
  mainWin.on('focus', () => mpvWin.showInactive());
  mainWin.on('blur', () => { /* keep visible */ });

  mainWin.on('enter-full-screen', () => {
    sendToRenderer('window:fullscreen-changed', true);
    syncMpvWindow(true);
    setTimeout(() => syncMpvWindow(true), 100);
  });
  mainWin.on('leave-full-screen', () => {
    sendToRenderer('window:fullscreen-changed', false);
    syncMpvWindow(false);
    setTimeout(() => syncMpvWindow(false), 100);
  });

  mainWin.on('close', () => {
    config.set('windowBounds', mainWin.getBounds());
    mpvWin.destroy();
  });

  mainWin.on('closed', () => {
    mainWin = null;
  });
}

/**
 * Position and size the mpv window to fill the video area of the main window.
 * The video area is everything below the controls bar.
 */
let isControlsHiddenInFullscreen = false;

function syncMpvWindow(fullscreenOverride, hideControls) {
  if (!mainWin || mainWin.isDestroyed() || !mpvWin || mpvWin.isDestroyed()) return;

  const isFullscreen = (typeof fullscreenOverride === 'boolean')
    ? fullscreenOverride
    : mainWin.isFullScreen();

  if (typeof hideControls === 'boolean') {
    isControlsHiddenInFullscreen = hideControls;
  }

  const bounds = mainWin.getContentBounds();

  let mpvBounds;
  if (isFullscreen) {
    if (isControlsHiddenInFullscreen) {
      mpvBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    } else {
      mpvBounds = {
        x: bounds.x,
        y: bounds.y + CONTROLS_HEIGHT,
        width: bounds.width,
        height: Math.max(1, bounds.height - CONTROLS_HEIGHT),
      };
    }
  } else {
    mpvBounds = {
      x: bounds.x,
      y: bounds.y + CONTROLS_HEIGHT,
      width: bounds.width,
      height: Math.max(1, bounds.height - CONTROLS_HEIGHT),
    };
  }

  mpvWin.setBounds(mpvBounds);
}

// ─── mpv startup ──────────────────────────────────────────────────────────────

async function startMpv() {
  manager.on('not-found', () => {
    sendToRenderer('mpv:not-found', {
      message: 'mpv not found. Please install mpv and ensure it is on your PATH.',
      instructions: getMpvInstallInstructions(),
    });
  });

  manager.on('ready', () => {
    sendToRenderer('mpv:property-change', { name: 'ready', data: true });
    mpvWin.show();
    syncMpvWindow();
  });

  manager.on('property-change', (ev) => {
    sendToRenderer('mpv:property-change', ev);
    if (ev && ev.name) {
      progressTracker.onPropertyChange(ev.name, ev.data);
    }
  });

  manager.on('start-file', (ev) => {
    sendToRenderer('mpv:start-file', ev);
    if (ev && ev.path) {
      progressTracker.onFileStarted(ev.path);
    }
    // Re-apply bounds when a file actually loads — mpv may only commit to
    // its embedded surface size once playback begins.
    syncMpvWindow();
  });

  manager.on('end-file', (ev) => {
    sendToRenderer('mpv:end-file', ev);
    progressTracker.onFileEnded();
  });

  manager.on('idle', () => {
    sendToRenderer('mpv:idle', {});
  });

  manager.on('playlist-changed', (playlistState) => {
    sendToRenderer('mpv:playlist-changed', playlistState);
  });

  manager.on('playlist-end', () => {
    sendToRenderer('mpv:playlist-end', {});
  });

  manager.on('error', (err) => {
    sendToRenderer('mpv:error', err);
  });

  manager.on('hwdec-fallback', (info) => {
    sendToRenderer('mpv:hwdec-fallback', info);
  });

  manager.on('exit', (info) => {
    sendToRenderer('mpv:exit', info);
  });

  // Get the native OS window handle of the mpv child window and pass it
  // to mpv via --wid so mpv renders directly into that surface.
  // IMPORTANT: the window must be shown and properly sized BEFORE mpv
  // initializes its video output, otherwise the D3D11 swapchain is created
  // against a hidden/zero-size surface and no video is ever presented until
  // a later resize forces a swapchain rebuild.
  syncMpvWindow();
  mpvWin.showInactive();
  // Give the OS a moment to actually present the window surface before mpv
  // grabs the handle and initializes its video output chain.
  await new Promise((r) => setTimeout(r, 150));

  const handle = mpvWin.getNativeWindowHandle();
  let wid;
  if (process.platform === 'win32') {
    wid = handle.readUInt32LE(0);
  } else if (process.platform === 'darwin') {
    // On macOS getNativeWindowHandle() returns an NSView pointer (8 bytes, LE)
    wid = handle.readBigUInt64LE(0).toString();
  } else {
    // Linux/X11 — 32-bit XID
    wid = handle.readUInt32LE(0);
  }

  await manager.start([`--wid=${wid}`]);
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

function registerIpcHandlers() {
  // File dialogs
  ipcMain.handle('dialog:open-file', async () => {
    const result = await dialog.showOpenDialog(mainWin, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Video Files',
          extensions: [
            'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'ts', 'mts', 'm2ts',
            'webm', 'ogv', 'mpg', 'mpeg', 'm4v', 'vob', '3gp', 'rm', 'rmvb',
            'divx', 'xvid', 'hevc', 'h264', 'h265', 'prores', 'dnxhd',
          ],
        },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:open-subtitle', async () => {
    const result = await dialog.showOpenDialog(mainWin, {
      properties: ['openFile'],
      filters: [
        { name: 'Subtitle Files', extensions: ['srt', 'ass', 'ssa', 'vtt', 'sub', 'idx'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Playback
  ipcMain.handle('mpv:open-file', async (_e, filePath) => {
    return manager.openFile(filePath);
  });

  ipcMain.handle('mpv:open-url', async (_e, url) => {
    return manager.openURL(url);
  });

  ipcMain.handle('mpv:add-files', async (_e, paths) => {
    return manager.addFiles(paths);
  });

  ipcMain.handle('mpv:command', async (_e, ...args) => {
    return manager.command(...args);
  });

  ipcMain.handle('mpv:get-property', async (_e, name) => {
    return manager.getProperty(name);
  });

  ipcMain.handle('mpv:set-property', async (_e, name, value) => {
    return manager.setProperty(name, value);
  });

  ipcMain.handle('mpv:seek', async (_e, seconds) => {
    return manager.seek(seconds);
  });

  ipcMain.handle('mpv:seek-absolute', async (_e, seconds) => {
    return manager.seekAbsolute(seconds);
  });

  ipcMain.handle('mpv:seek-frame', async (_e, forward) => {
    return manager.seekFrame(forward);
  });

  // Playlist
  ipcMain.handle('mpv:playlist-next', () => manager.playNext());
  ipcMain.handle('mpv:playlist-prev', () => manager.playPrev());
  ipcMain.handle('mpv:playlist-index', (_e, index) => manager.playIndex(index));
  ipcMain.handle('mpv:playlist-remove', (_e, index) => manager.removeFromPlaylist(index));

  // Tracks
  ipcMain.handle('mpv:get-tracks', () => manager.getTrackList());
  ipcMain.handle('mpv:select-audio', (_e, id) => manager.selectAudioTrack(id));
  ipcMain.handle('mpv:select-sub', (_e, id) => manager.selectSubTrack(id));
  ipcMain.handle('mpv:load-sub', (_e, filePath) => manager.loadExternalSubtitle(filePath));

  // Config
  ipcMain.handle('config:get', (_e, key) => config.get(key));
  ipcMain.handle('config:set', (_e, key, value) => config.set(key, value));

  // Window / fullscreen
  ipcMain.handle('window:set-fullscreen', (_e, flag) => {
    if (!mainWin) return;
    mainWin.setFullScreen(flag);
    syncMpvWindow(flag);
    setTimeout(() => syncMpvWindow(flag), 100);
  });

  ipcMain.handle('window:get-fullscreen', () => mainWin?.isFullScreen() ?? false);

  // Renderer tells us the controls bar height so we can sync mpv window accurately
  ipcMain.on('renderer:controls-height', (_e, height) => {
    if (typeof height === 'number' && height >= 0) {
      CONTROLS_HEIGHT = height;
      syncMpvWindow();
    }
  });

  // Renderer tells us when controls are auto-hidden in fullscreen
  ipcMain.on('renderer:controls-hidden', (_e, hidden) => {
    syncMpvWindow(undefined, !!hidden);
  });

  // ── Library IPC ────────────────────────────────────────────────────────────
  ipcMain.handle('library:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWin, {
      properties: ['openDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return libraryService.scanFolder(result.filePaths[0]);
  });

  ipcMain.handle('library:scan-folder', async (_e, folderPath) => {
    return libraryService.scanFolder(folderPath);
  });

  ipcMain.handle('library:get-titles', async (_e, filterType) => {
    return libraryService.libraryStore.getAllTitles(filterType);
  });

  ipcMain.handle('library:get-recently-watched', async (_e, limit = 20) => {
    return libraryService.libraryStore.getRecentlyWatched(limit);
  });

  ipcMain.handle('library:get-title-detail', async (_e, titleId) => {
    const title = libraryService.libraryStore.getTitleById(titleId);
    if (!title) return null;
    const episodes = libraryService.libraryStore.getEpisodesForTitle(titleId);
    const files = libraryService.libraryStore.getFilesForTitle(titleId);
    return { title, episodes, files };
  });

  ipcMain.handle('library:search-metadata', async (_e, query, typeHint) => {
    return libraryService.searchMetadataCandidates(query, typeHint);
  });

  ipcMain.handle('library:fix-match', async (_e, titleId, candidate) => {
    return libraryService.fixMatch(titleId, candidate);
  });

  ipcMain.handle('library:confirm-series', async (_e, filePath, targetTitleId, sourceTitleId) => {
    return libraryService.confirmAmbiguousSeries(filePath, targetTitleId, sourceTitleId);
  });

  ipcMain.handle('library:apply-batch-matches', async (_e, matches, recheckPaths) => {
    return libraryService.applyManualMatches(matches, { recheckPaths: recheckPaths || [] });
  });

  ipcMain.handle('library:get-flagged', async () => {
    return libraryService.getFlaggedTitles();
  });

  ipcMain.handle('library:get-folders', async () => {
    return libraryService.libraryStore.getAllFolders();
  });

  ipcMain.handle('library:reset', async () => {
    return libraryService.resetLibrary();
  });

  // Persist + apply the TMDB API key live (Settings in the sidebar footer).
  ipcMain.handle('library:set-tmdb-key', async (_e, key) => {
    const trimmed = (key || '').trim();
    config.set('tmdbApiKey', trimmed);
    tmdbClient.setApiKey(trimmed);
    return { connected: tmdbClient.hasApiKey() };
  });

  ipcMain.handle('library:tmdb-status', async () => {
    return { connected: tmdbClient.hasApiKey() };
  });

  // ── Connectivity ──────────────────────────────────────────────────────────
  ipcMain.handle('library:get-connectivity', async () => {
    const status = await connectivity.check().catch(() => connectivity.status);
    return { online: status === 'online' };
  });

  ipcMain.handle('library:reparse', async () => {
    return libraryService.reparseIncompleteTitles();
  });
}

// ─── Connectivity startup ─────────────────────────────────────────────────────

connectivity.on('online', () => {
  console.log('[main] Network connectivity restored — scheduling background reparse.');
  sendToRenderer('library:connectivity-changed', { online: true });
  libraryService.reparseIncompleteTitles().catch((err) => {
    console.warn('[main] Background reparse failed:', err && err.message ? err.message : err);
  });
});

connectivity.on('offline', () => {
  console.log('[main] Network connectivity lost — scans will fall back to local grouping.');
  sendToRenderer('library:connectivity-changed', { online: false });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendToRenderer(channel, data) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send(channel, data);
  }
}

async function openFile(filePath) {
  await manager.openFile(filePath);
}

function getCliFile(argv) {
  // argv[0] = electron/node, argv[1] = main.js (dev) or app path (prod)
  // argv[2] onward = user args
  const args = process.defaultApp
    ? argv.slice(3)  // dev: electron . <file>
    : argv.slice(2); // prod: app.exe <file>
  const candidate = args.find(a => !a.startsWith('-') && a.length > 0);
  return candidate || null;
}

function handleSecondInstance() {
  app.on('second-instance', (_event, argv) => {
    const file = getCliFile(argv);
    if (file) openFile(file);

    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });
}

function getMpvInstallInstructions() {
  switch (process.platform) {
    case 'win32':
      return 'Install mpv via Scoop (scoop install mpv), Chocolatey (choco install mpv), or download from https://mpv.io/installation/';
    case 'darwin':
      return 'Install mpv via Homebrew: brew install mpv';
    default:
      return 'Install mpv via your package manager: sudo apt install mpv  or  sudo dnf install mpv';
  }
}
