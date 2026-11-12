'use strict';

/**
 * renderer.js — UI logic, Library view router, and mpv player wiring.
 */

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  playing: false,
  duration: 0,
  currentTime: 0,
  volume: 100,
  muted: false,
  speed: 1,
  seeking: false,
  fullscreen: false,
  tracks: { audio: [], sub: [], video: [] },
  playlist: { items: [], currentIndex: -1 },
  status: 'Idle',
  hwdec: '',
  errorMsg: '',
  mpvReady: false,
  
  // Library state
  currentView: 'library', // 'watching' | 'library' | 'detail' | 'manga' | 'tv' | 'player'
  currentFilter: 'all',  // 'all' | 'movie' | 'series' | 'anime'
  searchQuery: '',
  activeTitleId: null,
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const el = {
  seekBar: $('seek-bar'),
  timeDisplay: $('time-display'),
  btnPlayPause: $('btn-play-pause'),
  btnStop: $('btn-stop'),
  btnPrev: $('btn-prev'),
  btnNext: $('btn-next'),
  btnMute: $('btn-mute'),
  volumeSlider: $('volume-slider'),
  volumeWrap: $('volume-slider')?.parentElement,
  volumeDisplay: $('volume-display'),
  speedSelect: $('speed-select'),
  btnFullscreen: $('btn-fullscreen'),
  btnOpenFile: $('btn-open-file'),
  btnAddFiles: $('btn-add-files'),
  btnOpenUrl: $('btn-open-url'),
  btnOpenSub: $('btn-open-sub'),
  audioTrackSelect: $('audio-track-select'),
  subTrackSelect: $('sub-track-select'),
  playlistList: $('playlist-list'),
  statusState: $('status-state'),
  statusTitle: $('status-title'),
  statusHwdec: $('status-hwdec'),
  statusError: $('status-error'),
  urlDialog: $('url-dialog'),
  urlInput: $('url-input'),
  btnUrlOpen: $('btn-url-open'),
  btnUrlCancel: $('btn-url-cancel'),
  notFoundOverlay: $('not-found-overlay'),
  notFoundMsg: $('not-found-msg'),
  notFoundInstructions: $('not-found-instructions'),
  btnRetryMpv: $('btn-retry-mpv'),
  controlsBar: $('controls-bar'),
  
  // Library DOM elements
  navWatching: $('nav-watching'),
  navLibrary: $('nav-library'),
  navManga: $('nav-manga'),
  navTv: $('nav-tv'),
  navPlayer: $('nav-player'),
  
  viewWatching: $('view-watching'),
  viewLibrary: $('view-library'),
  viewDetail: $('view-detail'),
  viewManga: $('view-manga'),
  viewTv: $('view-tv'),
  viewPlayer: $('view-player'),
  
  libraryGrid: $('library-grid'),
  watchingGrid: $('watching-grid'),
  librarySearch: $('library-search'),
  btnAddFolder: $('btn-add-folder'),
  btnResetLibrary: $('btn-reset-library'),
  btnBackToLibrary: $('btn-back-to-library'),
  
  // Detail elements
  detailHero: $('detail-hero'),
  detailPoster: $('detail-poster'),
  detailTitle: $('detail-title'),
  detailType: $('detail-type'),
  detailYear: $('detail-year'),
  detailRating: $('detail-rating'),
  detailOverview: $('detail-overview'),
  detailEpisodesList: $('detail-episodes-list'),
  btnDetailPlay: $('btn-detail-play'),
  btnDetailFixMatch: $('btn-detail-fix-match'),
  btnDetailBack: $('btn-detail-back'),
  
  // Fix Match Modal
  fixMatchModal: $('fix-match-modal'),
  fixMatchSearchInput: $('fix-match-search-input'),
  fixMatchCandidatesList: $('fix-match-candidates-list'),
  btnFixMatchCancel: $('btn-fix-match-cancel'),

  // Settings (sidebar footer)
  tmdbKeyInput: $('tmdb-key-input'),
  btnSaveTmdbKey: $('btn-save-tmdb-key'),
  tmdbStatusDot: $('tmdb-status-dot'),

  // Connectivity (sidebar footer)
  connectivityDot: $('connectivity-dot'),
  connectivityHint: $('connectivity-hint'),
  btnReparse: $('btn-reparse'),

  // Flagged / needs-review
  tabFlagged: $('tab-flagged'),
  flaggedBadge: $('flagged-badge'),
};

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await loadSavedConfig();
  bindControls();
  bindKeyboard();
  bindDragDrop();
  bindMpvEvents();
  bindLibraryEvents();
  bindSettings();
  bindConnectivity();
  reportControlsHeight();
  setupFullscreenAutoHide();

  // Initial library load
  await switchView('library');
  refreshTmdbStatus();
  updateFlaggedBadge();
  updateConnectivityStatus();
}

