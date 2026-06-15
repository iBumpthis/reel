/**
 * Tests for the marker parsing engine (services/markers.js).
 *
 * This module is pure (no I/O, no DB) and carries the gnarliest logic in
 * the codebase — five overlapping line formats, time parsing with range
 * validation, and overlap repair. These tests lock in current behavior so
 * future edits can't silently regress tracklist parsing.
 *
 * Run: npm test   (or: node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTime,
  parseMarkerLine,
  formatTime,
  formatMarkerBlock,
  parseMarkerBlock,
} from '../services/markers.js';

// ============================================================
// parseTime
// ============================================================
test('parseTime — M:SS', () => {
  assert.equal(parseTime('1:23'), 83);
  assert.equal(parseTime('0:00'), 0);
  assert.equal(parseTime('59:59'), 3599);
});

test('parseTime — H:MM:SS', () => {
  assert.equal(parseTime('1:00:00'), 3600);
  assert.equal(parseTime('1:02:03'), 3723);
  assert.equal(parseTime('10:00:00'), 36000);
});

test('parseTime — rejects out-of-range seconds/minutes', () => {
  assert.equal(parseTime('1:60'), null);     // seconds > 59
  assert.equal(parseTime('1:99:00'), null);  // minutes > 59
  assert.equal(parseTime('1:00:99'), null);  // seconds > 59 in H:MM:SS
});

test('parseTime — rejects malformed', () => {
  assert.equal(parseTime('abc'), null);
  assert.equal(parseTime('1:2:3:4'), null);
  assert.equal(parseTime(''), null);
});

// ============================================================
// formatTime  (inverse of parseTime)
// ============================================================
test('formatTime — M:SS and H:MM:SS', () => {
  assert.equal(formatTime(83), '1:23');
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(3723), '1:02:03');
  assert.equal(formatTime(36000), '10:00:00');
});

test('formatTime — clamps negatives and floors', () => {
  assert.equal(formatTime(-5), '0:00');
  assert.equal(formatTime(83.9), '1:23');
});

// ============================================================
// parseMarkerLine — each supported format
// ============================================================
test('parseMarkerLine — bracket range, label before', () => {
  const m = parseMarkerLine('Intro [0:00-1:30]');
  assert.deepEqual([m.startSeconds, m.endSeconds, m.label], [0, 90, 'Intro']);
});

test('parseMarkerLine — bracket range, label after', () => {
  const m = parseMarkerLine('[0:00-1:30] Intro');
  assert.deepEqual([m.startSeconds, m.endSeconds, m.label], [0, 90, 'Intro']);
});

test('parseMarkerLine — paren range', () => {
  const m = parseMarkerLine('Intro (0:00-1:30)');
  assert.deepEqual([m.startSeconds, m.endSeconds, m.label], [0, 90, 'Intro']);
});

test('parseMarkerLine — bare range, range first', () => {
  const m = parseMarkerLine('0:00-1:30 Intro');
  assert.deepEqual([m.startSeconds, m.endSeconds, m.label], [0, 90, 'Intro']);
});

test('parseMarkerLine — bare range, range last', () => {
  const m = parseMarkerLine('Intro 0:00-1:30');
  assert.deepEqual([m.startSeconds, m.endSeconds, m.label], [0, 90, 'Intro']);
});

test('parseMarkerLine — time first (point marker)', () => {
  const m = parseMarkerLine('1:23 Some Track');
  assert.deepEqual([m.startSeconds, m.endSeconds, m.label], [83, null, 'Some Track']);
});

test('parseMarkerLine — time first with dash separator', () => {
  const m = parseMarkerLine('1:23 - Some Track');
  assert.deepEqual([m.startSeconds, m.endSeconds, m.label], [83, null, 'Some Track']);
});

test('parseMarkerLine — time last (point marker)', () => {
  const m = parseMarkerLine('Some Track 1:23');
  assert.deepEqual([m.startSeconds, m.endSeconds, m.label], [83, null, 'Some Track']);
});

test('parseMarkerLine — time last with dash separator', () => {
  const m = parseMarkerLine('Some Track - 1:23');
  assert.deepEqual([m.startSeconds, m.endSeconds, m.label], [83, null, 'Some Track']);
});

test('parseMarkerLine — H:MM:SS in a point marker', () => {
  const m = parseMarkerLine('1:00:30 Long One');
  assert.deepEqual([m.startSeconds, m.endSeconds, m.label], [3630, null, 'Long One']);
});

test('parseMarkerLine — rejects end < start', () => {
  assert.equal(parseMarkerLine('Bad [1:30-0:30]'), null);
});

test('parseMarkerLine — normalizes en/em dashes in a range', () => {
  // en dash between times should be treated like a hyphen
  const m = parseMarkerLine('Intro 0:00\u20131:30');
  assert.ok(m, 'en-dash range should parse');
  assert.deepEqual([m.startSeconds, m.endSeconds, m.label], [0, 90, 'Intro']);
});

test('parseMarkerLine — empty line returns null', () => {
  assert.equal(parseMarkerLine('   '), null);
  assert.equal(parseMarkerLine(''), null);
});

// ============================================================
// formatMarkerBlock + round-trip
// ============================================================
test('formatMarkerBlock — point and range markers', () => {
  const text = formatMarkerBlock([
    { startSeconds: 0, endSeconds: null, label: 'Intro' },
    { startSeconds: 90, endSeconds: 150, label: 'Track B' },
  ]);
  assert.equal(text, '0:00 Intro\n1:30-2:30 Track B');
});

test('round-trip — format then parse preserves start/end/label', () => {
  const markers = [
    { startSeconds: 0, endSeconds: null, label: 'Intro' },
    { startSeconds: 90, endSeconds: 150, label: 'Track B' },
    { startSeconds: 3723, endSeconds: null, label: 'Outro' },
  ];
  const { markers: round } = parseMarkerBlock(formatMarkerBlock(markers));
  assert.equal(round.length, markers.length);
  for (let i = 0; i < markers.length; i++) {
    assert.equal(round[i].startSeconds, markers[i].startSeconds);
    assert.equal(round[i].endSeconds, markers[i].endSeconds);
    assert.equal(round[i].label, markers[i].label);
  }
});

// ============================================================
// parseMarkerBlock — multi-line, sorting, errors, overlap repair
// ============================================================
test('parseMarkerBlock — collects errors and skips blank lines', () => {
  const { markers, errors } = parseMarkerBlock('0:00 Good\n\n!!!garbage with no time\n1:00 Also Good');
  assert.equal(markers.length, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 3); // 1-indexed, blank line skipped not errored
});

test('parseMarkerBlock — sorts by start time, assigns sort_order', () => {
  const { markers } = parseMarkerBlock('2:00 Third\n0:00 First\n1:00 Second');
  assert.deepEqual(markers.map(m => m.label), ['First', 'Second', 'Third']);
  assert.deepEqual(markers.map(m => m.sortOrder), [0, 1, 2]);
});

test('parseMarkerBlock — overlap repair truncates previous end to next start', () => {
  // A spans 0:00-2:00, B is a point at 1:30 → A.end should truncate to 90,
  // and B's start (the real transition point) is preserved.
  const { markers } = parseMarkerBlock('A 0:00-2:00\nB 1:30');
  const a = markers.find(m => m.label === 'A');
  const b = markers.find(m => m.label === 'B');
  assert.equal(a.endSeconds, 90, 'A end truncated to B start');
  assert.equal(a.wasAdjusted, true);
  assert.ok(a.adjustReason, 'adjust reason recorded');
  assert.equal(b.startSeconds, 90, 'B start preserved as navigable point');
});

test('parseMarkerBlock — no overlap leaves ends untouched', () => {
  const { markers } = parseMarkerBlock('A 0:00-1:00\nB 2:00-3:00');
  assert.equal(markers[0].endSeconds, 60);
  assert.equal(markers[0].wasAdjusted, false);
});
