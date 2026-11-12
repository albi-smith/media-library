'use strict';

/**
 * mpv-ipc.js — Custom mpv IPC layer built on Node's net module.
 *
 * Spawns the system mpv binary with --idle and --input-ipc-server,
 * connects via a Unix socket (Linux/macOS) or named pipe (Windows),
 * and exposes a clean Promise + EventEmitter API.
 *
 * No node-mpv dependency. Protocol: newline-delimited JSON.
 */

const net = require('net');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

// ─── Binary detection ────────────────────────────────────────────────────────

const BINARY_SEARCH_PATHS = {
  win32: [
    'mpv',
    'C:\\Program Files\\MPV Player\\mpv.exe',
    'C:\\Program Files\\mpv\\mpv.exe',
    'C:\\Program Files (x86)\\mpv\\mpv.exe',
    path.join(process.env.USERPROFILE || '', 'scoop', 'shims', 'mpv.exe'),
    path.join(process.env.PROGRAMDATA || '', 'chocolatey', 'bin', 'mpv.exe'),
  ],
  darwin: [
    'mpv',
    '/usr/local/bin/mpv',
    '/opt/homebrew/bin/mpv',
    '/usr/bin/mpv',
  ],
  linux: [
    'mpv',
    '/usr/bin/mpv',
    '/usr/local/bin/mpv',
    '/snap/bin/mpv',
    '/var/lib/flatpak/exports/bin/io.mpv.Mpv',
  ],
};

