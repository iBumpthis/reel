/**
 * Reel — Library page
 * Browse, search, filter, edit metadata, manage tags, scan, import.
 * v1.1: sidebar browse (artists, tags, libraries), multi-column grid.
 */
import { fmtBytes, debounce, escHtml, toast } from './shared/utils.js';
import * as api from './shared/api.js';
import { installHelpOverlay } from './shared/help-overlay.js';

// ============================================================
// DOM refs
// ============================================================
const elVersion = document.getElementById('appVersion');
const elFooterVersion = document.getElementById('footerVersion');
const elSearchInput = document.getElementById('searchInput');
const elSearchClear = document.getElementById('searchClear');
const elScanBtn = document.getElementById('scanBtn');
const elScanStatus = document.getElementById('scanStatus');
const elSortField = document.getElementById('sortField');
const elSortOrder = document.getElementById('sortOrder');
const elTypeFilter = document.getElementById('typeFilter');
const elMarkerFilter = document.getElementById('markerFilter');
const elSurpriseBtn = document.getElementById('surpriseBtn');
const elActiveFilters = document.getElementById('activeFilters');
const elResultCount = document.getElementById('resultCount');
const elMediaGrid = document.getElementById('mediaGrid');
const elLoadMore = document.getElementById('loadMore');
const elLoadMoreBtn = document.getElementById('loadMoreBtn');
const elImportOverlay = document.getElementById('importOverlay');
const elImportText = document.getElementById('importText');
const elImportBtn = document.getElementById('importBtn');
const elImportStatus = document.getElementById('importStatus');
const elImportResult = document.getElementById('importResult');
const elMarkerImportOverlay = document.getElementById('markerImportOverlay');
const elMarkerImportText = document.getElementById('markerImportText');
const elMarkerImportBtn = document.getElementById('markerImportBtn');
const elMarkerImportStatus = document.getElementById('markerImportStatus');
const elMarkerImportResult = document.getElementById('markerImportResult');
const elSidebar = document.getElementById('sidebar');
const elSidebarToggle = document.getElementById('sidebarToggle');
const elSidebarLibraries = document.getElementById('sidebarLibraries');
const elSidebarArtists = document.getElementById('sidebarArtists');
const elSidebarTags = document.getElementById('sidebarTags');
const elSettingsBtn = document.getElementById('settingsBtn');
const elSettingsOverlay = document.getElementById('settingsOverlay');
// Help overlay is now a SHARED module (one source of truth across index +
// player). installHelpOverlay injects #helpOverlay and self-wires the button +
// close; we keep the returned element for the Esc handler below.
const elHelpOverlay = installHelpOverlay('helpBtn').overlay;
const elOpenMetaImportBtn = document.getElementById('openMetaImportBtn');
const elOpenMarkerImportBtn = document.getElementById('openMarkerImportBtn');
const elFullScanBtn = document.getElementById('fullScanBtn');
const elPurgeBtn = document.getElementById('purgeBtn');
const elViewMissingLink = document.getElementById('viewMissingLink');
const elMissingList = document.getElementById('missingList');

// ============================================================
// State
// ============================================================
let allTags = [];
let allArtists = [];
let allLibraries = [];
let activeTagFilter = [];
let activeLibFilter = null;
let activeArtistFilter = null;
let nextCursor = null;
let totalCount = 0;
let currentEditId = null;

// ============================================================
// Version
// ============================================================
api.getHealth().then(d => {
  const v = d.version ?? '';
  elVersion.textContent = `v${v}`;
  elFooterVersion.textContent = `v${v}`;
}).catch(() => {});

// ============================================================
// Sidebar — mobile toggle
// ============================================================
let backdropEl = null;

function openSidebar() {
  elSidebar.classList.add('open');
  if (!backdropEl) {
    backdropEl = document.createElement('div');
    backdropEl.className = 'sidebar-backdrop';
    backdropEl.addEventListener('click', closeSidebar);
  }
  document.body.appendChild(backdropEl);
}

function closeSidebar() {
  elSidebar.classList.remove('open');
  if (backdropEl && backdropEl.parentNode) {
    backdropEl.parentNode.removeChild(backdropEl);
  }
}

elSidebarToggle.addEventListener('click', () => {
  if (elSidebar.classList.contains('open')) closeSidebar();
  else openSidebar();
});

