'use strict';

/**
 * connectivity.js — Cached online/offline detection for the main process.
 *
 * The app is "online" when at least one metadata provider (TMDB/TVMaze,
 * AniList) is reachable and returns an HTTP OK for a cheap probe request.
 * The result is cached for PROBE_TTL_MS so scans don't hammer the network
 * on every single file (matching uses connectivity.isOnline() hundreds of
 * times per scan).
 *
 * Offline -> online transitions are emitted as 'online' events so the
 * library can background-reparse previously filename-guessed entries.
 * The probe is keyless (a terse TVMaze search costs nothing and needs no
 * API key), so online status does not depend on the user having configured
 * a TMDB key.
 */

const { EventEmitter } = require('events');

const PROBE_TTL_MS = 30 * 1000;
const PROBE_TIMEOUT_MS = 5000;
const PROBE_ENDPOINT = 'https://api.tvmaze.com/search/shows?q=probe';

const emitter = new EventEmitter();

let status = null;   // { online: boolean, checkedAt: number }
let inFlight = null; // Promise while a probe is running
let timer = null;

/**
 * Run a single reachability probe. Never throws.
 * @returns {Promise<boolean>} true when a provider is reachable
 */
async function probe() {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(PROBE_ENDPOINT, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    return response && response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Refresh the cached online status with a live probe (deduped so
 * concurrent callers share a single in-flight request).
 * @returns {Promise<boolean>} current online status
 */
async function refresh() {
  if (inFlight) {
    await inFlight.catch(() => {});
    return status && status.online;
  }
  inFlight = (async () => {
    const online = await probe();
    const previous = status ? status.online : null;
    status = { online, checkedAt: Date.now() };
    if (previous !== null && online !== previous) {
      emitter.emit(online ? 'online' : 'offline', status);
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { status = null; }, PROBE_TTL_MS + 1000);
    return online;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

/**
 * Current connectivity status, probing when the cache is stale.
 * @returns {Promise<{online:boolean, checkedAt:number|null}>}
 */
async function check() {
  if (status && Date.now() - status.checkedAt < PROBE_TTL_MS) {
    return { ...status };
  }
  const online = await refresh();
  return { online, checkedAt: status ? status.checkedAt : null };
}

/**
 * Synchronous view of the last known status (no network I/O).
 * Returns true while unknown so a scan still attempts enrichment —
 * the metadata call itself falls back to local grouping on failure.
 * @returns {boolean}
 */
function isOnline() {
  if (!status) return true;
  return status.online;
}

/**
 * Force the probe to re-check immediately (e.g. renderer reported the OS
 * network came back). Returns the fresh status.
 * @returns {Promise<{online:boolean, checkedAt:number|null}>}
 */
function recheck() {
  status = null;
  return check();
}

/**
 * Subscribe to connectivity transitions.
 * @param {'online'|'offline'|string} event
 * @param {(status:object)=>void} cb
 * @returns {() => void} unsubscribe
 */
function on(event, cb) {
  emitter.on(event, cb);
  return () => emitter.removeListener(event, cb);
}

module.exports = {
  check,
  refresh,
  recheck,
  isOnline,
  on,
  PROBE_TTL_MS,
};