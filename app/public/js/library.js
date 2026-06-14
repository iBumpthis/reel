/**
 * Reel — Library page
 * Browse, search, filter, edit metadata, manage tags, scan, import.
 * v1.1: sidebar browse (artists, tags, libraries), multi-column grid.
 */
import { fmtBytes, debounce, escHtml, toast } from './shared/utils.js';
import * as api from './shared/api.js';

// ============================================================
// DOM refs
// ============================================================
const elVersion = document.getElementById('appVersion');
const elFooterVersion = document.getElementById('footerVersion');
const elSearchInput = document.getElementById('searchInput');
const elScanBtn = document.getElementById('scanBtn');
const elScanStatus = document.getElementById('scanStatus');
const elSortField = document.getElementById('sortField');
const elSortOrder = document.getElementById('sortOrder');
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
const elImportLink = document.getElementById('importLink');
const elSidebar = document.getElementById('sidebar');
const elSidebarToggle = document.getElementById('sidebarToggle');
const elSidebarLibraries = document.getElementById('sidebarLibraries');
const elSidebarArtists = document.getElementById('sidebarArtists');
const elSidebarTags = document.getElementById('sidebarTags');

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

function renderSidebarArtists() {
  elSidebarArtists.innerHTML = '';

  const allItem = createSidebarItem('All artists', null, !activeArtistFilter);
  allItem.addEventListener('click', () => {
    activeArtistFilter = null;
    renderSidebarArtists();
    renderActiveFilters();
    loadLibrary();
  });
  elSidebarArtists.appendChild(allItem);

  for (const a of allArtists) {
    const item = createSidebarItem(a.name, a.count, activeArtistFilter === a.name);
    item.addEventListener('click', () => {
      activeArtistFilter = activeArtistFilter === a.name ? null : a.name;
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

function createSidebarItem(name, count, active) {
  const el = document.createElement('div');
  el.className = `sidebar-item${active ? ' active' : ''}`;
  el.innerHTML = `
    <span class="sidebar-item-name">${escHtml(name)}</span>
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

  if (activeLibFilter) params.lib = activeLibFilter;
  if (activeArtistFilter) params.artist = activeArtistFilter;
  if (q) params.q = q;
  if (sort) params.sort = sort;
  if (order) params.order = order;
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
    existing.remove();
    if (currentEditId === item.id) {
      currentEditId = null;
      return;
    }
  }
  currentEditId = item.id;

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
// Scan
// ============================================================
elScanBtn.addEventListener('click', async () => {
  elScanBtn.disabled = true;
  elScanStatus.textContent = 'Scanning...';

  try {
    const result = await api.scan();
    const parts = [];
    if (result.totalUpserts > 0) parts.push(`${result.totalUpserts} found`);
    if (result.totalDeletes > 0) parts.push(`${result.totalDeletes} removed`);
    const msg = parts.length > 0 ? parts.join(', ') : 'No changes';
    elScanStatus.textContent = msg;
    if (result.skippedLibraries?.length) {
      toast(`Library unavailable, nothing removed: ${result.skippedLibraries.join(', ')}`, 'error');
    } else {
      toast(`Scan complete: ${msg}`, 'success');
    }
    setTimeout(() => { elScanStatus.textContent = ''; }, 5000);
    await refreshSidebarData();
    loadLibrary();
  } catch (err) {
    elScanStatus.textContent = 'Scan failed';
    toast(`Scan failed: ${err.message}`, 'error');
  } finally {
    elScanBtn.disabled = false;
  }
});

// ============================================================
// CSV Import
// ============================================================
elImportLink.addEventListener('click', (e) => {
  e.preventDefault();
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
    const msg = parts.join(', ') || 'Done';
    elImportStatus.textContent = msg;
    toast(`Import: ${msg}`, result.errors?.length ? 'error' : 'success');

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
  } finally {
    elImportBtn.disabled = false;
  }
});

// ============================================================
// Filter & search event wiring
// ============================================================
const reloadDebounced = debounce(() => loadLibrary(), 250);

elSearchInput.addEventListener('input', reloadDebounced);
elSortField.addEventListener('change', () => loadLibrary());
elSortOrder.addEventListener('change', () => loadLibrary());

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
    if (!elImportOverlay.classList.contains('hidden')) {
      elImportOverlay.classList.add('hidden');
    } else if (elSidebar.classList.contains('open')) {
      closeSidebar();
    } else if (document.activeElement === elSearchInput) {
      elSearchInput.value = '';
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
  await refreshSidebarData();
  await loadLibrary();
}

init();
