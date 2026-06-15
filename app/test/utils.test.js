/**
 * Tests for the pure helpers in the shared frontend utils.
 * Only the dependency-free functions are covered here (escHtml and toast
 * touch the DOM and are exercised in the browser, not in node).
 *
 * Run: npm test   (or: node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTime, fmtBytes, debounce } from '../public/js/shared/utils.js';

test('fmtTime — M:SS and H:MM:SS, clamps negatives', () => {
  assert.equal(fmtTime(0), '0:00');
  assert.equal(fmtTime(83), '1:23');
  assert.equal(fmtTime(3723), '1:02:03');
  assert.equal(fmtTime(-10), '0:00');
});

test('fmtBytes — unit boundaries', () => {
  assert.equal(fmtBytes(512), '512 B');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(fmtBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
});

test('debounce — collapses rapid calls into one trailing call', async () => {
  let calls = 0;
  const fn = debounce(() => { calls++; }, 20);
  fn(); fn(); fn();
  assert.equal(calls, 0, 'no call before the delay');
  await new Promise(r => setTimeout(r, 40));
  assert.equal(calls, 1, 'exactly one call after the delay');
});
