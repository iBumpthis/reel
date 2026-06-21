/**
 * Shared Help overlay — single source of truth for the Help & Shortcuts panel.
 *
 * The panel is static reference content (keyboard shortcuts + filename grammar).
 * Most of it — the Player Shortcuts section — applies on the PLAYER page, yet it
 * was originally reachable only from the library (index). This module lets both
 * pages mount the same panel so the content can't drift between them.
 *
 * Usage (each page, after imports, before its own [data-close]/Esc wiring runs):
 *   import { installHelpOverlay } from './shared/help-overlay.js';
 *   const help = installHelpOverlay('helpBtn');   // injects #helpOverlay + wires it
 *
 * `installHelpOverlay` is idempotent (a pre-existing #helpOverlay is reused) and
 * self-wires open (the given button), close (backdrop + close button), so it does
 * not depend on the page's generic [data-close] snapshot or its load order. The
 * page's existing Esc handler closes it for free once it's in the DOM (those
 * handlers query the live DOM at event time). Returns { open, close, overlay }.
 */

// Inner markup (backdrop + panel) of the #helpOverlay wrapper. Kept here as the
// ONE copy; the wrapper is created by installHelpOverlay.
export const HELP_OVERLAY_INNER = `
  <div class="overlay-backdrop" data-close="helpOverlay"></div>
  <div class="overlay-panel">
    <div class="overlay-header">
      <span class="overlay-title">Help &amp; Shortcuts</span>
      <button class="overlay-close" data-close="helpOverlay">&#10005;</button>
    </div>

    <div class="settings-section">
      <h3 class="settings-heading">Library Shortcuts</h3>
      <dl class="help-keys">
        <dt><kbd>/</kbd></dt>
        <dd>Focus the search box</dd>
        <dt><kbd>Esc</kbd></dt>
        <dd>Close an overlay, the sidebar, or clear/blur the focused search box</dd>
      </dl>
    </div>

    <div class="settings-section">
      <h3 class="settings-heading">Player Shortcuts</h3>
      <dl class="help-keys">
        <dt><kbd>Space</kbd></dt>
        <dd>Play / pause</dd>
        <dt><kbd>&larr;</kbd> <kbd>&rarr;</kbd></dt>
        <dd>Seek &minus;/&plus; 5 seconds</dd>
        <dt><kbd>&uarr;</kbd> <kbd>&darr;</kbd></dt>
        <dd>Volume up / down</dd>
        <dt><kbd>M</kbd></dt>
        <dd>Mute / unmute</dd>
        <dt><kbd>F</kbd></dt>
        <dd>Toggle fullscreen</dd>
        <dt><kbd>V</kbd> <span class="help-key-alt">/ <kbd>Shift</kbd>+<kbd>V</kbd></span></dt>
        <dd>Enter visualizer, then cycle mode forward (Shift = backward)</dd>
        <dt><kbd>T</kbd> <span class="help-key-alt">/ <kbd>Shift</kbd>+<kbd>T</kbd></span></dt>
        <dd>Cycle color theme forward (Shift = backward)</dd>
        <dt><kbd>G</kbd></dt>
        <dd>Toggle Trails (frame-persistence) in visualizer mode</dd>
        <dt><kbd>Esc</kbd></dt>
        <dd>Close an open overlay</dd>
      </dl>
    </div>

    <div class="settings-section">
      <h3 class="settings-heading">Filename Conventions</h3>
      <p class="settings-row-desc help-intro">
        Reel reads artist, title, and year from the filename. Embedded ID3 /
        M4A tags take priority for audio when present; the filename is the
        fallback (and the only source for video).
      </p>
      <dl class="help-grammar">
        <dt><code>Artist - Event (YYYY).ext</code></dt>
        <dd>Solo set. Artist before the dash, year in trailing parens.</dd>
        <dt><code>Artist1 b2b Artist2 - Event (YYYY).ext</code></dt>
        <dd>
          Back-to-back set. Any number of <code>b2b</code> participants; each is
          split into its own artist and tagged individually, plus a literal
          <code>b2b</code> tag. The <code>b2b</code> delimiter is
          whitespace-bounded, so it won't fire on a substring inside a name.
        </dd>
        <dt><code>Artist1 b2b Artist2 [GROUP] - Event (YYYY).ext</code></dt>
        <dd>
          b2b set with a collective act / alias name in trailing brackets,
          placed on the artist side <em>before</em> the <code>-</code>. The
          alias is stripped from the displayed artist chain and surfaced as a
          browsable <strong>act</strong> in the artist list (its own entry,
          marked <em>act</em>) &mdash; and, this release, also kept as a
          one-click tag. Brackets after the dash stay literal title text.
        </dd>
      </dl>
      <p class="settings-row-desc help-note">
        To find every set an artist appears in &mdash; solo <em>and</em> b2b
        &mdash; select them in the artist list, or use the search box (it matches
        the artist column and tag names).
      </p>
    </div>
  </div>
`;

export function installHelpOverlay(buttonId) {
  let overlay = document.getElementById('helpOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'helpOverlay';
    overlay.className = 'overlay hidden';
    overlay.innerHTML = HELP_OVERLAY_INNER;
    document.body.appendChild(overlay);
  }
  const open = () => overlay.classList.remove('hidden');
  const close = () => overlay.classList.add('hidden');
  // Self-wire close (backdrop + close button) so we don't depend on the page's
  // generic [data-close] snapshot having run after injection.
  overlay.querySelectorAll('[data-close="helpOverlay"]').forEach(el => {
    el.addEventListener('click', close);
  });
  const btn = document.getElementById(buttonId);
  if (btn) btn.addEventListener('click', open);
  return { open, close, overlay };
}
