/**
 * Tests for the filename metadata parser (services/metadata.js).
 *
 * Pure heuristic parsing: artist/title/year extraction, track-number and
 * disc-prefix stripping, and a year-range guard. Locking this in protects
 * the library/player fallback display when embedded tags are absent.
 *
 * Run: npm test   (or: node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilename } from '../services/metadata.js';

test('Artist - Title (Year)', () => {
  assert.deepEqual(parseFilename('Daft Punk - Around the World (2007).mp3'), {
    artist: 'Daft Punk', title: 'Around the World', year: 2007,
  });
});

test('Artist - Title (no year)', () => {
  assert.deepEqual(parseFilename('Daft Punk - Around the World.mp3'), {
    artist: 'Daft Punk', title: 'Around the World', year: null,
  });
});

test('Title (Year), no artist', () => {
  assert.deepEqual(parseFilename('Around the World (2007).flac'), {
    artist: null, title: 'Around the World', year: 2007,
  });
});

test('Title only', () => {
  assert.deepEqual(parseFilename('Around the World.wav'), {
    artist: null, title: 'Around the World', year: null,
  });
});

test('strips leading track number "01 "', () => {
  assert.equal(parseFilename('01 Around the World.mp3').title, 'Around the World');
});

test('strips leading track number "01. "', () => {
  assert.equal(parseFilename('01. Around the World.mp3').title, 'Around the World');
});

test('strips leading track number "1. "', () => {
  assert.equal(parseFilename('1. Around the World.mp3').title, 'Around the World');
});

test('strips disc prefix then track number', () => {
  assert.equal(parseFilename('(Disc 2) 01 - Track Name.mp3').title, 'Track Name');
});

test('year-range guard — pre-1900 not treated as year', () => {
  const r = parseFilename('Vintage Song (1850).mp3');
  assert.equal(r.year, null);
  assert.equal(r.title, 'Vintage Song (1850)'); // not sliced off
});

test('does not eat a 4-digit year-prefixed title as a track number', () => {
  const r = parseFilename('2024 Year in Review.mp3');
  assert.equal(r.title, '2024 Year in Review');
});

test('artist split only on first " - "', () => {
  const r = parseFilename('Artist - Title - With Dash.mp3');
  assert.equal(r.artist, 'Artist');
  assert.equal(r.title, 'Title - With Dash');
});

test('falls back to filename stem when title would be empty', () => {
  // Defensive: a pathological all-stripped name still yields a non-empty title
  const r = parseFilename('01.mp3');
  assert.ok(r.title.length > 0);
});
