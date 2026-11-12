'use strict';

/**
 * parser.js — Offline-first filename parser (guessit-equivalent) for Movies, Series, Anime.
 *
 * Primary step: extract show/movie name + season/episode from the filename
 * WITHOUT any network access. External APIs (TMDB/AniList) are only used
 * later to *enrich* an already-grouped local entry — never to determine
 * the grouping itself.
 *
 * The parser ignores release groups, bracketed blocks, quality/resolution,
 * codec/audio tags, and other noise. It understands SxxExx, SxEx, NxM,
 * "Season N Episode M", EPxx/Exx, dash-separated absolute numbering
 * (including long-form 4-digit anime episodes like One Piece 1112), and
 * standalone episode numbers — then reports a 0-1 confidence so uncertain
 * matches can be sent for user review instead of silently mislabeled.
 *
 * Exports:
 *   - parseFilename(filePath) -> { rawName, title, year, season, episode,
 *       typeCandidate, releaseGroup, confidence, needsReview }
 *   - normalizeTitle(title) -> string  (grouping key component)
 *   - getGroupKey(parsed) -> string    (`movie|<norm>|<year>` or `show|<norm>`)
 *   - hasCjk(text) -> boolean
 *   - REVIEW_THRESHOLD -> number (below this, matches are flagged for review)
 */

const path = require('path');

/** Below this confidence, a parsed match is flagged for manual review. */
const REVIEW_THRESHOLD = 0.55;

const NOISE_TAGS = new Set([
  // Resolution
  '1080p', '720p', '480p', '576p', '360p', '2160p', '4k', '8k', 'uhd',
  '1080i', '720i', '480i',
  // HDR / color
  'hdr', 'hdr10', 'hdr10plus', 'dolbyvision', 'dolby-vision', 'dv', 'sdr',
  'hdr10+', 'hlg', 'pq',
  // Source
  'webrip', 'web-dl', 'webdl', 'web', 'bluray', 'blu-ray', 'bdrip', 'brrip',
  'hdtv', 'dvdrip', 'dvd', 'remux', 'proper', 'repack', 'rerip', 'openmatte',
  'hdrip', 'ts', 'telesync', 'cam', 'hdcam', 'tc', 'telecine', 'ld', 'vhs',
  'dvdscr', 'scr', 'screener', 'hddvd', 'uhdrip', 'bdremux', 'dvdremux',
  // Codec
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'xvid', 'divx', 'av1',
  'av1an', 'vvc', 'vp8', 'vp9', 'mpeg2', 'mpeg4', 'mp4',
  // Audio
  'aac', 'ac3', 'eac3', 'dts', 'dts-hd', 'dtshd', 'dts-hdma', 'truehd',
  'flac', 'mp3', 'opus', 'atmos', '5.1', '7.1', '2ch', 'dual-audio',
  'dualaudio', 'multi-audio', 'multiaudio', '2.0', '3.0', '4.0', '6ch',
  'aacinema', 'dts51', 'dts-es', 'thd', 'lpcm', 'pcm', 'hdma',
  'dolby', 'dolbydigital', 'dd', 'ddp', 'dd51',
  // Bit depth
  '10bit', '8bit', '10-bit', '8-bit', '12bit',
  // Sub/audio notes that never appear as title words
  'subbed', 'hardsubbed', 'softsubbed', 'dubbed', 'multisubs', 'multi-subs',
  'extended', 'unrated', 'directors-cut', 'directors', 's01',
  'sub', 'dub', 'eng', 'jpn', 'chs', 'cht', 'kor', 'spa', 'fre', 'ger',
  'ita', 'por', 'rus', 'tha', 'ind', 'ara', 'hin', 'tur', 'pol', 'dut',
  'swe', 'nor', 'dan', 'fin', 'cze', 'hun', 'ron', 'bul', 'hrv', 'ukr',
  'ell', 'heb', 'vie', 'may', 'tl', 'swe', 'multi', 'subbed',
  // Common tags found in anime / scene releases
  'v2', 'v3', 'v4', 'fin', 'batch', 'complete', 'uncensored', 'uncut',
  'theatrical', 'chronological', 'saga', 'collection', 'anthology',
  'special', 'oav', 'oad', 'ona', 'ova', 'ncop', 'nced', 'preview', 'pv',
  'dual', 'raw', 'raws',
]);

