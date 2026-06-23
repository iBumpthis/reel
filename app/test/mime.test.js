/**
 * Tests for services/mime.js — the ext→MIME map and classification helpers.
 *
 * Coverage matters now because v1.19.0 surfaces `mimeForExt(row.ext)` directly
 * in the GET /api/media/:id payload (the File Info "Container" row). The frontend
 * renders `EXT · <mime>` when a MIME resolves and a bare `EXT` when it doesn't,
 * so the two contracts this file guards are:
 *   1. every SUPPORTED extension resolves to a MIME (Container is never bare for
 *      a real, playable file), and
 *   2. an unknown/empty extension returns null (Container shows a clean `EXT`,
 *      never `EXT · null`).
 *
 * Pure logic, no DB — always runs (no better-sqlite3 skip).
 *
 * Run: npm test   (or: node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mimeForExt, mediaTypeForExt, AUDIO_EXTS, VIDEO_EXTS } from '../services/mime.js';

test('mimeForExt — representative video + audio containers', () => {
  assert.equal(mimeForExt('mp4'), 'video/mp4');
  assert.equal(mimeForExt('mkv'), 'video/x-matroska');
  assert.equal(mimeForExt('webm'), 'video/webm');
  assert.equal(mimeForExt('mp3'), 'audio/mpeg');
  assert.equal(mimeForExt('aac'), 'audio/aac');
  assert.equal(mimeForExt('flac'), 'audio/flac');
});

test('mimeForExt — unknown / empty ext returns null (File Info shows bare EXT, not "· null")', () => {
  assert.equal(mimeForExt('xyz'), null);
  assert.equal(mimeForExt('zip'), null);
  assert.equal(mimeForExt(''), null);
});

test('mimeForExt — every SUPPORTED extension resolves (Container never bare for a real file)', () => {
  for (const ext of [...VIDEO_EXTS, ...AUDIO_EXTS]) {
    assert.ok(mimeForExt(ext), `expected a MIME for .${ext}`);
  }
});

test('mediaTypeForExt — classifies audio vs video, null for unknown', () => {
  assert.equal(mediaTypeForExt('mp4'), 'video');
  assert.equal(mediaTypeForExt('mov'), 'video');
  assert.equal(mediaTypeForExt('aac'), 'audio');
  assert.equal(mediaTypeForExt('opus'), 'audio');
  assert.equal(mediaTypeForExt('xyz'), null);
});

test('AUDIO_EXTS and VIDEO_EXTS are disjoint (no ext classifies as both)', () => {
  const overlap = [...AUDIO_EXTS].filter(e => VIDEO_EXTS.has(e));
  assert.deepEqual(overlap, [], `extensions in both sets: ${overlap.join(', ')}`);
});

test('mimeForExt agrees with mediaTypeForExt on the audio/video prefix', () => {
  // A supported ext's MIME prefix should match its classified media type — guards
  // against a future map edit that puts e.g. an audio ext under a video/ MIME.
  for (const ext of [...VIDEO_EXTS, ...AUDIO_EXTS]) {
    const mime = mimeForExt(ext);
    const type = mediaTypeForExt(ext);
    assert.ok(mime.startsWith(`${type}/`), `.${ext}: ${mime} should start with "${type}/"`);
  }
});