async function updateConnectivityStatus(online) {
  if (!el.connectivityDot) return;
  if (typeof online === 'undefined') {
    try {
      const status = await api.library.getConnectivity();
      online = !!status?.online;
    } catch {
      online = null;
    }
  }
  el.connectivityDot.classList.toggle('on', online === true);
  const hint = el.connectivityHint;
  if (!hint) return;
  if (online === true) {
    hint.textContent = 'Online — matching uses live metadata (TMDB/AniList/Jikan).';
  } else if (online === false) {
    hint.textContent = 'Offline — scans use filename grouping; reparse auto-runs when back online.';
  } else {
    hint.textContent = 'Could not determine network status.';
  }
}

function bindConnectivity() {
  // Manual "Refresh metadata" button (e.g. after the auto-reparse missed a row)
  el.btnReparse?.addEventListener('click', async () => {
    const btn = el.btnReparse;
    if (!btn) return;
    const original = btn.textContent;
    btn.textContent = '↻ Reparsing…';
    btn.disabled = true;
    try {
      const result = await api.library.reparse();
      if (result?.errors?.length) {
        console.warn('[renderer] Reparse completed with errors:', result.errors);
      }
      await loadLibraryGrid();
      updateFlaggedBadge();
      updateConnectivityStatus();
    } catch (err) {
      console.error('[renderer] Reparse failed:', err);
    } finally {
      btn.textContent = original;
      btn.disabled = false;
    }
  });

  // Push events from the main process (auto-reparse after reconnect).
  api.on('library:connectivity-changed', ({ online } = {}) => {
    updateConnectivityStatus(online === true);
  });
}

async function updateFlaggedBadge() {
  try {
    const flagged = await api.library.getFlagged();
    const count = flagged.length;
    if (el.tabFlagged) el.tabFlagged.style.display = count > 0 ? '' : 'none';
    if (el.flaggedBadge) el.flaggedBadge.textContent = count;
  } catch {
    /* non-fatal in builds without the bridge */
  }
}

async function refreshTmdbStatus() {
  try {
    const { connected } = await api.library.getTmdbStatus();
    el.tmdbStatusDot?.classList.toggle('on', !!connected);
    if (el.tmdbKeyInput && connected) el.tmdbKeyInput.placeholder = 'Key saved ✓ — paste to replace…';
  } catch {
    /* settings bridge unavailable — non-fatal */
  }
}

function bindSettings() {
  el.btnSaveTmdbKey?.addEventListener('click', async () => {
    const key = (el.tmdbKeyInput?.value || '').trim();
    if (!key) return;
    try {
      const { connected } = await api.library.setTmdbKey(key);
      el.tmdbStatusDot?.classList.toggle('on', !!connected);
      if (connected && el.tmdbKeyInput) {
        el.tmdbKeyInput.value = '';
        el.tmdbKeyInput.placeholder = 'Key saved ✓ — paste to replace…';
      }
    } catch (err) {
      console.error('Failed to save TMDB key:', err);
    }
  });
  el.tmdbKeyInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.btnSaveTmdbKey?.click();
  });
}

async function loadSavedConfig() {
  const volume = await api.getConfig('volume') ?? 100;
  const muted = await api.getConfig('mute') ?? false;
  state.volume = volume;
  state.muted = muted;
  if (el.volumeSlider) el.volumeSlider.value = volume;
  updateVolumeDisplay();
  updateMuteButton();
}

function applyConfigToMpv() {
  api.setProperty('volume', state.volume).catch(() => {});
  api.setProperty('mute', state.muted).catch(() => {});
}

// ─── Library View Router ──────────────────────────────────────────────────────

async function switchView(targetView) {
  state.currentView = targetView;
  
  // Hide all view panels
  const views = [el.viewWatching, el.viewLibrary, el.viewDetail, el.viewManga, el.viewTv, el.viewPlayer];
  views.forEach(v => v?.classList.remove('active'));
  
  // Update navigation buttons active class
  const navBtns = [el.navWatching, el.navLibrary, el.navManga, el.navTv, el.navPlayer];
  navBtns.forEach(b => b?.classList.remove('active'));
  
  switch (targetView) {
    case 'watching':
      el.viewWatching?.classList.add('active');
      el.navWatching?.classList.add('active');
      await loadWatchingView();
      break;
      
    case 'library':
      el.viewLibrary?.classList.add('active');
      el.navLibrary?.classList.add('active');
      await loadLibraryGrid();
      break;
      
    case 'detail':
      el.viewDetail?.classList.add('active');
      break;
      
    case 'manga':
      el.viewManga?.classList.add('active');
      el.navManga?.classList.add('active');
      break;
      
    case 'tv':
      el.viewTv?.classList.add('active');
      el.navTv?.classList.add('active');
      break;
      
    case 'player':
      el.viewPlayer?.classList.add('active');
      el.navPlayer?.classList.add('active');
      break;
  }

  // Controls bar now lives inside the player view — re-measure so the
  // main process positions the mpv window correctly (0 in library views).
  requestAnimationFrame(() => measureControlsHeight());
}

// ─── Library Operations ───────────────────────────────────────────────────────

