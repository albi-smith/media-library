'use strict';

/**
 * preload.js — contextBridge IPC bridge.
 *
 * Runs with sandbox: true. Exposes window.api to the renderer using
 * contextBridge — no nodeIntegration, no require() in renderer.
 *
 * All calls go through ipcRenderer.invoke (request/response) or
 * ipcRenderer.on (push events from main process). Both work in sandbox mode.
 */

const { contextBridge, ipcRenderer } = require('electron');

// Whitelist of events the renderer may subscribe to
const ALLOWED_EVENTS = new Set([
  'mpv:property-change',
  'mpv:tracks-changed',
  'mpv:start-file',
  'mpv:end-file',
  'mpv:idle',
  'mpv:playlist-changed',
  'mpv:playlist-end',
  'mpv:error',
  'mpv:not-found',
  'mpv:hwdec-fallback',
  'mpv:exit',
  'window:fullscreen-changed',
  'library:connectivity-changed',
]);

contextBridge.exposeInMainWorld('api', {
  // ── File / URL opening ──────────────────────────────────────────────────
  openFileDialog: () => ipcRenderer.invoke('dialog:open-file'),
  openSubtitleDialog: () => ipcRenderer.invoke('dialog:open-subtitle'),
  openFile: (filePath) => ipcRenderer.invoke('mpv:open-file', filePath),
  openURL: (url) => ipcRenderer.invoke('mpv:open-url', url),
  addFiles: (paths) => ipcRenderer.invoke('mpv:add-files', paths),

  // ── Playback control ─────────────────────────────────────────────────────
  command: (...args) => ipcRenderer.invoke('mpv:command', ...args),
  getProperty: (name) => ipcRenderer.invoke('mpv:get-property', name),
  setProperty: (name, value) => ipcRenderer.invoke('mpv:set-property', name, value),
  seek: (seconds) => ipcRenderer.invoke('mpv:seek', seconds),
  seekAbsolute: (seconds) => ipcRenderer.invoke('mpv:seek-absolute', seconds),
  seekFrame: (forward) => ipcRenderer.invoke('mpv:seek-frame', forward),

  // ── Playlist control ─────────────────────────────────────────────────────
  playNext: () => ipcRenderer.invoke('mpv:playlist-next'),
  playPrev: () => ipcRenderer.invoke('mpv:playlist-prev'),
  playIndex: (index) => ipcRenderer.invoke('mpv:playlist-index', index),
  removeFromPlaylist: (index) => ipcRenderer.invoke('mpv:playlist-remove', index),

  // ── Track management ─────────────────────────────────────────────────────
  getTrackList: () => ipcRenderer.invoke('mpv:get-tracks'),
  selectAudioTrack: (id) => ipcRenderer.invoke('mpv:select-audio', id),
  selectSubTrack: (id) => ipcRenderer.invoke('mpv:select-sub', id),
  loadExternalSubtitle: (filePath) => ipcRenderer.invoke('mpv:load-sub', filePath),

  // ── Config ───────────────────────────────────────────────────────────────
  getConfig: (key) => ipcRenderer.invoke('config:get', key),
  setConfig: (key, value) => ipcRenderer.invoke('config:set', key, value),

  // ── Window ───────────────────────────────────────────────────────────────
  setFullscreen: (flag) => ipcRenderer.invoke('window:set-fullscreen', flag),
  getFullscreen: () => ipcRenderer.invoke('window:get-fullscreen'),

  // Layout measurement — tells main the controls bar height so mpv window syncs correctly
  reportControlsHeight: (height) => ipcRenderer.send('renderer:controls-height', height),
  setControlsHidden: (hidden) => ipcRenderer.send('renderer:controls-hidden', hidden),

  // ── Library ───────────────────────────────────────────────────────────────
  library: {
    selectFolderAndScan: () => ipcRenderer.invoke('library:select-folder'),
    scanFolder: (folderPath) => ipcRenderer.invoke('library:scan-folder', folderPath),
    getTitles: (filterType) => ipcRenderer.invoke('library:get-titles', filterType),
    getRecentlyWatched: (limit) => ipcRenderer.invoke('library:get-recently-watched', limit),
    getTitleDetail: (titleId) => ipcRenderer.invoke('library:get-title-detail', titleId),
    searchMetadata: (query, typeHint) => ipcRenderer.invoke('library:search-metadata', query, typeHint),
    fixMatch: (titleId, candidate) => ipcRenderer.invoke('library:fix-match', titleId, candidate),
    confirmSeries: (filePath, targetTitleId, sourceTitleId) =>
      ipcRenderer.invoke('library:confirm-series', filePath, targetTitleId, sourceTitleId),
    applyBatchMatches: (matches, recheckPaths) =>
      ipcRenderer.invoke('library:apply-batch-matches', matches, recheckPaths || []),
    getFlagged: () => ipcRenderer.invoke('library:get-flagged'),
    getFolders: () => ipcRenderer.invoke('library:get-folders'),
    resetLibrary: () => ipcRenderer.invoke('library:reset'),
    setTmdbKey: (key) => ipcRenderer.invoke('library:set-tmdb-key', key),
    getTmdbStatus: () => ipcRenderer.invoke('library:tmdb-status'),
    getConnectivity: () => ipcRenderer.invoke('library:get-connectivity'),
    reparse: () => ipcRenderer.invoke('library:reparse'),
  },

  // ── Event subscription ───────────────────────────────────────────────────
  /**
   * Subscribe to a push event from the main process.
   * Returns an unsubscribe function.
   */
  on: (event, callback) => {
    if (!ALLOWED_EVENTS.has(event)) {
      console.warn(`[preload] Blocked subscription to unknown event: ${event}`);
      return () => {};
    }
    const handler = (_ipcEvent, ...args) => callback(...args);
    ipcRenderer.on(event, handler);
    return () => ipcRenderer.removeListener(event, handler);
  },
});