/**
 * Normalize a parsed title for local grouping.
 * Lowercase, strip diacritics, collapse punctuation/whitespace.
 * CJK characters (Han, Hiragana, Katakana, Hangul) are preserved so
 * Asian-titled files group correctly instead of collapsing to ''.
 * @param {string} title
 * @returns {string}
 */
/**
 * Normalize a parsed title for local grouping.
 * Lowercase, strip diacritics, collapse punctuation/whitespace.
 * CJK characters (Han, Hiragana, Katakana, Hangul) are preserved so
 * Asian-titled files group correctly instead of collapsing to ''.
 * @param {string} title
 * @returns {string}
 */
function normalizeTitle(title) {
  if (!title) return '';
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/['’`\u2019]/g, '') // strip apostrophes/single quotes so JoJo's -> jojos
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Clean season/part/cour noise from a series title to extract the root show title
 * and any implied season number.
 * @param {string} title
 * @returns {{ cleanTitle: string, extractedSeason: number|null }}
 */
function cleanSeriesTitle(title) {
  if (!title || typeof title !== 'string') return { cleanTitle: '', extractedSeason: null };
  let cleaned = title.trim();
  let extractedSeason = null;

  const seasonMatch =
    cleaned.match(/(?:^|\s|[:._\-])(?:season|s)\s*(\d{1,2})\b/i) ||
    cleaned.match(/(?:^|\s|[:._\-])(\d{1,2})(?:st|nd|rd|th)\s+season\b/i);
  if (seasonMatch && seasonMatch[1]) {
    extractedSeason = parseInt(seasonMatch[1], 10);
  }

  cleaned = cleaned.replace(
    /(?:[\s:._\-]+)(?:season\s*\d{1,2}|s\d{1,2}|\d{1,2}(?:st|nd|rd|th)\s+season|part\s*\d{1,2}|cour\s*\d{1,2}|act\s*\d{1,2}|stage\s*\d{1,2}|final\s+season|the\s+final\s+season|1st\s+season|2nd\s+season|3rd\s+season|4th\s+season)\b.*$/i,
    ''
  ).trim();

  if (!cleaned) cleaned = title.trim();
  return { cleanTitle: cleaned, extractedSeason };
}

/**
 * Detect CJK characters in a string (Chinese/Japanese/Korean).
 * Used only to pick lookup locales — never affects offline grouping.
 * @param {string} text
 * @returns {boolean}
 */
function hasCjk(text) {
  return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text || '');
}

/**
 * Build the stable local grouping key for a parsed file.
 * Movies group by normalized title + year; episodic content (series/anime)
 * groups by normalized root show name only — season/episode never split a group.
 * Anime and series share the `show` bucket so `[Group] Title - 01` and
 * `Title S01E01` land on the same entry.
 * @param {object} parsed - result of parseFilename()
 * @returns {string}
 */
function getGroupKey(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'show|';
  if (parsed.typeCandidate === 'movie') {
    const norm = normalizeTitle(parsed.title);
    return `movie|${norm}|${parsed.year || ''}`;
  }
  const { cleanTitle } = cleanSeriesTitle(parsed.title || '');
  const norm = normalizeTitle(cleanTitle || parsed.title);
  return `show|${norm}`;
}

/**
 * Compute a 0-1 confidence score from the extracted fields plus the kind of
 * episode/season pattern that produced them. Heuristic-only — cheap and
 * deterministic, suitable for offline use on thousands of filenames.
 * @param {object} parsed - partially populated parse result
 * @param {string} matchKind - which pattern branch matched
 * @returns {number} confidence 0..1 (rounded to 2 decimals)
 */
function computeConfidence(parsed, matchKind) {
  let score;

  switch (matchKind) {
    case 'sxxexx':      score = 0.97; break;
    case 'nxm':         score = 0.95; break;
    case 'seasonep':    score = 0.95; break;
    case 'sep':         score = 0.95; break;
    case 'epmarker':    score = 0.92; break;
    case 'bareep':      score = 0.88; break;
    case 'absdash':     score = parsed.episode >= 1000 ? 0.90 : parsed.episode >= 100 ? 0.86 : 0.82; break;
    case 'absspace':    score = parsed.episode >= 1000 ? 0.78 : 0.72; break;
    case 'seasononly':  score = 0.70; break;
    case 'movieyear':   score = 0.90; break;
    case 'movie':       score = 0.85; break;
    default:            score = 0.50;
  }

  // Title-quality penalties.
  const norm = normalizeTitle(parsed.title);
  if (!norm) score *= 0.1;
  else if (norm.length < 3) score *= 0.4;
  if (/^[0-9a-f]{16,}$/i.test(norm)) score *= 0.2; // looks like a hash
  if (/^\d+$/.test(norm)) score *= 0.3; // bare number title — almost certainly wrong

  // Season-only with no episode is reasonably informative but incomplete.
  if (matchKind === 'seasononly' && parsed.typeCandidate !== 'movie') score *= 0.85;

  score = Math.max(0, Math.min(1, score));
  return Math.round(score * 100) / 100;
}

/**
 * Strip every bracketed block plus non-year parenthesized blocks from a
 * copy of the working title, unwrapping bare years like `(2020)` so they
 * survive for year extraction. Used BEFORE absolute-episode detection so
 * trailing `[1080p][HEVC][Multi-Subs]` noise can't hide an episode number.
 * @param {string} text
 * @returns {string}
 */
function stripBracketNoise(text) {
  return text
    .replace(/\((\d{4})\)/g, '$1') // unwrap pure-year parens: (2020) -> 2020
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Social handles and channel tags like @Anime_x_Clan, @Animes2u, @tg_channel
 * that appear in filenames.
 */
function stripSocialHandles(text) {
  if (!text) return '';
  return text.replace(/@[\w_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * CRC32 / Hex hashes in brackets/parens at end of filename like [12345678] or (8A3F20C1).
 */
function stripHashTags(text) {
  if (!text) return '';
  return text.replace(/[\[\(][0-9a-f]{8}[\]\)]/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Unwrap bracketed title blocks when inner text is not a noise tag or episode marker.
 */
function unwrapTitleBrackets(text) {
  if (!text) return '';
  return text.replace(/\[([^\]]+)\]/g, (match, inner) => {
    const trimmed = inner.trim();
    const lower = trimmed.toLowerCase();
    if (
      NOISE_TAGS.has(lower) ||
      /^\d+p?$/i.test(lower) ||
      /^\d{4}$/.test(lower) ||
      /^s\d{1,2}/i.test(lower) ||
      /^ep?\d/i.test(lower) ||
      /^\d{1,4}$/.test(lower)
    ) {
      return match; // keep as bracketed noise to be stripped later
    }
    return ` ${trimmed} `; // unwrap valid title block
  });
}

/**
 * Parse a file path or filename into structured media metadata.
 * Pure offline string processing — no network, no fs probing.
 * @param {string} filePath
 * @returns {object} { rawName, title, year, season, episode,
 *                    typeCandidate, releaseGroup, confidence, needsReview }
 */
function parseFilename(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    console.warn('[parser] parseFilename called with invalid input:', filePath);
    return {
      rawName: '',
      title: '',
      year: null,
      season: null,
      episode: null,
      typeCandidate: 'movie',
      releaseGroup: null,
      confidence: 0,
      needsReview: true,
    };
  }

  const filename = path.basename(filePath, path.extname(filePath));
  let clean = stripSocialHandles(filename);
  clean = stripHashTags(clean);

  let releaseGroup = null;
  let season = null;
  let episode = null;
  let year = null;
  let typeCandidate = 'movie';
  let matchKind = null;

  // 1. Release group prefix: [Group] or (Group) at start
  const groupMatch = clean.match(/^\[([^\]]{1,32})\]/) || clean.match(/^\(([^)]{1,32})\)/);
  if (groupMatch) {
    const candidate = groupMatch[1].trim();
    // Only treat as a group if it looks like one (not a year, not SxxExx, not an episode marker, not a codec/noise tag)
    if (candidate && !/^(19\d\d|20\d\d)$/.test(candidate)
        && !/s\d{1,2}[\-_.\s]*e\d/i.test(candidate)
        && !/s\d{1,2}/i.test(candidate)
        && !/^ep?\d/i.test(candidate)
        && !/^\d{1,4}$/.test(candidate)
        && !NOISE_TAGS.has(candidate.toLowerCase())) {
      releaseGroup = candidate;
      clean = clean.slice(groupMatch[0].length).trim().replace(/^[\-_. ]+/, '');
      // Anime-style releases almost always carry the group prefix
      typeCandidate = 'anime';
    }
  }

  // 2. Bracketed Season / Episode patterns (extracted BEFORE bracket noise stripping)
  //    Matches [S01-E01], [S01E01], [S01_E01], (S01E01)
  {
    const bracketSE = clean.match(/[\[\(]\s*s(\d{1,2})[\-_.\s]*e(\d{1,4})\s*[\]\)]/i);
    if (bracketSE) {
      season = parseInt(bracketSE[1], 10);
      episode = parseInt(bracketSE[2], 10);
      clean = clean.replace(bracketSE[0], ' ').trim();
      typeCandidate = 'series';
      matchKind = 'sxxexx';
    }
  }

  //    Matches [E01], [EP01], (EP01)
  if (season === null && episode === null) {
    const bracketEp = clean.match(/[\[\(]\s*ep?\.?\s*(\d{1,4})\s*[\]\)]/i);
    if (bracketEp) {
      season = 1;
      episode = parseInt(bracketEp[1], 10);
      clean = clean.replace(bracketEp[0], ' ').trim();
      typeCandidate = 'anime';
      matchKind = 'epmarker';
    }
  }

  //    Matches standalone bracketed episode number near start or after group: [1135], [01], (1135)
  if (season === null && episode === null) {
    const bracketNum = clean.match(/(?:^|[\s._\-])[\[\(]\s*(\d{1,4})\s*[\]\)](?:[\s._\-]|$)/);
    if (bracketNum) {
      const num = parseInt(bracketNum[1], 10);
      const isYear = num >= 1900 && num <= 2099;
      if (!isYear) {
        season = 1;
        episode = num;
        clean = clean.replace(bracketNum[0], ' ').trim();
        typeCandidate = 'anime';
        matchKind = 'absdash';
      }
    }
  }

  // 3. Unwrap bracketed title blocks (e.g. [One Piece]) so titles survive noise stripping
  clean = unwrapTitleBrackets(clean);

  // 4. Trailing release group suffix: Title.S01E01-GROUP
  const suffixGroupMatch = clean.match(/-([A-Za-z0-9]{2,12})$/);

  // 3. SxxExx / SxEx / NxM / "Season N Episode M" / Sxx EPxx patterns
  //    Checked first — most unambiguous episodic signal.
  const sxxexx = clean.match(/^(.*?)[ ._\-]s(\d{1,2})\s*e(\d{1,4})(?:e\d{1,4}|\s*-\s*e?\d{1,4})?(?:[ ._\-(\[]|$)/i);
  const nxm = !sxxexx && clean.match(/^(.*?)[ ._\-](\d{1,2})x(\d{1,4})(?:[ ._\-(\[]|$)/i);
  const seasonEpWords = !sxxexx && !nxm && clean.match(
    /^(.*?)\bseason[\s._\-]*(\d{1,2})\b[\s._\-]*episode[\s._\-]*(\d{1,4})\b/i
  );
  const seasonEpShort = !sxxexx && !nxm && !seasonEpWords && clean.match(
    /^(.*?)[ ._\-]s(\d{1,2})\s*(?:e|ep)(\d{1,4})(?:[ ._\-(\[]|$)/i
  );
  // Tight "S01E01" with no separator (pure episode marker file). Only fires
  // when the `s` is at a word boundary so a glued "ShowS01E01" name is NOT
  // split; keeps the leading title portion (usually empty) in group 1.
  const sxxexxTight = !sxxexx && !seasonEpWords && clean.match(
    /^(.*?)(?:^|\s|[. _\-(\[])(?:s)(\d{1,2})\s*e(\d{1,4})(?:e\d{1,4})?(?:[ ._\-(\[]|$)/i
  );

  const epMatch = sxxexx || nxm || seasonEpWords || seasonEpShort ||
    (sxxexxTight && { 1: sxxexxTight[1], 2: sxxexxTight[2], 3: sxxexxTight[3], tight: true });
  if (epMatch) {
    if (typeCandidate !== 'anime') typeCandidate = 'series';
    season = parseInt(epMatch[2], 10);
    episode = parseInt(epMatch[3], 10);
    clean = epMatch[1] || '';
    matchKind = sxxexx ? 'sxxexx' : nxm ? 'nxm' : seasonEpWords ? 'seasonep' : (sxxexxTight ? 'sxxexx' : 'sep');
  } else {
    // 4. Absolute / anime numbering. All bracketed and non-year parenthesized
    //    noise is stripped first so "[1080p][HEVC][Multi-Subs]" or a trailing
    //    "(1080p)" can't swallow the episode number. Dots/underscores are
    //    normalized to spaces so "Show.Episode.01", "Show.EP04" and
    //    "Show-E02" are all readable without punctuation-specific regexes.
    const work = stripBracketNoise(clean).replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim();

    // Explicit marker: "Title Episode 12", "Title Ep 12", "Title EP12"
    const epMarker =
      work.match(/^(.*?)\s+episode\s*\.?\s*(\d{1,4})\s*(?:v\d+)?$/i) ||
      work.match(/^(.*?)\s*[-–_ ]+\s*e(?:p)?\.?\s*(\d{1,4})\s*(?:v\d+)?$/i);

    // Part marker: "Title Part 1", "Title - Part 12"
    const partMarker = !epMarker &&
      work.match(/^(.*?)\s+(?:part|pt\.?)\s*(\d{1,4})\s*$/i);

    // Attached bare marker: "Title.E01", "Title.EP01" (boundary-guarded)
    const bareEp = !epMarker && !partMarker && work.match(/^(.*?)[ ._\-](?:e|ep)(\d{1,4})(?:[ ._\-(\[]|$)/i);

    // Dash/underscore separated absolute number: "Title - 123"
    const absDash = !epMarker && !partMarker && !bareEp &&
      work.match(/^(.*?)\s*[-–_]\s*(\d{1,4})\s*(?:v\d+)?$/);

    // Space separated bare trailing number (risky — guarded below)
    const absSpace = !epMarker && !partMarker && !bareEp && !absDash &&
      work.match(/^(.*?)\s+(\d{1,4})(?:\s*v\d+)?$/);

    const isYearLike = (n) => n >= 1900 && n <= 2099;

    if (epMarker) {
      if (typeCandidate !== 'anime') typeCandidate = 'series';
      season = 1;
      episode = parseInt(epMarker[2], 10);
      clean = (epMarker[1] || '').trim();
      matchKind = 'epmarker';
    } else if (partMarker) {
      if (typeCandidate !== 'anime') typeCandidate = 'series';
      season = 1;
      episode = parseInt(partMarker[2], 10);
      clean = (partMarker[1] || '').trim();
      matchKind = 'epmarker';
    } else if (bareEp) {
      const num = parseInt(bareEp[2], 10);
      if (!isYearLike(num)) {
        if (typeCandidate !== 'anime') typeCandidate = 'series';
        season = 1;
        episode = num;
        clean = (bareEp[1] || '').trim();
        matchKind = 'bareep';
      }
    } else if (absDash) {
      const num = parseInt(absDash[2], 10);
      // A year-like trailing number is a year, not an episode (e.g. "Movie - 2020").
      if (!isYearLike(num)) {
        if (typeCandidate !== 'anime') typeCandidate = 'series';
        season = 1;
        episode = num;
        clean = (absDash[1] || '').trim();
        matchKind = 'absdash';
      }
    } else if (absSpace) {
      const num = parseInt(absSpace[2], 10);
      // Space-separated trailing numbers are ambiguous. Treat as episode only
      // when backed by an anime group/tag OR long-form (>= 1000) numbering,
      // and never swallow a year.
      const animeSignals = typeCandidate === 'anime' || releaseGroup || /\banime\b/i.test(clean);
      if (!isYearLike(num) && (animeSignals || num >= 1000)) {
        season = 1;
        episode = num;
        clean = (absSpace[1] || '').trim();
        matchKind = 'absspace';
      }
    }
  }

  // 5. Standalone season marker without episode: "Title S02 ..." (episode unknown)
  if (season === null) {
    const seasonOnly = clean.match(/^(.*?)[ ._\-]s(\d{1,2})(?:[ ._\-(\[]|$)/i);
    if (seasonOnly && seasonOnly[1] && seasonOnly[1].trim()) {
      typeCandidate = typeCandidate === 'movie' ? 'series' : typeCandidate;
      season = parseInt(seasonOnly[2], 10);
      clean = seasonOnly[1].trim();
      matchKind = 'seasononly';
    }
  }

  // 6. Year: (2020), [2020], .2020. _2020 — but never eat a title that IS a year.
  //    Prefer a parenthesized/bracketed year (handles "2012 (2009)"), else the
  //    last year-like token with a non-empty prefix.
  {
    const yearRe = /(19\d\d|20\d\d)/g;
    const hits = [];
    let m;
    while ((m = yearRe.exec(clean)) !== null) {
      const idx = m.index;
      const enclosed =
        (clean[idx - 1] === '(' && clean[idx + 4] === ')') ||
        (clean[idx - 1] === '[' && clean[idx + 4] === ']');
      const prefix = clean.substring(0, idx).trim().replace(/[(\[._\- ]+$/, '');
      hits.push({ value: parseInt(m[1], 10), index: idx, enclosed, prefix });
    }
    const ranked = hits
      .filter((h) => h.prefix)
      .sort((a, b) => (b.enclosed - a.enclosed) || (b.index - a.index));
    if (ranked.length > 0) {
      year = ranked[0].value;
      clean = ranked[0].prefix;
    }
    // else: filename is just "2012" etc. — keep as title, no year
  }

  // 7. Trailing "-GROUP" suffix now that S/E + year are removed
  if (!releaseGroup && suffixGroupMatch) {
    const maybeGroup = suffixGroupMatch[1];
    if (/^[A-Za-z0-9]{2,12}$/.test(maybeGroup) && !NOISE_TAGS.has(maybeGroup.toLowerCase())) {
      const withoutSuffix = clean.replace(/-[A-Za-z0-9]{2,12}$/, '').trim();
      if (withoutSuffix && withoutSuffix !== clean) {
        releaseGroup = maybeGroup;
        clean = withoutSuffix;
      }
    }
  }

  // 8. Strip remaining noise: delimiters + leftover quality/codec/etc. tags.
  //    Also strip trailing standalone numbers that look like episode numbers
  //    that survived the earlier patterns (e.g. "Title 01" after bracket strip).
  clean = clean.replace(/[\._\-]+/g, ' ');
  clean = clean.replace(/\s+/g, ' ').trim();

  // Strip trailing isolated episode-like numbers (1-4 digits) that were not
  // caught by the explicit episode patterns above.  Only strip if the remaining
  // title text is non-empty so we don't eat the entire string.
  {
    const trailingEp = clean.match(/^(.*?)\s+(\d{1,4})\s*$/);
    if (trailingEp && trailingEp[1] && trailingEp[1].trim()) {
      const num = parseInt(trailingEp[2], 10);
      const isYearLike = num >= 1900 && num <= 2099;
      if (!isYearLike && episode === null) {
        clean = trailingEp[1].trim();
      }
    }
  }

  const words = clean.split(' ').filter((w) => {
    if (!w) return false;
    const cleanWord = w.replace(/[\[\]()]/g, '').toLowerCase();
    if (NOISE_TAGS.has(cleanWord)) return false;
    if (/^\d+p+$/i.test(cleanWord)) return false; // e.g. 720p, 720pp, 1080p
    if (/^(sub|dub|esub|hardsub|softsub|dualaudio|multiaudio)$/i.test(cleanWord)) return false;
    return true;
  });

  let parsedTitle = words.join(' ').trim() || filename.trim();
  parsedTitle = parsedTitle
    .replace(/[\[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Final guard: if the title still contains an episode marker like "EP" or "E"
  // followed by a number that wasn't parsed, strip it to avoid duplication
  // in the display title.
  parsedTitle = parsedTitle
    .replace(/\s+(?:ep?|episode)\s*\d{1,4}\s*$/i, '')
    .replace(/\s+part\s*\d{1,4}\s*$/i, '')
    .trim();

  if (typeCandidate !== 'movie') {
    const cleanedRes = cleanSeriesTitle(parsedTitle);
    if (cleanedRes.cleanTitle) {
      parsedTitle = cleanedRes.cleanTitle;
    }
    if ((season === null || season === 1) && cleanedRes.extractedSeason !== null) {
      season = cleanedRes.extractedSeason;
    }
  }

  // 9. Confidence scoring.
  if (matchKind === null) {
    matchKind = year ? 'movieyear' : 'movie';
    if (episode !== null) matchKind = 'episode'; // shouldn't happen — treat as plain
  }
  const confidence = computeConfidence(
    { title: parsedTitle, year, season, episode, typeCandidate },
    matchKind
  );
  const needsReview = confidence < REVIEW_THRESHOLD;

  return {
    rawName: filename,
    title: parsedTitle,
    year,
    season,
    episode,
    typeCandidate,
    releaseGroup,
    confidence,
    needsReview,
  };
}

module.exports = {
  parseFilename,
  normalizeTitle,
  cleanSeriesTitle,
  getGroupKey,
  hasCjk,
  REVIEW_THRESHOLD,
};