async function loadLibraryGrid() {
  if (!el.libraryGrid) return;

  let titles;
  if (state.currentFilter === 'flagged') {
    titles = await api.library.getFlagged();
  } else {
    titles = await api.library.getTitles(state.currentFilter === 'all' ? null : state.currentFilter);
  }

  const query = state.searchQuery.toLowerCase().trim();
  const filtered = query
    ? titles.filter(t => t.title.toLowerCase().includes(query))
    : titles;
    
  el.libraryGrid.innerHTML = '';
  
  if (filtered.length === 0) {
    const emptyMsg = state.currentFilter === 'flagged'
      ? 'No titles need review. Nice!'
      : 'No titles found in library. Click "Add Folder" to scan local video files.';
    el.libraryGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: #71717a; padding: 40px;">${emptyMsg}</div>`;
    return;
  }
  
  for (const item of filtered) {
    const card = document.createElement('div');
    const isFlagged = item.match_confidence === 'flagged' || item.match_confidence === 'unmatched';
    card.className = `poster-card${isFlagged ? ' flagged' : ''}`;
    const posterSrc = item.poster_url || getPlaceholderPoster(item.title);
    
    card.innerHTML = `
      <div class="poster-img-wrap">
        <img class="poster-img" src="${posterSrc}" alt="${item.title}" loading="lazy" />
        <span class="poster-badge${isFlagged ? ' flagged' : ''}">${item.type}</span>
      </div>
      <div class="poster-info">
        <div class="poster-title" title="${item.title}">${item.title}</div>
        <div class="poster-meta">${item.year || ''}</div>
      </div>
    `;
    
    card.addEventListener('click', () => openDetailView(item.id));
    el.libraryGrid.appendChild(card);
  }
}

async function loadWatchingView() {
  if (!el.watchingGrid) return;
  const items = await api.library.getRecentlyWatched(20);
  
  el.watchingGrid.innerHTML = '';
  if (items.length === 0) {
    el.watchingGrid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; color: #71717a; padding: 40px;">No recently watched items. Start playing a movie or series!</div>`;
    return;
  }
  
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'poster-card';
    const posterSrc = item.poster_url || getPlaceholderPoster(item.title || 'Media');
    const pct = (item.duration_seconds > 0) ? Math.min(100, Math.round((item.progress_seconds / item.duration_seconds) * 100)) : 0;
    
    card.innerHTML = `
      <div class="poster-img-wrap">
        <img class="poster-img" src="${posterSrc}" alt="${item.title}" loading="lazy" />
        <span class="poster-badge">${item.type || 'video'}</span>
      </div>
      <div class="card-progress-bar">
        <div class="card-progress-fill" style="width: ${pct}%;"></div>
      </div>
      <div class="poster-info">
        <div class="poster-title" title="${item.title || item.file_path}">${item.title || item.file_path}</div>
        <div class="poster-meta">${item.completed ? 'Completed' : `${pct}% watched`}</div>
      </div>
    `;
    
    card.addEventListener('click', async () => {
      await playVideoFile(item.file_path);
    });
    el.watchingGrid.appendChild(card);
  }
}

async function openDetailView(titleId) {
  state.activeTitleId = titleId;
  const detail = await api.library.getTitleDetail(titleId);
  if (!detail || !detail.title) return;
  
  const t = detail.title;
  el.detailTitle.textContent = t.title;
  el.detailType.textContent = t.type.toUpperCase();
  el.detailYear.textContent = t.year || '';
  el.detailRating.textContent = t.rating ? `⭐ ${t.rating}` : '';
  el.detailOverview.textContent = t.overview || 'No description available.';
  el.detailPoster.src = t.poster_url || getPlaceholderPoster(t.title);
  
  if (t.backdrop_url) {
    el.detailHero.style.backgroundImage = `url('${t.backdrop_url}')`;
  } else {
    el.detailHero.style.backgroundImage = 'none';
  }
  
  // Render episode / file list
  el.detailEpisodesList.innerHTML = '';
  const listItems = detail.files.length > 0 ? detail.files : detail.episodes;
  
  if (listItems.length === 0) {
    el.detailEpisodesList.innerHTML = `<div style="color: #71717a;">No files associated with this title.</div>`;
  } else {
    for (const f of detail.files) {
      const epRow = document.createElement('div');
      epRow.className = 'episode-item';
      const epLabel = (f.season_number && f.episode_number)
        ? `Season ${f.season_number} Episode ${f.episode_number}`
        : (f.file_path.split(/[\\/]/).pop());
        
      epRow.innerHTML = `
        <span class="episode-name">${epLabel}</span>
        <button class="btn-primary" style="padding: 3px 8px; font-size: 11px;">▶ Play</button>
      `;
      
      epRow.querySelector('button').addEventListener('click', async () => {
        await playVideoFile(f.file_path);
      });
      el.detailEpisodesList.appendChild(epRow);
    }
  }
  
  await switchView('detail');

  // Auto-prompt the fix-match modal for flagged / unmatched titles.
  if (t.match_confidence === 'flagged' || t.match_confidence === 'unmatched') {
    setTimeout(() => openFixMatchModal(), 150);
  }
}