// ============================================================
// Sidebar — rendering
// ============================================================
function renderSidebarLibraries() {
  elSidebarLibraries.innerHTML = '';

  const allItem = createSidebarItem('All libraries', null, !activeLibFilter);
  allItem.addEventListener('click', () => {
    activeLibFilter = null;
    renderSidebarLibraries();
    loadLibrary();
  });
  elSidebarLibraries.appendChild(allItem);

  for (const lib of allLibraries) {
    const item = createSidebarItem(lib.name, null, activeLibFilter === lib.name);
    item.addEventListener('click', () => {
      activeLibFilter = activeLibFilter === lib.name ? null : lib.name;
      renderSidebarLibraries();
      loadLibrary();
      closeSidebar();
    });
    elSidebarLibraries.appendChild(item);
  }
}

/**
 * Keep the URL's ?artist param in sync with the active artist filter, so the
 * library is refresh-safe and shareable and the player→library deep link round-
 * trips. replaceState (not push) — sidebar toggling shouldn't spam history.
 */
function syncArtistUrl() {
  const url = new URL(location.href);
  if (activeArtistFilter) url.searchParams.set('artist', activeArtistFilter);
  else url.searchParams.delete('artist');
  history.replaceState(null, '', url);
}

function renderSidebarArtists() {
  elSidebarArtists.innerHTML = '';

  const allItem = createSidebarItem('All artists', null, !activeArtistFilter);
  allItem.addEventListener('click', () => {
    activeArtistFilter = null;
    syncArtistUrl();
    renderSidebarArtists();
    renderActiveFilters();
    loadLibrary();
  });
  elSidebarArtists.appendChild(allItem);

  for (const a of allArtists) {
    const item = createSidebarItem(a.name, a.count, activeArtistFilter === a.name, a.kind);
    item.addEventListener('click', () => {
      activeArtistFilter = activeArtistFilter === a.name ? null : a.name;
      syncArtistUrl();
      renderSidebarArtists();
      renderActiveFilters();
      loadLibrary();
      closeSidebar();
    });
    elSidebarArtists.appendChild(item);
  }
}

function renderSidebarTags() {
  elSidebarTags.innerHTML = '';

  for (const t of allTags) {
    const pill = document.createElement('span');
    const isActive = activeTagFilter.includes(t.name.toLowerCase());
    pill.className = `sidebar-tag${isActive ? ' active' : ''}`;
    pill.innerHTML = `${escHtml(t.name)} <span class="sidebar-tag-count">${t.count}</span>`;
    pill.addEventListener('click', () => {
      const norm = t.name.toLowerCase();
      if (activeTagFilter.includes(norm)) {
        activeTagFilter = activeTagFilter.filter(x => x !== norm);
      } else {
        activeTagFilter.push(norm);
      }
      renderSidebarTags();
      renderActiveFilters();
      loadLibrary();
      closeSidebar();
    });
    elSidebarTags.appendChild(pill);
  }
}

function createSidebarItem(name, count, active, kind) {
  const el = document.createElement('div');
  el.className = `sidebar-item${active ? ' active' : ''}`;
  // C2 — act badge: a promoted "[ALIAS]" collective (kind='act') reads
  // differently from a person in the artist sidebar. Additive; artists render
  // unchanged (kind undefined on older payloads => no badge).
  const badge = kind === 'act'
    ? ` <span class="sidebar-item-badge" title="Group / act alias">act</span>`
    : '';
  el.innerHTML = `
    <span class="sidebar-item-name">${escHtml(name)}${badge}</span>
    ${count != null ? `<span class="sidebar-item-count">${count}</span>` : ''}`;
  return el;
}

// ============================================================
// Active filter chips (above grid)
// ============================================================
function renderActiveFilters() {
  elActiveFilters.innerHTML = '';

  if (activeLibFilter) {
    elActiveFilters.appendChild(createFilterChip('Library', activeLibFilter, () => {
      activeLibFilter = null;
      renderSidebarLibraries();
      renderActiveFilters();
      loadLibrary();
    }));
  }

  if (activeArtistFilter) {
    elActiveFilters.appendChild(createFilterChip('Artist', activeArtistFilter, () => {
      activeArtistFilter = null;
      syncArtistUrl();
      renderSidebarArtists();
      renderActiveFilters();
      loadLibrary();
    }));
  }

  for (const tag of activeTagFilter) {
    elActiveFilters.appendChild(createFilterChip('Tag', tag, () => {
      activeTagFilter = activeTagFilter.filter(t => t !== tag);
      renderSidebarTags();
      renderActiveFilters();
      loadLibrary();
    }));
  }
}

function createFilterChip(label, value, onRemove) {
  const chip = document.createElement('span');
  chip.className = 'filter-chip';
  chip.innerHTML = `<span class="filter-chip-label">${escHtml(label)}</span>${escHtml(value)} <span class="filter-chip-remove">×</span>`;
  chip.querySelector('.filter-chip-remove').addEventListener('click', onRemove);
  return chip;
}

