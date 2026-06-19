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
    artist: 'Daft Punk', artists: ['Daft Punk'], alias: null, isB2B: false,
    title: 'Around the World', year: 2007,
  });
});

test('Artist - Title (no year)', () => {
  assert.deepEqual(parseFilename('Daft Punk - Around the World.mp3'), {
    artist: 'Daft Punk', artists: ['Daft Punk'], alias: null, isB2B: false,
    title: 'Around the World', year: null,
  });
});

test('Title (Year), no artist', () => {
  assert.deepEqual(parseFilename('Around the World (2007).flac'), {
    artist: null, artists: [], alias: null, isB2B: false,
    title: 'Around the World', year: 2007,
  });
});

test('Title only', () => {
  assert.deepEqual(parseFilename('Around the World.wav'), {
    artist: null, artists: [], alias: null, isB2B: false,
    title: 'Around the World', year: null,
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

// ----------------------------------------------------------------------------
// Back-to-back (b2b) parsing
// ----------------------------------------------------------------------------

test('b2b — two artists split, b2b preserved in display by default', () => {
  const r = parseFilename('Excision b2b Wooli - Lost Lands (2024).mp4');
  assert.equal(r.isB2B, true);
  assert.deepEqual(r.artists, ['Excision', 'Wooli']);
  assert.equal(r.artist, 'Excision b2b Wooli'); // default join preserves "b2b"
  assert.equal(r.title, 'Lost Lands');
  assert.equal(r.year, 2024);
});

test('b2b — three artists split', () => {
  const r = parseFilename('Excision b2b Wooli b2b Crankdat - Lost Lands (2024).mp4');
  assert.equal(r.isB2B, true);
  assert.deepEqual(r.artists, ['Excision', 'Wooli', 'Crankdat']);
  assert.equal(r.artist, 'Excision b2b Wooli b2b Crankdat');
});

test('b2b — custom display join (piped)', () => {
  const r = parseFilename('Excision b2b Wooli b2b Crankdat - Lost Lands (2024).mp4', { b2bJoin: ' | ' });
  assert.deepEqual(r.artists, ['Excision', 'Wooli', 'Crankdat']);
  assert.equal(r.artist, 'Excision | Wooli | Crankdat');
});

test('b2b — case-insensitive delimiter', () => {
  const r = parseFilename('Excision B2B Wooli - Lost Lands (2024).mp4');
  assert.equal(r.isB2B, true);
  assert.deepEqual(r.artists, ['Excision', 'Wooli']);
});

test('b2b — solo set is not flagged, artists has the one artist', () => {
  const r = parseFilename('Eptic - Lost Lands (2025).mp4');
  assert.equal(r.isB2B, false);
  assert.deepEqual(r.artists, ['Eptic']);
  assert.equal(r.artist, 'Eptic');
});

test('b2b — substring "b2b" inside a name does not trigger a split', () => {
  // No whitespace-bounded " b2b " delimiter present.
  const r = parseFilename('Subtronics - Cyclops b2bx Theory (2023).mp4');
  assert.equal(r.isB2B, false);
  assert.deepEqual(r.artists, ['Subtronics']);
});

test('b2b — no-artist file (no dash) is not split', () => {
  const r = parseFilename('Excision b2b Wooli.mp4');
  assert.equal(r.isB2B, false);
  assert.equal(r.artist, null);
  assert.deepEqual(r.artists, []);
});

// ----------------------------------------------------------------------------
// Group/act alias — trailing "[Name]" on the artist chunk
// ----------------------------------------------------------------------------

test('alias — b2b duo with bracketed alias', () => {
  const r = parseFilename('Crankdat b2b Wooli [WANKDAT] - Ultra Music Festival Miami (2025).mp4');
  assert.equal(r.artist, 'Crankdat b2b Wooli'); // alias stripped from display
  assert.deepEqual(r.artists, ['Crankdat', 'Wooli']);
  assert.equal(r.alias, 'WANKDAT');
  assert.equal(r.isB2B, true);
  assert.equal(r.title, 'Ultra Music Festival Miami');
  assert.equal(r.year, 2025);
});

test('alias — named trio (all members + act name)', () => {
  const r = parseFilename('Eptic b2b Space Laces b2b SVDDEN DEATH [MASTERHVND] - Some Event (2024).mp4');
  assert.deepEqual(r.artists, ['Eptic', 'Space Laces', 'SVDDEN DEATH']);
  assert.equal(r.alias, 'MASTERHVND');
  assert.equal(r.artist, 'Eptic b2b Space Laces b2b SVDDEN DEATH');
  assert.equal(r.title, 'Some Event');
});

test('alias — bracket in the event/title is NOT treated as an alias', () => {
  const r = parseFilename('Crankdat b2b Wooli [WANKDAT] - Ultra [Mainstage] (2025).mp4');
  assert.equal(r.alias, 'WANKDAT');            // artist-position bracket → alias
  assert.equal(r.title, 'Ultra [Mainstage]');  // title-position bracket → literal
});

test('alias — absent when no bracket present', () => {
  const r = parseFilename('Excision b2b Wooli - Lost Lands (2024).mp4');
  assert.equal(r.alias, null);
  assert.deepEqual(r.artists, ['Excision', 'Wooli']);
});

test('alias — solo artist with a bracketed alias', () => {
  const r = parseFilename('Virtual Riot [VIP Set] - Lost Lands (2024).mp4');
  assert.equal(r.artist, 'Virtual Riot');
  assert.equal(r.alias, 'VIP Set');
  assert.equal(r.isB2B, false);
});