async function playVideoFile(filePath) {
  await switchView('player');
  await api.openFile(filePath).catch(err => console.error('Play error:', err));
}

function getPlaceholderPoster(title) {
  const enc = encodeURIComponent(title || 'Media');
  return `https://placehold.co/400x600/18181b/ffffff?text=${enc}`;
}

// ─── Fix Match Modal Logic ────────────────────────────────────────────────────

function openFixMatchModal() {
  if (!state.activeTitleId) return;
  el.fixMatchSearchInput.value = el.detailTitle.textContent || '';
  el.fixMatchCandidatesList.innerHTML = '';
  el.fixMatchModal.classList.add('visible');
  performFixMatchSearch();
}

function closeFixMatchModal() {
  el.fixMatchModal.classList.remove('visible');
}

async function performFixMatchSearch() {
  const q = el.fixMatchSearchInput.value.trim();
  if (!q) return;
  el.fixMatchCandidatesList.innerHTML = '<div style="color: #a1a1aa; padding: 12px;">Searching metadata...</div>';
  
  const typeHint = el.detailType.textContent.toLowerCase() || 'movie';
  const candidates = await api.library.searchMetadata(q, typeHint);
  
  el.fixMatchCandidatesList.innerHTML = '';
  if (candidates.length === 0) {
    el.fixMatchCandidatesList.innerHTML = '<div style="color: #71717a; padding: 12px;">No metadata candidates found.</div>';
    return;
  }
  
  for (const c of candidates) {
    const item = document.createElement('div');
    item.className = 'candidate-item';
    const poster = c.poster_url || getPlaceholderPoster(c.title);
    
    item.innerHTML = `
      <img class="candidate-img" src="${poster}" alt="${c.title}" />
      <div class="candidate-info">
        <div style="font-weight: 600; color: #f4f4f5;">${c.title}</div>
        <div style="font-size: 11px; color: #71717a;">${c.year || ''} • ${c.type}</div>
      </div>
      <button class="btn-primary" style="padding: 4px 8px; font-size: 11px;">Select Match</button>
    `;
    
    item.querySelector('button').addEventListener('click', async () => {
      await api.library.fixMatch(state.activeTitleId, c);
      closeFixMatchModal();
      await openDetailView(state.activeTitleId);
      updateFlaggedBadge();
    });
    
    el.fixMatchCandidatesList.appendChild(item);
  }
}

// ─── Batch Series Review (grouped confirmation) ──────────────────────────────

/**
 * Ask the user to resolve several uncertain files AT ONCE (as a group) rather
 * than one file-by-file modal. Every row offers the existing series the file
 * might belong to, plus an explicit "create new series" escape hatch.
 *
 * The confirmations returned here feed the scanner's training memory, so the
 * same mapping is automatically applied to similar remaining files.
 *
 * @param {Array<{filePath:string, parsedTitle:string, currentTitleId:?number,
 *   candidates:Array<{titleId:number,title:string,score:number}>, ambiguous:boolean}>} items
 * @returns {Promise<{matches:Array, cancelled:boolean}>}
 *   matches entries: { filePath, titleId } | { filePath, createNew:{title} }
 */
