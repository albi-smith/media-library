'use strict';
const { parseFilename } = require('./src/main/library/parser');
const cases = [
  '[SubsPlease] One Piece - 1112 [1080p][HEVC][Multi-Subs]',
  'Attack.on.Titan.S04E28.1080p.WEB-DL.x264',
  '[EMBER] Jujutsu Kaisen S02E15 [1080p][10bit][Dual Audio]',
];
for (const c of cases) console.log(JSON.stringify(parseFilename(c + '.mkv')));