// ============================================================
// Library loading
// ============================================================
function getFilterParams() {
  const params = {};
  const q = elSearchInput.value.trim();
  const sort = elSortField.value;
  const order = elSortOrder.value;
  const type = elTypeFilter.value;     // '' | 'audio' | 'video'
  const markers = elMarkerFilter.value; // '' | 'has' | 'none'

  if (activeLibFilter) params.lib = activeLibFilter;
  if (activeArtistFilter) params.artist = activeArtistFilter;
  if (q) params.q = q;
  if (sort) params.sort = sort;
  if (order) params.order = order;
  if (type) params.type = type;
  if (markers) params.markers = markers;
  if (activeTagFilter.length > 0) params.tag = activeTagFilter.join(',');

  return params;
}

async function loadLibrary(append = false) {
  const params = getFilterParams();
  if (append && nextCursor) {
    params.cursor = nextCursor;
  }

  try {
    const data = await api.getLibrary(params);

    // Store libraries (for sidebar, only update if we haven't loaded artists yet)
    if (data.libraries && allLibraries.length === 0) {
      allLibraries = data.libraries;
      renderSidebarLibraries();
    }

    nextCursor = data.nextCursor;
    totalCount = data.totalCount;

    if (!append) {
      elMediaGrid.innerHTML = '';
      // Keep the active-filter chips in sync with the loaded state on every
      // fresh load — not just the in-session click handlers that call this
      // explicitly. Without it, a deep-link entry (?artist=…) applies the
      // filter but renders no chip, leaving no in-context way to clear it.
      renderActiveFilters();
    }

    if (data.items.length === 0 && !append) {
      renderEmpty();
    } else {
      for (const item of data.items) {
        elMediaGrid.appendChild(renderCard(item));
      }
    }

    elResultCount.textContent = `${totalCount} item${totalCount !== 1 ? 's' : ''}`;
    elLoadMore.classList.toggle('hidden', !nextCursor);

  } catch (err) {
    toast(`Load failed: ${err.message}`, 'error');
  }
}

function renderEmpty() {
  elMediaGrid.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-title">No media found</div>
      <div class="empty-state-hint">
        Try adjusting your filters, or hit <strong>Scan</strong> to discover new files.
      </div>
    </div>`;
}

// ============================================================
// Media card rendering
// ============================================================
const MARKER_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/><circle cx="12" cy="9" r="2.5"/></svg>`;

function renderCard(item) {
  const card = document.createElement('div');
  card.className = 'media-card';
  card.dataset.id = item.id;

  const displayTitle = item.title || item.filename;
  const yearDisplay = item.year ? `<span class="card-year">${escHtml(String(item.year))}</span>` : '';

  const artistHtml = item.artist
    ? `<div class="card-artist">${escHtml(item.artist)}</div>`
    : '';

  const albumHtml = item.album
    ? `<div class="card-album">${escHtml(item.album)}</div>`
    : '';

  // Tags as inline pills
  let tagsHtml = '';
  if (item.tags && item.tags.length > 0) {
    tagsHtml = `<div class="card-tags">${
      item.tags.map(t => `<span class="tag-pill tag-pill-clickable" data-tag="${escHtml(t)}">${escHtml(t)}</span>`).join('')
    }</div>`;
  }

  // Marker count
  const markerHtml = item.markerCount > 0
    ? `<span class="card-marker-count">${MARKER_ICON}${item.markerCount}</span>`
    : '';

  card.innerHTML = `
    <div class="card-main">
      <div class="card-body">
        <div class="card-title-row">
          <a class="card-title" href="/player.html?id=${encodeURIComponent(item.id)}">${escHtml(displayTitle)}</a>
          ${yearDisplay}
        </div>
        ${artistHtml}
        ${albumHtml}
        <div class="card-info-row">
          <div class="card-meta">
            <span class="badge badge-${item.mediaType}">${item.mediaType}</span>
            <span class="card-meta-sep"></span>
            <span>${item.ext.toUpperCase()}</span>
            <span class="card-meta-sep"></span>
            <span>${fmtBytes(item.sizeBytes)}</span>
            ${markerHtml ? `<span class="card-meta-sep"></span>${markerHtml}` : ''}
          </div>
          ${tagsHtml}
        </div>
      </div>
      <div class="card-actions">
        <button class="btn-sm btn-icon" title="Edit metadata" data-edit="${item.id}">✎</button>
      </div>
    </div>`;

  // Tag click → filter by tag
  card.querySelectorAll('.tag-pill-clickable').forEach(pill => {
    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const tag = pill.dataset.tag;
      if (!activeTagFilter.includes(tag.toLowerCase())) {
        activeTagFilter.push(tag.toLowerCase());
        renderSidebarTags();
        renderActiveFilters();
        loadLibrary();
      }
    });
  });

  // Edit button
  const editBtn = card.querySelector('[data-edit]');
  if (editBtn) {
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleEdit(card, item);
    });
  }

  return card;
}