function promptBatchSeriesReview(items) {
  return new Promise((resolve) => {
    const rowState = new Map(); // filePath -> createNew title (if selected)
    const rowSelects = [];      // parallel to `items`

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: fixed; inset: 0; background: rgba(0,0,0,0.65); z-index: 9999;
      display: flex; align-items: center; justify-content: center;
    `;
    const box = document.createElement('div');
    box.style.cssText = `
      background: #18181b; border: 1px solid #27272a; border-radius: 12px;
      width: min(680px, 94vw); max-height: 84vh; display: flex; flex-direction: column;
      color: #f4f4f5; font-family: inherit;
    `;

    const header = document.createElement('div');
    header.style.cssText = 'padding: 18px 20px 6px 20px;';
    header.innerHTML = `
      <div style="font-weight: 700; font-size: 15px;">Confirm ${items.length} file(s) as a group</div>
      <div style="font-size: 12px; color: #a1a1aa; margin-top: 4px; line-height: 1.4;">
        Pick the right series for each. Your choice is applied to similar files in
        this scan automatically — pick a series once and the rest group together.
      </div>
    `;
    box.appendChild(header);

    const list = document.createElement('div');
    list.style.cssText = 'flex: 1; overflow: auto; padding: 12px 20px; display: flex; flex-direction: column; gap: 10px;';
    box.appendChild(list);

    const currentTitleName = (item) => {
      const c = (item.candidates || []).find((x) => x.titleId === item.currentTitleId);
      return c ? c.title : (item.currentTitleId != null ? `Series #${item.currentTitleId}` : null);
    };

    for (const item of items) {
      const row = document.createElement('div');
      row.style.cssText = 'background: #1f1f23; border: 1px solid #27272a; border-radius: 8px; padding: 10px 12px;';

      const label = document.createElement('div');
      const fileName = (item.filePath || '').split(/[\\/]/).pop();
      label.style.cssText = 'font-size: 12px; color: #e4e4e7; margin-bottom: 6px; word-break: break-all;';
      label.textContent = (item.parsedTitle || fileName) + (item.ambiguous ? ' • watch for a duplicate' : ' • no series yet');
      row.appendChild(label);

      const select = document.createElement('select');
      select.style.cssText = 'width: 100%; background: #27272a; color: #f4f4f5; border: 1px solid #3f3f46; border-radius: 6px; padding: 6px 8px; font-size: 12px;';

      const currentTitle = currentTitleName(item);
      const keepLabel = item.currentTitleId != null
        ? (currentTitle ? `Keep → ${currentTitle}` : `Keep → Series #${item.currentTitleId}`)
        : 'Leave unmatched for now';
      const keep = document.createElement('option');
      keep.value = '';
      keep.textContent = keepLabel;
      select.appendChild(keep);

      const offered = new Set();
      for (const c of item.candidates || []) {
        if (!c || c.titleId == null || offered.has(c.titleId)) continue;
        offered.add(c.titleId);
        if (item.currentTitleId != null && c.titleId === item.currentTitleId) continue; // keep option covers it
        const opt = document.createElement('option');
        opt.value = `id:${c.titleId}`;
        opt.textContent = `${c.title} (${Math.round((c.score || 0) * 100)}%)`;
        select.appendChild(opt);
      }

      const createNew = document.createElement('option');
      createNew.value = '__new__';
      createNew.textContent = '＋ Create new series…';
      select.appendChild(createNew);

      const note = document.createElement('div');
      note.style.cssText = 'font-size: 11px; color: #818cf8; margin-top: 5px; display: none;';

      select.addEventListener('change', () => {
        if (select.value === '__new__') {
          const name = window.prompt('Name of the new series:', item.parsedTitle || fileName || '');
          if (name && name.trim()) {
            rowState.set(item.filePath, name.trim());
            note.textContent = `Will be created as: ${name.trim()}`;
            note.style.display = 'block';
          } else {
            rowState.delete(item.filePath);
            select.value = '';
            note.style.display = 'none';
          }
        } else {
          rowState.delete(item.filePath);
          note.style.display = 'none';
        }
      });
      row.appendChild(select);
      row.appendChild(note);
      list.appendChild(row);
      rowSelects.push({ filePath: item.filePath, select });
    }

    const footer = document.createElement('div');
    footer.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid #27272a;';

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background: none; color: #a1a1aa; border: 1px solid #3f3f46; border-radius: 8px; padding: 8px 14px; font-size: 12px; cursor: pointer;';
    const apply = document.createElement('button');
    apply.textContent = 'Apply matches';
    apply.style.cssText = 'background: #6366f1; color: #fff; border: none; border-radius: 8px; padding: 8px 16px; font-size: 12px; font-weight: 600; cursor: pointer;';

    const close = (matches) => { document.body.removeChild(overlay); resolve({ matches, cancelled: matches === null }); };

    cancel.addEventListener('click', () => close(null));
    apply.addEventListener('click', () => {
      const matches = [];
      for (const { filePath, select } of rowSelects) {
        if (select.value.startsWith('id:')) {
          matches.push({ filePath, titleId: Number(select.value.slice(3)) });
        } else if (select.value === '__new__') {
          const name = rowState.get(filePath);
          if (name) matches.push({ filePath, createNew: { title: name } });
        }
      }
      close(matches);
    });
    footer.appendChild(cancel);
    footer.appendChild(apply);
    box.appendChild(footer);

    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

// ─── Event Binding ───────────────────────────────────────────────────────────

function bindLibraryEvents() {
  // Navigation sidebar buttons
  el.navWatching?.addEventListener('click', () => switchView('watching'));
  el.navLibrary?.addEventListener('click', () => switchView('library'));
  el.navManga?.addEventListener('click', () => switchView('manga'));
  el.navTv?.addEventListener('click', () => switchView('tv'));
  el.navPlayer?.addEventListener('click', () => switchView('player'));
  
  // Library Search
  el.librarySearch?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    loadLibraryGrid();
  });
  
  // Filter Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      state.currentFilter = e.target.dataset.filter || 'all';
      loadLibraryGrid();
    });
  });
  
  // Add Folder button
  el.btnAddFolder?.addEventListener('click', async () => {
    const result = await api.library.selectFolderAndScan();
    if (result) {
      let msg = `Scanned ${result.scannedCount} files from folder.`;
      if (result.errors && result.errors.length) {
        msg += `\n\n${result.errors.length} file(s) had errors:\n` +
          result.errors.slice(0, 5).map(e => `  • ${e.file}: ${e.error}`).join('\n');
      }
      alert(msg);

      // Collect everything uncertain into one grouped review — ambiguous
      // near-tie matches AND files with too-weak evidence. Ask as a group
      // instead of file-by-file; each confirmation trains the scanner so the
      // same mapping auto-applies to similar remaining files.
      let uncertain = [
        ...(result.ambiguous || []),
        ...(result.unresolved || []),
      ];

      let round = 0;
      while (uncertain.length && round < 5) {
        const { matches, cancelled } = await promptBatchSeriesReview(uncertain);
        if (cancelled || !matches || matches.length === 0) break;

        const after = await api.library.applyBatchMatches(matches, uncertain.map((i) => i.filePath));
        if (!after) break;
        if (!after.stillUnresolved || after.stillUnresolved.length === 0) break;

        // No progress (every remaining file left as-is) → give up this round.
        if (after.stillUnresolved.length >= uncertain.length) break;
        uncertain = after.stillUnresolved;
        round++;
      }

      await loadLibraryGrid();
      updateFlaggedBadge();
    }
  });

  // Reset Library button (sidebar footer) — clears folders + fetched details
  el.btnResetLibrary?.addEventListener('click', async () => {
    if (!confirm('Reset library? This clears all added folders and fetched metadata.')) return;
    await api.library.resetLibrary();
    state.activeTitleId = null;
    state.searchQuery = '';
    if (el.librarySearch) el.librarySearch.value = '';
    await switchView('library');
    updateFlaggedBadge();
  });
  
  // Detail buttons
  el.btnDetailBack?.addEventListener('click', () => switchView('library'));
  el.btnBackToLibrary?.addEventListener('click', () => switchView('library'));
  el.btnDetailFixMatch?.addEventListener('click', openFixMatchModal);
  el.btnFixMatchCancel?.addEventListener('click', closeFixMatchModal);
  
  el.fixMatchSearchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') performFixMatchSearch();
  });
}