function findMpvBinary() {
  const candidates = BINARY_SEARCH_PATHS[process.platform] || ['mpv'];
  for (const candidate of candidates) {
    try {
      // Absolute path: check existence
      if (path.isAbsolute(candidate)) {
        if (fs.existsSync(candidate)) return candidate;
        continue;
      }
      // Bare name: let the OS resolve via PATH by doing a cheap probe
      const { execFileSync } = require('child_process');
      execFileSync(candidate, ['--version'], { stdio: 'ignore', timeout: 3000 });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

// ─── Hardware decode flags per platform ─────────────────────────────────────

function hwdecFlag() {
  switch (process.platform) {
    case 'win32': return 'd3d11va';
    case 'darwin': return 'videotoolbox';
    default: return 'vaapi';
  }
}

// ─── Socket path ─────────────────────────────────────────────────────────────

function socketPath(pid) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\electron-mpv-${pid}`;
  }
  return `/tmp/electron-mpv-${pid}.sock`;
}

// ─── MpvIpc class ────────────────────────────────────────────────────────────

class MpvIpc extends EventEmitter {
  constructor() {
    super();
    this._proc = null;        // child_process
    this._socket = null;      // net.Socket
    this._sockPath = null;
    this._reqId = 1;
    this._pending = new Map(); // reqId → { resolve, reject }
    this._lineBuffer = '';
    this._connected = false;
    this._softwareFallbackDone = false;
    this._hwdecPrimary = hwdecFlag();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Start mpv and connect to its IPC socket. Returns Promise that resolves when ready. */
  async start(extraFlags = []) {
    const binary = findMpvBinary();
    if (!binary) {
      const err = new Error('mpv binary not found');
      err.code = 'MPV_NOT_FOUND';
      throw err;
    }

    const pid = process.pid;
    this._sockPath = socketPath(pid);

    // Clean up stale socket on Unix
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this._sockPath); } catch { /* ok */ }
    }

    const flags = [
      '--idle=yes',
      '--no-terminal',
      '--no-input-default-bindings',
      '--keepaspect=yes',
      '--volume=100',
      '--volume-max=200',
      `--hwdec=${this._hwdecPrimary}`,
      '--hwdec-codecs=all',
      `--input-ipc-server=${this._sockPath}`,
      '--video-sync=display-resample',
      '--interpolation=no',
      ...extraFlags,
    ];

    this._proc = spawn(binary, flags, { stdio: 'ignore', detached: false });

    this._proc.on('exit', (code, signal) => {
      this._connected = false;
      this.emit('exit', { code, signal });
    });

    this._proc.on('error', (err) => {
      this.emit('mpv-error', { message: `Process error: ${err.message}` });
    });

    await this._waitForSocket(this._sockPath, 5000);
    await this._connect();
    this._setupObservers();
  }

  /** Gracefully quit mpv. */
  async stop() {
    if (!this._connected) return;
    try { await this.command('quit'); } catch { /* already dead */ }
    this._socket?.destroy();
    this._proc?.kill();
  }

  /** Load a file or URL for playback. */
  loadFile(filePath) {
    return this.command('loadfile', filePath, 'replace');
  }

  loadURL(url) {
    return this.command('loadfile', url, 'replace');
  }

  /** Append to mpv's internal playlist (used for single-file-at-a-time approach). */
  appendFile(filePath) {
    return this.command('loadfile', filePath, 'append');
  }

  /** Send any mpv command. Returns Promise<response data>. */
  command(...args) {
    return this._send({ command: args });
  }

  /** Get a property value. */
  getProperty(name) {
    return this._send({ command: ['get_property', name] });
  }

  /** Set a property value. */
  setProperty(name, value) {
    return this._send({ command: ['set_property', name, value] });
  }

  /** Ask mpv to send property-change events whenever this property changes. */
  observeProperty(id, name) {
    return this._send({ command: ['observe_property', id, name] });
  }

  get isConnected() { return this._connected; }

  // ── Internal ─────────────────────────────────────────────────────────────

  async _waitForSocket(sockPath, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (process.platform === 'win32') {
        // Named pipes don't show up in the filesystem; we poll by attempting
        // a connection. Give mpv a moment to start, then let _connect handle retries.
        await new Promise(r => setTimeout(r, 300));
        return;
      }
      if (fs.existsSync(sockPath)) return;
      await new Promise(r => setTimeout(r, 80));
    }
    throw new Error(`Timed out waiting for mpv socket at ${sockPath}`);
  }

  async _connect() {
    const deadline = Date.now() + 8000; // allow up to 8 seconds total
    let lastError = null;

    while (Date.now() < deadline) {
      try {
        await this._tryConnect();
        return; // success
      } catch (err) {
        lastError = err;
        // Wait before retrying — pipe may not exist yet
        await new Promise(r => setTimeout(r, 250));
      }
    }
    throw lastError || new Error('Connection to mpv socket timed out');
  }

  /** Single connection attempt — resolves on connect, rejects on error/timeout. */
  _tryConnect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this._sockPath);
      let settled = false;

      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(new Error('Connection to mpv socket timed out'));
      }, 2000);

      sock.on('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        this._connected = true;
        this._socket = sock;

        sock.on('data', (chunk) => this._onData(chunk));

        sock.on('error', (err) => {
          this._connected = false;
          this.emit('mpv-error', { message: `Socket error: ${err.message}` });
        });

        sock.on('close', () => {
          this._connected = false;
          for (const [id, { reject: rej }] of this._pending) {
            rej(new Error('Socket closed'));
            this._pending.delete(id);
          }
        });

        resolve();
      });

      sock.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          sock.destroy();
          reject(err);
        }
      });
    });
  }

  _onData(chunk) {
    this._lineBuffer += chunk.toString('utf8');
    const lines = this._lineBuffer.split('\n');
    this._lineBuffer = lines.pop(); // last element may be partial

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Response to a command we sent
    if (msg.request_id !== undefined) {
      const pending = this._pending.get(msg.request_id);
      if (pending) {
        this._pending.delete(msg.request_id);
        if (msg.error && msg.error !== 'success') {
          pending.reject(new Error(`mpv: ${msg.error}`));
        } else {
          pending.resolve(msg.data);
        }
      }
      return;
    }

    // Unsolicited event
    if (msg.event) {
      this.emit('mpv-event', msg);

      switch (msg.event) {
        case 'property-change':
          this.emit('property-change', { id: msg.id, name: msg.name, data: msg.data });
          // Check hwdec fallback
          if (msg.name === 'hwdec-current' && msg.data === 'no' && !this._softwareFallbackDone) {
            this._handleHwdecFailure();
          }
          break;
        case 'start-file':
          this.emit('start-file', msg);
          break;
        case 'end-file':
          this.emit('end-file', { reason: msg.reason, error: msg['file-error'] });
          break;
        case 'idle':
          this.emit('idle');
          break;
        case 'playback-restart':
          this.emit('playback-restart');
          break;
      }
    }
  }

  _send(payload) {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this._socket) {
        return reject(new Error('Not connected to mpv'));
      }
      const id = this._reqId++;
      payload.request_id = id;
      this._pending.set(id, { resolve, reject });

      const raw = JSON.stringify(payload) + '\n';
      this._socket.write(raw, 'utf8', (err) => {
        if (err) {
          this._pending.delete(id);
          reject(err);
        }
      });

      // Per-request timeout (5 s)
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`mpv command timed out: ${JSON.stringify(payload.command)}`));
        }
      }, 5000);
    });
  }

  _setupObservers() {
    // IDs are arbitrary but unique — used to identify which property changed
    const props = [
      [1, 'pause'],
      [2, 'playback-time'],
      [3, 'duration'],
      [4, 'volume'],
      [5, 'mute'],
      [6, 'speed'],
      [7, 'track-list'],
      [8, 'hwdec-current'],
      [9, 'buffering'],
      [10, 'media-title'],
      [11, 'path'],
    ];
    for (const [id, name] of props) {
      this.observeProperty(id, name).catch(() => { /* ok if mpv not ready */ });
    }
  }

  async _handleHwdecFailure() {
    this._softwareFallbackDone = true;
    console.warn(`[mpv-ipc] hwdec=${this._hwdecPrimary} not active; falling back to auto-safe`);
    this.emit('hwdec-fallback', { attempted: this._hwdecPrimary });
    try {
      await this.setProperty('hwdec', 'auto-safe');
    } catch (err) {
      console.warn('[mpv-ipc] Could not set hwdec=auto-safe:', err.message);
    }
  }
}

module.exports = { MpvIpc, findMpvBinary };
