'use strict';

/**
 * mpv-manager.js — Higher-level playback manager built on MpvIpc.
 *
 * Responsibilities:
 *  - Track list parsing (audio / subtitle / video tracks)
 *  - In-process playlist management and auto-advance
 *  - External subtitle loading
 *  - Forwarding structured state to the main process event emitter
 */

const { EventEmitter } = require('events');
const path = require('path');
const { MpvIpc, findMpvBinary } = require('./mpv-ipc');

class MpvManager extends EventEmitter {
  constructor() {
    super();
    this._ipc = new MpvIpc();
    this._playlist = [];      // [{ path, title }]
    this._playlistIndex = -1;
    this._ready = false;

    this._bindIpcEvents();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(extraFlags = []) {
    // Check binary before trying
    if (!findMpvBinary()) {
      this.emit('not-found');
      return;
    }
    try {
      await this._ipc.start(extraFlags);
      this._ready = true;
      this.emit('ready');
    } catch (err) {
      if (err.code === 'MPV_NOT_FOUND') {
        this.emit('not-found');
      } else {
        this.emit('error', { message: err.message });
      }
    }
  }

  async stop() {
    this._ready = false;
    await this._ipc.stop();
  }

  get isReady() { return this._ready; }

  // ── Playback control ───────────────────────────────────────────────────────

  async openFile(filePath) {
    if (!this._ready) return;
    const existing = this._playlist.findIndex(p => p.path === filePath);
    if (existing !== -1) {
      this._playlistIndex = existing;
    } else {
      this._playlist = [{ path: filePath, title: path.basename(filePath) }];
      this._playlistIndex = 0;
    }
    await this._ipc.loadFile(filePath);
    this.emit('playlist-changed', this._getPlaylistState());
  }

  async openURL(url) {
    if (!this._ready) return;
    this._playlist = [{ path: url, title: url }];
    this._playlistIndex = 0;
    await this._ipc.loadURL(url);
    this.emit('playlist-changed', this._getPlaylistState());
  }

  async addFiles(filePaths) {
    if (!this._ready) return;
    for (const fp of filePaths) {
      if (!this._playlist.find(p => p.path === fp)) {
        this._playlist.push({ path: fp, title: path.basename(fp) });
      }
    }
    // If nothing is playing, start the first added file
    if (this._playlistIndex === -1) {
      this._playlistIndex = 0;
      await this._ipc.loadFile(this._playlist[0].path);
    }
    this.emit('playlist-changed', this._getPlaylistState());
  }

  removeFromPlaylist(index) {
    if (index < 0 || index >= this._playlist.length) return;
    this._playlist.splice(index, 1);
    if (this._playlistIndex >= this._playlist.length) {
      this._playlistIndex = this._playlist.length - 1;
    }
    this.emit('playlist-changed', this._getPlaylistState());
  }

  async playNext() {
    if (this._playlistIndex < this._playlist.length - 1) {
      this._playlistIndex++;
      await this._ipc.loadFile(this._playlist[this._playlistIndex].path);
      this.emit('playlist-changed', this._getPlaylistState());
    }
  }

  async playPrev() {
    if (this._playlistIndex > 0) {
      this._playlistIndex--;
      await this._ipc.loadFile(this._playlist[this._playlistIndex].path);
      this.emit('playlist-changed', this._getPlaylistState());
    }
  }

  async playIndex(index) {
    if (index < 0 || index >= this._playlist.length) return;
    this._playlistIndex = index;
    await this._ipc.loadFile(this._playlist[index].path);
    this.emit('playlist-changed', this._getPlaylistState());
  }

  // ── Playback commands (pass-through) ────────────────────────────────────────

  command(...args) { return this._ipc.command(...args); }
  getProperty(name) { return this._ipc.getProperty(name); }
  setProperty(name, value) { return this._ipc.setProperty(name, value); }

  async seek(seconds) {
    return this._ipc.command('seek', seconds, 'relative');
  }

  async seekAbsolute(seconds) {
    return this._ipc.command('seek', seconds, 'absolute');
  }

  async seekFrame(forward = true) {
    return this._ipc.command(forward ? 'frame-step' : 'frame-back-step');
  }

  // ── Track management ──────────────────────────────────────────────────────

  async getTrackList() {
    try {
      const raw = await this._ipc.getProperty('track-list');
      return this._parseTrackList(raw);
    } catch {
      return { audio: [], sub: [], video: [] };
    }
  }

  async selectAudioTrack(id) {
    return this._ipc.setProperty('aid', id);
  }

  async selectSubTrack(id) {
    if (id === 'off' || id === 0) {
      return this._ipc.setProperty('sid', 'no');
    }
    return this._ipc.setProperty('sid', id);
  }

  async loadExternalSubtitle(filePath) {
    return this._ipc.command('sub-add', filePath, 'select');
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _parseTrackList(rawList) {
    const result = { audio: [], sub: [], video: [] };
    if (!Array.isArray(rawList)) return result;

    for (const t of rawList) {
      const entry = {
        id: t.id,
        selected: t.selected || false,
        lang: t.lang || '',
        title: t.title || '',
        codec: t.codec || '',
        label: [t.title, t.lang, t.codec].filter(Boolean).join(' / ') || `Track ${t.id}`,
        external: t.external || false,
        externalFilename: t['external-filename'] || '',
        defaultTrack: t.default || false,
      };

      if (t.type === 'audio') result.audio.push(entry);
      else if (t.type === 'sub') result.sub.push(entry);
      else if (t.type === 'video') result.video.push(entry);
    }
    return result;
  }

  _getPlaylistState() {
    return {
      items: this._playlist.map((p, i) => ({ ...p, index: i })),
      currentIndex: this._playlistIndex,
    };
  }

  _bindIpcEvents() {
    const ipc = this._ipc;

    ipc.on('property-change', (ev) => {
      // Re-emit as structured state change
      this.emit('property-change', ev);

      // Re-parse track list when it changes
      if (ev.name === 'track-list') {
        const parsed = this._parseTrackList(ev.data);
        this.emit('tracks-changed', parsed);
      }
    });

    ipc.on('start-file', () => {
      this.emit('start-file', { playlistIndex: this._playlistIndex });
    });

    ipc.on('end-file', async ({ reason, error }) => {
      this.emit('end-file', { reason, error });

      if (reason === 'eof') {
        // Auto-advance
        if (this._playlistIndex < this._playlist.length - 1) {
          await this.playNext();
        } else {
          this.emit('playlist-end');
        }
      } else if (reason === 'error') {
        this.emit('error', {
          message: error || 'Playback error — file may be corrupt or unsupported',
        });
      }
    });

    ipc.on('idle', () => this.emit('idle'));
    ipc.on('exit', (info) => {
      this._ready = false;
      this.emit('exit', info);
    });
    ipc.on('mpv-error', (err) => this.emit('error', err));
    ipc.on('hwdec-fallback', (info) => this.emit('hwdec-fallback', info));
  }
}

module.exports = { MpvManager };