// ─── Existing Player Controls Wiring ──────────────────────────────────────────

function bindControls() {
  el.btnPlayPause?.addEventListener('click', () => { if (state.mpvReady) togglePlayPause(); });
  el.btnStop?.addEventListener('click', () => { if (state.mpvReady) stop(); });
  el.btnPrev?.addEventListener('click', () => { if (state.mpvReady) api.playPrev(); });
  el.btnNext?.addEventListener('click', () => { if (state.mpvReady) api.playNext(); });
  el.btnMute?.addEventListener('click', () => { if (state.mpvReady) setMute(!state.muted, true); });
  el.btnFullscreen?.addEventListener('click', () => { if (state.mpvReady) toggleFullscreen(); });

  const videoArea = $('video-area');
  if (videoArea) {
    let clickTimeout = null;
    videoArea.addEventListener('click', () => {
      if (clickTimeout) clearTimeout(clickTimeout);
      clickTimeout = setTimeout(() => {
        clickTimeout = null;
        if (state.mpvReady) togglePlayPause();
      }, 220);
    });
    videoArea.addEventListener('dblclick', () => {
      if (clickTimeout) {
        clearTimeout(clickTimeout);
        clickTimeout = null;
      }
      if (state.mpvReady) toggleFullscreen();
    });
  }

  el.volumeSlider?.addEventListener('input', (e) => setVolume(Number(e.target.value), true));
  el.speedSelect?.addEventListener('change', (e) => {
    if (!state.mpvReady) return;
    const spd = parseFloat(e.target.value);
    state.speed = spd;
    api.setProperty('speed', spd).catch(() => {});
  });

  el.seekBar?.addEventListener('mousedown', () => { if (state.mpvReady) state.seeking = true; });
  el.seekBar?.addEventListener('input', () => {
    if (state.duration > 0) {
      const t = (el.seekBar.value / 1000) * state.duration;
      el.timeDisplay.textContent = `${formatTime(t)} / ${formatTime(state.duration)}`;
    }
  });
  el.seekBar?.addEventListener('mouseup', async () => {
    state.seeking = false;
    if (state.mpvReady && state.duration > 0) {
      const t = (el.seekBar.value / 1000) * state.duration;
      await api.seekAbsolute(t).catch(() => {});
    }
  });

  el.btnOpenFile?.addEventListener('click', async () => {
    if (!state.mpvReady) return;
    const files = await api.openFileDialog();
    if (files.length === 1) {
      await playVideoFile(files[0]);
    } else if (files.length > 1) {
      await switchView('player');
      await api.addFiles(files).catch(() => {});
    }
  });

  el.btnAddFiles?.addEventListener('click', async () => {
    if (!state.mpvReady) return;
    const files = await api.openFileDialog();
    if (files.length > 0) await api.addFiles(files).catch(() => {});
  });

  el.btnOpenUrl?.addEventListener('click', () => { if (state.mpvReady) showUrlDialog(); });
  el.btnUrlOpen?.addEventListener('click', () => { if (state.mpvReady) openURL(); });
  el.btnUrlCancel?.addEventListener('click', hideUrlDialog);

  el.btnOpenSub?.addEventListener('click', async () => {
    if (!state.mpvReady) return;
    const file = await api.openSubtitleDialog();
    if (file) await api.loadExternalSubtitle(file).catch(() => {});
  });

  el.audioTrackSelect?.addEventListener('change', (e) => {
    if (state.mpvReady) api.selectAudioTrack(Number(e.target.value)).catch(() => {});
  });
  el.subTrackSelect?.addEventListener('change', (e) => {
    if (state.mpvReady) {
      const val = e.target.value;
      api.selectSubTrack(val === 'off' ? 'off' : Number(val)).catch(() => {});
    }
  });
}

