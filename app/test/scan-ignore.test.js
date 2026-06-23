/**
 * Tests for the directory-walk ignore predicate (REEL-009a).
 *
 * Pure logic with no I/O and no deps — imported directly from the dependency-
 * free scan-ignore module, so this suite ALWAYS runs (no native build, no
 * `npm install` required), matching mime.test.js / utils.test.js.
 *
 * Run: npm test   (or: node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldIgnoreDir, IGNORED_DIRS } from '../services/scan-ignore.js';

test('shouldIgnoreDir — exact-match sidecar/trash directories', () => {
  for (const name of [
    '@eaDir', '#recycle', '#snapshot', '@Recycle',
    'lost+found', '.Trashes', '.Spotlight-V100', '.fseventsd',
  ]) {
    assert.equal(shouldIgnoreDir(name), true, `${name} should be ignored`);
  }
});

test('shouldIgnoreDir — .Trash-<uid> prefix (Linux desktop trash)', () => {
  assert.equal(shouldIgnoreDir('.Trash-1000'), true);
  assert.equal(shouldIgnoreDir('.Trash-0'), true);
  assert.equal(shouldIgnoreDir('.Trash-'), true); // degenerate but still prefix
});

test('shouldIgnoreDir — real media/library directories are NOT ignored', () => {
  for (const name of [
    'Music', 'Concerts', 'Audiobooks', 'Artist - Album',
    'eaDir',          // no leading @
    'recycle',        // no leading #
    'Trash',          // no dot/dash
    '.Trash',         // exact, not the .Trash-<uid> form
    'lost',           // partial
    '@eaDirectory',   // superset name, not exact
  ]) {
    assert.equal(shouldIgnoreDir(name), false, `${name} should NOT be ignored`);
  }
});

test('shouldIgnoreDir — case-sensitive (does not over-match)', () => {
  // The set is case-sensitive by design; a differently-cased variant is a
  // distinct real directory and must not be silently swallowed.
  assert.equal(shouldIgnoreDir('@EADIR'), false);
  assert.equal(shouldIgnoreDir('#Recycle'), false); // '#recycle' vs QNAP '@Recycle'
});

test('shouldIgnoreDir — .DS_Store is NOT in the dir set (it is a file)', () => {
  // Documented exclusion: .DS_Store is a macOS file, never a directory, so the
  // dir-level predicate must not list it. (It is excluded from results by the
  // extension filter, not by this predicate.)
  assert.equal(IGNORED_DIRS.has('.DS_Store'), false);
});
