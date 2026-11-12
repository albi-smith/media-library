'use strict';

/**
 * scanner.js — Recursive directory video file scanner
 */

const fs = require('fs');
const path = require('path');

const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.ts', '.mts', '.m2ts',
  '.webm', '.ogv', '.mpg', '.mpeg', '.m4v', '.vob', '.3gp', '.rm', '.rmvb',
  '.divx', '.xvid', '.hevc', '.h264', '.h265', '.prores', '.dnxhd'
]);

/**
 * Recursively scan a folder for video files
 * @param {string} dirPath - Folder to scan
 * @returns {Array<{filePath: string, size: number, mtime: string}>} List of found video files
 */
function scanDirectory(dirPath) {
  let results = [];

  if (!fs.existsSync(dirPath)) {
    return results;
  }

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      // Skip hidden directories (like .git or system folders)
      if (entry.name.startsWith('.')) continue;
      results = results.concat(scanDirectory(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (VIDEO_EXTENSIONS.has(ext)) {
        try {
          const stats = fs.statSync(fullPath);
          results.push({
            filePath: fullPath,
            size: stats.size,
            mtime: stats.mtime.toISOString(),
          });
        } catch (e) {
          console.warn(`Could not stat file: ${fullPath}`, e);
        }
      }
    }
  }

  return results;
}

module.exports = {
  scanDirectory,
  VIDEO_EXTENSIONS,
};