function bindKeyboard() {
  document.addEventListener('keydown', async (e) => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (!state.mpvReady) return;

    switch (e.key) {
      case ' ': e.preventDefault(); togglePlayPause(); break;
      case 'ArrowRight':
        e.preventDefault();
        await api.seek(e.ctrlKey ? 30 : 5).catch(() => {});
        break;
      case 'ArrowLeft':
        e.preventDefault();
        await api.seek(e.ctrlKey ? -30 : -5).catch(() => {});
        break;
      case 'ArrowUp': e.preventDefault(); setVolume(Math.min(200, state.volume + 5), true); break;
      case 'ArrowDown': e.preventDefault(); setVolume(Math.max(0, state.volume - 5), true); break;
      case 'f': case 'F': e.preventDefault(); toggleFullscreen(); break;
      case 'm': case 'M': e.preventDefault(); setMute(!state.muted, true); break;
      case 'Escape':
        if (el.urlDialog?.classList.contains('visible')) hideUrlDialog();
        else if (el.fixMatchModal?.classList.contains('visible')) closeFixMatchModal();
        else if (state.fullscreen) toggleFullscreen();
        break;
    }
  });
}

function bindDragDrop() {
  document.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).map(f => f.path);
    if (!files.length) return;

    const subtitleExts = new Set(['.srt', '.ass', '.ssa', '.vtt', '.sub', '.idx']);
    const subs = files.filter(f => subtitleExts.has(getExt(f)));
    const videos = files.filter(f => !subtitleExts.has(getExt(f)));

    for (const sub of subs) await api.loadExternalSubtitle(sub);
    if (videos.length === 1) await playVideoFile(videos[0]);
    else if (videos.length > 1) {
      await switchView('player');
      await api.addFiles(videos);
    }
  });
}

