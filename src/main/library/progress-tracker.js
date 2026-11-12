'use strict';

/**
 * progress-tracker.js — Playback progress listener & SQLite persistence
 */

const libraryStore = require('../db/library-store');

let currentFile = null;
let currentDuration = 0;
let currentTime = 0;

/**
 * Handle new file started in mpv player
 */
function onFileStarted(filePath) {
  currentFile = filePath;
  currentDuration = 0;
  currentTime = 0;
}

/**
 * Handle playback property change (time-pos, duration)
 */
function onPropertyChange(name, data) {
  if (!currentFile) return;

  if (name === 'duration' && typeof data === 'number' && data > 0) {
    currentDuration = data;
  }

  if (name === 'time-pos' && typeof data === 'number') {
    currentTime = data;
    saveProgress(false);
  }
}

/**
 * Handle file ended in mpv player
 */
function onFileEnded() {
  if (!currentFile) return;
  saveProgress(true);
  currentFile = null;
  currentDuration = 0;
  currentTime = 0;
}

/**
 * Helper to record progress into watch_progress table
 */
function saveProgress(isFinished = false) {
  if (!currentFile) return;

  const fileRecord = libraryStore.getFileByPath(currentFile);
  const titleId = fileRecord ? fileRecord.title_id : null;
  const season = fileRecord ? fileRecord.season_number : null;
  const episode = fileRecord ? fileRecord.episode_number : null;

  let completed = 0;
  if (isFinished || (currentDuration > 0 && currentTime / currentDuration >= 0.9)) {
    completed = 1;
  }

  libraryStore.updateWatchProgress({
    file_path: currentFile,
    title_id: titleId,
    season_number: season,
    episode_number: episode,
    progress_seconds: currentTime,
    duration_seconds: currentDuration,
    completed: completed,
  });
}

module.exports = {
  onFileStarted,
  onPropertyChange,
  onFileEnded,
  saveProgress,
};