// ============================================================
// Inline metadata editing
// ============================================================
function toggleEdit(card, item) {
  const existing = document.querySelector('.edit-form');
  if (existing) {
    existing.closest('.media-card')?.classList.remove('editing');
    existing.remove();
    if (currentEditId === item.id) {
      currentEditId = null;
      return;
    }
  }
  currentEditId = item.id;
  card.classList.add('editing');

  const form = document.createElement('div');
  form.className = 'edit-form';

  const itemTags = Array.isArray(item.tags) ? [...item.tags] : [];

  form.innerHTML = `
    <div class="edit-field">
      <label class="edit-label">Title</label>
      <input type="text" id="editTitle" value="${escHtml(item.title || '')}" placeholder="From filename if empty">
    </div>
    <div class="edit-field">
      <label class="edit-label">Artist</label>
      <input type="text" id="editArtist" value="${escHtml(item.artist || '')}">
    </div>
    <div class="edit-field">
      <label class="edit-label">Album</label>
      <input type="text" id="editAlbum" value="${escHtml(item.album || '')}">
    </div>
    <div class="edit-field">
      <label class="edit-label">Year</label>
      <input type="number" id="editYear" value="${item.year || ''}" placeholder="e.g. 2024">
    </div>
    <div class="edit-field">
      <label class="edit-label">Description</label>
      <input type="text" id="editDesc" value="${escHtml(item.description || '')}">
    </div>
    <div class="edit-field edit-field-wide">
      <label class="edit-label">Tags</label>
      <div class="tag-input-wrap">
        <div class="tag-input-current" id="editTagsCurrent"></div>
        <input type="text" id="editTagInput" placeholder="Add tag...">
        <div class="tag-autocomplete hidden" id="editTagAutocomplete"></div>
      </div>
    </div>
    <div class="edit-actions">
      <span class="edit-status" id="editStatus"></span>
      <button class="btn-sm" id="editCancel">Cancel</button>
      <button class="btn-sm btn-accent" id="editSave">Save</button>
    </div>`;

  card.appendChild(form);

  const elTagsCurrent = form.querySelector('#editTagsCurrent');
  function renderEditTags() {
    elTagsCurrent.innerHTML = '';
    for (const t of itemTags) {
      const pill = document.createElement('span');
      pill.className = 'tag-pill';
      pill.innerHTML = `${escHtml(t)} <span class="tag-pill-remove">×</span>`;
      pill.querySelector('.tag-pill-remove').addEventListener('click', () => {
        const idx = itemTags.indexOf(t);
        if (idx !== -1) itemTags.splice(idx, 1);
        renderEditTags();
      });
      elTagsCurrent.appendChild(pill);
    }
  }
  renderEditTags();

  // Tag autocomplete
  const elTagInput = form.querySelector('#editTagInput');
  const elAutocomplete = form.querySelector('#editTagAutocomplete');

  elTagInput.addEventListener('input', () => {
    const val = elTagInput.value.trim().toLowerCase();
    if (!val) {
      elAutocomplete.classList.add('hidden');
      return;
    }
    const matches = allTags
      .filter(t => t.name.toLowerCase().includes(val) && !itemTags.map(x => x.toLowerCase()).includes(t.name.toLowerCase()))
      .slice(0, 8);

    if (matches.length === 0) {
      elAutocomplete.innerHTML = `<div class="tag-autocomplete-item" data-new="${escHtml(elTagInput.value.trim())}">Create "${escHtml(elTagInput.value.trim())}"</div>`;
    } else {
      elAutocomplete.innerHTML = matches.map(t =>
        `<div class="tag-autocomplete-item" data-tag-add="${escHtml(t.name)}">${escHtml(t.name)} <span class="text-muted">(${t.count})</span></div>`
      ).join('');
    }
    elAutocomplete.classList.remove('hidden');
  });

  elAutocomplete.addEventListener('click', (e) => {
    const addEl = e.target.closest('[data-tag-add]');
    const newEl = e.target.closest('[data-new]');
    if (addEl) {
      itemTags.push(addEl.dataset.tagAdd);
    } else if (newEl) {
      itemTags.push(newEl.dataset.new);
    }
    renderEditTags();
    elTagInput.value = '';
    elAutocomplete.classList.add('hidden');
  });

  elTagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && elTagInput.value.trim()) {
      e.preventDefault();
      const val = elTagInput.value.trim();
      if (!itemTags.map(x => x.toLowerCase()).includes(val.toLowerCase())) {
        itemTags.push(val);
        renderEditTags();
      }
      elTagInput.value = '';
      elAutocomplete.classList.add('hidden');
    }
    if (e.key === 'Escape') {
      elAutocomplete.classList.add('hidden');
    }
  });

  document.addEventListener('click', function closeAc(e) {
    if (!form.contains(e.target)) {
      elAutocomplete.classList.add('hidden');
      document.removeEventListener('click', closeAc);
    }
  });

  // Cancel
  form.querySelector('#editCancel').addEventListener('click', () => {
    card.classList.remove('editing');
    form.remove();
    currentEditId = null;
  });

  // Save
  form.querySelector('#editSave').addEventListener('click', async () => {
    const elStatus = form.querySelector('#editStatus');
    elStatus.textContent = 'Saving...';

    const title = form.querySelector('#editTitle').value.trim() || null;
    const artist = form.querySelector('#editArtist').value.trim() || null;
    const album = form.querySelector('#editAlbum').value.trim() || null;
    const yearVal = form.querySelector('#editYear').value.trim();
    const year = yearVal ? parseInt(yearVal, 10) : null;
    const description = form.querySelector('#editDesc').value.trim();

    try {
      await api.updateMedia(item.id, { title, artist, album, year, description });
      await api.setMediaTags(item.id, itemTags);
      await refreshSidebarData();

      elStatus.textContent = '';
      card.classList.remove('editing');
      form.remove();
      currentEditId = null;
      toast('Saved', 'success');
      loadLibrary();
    } catch (err) {
      elStatus.textContent = `Error: ${err.message}`;
    }
  });
}

