/**
 * Reel — Browse overlay.
 * Browse library from the player page, switch media without going back.
 */
import * as api from '../shared/api.js';
import { escHtml } from '../shared/utils.js';
import { debounce } from '../shared/utils.js';

let state, els;
let librariesLoaded = false;

const elBrowseBtn = document.getElementById('browseBtn');
const elBrowseOverlay = document.getElementById('browseOverlay');
const elBrowseLib = document.getElementById('browseLib');
const elBrowseQ = document.getElementById('browseQ');
const elBrowseList = document.getElementById('browseList');

function openBrowse() {
  elBrowseOverlay.classList.remove('hidden');
  elBrowseQ.focus();
  loadBrowse();
}

function closeBrowse() {
  elBrowseOverlay.classList.add('hidden');
}

async function loadBrowse() {
  const params = {};
  const lib = elBrowseLib.value;
  const q = elBrowseQ.value.trim();
  if (lib) params.lib = lib;
  if (q) params.q = q;

  try {
    const data = await api.getLibrary(params);

    // Populate library dropdown once
    if (!librariesLoaded && data.libraries) {
      for (const lib of data.libraries) {
        const opt = document.createElement('option');
        opt.value = lib.name;
        opt.textContent = lib.name;
        elBrowseLib.appendChild(opt);
      }
      librariesLoaded = true;
    }

    // Render items
    elBrowseList.innerHTML = '';
    for (const item of data.items) {
      const div = document.createElement('div');
      const isCurrent = String(item.id) === String(state.mediaId);
      div.className = `browse-item${isCurrent ? ' browse-item-current' : ''}`;

      const title = item.title || item.filename;
      const display = item.artist ? `${item.artist} — ${title}` : title;
      const parts = [item.year, item.libraryName, (item.ext || '').toUpperCase()].filter(Boolean);

      div.innerHTML = `
        <div class="browse-item-title">${escHtml(display)}</div>
        <div class="browse-item-meta">${escHtml(parts.join(' · '))}</div>`;

      div.addEventListener('click', () => {
        window.location.href = `/player.html?id=${encodeURIComponent(item.id)}`;
      });

      elBrowseList.appendChild(div);
    }

    if (data.items.length === 0) {
      elBrowseList.innerHTML = '<div class="markers-empty">No results</div>';
    }
  } catch (err) {
    elBrowseList.innerHTML = `<div class="markers-empty">Error: ${escHtml(err.message)}</div>`;
  }
}

const debouncedLoad = debounce(loadBrowse, 250);

export function initBrowse(_state, _els) {
  state = _state;
  els = _els;

  elBrowseBtn.addEventListener('click', openBrowse);
  elBrowseLib.addEventListener('change', loadBrowse);
  elBrowseQ.addEventListener('input', debouncedLoad);
}