function bindMpvEvents() {
  api.on('mpv:property-change', ({ name, data }) => {
    switch (name) {
      case 'ready':
        state.mpvReady = true;
        applyConfigToMpv();
        break;
      case 'pause':
        state.playing = !data;
        if (el.btnPlayPause) el.btnPlayPause.textContent = data ? '▶' : '⏸';
        setStatus(data ? 'Paused' : 'Playing');
        break;
      case 'playback-time':
        if (!state.seeking && typeof data === 'number') {
          state.currentTime = data;
          updateSeekBar();
          updateTimeDisplay();
        }
        break;
      case 'duration':
        if (typeof data === 'number') {
          state.duration = data;
          updateTimeDisplay();
        }
        break;
      case 'volume':
        if (typeof data === 'number') {
          state.volume = data;
          if (el.volumeSlider) el.volumeSlider.value = data;
          updateVolumeDisplay();
          updateMuteButton();
        }
        break;
    }
  });

  api.on('mpv:tracks-changed', (tracks) => {
    state.tracks = tracks;
    rebuildAudioTrackSelect(tracks.audio);
    rebuildSubTrackSelect(tracks.sub);
  });

  api.on('mpv:start-file', () => {
    setStatus('Playing');
    state.playing = true;
    if (el.btnPlayPause) el.btnPlayPause.textContent = '⏸';
  });

  api.on('mpv:end-file', ({ reason, error }) => {
    if (reason === 'error' && error) showError(error);
    if (reason !== 'eof') {
      state.playing = false;
      if (el.btnPlayPause) el.btnPlayPause.textContent = '▶';
    }
  });

  api.on('mpv:idle', () => {
    setStatus('Idle');
    state.playing = false;
    if (el.btnPlayPause) el.btnPlayPause.textContent = '▶';
  });

  api.on('mpv:playlist-changed', (playlistState) => {
    state.playlist = playlistState;
    rebuildPlaylistUI(playlistState);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function togglePlayPause() {
  if (!state.mpvReady) return;
  api.command('cycle', 'pause').catch(() => {});
}

function stop() {
  if (!state.mpvReady) return;
  api.command('stop').catch(() => {});
  state.playing = false;
  if (el.btnPlayPause) el.btnPlayPause.textContent = '▶';
  setStatus('Idle');
}

function setVolume(vol, persist = false) {
  vol = Math.max(0, Math.min(200, vol));
  state.volume = vol;
  if (el.volumeSlider) el.volumeSlider.value = vol;
  if (state.mpvReady) api.setProperty('volume', vol).catch(() => {});
  updateVolumeDisplay();
  updateMuteButton();
  if (persist) api.setConfig('volume', vol);
}

function setMute(muted, persist = false) {
  state.muted = muted;
  if (state.mpvReady) api.setProperty('mute', muted).catch(() => {});
  updateMuteButton();
  if (persist) api.setConfig('mute', muted);
}

function setupFullscreenAutoHide() {
  document.addEventListener('mousemove', (e) => {
    if (!state.fullscreen) return;
    if (e.clientY >= window.innerHeight - 80) showFullscreenControls();
    else hideFullscreenControls();
  });
}

function showFullscreenControls() {
  document.body.classList.add('is-fullscreen');
  el.controlsBar?.classList.remove('hidden');
  if (typeof api.setControlsHidden === 'function') api.setControlsHidden(false);
}

function hideFullscreenControls() {
  if (!state.fullscreen) return;
  document.body.classList.add('is-fullscreen');
  el.controlsBar?.classList.add('hidden');
  if (typeof api.setControlsHidden === 'function') api.setControlsHidden(true);
}

async function toggleFullscreen() {
  const next = !state.fullscreen;
  await api.setFullscreen(next).catch(() => {});
  applyFullscreenUI(next);
}

function applyFullscreenUI(isFullscreen) {
  state.fullscreen = isFullscreen;
  if (el.btnFullscreen) {
    el.btnFullscreen.textContent = isFullscreen ? '⛶↩' : '⛶';
  }
  if (!isFullscreen) {
    document.body.classList.remove('is-fullscreen');
    el.controlsBar?.classList.remove('hidden');
    if (typeof api.setControlsHidden === 'function') api.setControlsHidden(false);
  }
}

function showUrlDialog() { el.urlDialog?.classList.add('visible'); el.urlInput?.focus(); }
function hideUrlDialog() { el.urlDialog?.classList.remove('visible'); if (el.urlInput) el.urlInput.value = ''; }
async function openURL() {
  if (!state.mpvReady) return;
  const url = el.urlInput?.value.trim();
  if (!url) return;
  hideUrlDialog();
  await switchView('player');
  await api.openURL(url).catch(() => {});
}

function updateSeekBar() {
  if (!state.seeking && state.duration > 0 && el.seekBar) {
    el.seekBar.value = Math.round((state.currentTime / state.duration) * 1000);
  }
}

function updateTimeDisplay() {
  if (el.timeDisplay) {
    el.timeDisplay.textContent = `${formatTime(state.currentTime)} / ${formatTime(state.duration)}`;
  }
}

function updateMuteButton() {
  if (!el.btnMute) return;
  if (state.muted || state.volume === 0) el.btnMute.textContent = '🔇';
  else if (state.volume < 100) el.btnMute.textContent = '🔉';
  else el.btnMute.textContent = '🔊';
}

function updateVolumeDisplay() {
  if (el.volumeDisplay) el.volumeDisplay.textContent = `${Math.round(state.volume)}%`;
}

function setStatus(s) {
  state.status = s;
  if (el.statusState) el.statusState.textContent = s;
}

function showError(msg) {
  state.errorMsg = msg;
  if (el.statusError) el.statusError.textContent = `⚠ ${msg}`;
  setStatus('Error');
}

function rebuildAudioTrackSelect(tracks) {
  if (!el.audioTrackSelect) return;
  el.audioTrackSelect.innerHTML = '';
  for (const t of tracks) {
    const opt = new Option(t.label, String(t.id));
    opt.selected = t.selected;
    el.audioTrackSelect.appendChild(opt);
  }
}

function rebuildSubTrackSelect(tracks) {
  if (!el.subTrackSelect) return;
  el.subTrackSelect.innerHTML = '';
  el.subTrackSelect.appendChild(new Option('Off', 'off'));
  for (const t of tracks) {
    const opt = new Option(t.label, String(t.id));
    opt.selected = t.selected;
    el.subTrackSelect.appendChild(opt);
  }
}

function rebuildPlaylistUI({ items, currentIndex }) {
  if (!el.playlistList) return;
  el.playlistList.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    if (item.index === currentIndex) li.style.fontWeight = 'bold';
    li.textContent = item.title;
    li.addEventListener('click', () => api.playIndex(item.index));
    el.playlistList.appendChild(li);
  }
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function getExt(filePath) {
  const i = filePath.lastIndexOf('.');
  return i >= 0 ? filePath.slice(i).toLowerCase() : '';
}

function measureControlsHeight() {
  // When the player view is hidden the bar has no layout box — report 0
  // so mpv fills the window instead of being offset by a stale height.
  const playerActive = el.viewPlayer?.classList.contains('active');
  const h = (playerActive && !el.controlsBar?.classList.contains('hidden'))
    ? (el.controlsBar?.getBoundingClientRect().height || 0)
    : 0;
  if (typeof api.reportControlsHeight === 'function') {
    api.reportControlsHeight(Math.ceil(h));
  }
}

function reportControlsHeight() {
  measureControlsHeight();
  window.addEventListener('resize', () => measureControlsHeight());
  setTimeout(() => measureControlsHeight(), 300);
}

// Bootstrap
init().catch(console.error);