// ============================================================
// Scan — shared by the header Scan button and Full Metadata Scan
// ============================================================
let scanRunning = false;

async function runScan({ fullMetadata = false } = {}) {
  if (scanRunning) return;
  scanRunning = true;
  elScanBtn.disabled = true;
  elFullScanBtn.disabled = true;
  elScanStatus.textContent = fullMetadata ? 'Full metadata scan...' : 'Scanning...';

  // Show progress indicator in the grid
  const scanProgress = document.createElement('div');
  scanProgress.className = 'scan-progress';
  const label = fullMetadata ? 'Full metadata scan' : 'Scanning libraries';
  scanProgress.innerHTML = `
    <div class="scan-spinner"></div>
    <span>${label}<span class="scan-dots"></span></span>`;
  elMediaGrid.prepend(scanProgress);

  // Animate dots
  let dots = 0;
  const dotsEl = scanProgress.querySelector('.scan-dots');
  const dotsTimer = setInterval(() => {
    dots = (dots + 1) % 4;
    dotsEl.textContent = '.'.repeat(dots);
  }, 400);

  try {
    const result = await api.scan(fullMetadata ? { fullMetadata: true } : {});
    const parts = [];
    if (result.totalUpserts > 0) parts.push(`${result.totalUpserts} found`);
    if (result.totalReactivated > 0) parts.push(`${result.totalReactivated} restored`);
    if (result.totalMissing > 0) parts.push(`${result.totalMissing} missing`);
    if (fullMetadata && result.totalMetaUpdated > 0) parts.push(`${result.totalMetaUpdated} metadata refreshed`);
    const msg = parts.length > 0 ? parts.join(', ') : 'No changes';
    elScanStatus.textContent = msg;
    if (result.skippedLibraries?.length) {
      toast(`Library unavailable, nothing marked missing: ${result.skippedLibraries.join(', ')}`, 'error');
    } else {
      toast(`${fullMetadata ? 'Full metadata scan' : 'Scan'} complete: ${msg}`, 'success');
    }
    setTimeout(() => { elScanStatus.textContent = ''; }, 5000);
    await refreshSidebarData();
    loadLibrary();
  } catch (err) {
    elScanStatus.textContent = 'Scan failed';
    toast(`Scan failed: ${err.message}`, 'error');
  } finally {
    clearInterval(dotsTimer);
    scanProgress.remove();
    elScanBtn.disabled = false;
    elFullScanBtn.disabled = false;
    scanRunning = false;
  }
}

elScanBtn.addEventListener('click', () => runScan());

// ============================================================
// Settings overlay + maintenance actions
// ============================================================
let purgeArmed = false;

