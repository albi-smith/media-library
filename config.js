'use strict';

/**
 * config.js — Simple persistent settings store.
 *
 * Reads/writes a JSON file in Electron's userData directory.
 * Synchronous read at startup; debounced async write on change.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  volume: 100,
  mute: false,
  windowBounds: { x: undefined, y: undefined, width: 1024, height: 640 },
  lastPlaylist: [],
  tmdbApiKey: '',
};

let configPath = null;
let data = null;
let writeTimer = null;

/**
 * Must be called once from main process before any get/set.
 * @param {string} userDataPath  Value of app.getPath('userData')
 */
function init(userDataPath) {
  configPath = path.join(userDataPath, 'config.json');
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    data = Object.assign({}, DEFAULTS, JSON.parse(raw));
  } catch {
    data = Object.assign({}, DEFAULTS);
  }
}

function get(key) {
  if (!data) throw new Error('config.init() not called');
  return key ? data[key] : Object.assign({}, data);
}

function set(key, value) {
  if (!data) throw new Error('config.init() not called');
  data[key] = value;
  scheduleWrite();
}

function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 500);
}

function flush() {
  if (!configPath || !data) return;
  try {
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[config] Failed to write config:', err.message);
  }
}

module.exports = { init, get, set, flush };
