/**
 * Directory-walk ignore rules (REEL-009a).
 *
 * Kept in its own dependency-free module — deliberately NOT inside scanner.js —
 * so the predicate is importable and unit-testable WITHOUT pulling in the
 * scanner's `music-metadata` (and transitively heavier) dependencies. This
 * mirrors metadata.js / mime.js: a pure-logic unit that the test suite can
 * exercise with no native build and no `npm install`.
 *
 * The names below are NAS/OS sidecar, index, and trash directories that never
 * hold real library media. The walker skips them at the DIRECTORY level (never
 * descends), so the cost saved is the whole subtree's readdir/stat traffic —
 * meaningful over CIFS, where every descent is a network round-trip and these
 * trees (Synology @eaDir thumbnail caches especially) can be large.
 */

/**
 * Case-sensitive exact-match directory names to skip. Named const so adding a
 * new one is a one-line edit.
 *
 * NB: `.DS_Store` is deliberately absent — it is a macOS *file*, not a
 * directory, so it can never match a directory entry. It carries no media
 * extension and is already excluded from results by the ext filter; listing it
 * in a directory-ignore set would be misleading dead weight.
 */
export const IGNORED_DIRS = new Set([
  '@eaDir',          // Synology thumbnail/index sidecar (the big CIFS cost)
  '#recycle',        // Synology shared-folder recycle bin
  '#snapshot',       // Synology snapshot mount
  '@Recycle',        // QNAP recycle bin
  'lost+found',      // ext fsck recovery
  '.Trashes',        // macOS volume trash
  '.Spotlight-V100', // macOS Spotlight index
  '.fseventsd',      // macOS fsevents log
]);

/**
 * True if a directory with this name should be skipped (not descended into).
 * Exact membership in IGNORED_DIRS plus the per-uid `.Trash-<n>` prefix
 * (Linux desktop trash: `.Trash-1000`). Pure, no I/O.
 *
 * @param {string} name - a single path segment (directory basename)
 * @returns {boolean}
 */
export function shouldIgnoreDir(name) {
  if (IGNORED_DIRS.has(name)) return true;
  if (name.startsWith('.Trash-')) return true; // .Trash-1000 etc.
  return false;
}