function resetPurgeButton() {
  purgeArmed = false;
  elPurgeBtn.textContent = 'Purge Missing…';
  elPurgeBtn.classList.remove('btn-danger-armed');
  elPurgeBtn.disabled = false;
}

function resetSettings() {
  resetPurgeButton();
  elMissingList.classList.add('hidden');
  elMissingList.innerHTML = '';
}

elSettingsBtn.addEventListener('click', () => {
  resetSettings();
  elSettingsOverlay.classList.remove('hidden');
});

// Full Metadata Scan — close the panel, then reuse the scan progress UI.
elFullScanBtn.addEventListener('click', () => {
  elSettingsOverlay.classList.add('hidden');
  resetSettings();
  runScan({ fullMetadata: true });
});

// Purge Missing — two-click confirm. First click arms with the LIVE count;
// second click executes. Disarms on overlay reopen.
elPurgeBtn.addEventListener('click', async () => {
  if (!purgeArmed) {
    elPurgeBtn.disabled = true;
    try {
      const { count } = await api.getMissingCount();
      if (!count) {
        toast('No missing items to purge', 'success');
        resetPurgeButton();
        return;
      }
      purgeArmed = true;
      elPurgeBtn.textContent = `Confirm: delete ${count} item${count !== 1 ? 's' : ''}`;
      elPurgeBtn.classList.add('btn-danger-armed');
      elPurgeBtn.disabled = false;
    } catch (err) {
      toast(`Could not read missing count: ${err.message}`, 'error');
      resetPurgeButton();
    }
    return;
  }

  // Armed → execute the irreversible purge.
  elPurgeBtn.disabled = true;
  elPurgeBtn.textContent = 'Purging…';
  try {
    const { purged, staleTags } = await api.purgeMissing();
    const tail = staleTags > 0 ? `, removed ${staleTags} stale tag${staleTags !== 1 ? 's' : ''}` : '';
    toast(`Purged ${purged} missing item${purged !== 1 ? 's' : ''}${tail}`, 'success');
    resetSettings();
    await refreshSidebarData();
    loadLibrary();
  } catch (err) {
    toast(`Purge failed: ${err.message}`, 'error');
    resetPurgeButton();
  }
});

// View missing — list the orphan rows (present = 0), markers included, so they
// can be sanity-checked before an irreversible purge. Toggles open/closed.
elViewMissingLink.addEventListener('click', async (e) => {
  e.preventDefault();
  if (!elMissingList.classList.contains('hidden')) {
    elMissingList.classList.add('hidden');
    return;
  }
  elMissingList.classList.remove('hidden');
  elMissingList.innerHTML = '<div class="settings-missing-empty">Loading…</div>';
  try {
    const data = await api.getLibrary({ missing: 'only', limit: 200 });
    if (!data.items.length) {
      elMissingList.innerHTML = '<div class="settings-missing-empty">No missing items.</div>';
      return;
    }
    const rows = data.items.map(it => {
      const title = escHtml(it.title || it.filename);
      const sub = escHtml(it.artist || it.libraryName || it.ext.toUpperCase());
      const markers = it.markerCount > 0
        ? `<span class="settings-missing-markers">${it.markerCount} marker${it.markerCount !== 1 ? 's' : ''}</span>`
        : '';
      return `<div class="settings-missing-row">
          <div class="settings-missing-main">
            <span class="settings-missing-title">${title}</span>
            <span class="settings-missing-sub">${sub}</span>
          </div>
          ${markers}
        </div>`;
    }).join('');
    const more = data.nextCursor ? '<div class="settings-missing-empty">Showing first 200.</div>' : '';
    elMissingList.innerHTML = rows + more;
  } catch (err) {
    elMissingList.innerHTML = `<div class="settings-missing-empty">Failed to load: ${escHtml(err.message)}</div>`;
  }
});

// ============================================================
// CSV Import
// ============================================================
// Open the metadata import overlay from the Settings → Import row.
elOpenMetaImportBtn.addEventListener('click', () => {
  elSettingsOverlay.classList.add('hidden');
  resetSettings();
  elImportStatus.textContent = '';
  elImportResult.classList.add('hidden');
  elImportResult.innerHTML = '';
  elImportOverlay.classList.remove('hidden');
});

elImportBtn.addEventListener('click', async () => {
  const text = elImportText.value.trim();
  if (!text) {
    elImportStatus.textContent = 'Paste CSV data first';
    return;
  }

  elImportBtn.disabled = true;
  elImportStatus.textContent = 'Importing...';

  try {
    const result = await api.importData({ csv: text });
    const parts = [];
    if (result.matched > 0) parts.push(`${result.matched} matched`);
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
    if (result.errors?.length > 0) parts.push(`${result.errors.length} errors`);
    const msg = parts.join(', ') || 'Nothing to import';
    elImportStatus.textContent = msg;
    const ok = result.matched > 0 && !result.errors?.length;
    toast(`Import: ${msg}`, ok ? 'success' : 'error');

    if (result.errors?.length) {
      elImportResult.classList.remove('hidden');
      elImportResult.innerHTML = result.errors.map(e =>
        `<div class="import-preview-row import-result-error">${escHtml(String(e))}</div>`
      ).join('');
    }

    await refreshSidebarData();
    loadLibrary();
  } catch (err) {
    elImportStatus.textContent = `Error: ${err.message}`;
    toast(`Import failed: ${err.message}`, 'error');
  } finally {
    elImportBtn.disabled = false;
  }
});

// ============================================================
// Markers CSV Import (bulk, replace-all per matched file)
// ============================================================
// Opens from the Settings → Import row. Two-click confirm mirrors Purge
// Missing: the action is destructive (it deletes every matched file's existing
// markers before inserting the CSV's rows), so the first click only arms.
let markerImportArmed = false;
// True only in the post-success "Imported ✓" parked state. Kept distinct from
// `armed` so the input listener can re-arm out of EITHER state when the payload
// changes, without sniffing button text.
let markerImportDone = false;

function resetMarkerImportBtn() {
  markerImportArmed = false;
  markerImportDone = false;
  elMarkerImportBtn.textContent = 'Import & replace markers';
  elMarkerImportBtn.classList.remove('btn-danger-armed');
  elMarkerImportBtn.disabled = false;
}

elOpenMarkerImportBtn.addEventListener('click', () => {
  elSettingsOverlay.classList.add('hidden');
  resetSettings();
  resetMarkerImportBtn();
  elMarkerImportStatus.textContent = '';
  elMarkerImportResult.classList.add('hidden');
  elMarkerImportResult.innerHTML = '';
  elMarkerImportOverlay.classList.remove('hidden');
});

// Editing the payload after arming (or after a completed import) invalidates
// the pending confirm / clears the parked "Imported ✓" state so a fresh,
// deliberate two-click arm is required again.
elMarkerImportText.addEventListener('input', () => {
  if (markerImportArmed || markerImportDone) resetMarkerImportBtn();
});

elMarkerImportBtn.addEventListener('click', async () => {
  const text = elMarkerImportText.value.trim();
  if (!text) {
    elMarkerImportStatus.textContent = 'Paste a markers CSV first';
    return;
  }

  // First click arms; second click executes the destructive import.
  if (!markerImportArmed) {
    markerImportArmed = true;
    elMarkerImportBtn.textContent = 'Confirm — replace markers';
    elMarkerImportBtn.classList.add('btn-danger-armed');
    return;
  }

  elMarkerImportBtn.disabled = true;
  elMarkerImportBtn.textContent = 'Importing…';
  elMarkerImportStatus.textContent = 'Importing…';

  try {
    const result = await api.importMarkers({ csv: text });
    const parts = [];
    if (result.matched > 0) parts.push(`${result.matched} file${result.matched !== 1 ? 's' : ''} matched`);
    if (result.markerCount > 0) parts.push(`${result.markerCount} marker${result.markerCount !== 1 ? 's' : ''}`);
    if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
    if (result.errors?.length > 0) parts.push(`${result.errors.length} error${result.errors.length !== 1 ? 's' : ''}`);
    const msg = parts.join(', ') || 'No matching files';
    elMarkerImportStatus.textContent = msg;
    const ok = result.matched > 0 && !result.errors?.length;
    toast(`Markers: ${msg}`, ok ? 'success' : 'error');

    if (result.errors?.length) {
      elMarkerImportResult.classList.remove('hidden');
      elMarkerImportResult.innerHTML = result.errors.map(e => {
        const detail = typeof e === 'string' ? e : (e.error || e.key || JSON.stringify(e));
        return `<div class="import-preview-row import-result-error">${escHtml(String(detail))}</div>`;
      }).join('');
    }

    await refreshSidebarData();
    loadLibrary();

    // Success: park the button as a DISABLED "Imported ✓" rather than resetting
    // it to the armable stage-1. The pasted CSV is still loaded, and the import
    // is destructive (it replaces every matched file's markers), so leaving the
    // control hot invited an accidental re-fire on the same payload. Editing the
    // textarea (input listener) re-arms it for a deliberate second run.
    markerImportArmed = false;
    markerImportDone = true;
    elMarkerImportBtn.textContent = 'Imported ✓';
    elMarkerImportBtn.classList.remove('btn-danger-armed');
    elMarkerImportBtn.disabled = true;
  } catch (err) {
    elMarkerImportStatus.textContent = `Error: ${err.message}`;
    toast(`Markers import failed: ${err.message}`, 'error');
    // Failure → reset so the user can immediately retry the same payload.
    resetMarkerImportBtn();
  }
});

// ============================================================
// Filter & search event wiring
// ============================================================
const reloadDebounced = debounce(() => loadLibrary(), 250);

// Toggle the clear (X) affordance based on whether the box has content.
// Centralized so programmatic clears (Esc handler, clear button) stay in sync
// with typed input.
function syncSearchClear() {
  elSearchClear.classList.toggle('hidden', elSearchInput.value === '');
}

elSearchInput.addEventListener('input', () => {
  syncSearchClear();
  reloadDebounced();
});

// Clear button: wipe the query, reload immediately (not debounced — it's an
// explicit action), and return focus to the box for the next search.
elSearchClear.addEventListener('click', () => {
  elSearchInput.value = '';
  syncSearchClear();
  elSearchInput.focus();
  loadLibrary();
});

elSortField.addEventListener('change', () => loadLibrary());
elSortOrder.addEventListener('change', () => loadLibrary());

// Type (audio/video) and marker-presence filters. The <select> is the visible
// control AND the clear affordance (set back to "All…"), so these deliberately
// don't render redundant filter chips — unlike lib/artist/tag, which are driven
// from the sidebar and have no other on-screen indication. Reset the cursor by
// reloading from scratch (loadLibrary() with append=false).
elTypeFilter.addEventListener('change', () => loadLibrary());
elMarkerFilter.addEventListener('change', () => loadLibrary());

// "Surprise Me" — jump to a random item from the CURRENT filtered view. Reuses
// getFilterParams() so it honours the active library/artist/tag/search/type/
// marker filters; the server ignores sort/order/limit for the random pick.
elSurpriseBtn.addEventListener('click', async () => {
  elSurpriseBtn.disabled = true;
  try {
    const { id } = await api.getRandom(getFilterParams());
    if (id == null) {
      toast('Nothing matches the current filters', '');
      return;
    }
    location.href = `/player.html?id=${encodeURIComponent(id)}`;
  } catch (err) {
    toast(`Surprise failed: ${err.message}`, 'error');
  } finally {
    elSurpriseBtn.disabled = false;
  }
});

elLoadMoreBtn.addEventListener('click', () => loadLibrary(true));

// Close overlays
document.querySelectorAll('[data-close]').forEach(el => {
  el.addEventListener('click', () => {
    const id = el.dataset.close;
    document.getElementById(id).classList.add('hidden');
  });
});

// ============================================================
// Keyboard shortcuts
// ============================================================
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
    e.preventDefault();
    elSearchInput.focus();
  }
  if (e.key === 'Escape') {
    if (!elHelpOverlay.classList.contains('hidden')) {
      elHelpOverlay.classList.add('hidden');
    } else if (!elSettingsOverlay.classList.contains('hidden')) {
      elSettingsOverlay.classList.add('hidden');
      resetSettings();
    } else if (!elMarkerImportOverlay.classList.contains('hidden')) {
      elMarkerImportOverlay.classList.add('hidden');
      resetMarkerImportBtn();
    } else if (!elImportOverlay.classList.contains('hidden')) {
      elImportOverlay.classList.add('hidden');
    } else if (elSidebar.classList.contains('open')) {
      closeSidebar();
    } else if (document.activeElement === elSearchInput) {
      elSearchInput.value = '';
      syncSearchClear();
      elSearchInput.blur();
      loadLibrary();
    }
  }
});

// ============================================================
// Data refresh helpers
// ============================================================
async function refreshSidebarData() {
  try {
    const [tagData, artistData] = await Promise.all([
      api.getTags(),
      api.getArtists(),
    ]);
    allTags = tagData.tags || [];
    allArtists = artistData.artists || [];
    renderSidebarTags();
    renderSidebarArtists();
  } catch { /* silent */ }
}

// ============================================================
// Init
// ============================================================
async function init() {
  // Deep-link entry: a ?artist=<name> param (e.g. from a player artist link)
  // pre-sets the filter before the first render so the library lands filtered.
  // Case-exact, matching the facet/filter (Stage A invariant).
  const initialArtist = new URLSearchParams(location.search).get('artist');
  if (initialArtist) activeArtistFilter = initialArtist;
  await refreshSidebarData();
  await loadLibrary();
}

init();
