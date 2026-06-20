/**
 * Tests for media_artists normalization (migration 005, Stage A).
 *
 * Two layers:
 *   1. deriveArtistNames — the SHARED pure-logic seam used by both the scanner
 *      dual-write and the backfill. Runs with NO skip (no native module).
 *   2. DB-level: migration 005 shape, the replace-not-accrete link sync, and
 *      the one-time backfill. These apply the real migration files (001–005)
 *      into an in-memory SQLite via better-sqlite3, mirroring db/index.js, and
 *      SKIP cleanly when the native module isn't built (same pattern as the
 *      other DB tests).
 *
 * The accretion regression (test "re-sync with a CHANGED display artist
 * REPLACES, does not accrete") is the reason solo membership is keyed off the
 * stored display column + a diff-and-replace sync rather than the handoff's
 * literal INSERT-OR-IGNORE-on-the-parsed-value: the latter would leave a
 * solo file resolving to 2 artists after one re-scan.
 *
 * Run: npm test   (or: node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  deriveArtistNames,
  makeArtistStmts,
  syncArtistLinks,
  backfillArtists,
} from '../services/artists.js';
import { parseFilename } from '../services/metadata.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'db', 'migrations');

// ============================================================
// Layer 1: deriveArtistNames (pure, always runs)
// ============================================================

test('derive — solo: single member is the display artist', () => {
  const parsed = parseFilename('Eptic - Lost Lands (2025).mp4');
  assert.deepEqual(deriveArtistNames(parsed, 'Eptic'), ['Eptic']);
});

test('derive — solo: display artist (embedded-wins) overrides the parsed name', () => {
  // The scanner passes the STORED media.artist, which may be the embedded tag,
  // not parsed.artist. derive must honour the passed display value verbatim.
  const parsed = parseFilename('eptic - Lost Lands (2025).mp4'); // parsed.artist = 'eptic'
  assert.deepEqual(deriveArtistNames(parsed, 'Eptic Official'), ['Eptic Official']);
});

test('derive — b2b: members come from the filename array, not the display string', () => {
  const parsed = parseFilename('Excision b2b Wooli - Lost Lands (2024).mp4');
  // Even if an embedded tag had set a flat display string, multiplicity is the
  // filename's; derive ignores displayArtist on the b2b branch.
  assert.deepEqual(deriveArtistNames(parsed, 'Excision'), ['Excision', 'Wooli']);
});

test('derive — b2b trio', () => {
  const parsed = parseFilename('Eptic b2b Space Laces b2b SVDDEN DEATH [MASTERHVND] - Event (2024).mp4');
  // Alias is stripped by the parser and is NOT a member in Stage A.
  assert.deepEqual(deriveArtistNames(parsed, 'whatever'), ['Eptic', 'Space Laces', 'SVDDEN DEATH']);
});

test('derive — solo with no/empty display artist yields no members', () => {
  const parsed = parseFilename('Some Title (2024).mp4'); // no artist
  assert.deepEqual(deriveArtistNames(parsed, null), []);
  assert.deepEqual(deriveArtistNames(parsed, ''), []);
});

// ============================================================
// Layer 2: DB-level (skips cleanly without the native module)
// ============================================================

let Database = null;
let loadError = null;
try {
  ({ default: Database } = await import('better-sqlite3'));
} catch (err) {
  loadError = err;
}
const skip = Database
  ? false
  : `better-sqlite3 native module unavailable (${loadError?.code || loadError?.message}) — media_artists DB tests skipped`;

/** Fresh in-memory DB with migrations 001–005 applied, mirroring db/index.js. */
function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT
  )`);
  for (const f of [
    '001-initial.sql',
    '002-album-track.sql',
    '003-fts-triggers.sql',
    '004-soft-delete.sql',
    '005-media-artists.sql',
  ]) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  db.exec(`INSERT INTO libraries (id, name, path) VALUES (1, 'Music', '/m')`);
  return db;
}

const insertMedia = (db) => db.prepare(`
  INSERT INTO media (library_id, abs_path, rel_path, filename, ext, media_type,
                     size_bytes, mtime_ms, artist, last_seen_scan)
  VALUES (1, @abs, @rel, @fn, @ext, @type, 1, 1, @artist, 1)
`);

const memberNames = (db, mediaId) => db.prepare(
  `SELECT a.name FROM media_artists ma JOIN artists a ON a.id = ma.artist_id
   WHERE ma.media_id = ? ORDER BY a.name`
).all(mediaId).map(r => r.name);

const artistRowCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM artists').get().n;

test('005 — migration applies and reports schema_version 5', { skip }, () => {
  const db = freshDb();
  const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
  assert.equal(v, 5);
  // Tables exist and are empty.
  assert.equal(artistRowCount(db), 0);
  db.close();
});

test('sync — solo file resolves to exactly one member', { skip }, () => {
  const db = freshDb();
  const id = insertMedia(db).run({
    abs: '/m/Eptic - Lost Lands (2025).mp4', rel: 'Eptic - Lost Lands (2025).mp4',
    fn: 'Eptic - Lost Lands (2025).mp4', ext: 'mp4', type: 'video', artist: 'Eptic',
  }).lastInsertRowid;
  const stmts = makeArtistStmts(db);
  const parsed = parseFilename('Eptic - Lost Lands (2025).mp4');
  syncArtistLinks(id, deriveArtistNames(parsed, 'Eptic'), stmts);
  assert.deepEqual(memberNames(db, id), ['Eptic']);
  db.close();
});

test('sync — b2b file resolves to N members; set is shared across files', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);

  const fn1 = 'Excision b2b Wooli - Lost Lands (2024).mp4';
  const id1 = insertMedia(db).run({ abs: '/m/' + fn1, rel: fn1, fn: fn1, ext: 'mp4', type: 'video', artist: 'Excision b2b Wooli' }).lastInsertRowid;
  syncArtistLinks(id1, deriveArtistNames(parseFilename(fn1), 'Excision b2b Wooli'), stmts);

  // A solo Excision set should REUSE the same 'Excision' artist row.
  const fn2 = 'Excision - Lost Lands (2025).mp4';
  const id2 = insertMedia(db).run({ abs: '/m/' + fn2, rel: fn2, fn: fn2, ext: 'mp4', type: 'video', artist: 'Excision' }).lastInsertRowid;
  syncArtistLinks(id2, deriveArtistNames(parseFilename(fn2), 'Excision'), stmts);

  assert.deepEqual(memberNames(db, id1), ['Excision', 'Wooli']);
  assert.deepEqual(memberNames(db, id2), ['Excision']);
  // 'Excision' exists once, not twice → the b2b member and the solo set share it.
  // This is the de-fragmentation Stage B will read: Excision's facet count = 2.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM media_artists ma JOIN artists a ON a.id=ma.artist_id WHERE a.name='Excision'`).get().n, 2);
  assert.equal(artistRowCount(db), 2); // Excision, Wooli
  db.close();
});

test('sync — re-sync with a CHANGED display artist REPLACES, does not accrete', { skip }, () => {
  // The regression that drove the design deviation. First scan stored the
  // embedded-tag display; a later derive sees a different value. INSERT-OR-IGNORE
  // would leave the row resolving to 2 artists. Diff-and-replace keeps it at 1.
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  const fn = 'foo - Set (2024).mp3';
  const id = insertMedia(db).run({ abs: '/m/' + fn, rel: fn, fn, ext: 'mp3', type: 'audio', artist: 'Foo Official' }).lastInsertRowid;

  // First pass: embedded display won.
  syncArtistLinks(id, deriveArtistNames(parseFilename(fn), 'Foo Official'), stmts);
  assert.deepEqual(memberNames(db, id), ['Foo Official']);

  // Later pass derives a different display value.
  syncArtistLinks(id, deriveArtistNames(parseFilename(fn), 'Foo'), stmts);
  assert.deepEqual(memberNames(db, id), ['Foo'], 'old member replaced, not accreted');
  db.close();
});

test('sync — distinct casings stay distinct rows in Stage A (no folding)', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  const a = insertMedia(db).run({ abs: '/m/a.mp3', rel: 'a.mp3', fn: 'Rezz - X (2024).mp3', ext: 'mp3', type: 'audio', artist: 'Rezz' }).lastInsertRowid;
  const b = insertMedia(db).run({ abs: '/m/b.mp3', rel: 'b.mp3', fn: 'REZZ - Y (2024).mp3', ext: 'mp3', type: 'audio', artist: 'REZZ' }).lastInsertRowid;
  syncArtistLinks(a, deriveArtistNames(parseFilename('Rezz - X (2024).mp3'), 'Rezz'), stmts);
  syncArtistLinks(b, deriveArtistNames(parseFilename('REZZ - Y (2024).mp3'), 'REZZ'), stmts);
  assert.equal(artistRowCount(db), 2, 'Rezz and REZZ are distinct rows until Stage C');
  db.close();
});

test('sync — idempotent: re-running an unchanged set writes nothing new', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  const fn = 'Eptic - X (2024).mp4';
  const id = insertMedia(db).run({ abs: '/m/' + fn, rel: fn, fn, ext: 'mp4', type: 'video', artist: 'Eptic' }).lastInsertRowid;
  const names = deriveArtistNames(parseFilename(fn), 'Eptic');
  syncArtistLinks(id, names, stmts);
  syncArtistLinks(id, names, stmts);
  syncArtistLinks(id, names, stmts);
  assert.deepEqual(memberNames(db, id), ['Eptic']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_artists WHERE media_id = ?').get(id).n, 1);
  db.close();
});

test('purge (hard DELETE of media) cascades artist links away', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  const fn = 'Eptic - X (2024).mp4';
  const id = insertMedia(db).run({ abs: '/m/' + fn, rel: fn, fn, ext: 'mp4', type: 'video', artist: 'Eptic' }).lastInsertRowid;
  syncArtistLinks(id, deriveArtistNames(parseFilename(fn), 'Eptic'), stmts);
  db.prepare('DELETE FROM media WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM media_artists WHERE media_id = ?').get(id).n, 0);
  db.close();
});

// ------------------------------------------------------------
// backfill
// ------------------------------------------------------------

test('backfill — populates links for existing rows; guarded as one-shot', { skip }, () => {
  const db = freshDb();
  const solo = 'Eptic - Lost Lands (2025).mp4';
  const b2b = 'Excision b2b Wooli - Lost Lands (2024).mp4';
  const noArtist = 'Mystery Set (2024).mp4';
  const sId = insertMedia(db).run({ abs: '/m/' + solo, rel: solo, fn: solo, ext: 'mp4', type: 'video', artist: 'Eptic' }).lastInsertRowid;
  const bId = insertMedia(db).run({ abs: '/m/' + b2b, rel: b2b, fn: b2b, ext: 'mp4', type: 'video', artist: 'Excision b2b Wooli' }).lastInsertRowid;
  const nId = insertMedia(db).run({ abs: '/m/' + noArtist, rel: noArtist, fn: noArtist, ext: 'mp4', type: 'video', artist: null }).lastInsertRowid;

  const r1 = backfillArtists(db, {});
  assert.equal(r1.ran, true);
  assert.equal(r1.rows, 3);
  assert.deepEqual(memberNames(db, sId), ['Eptic']);
  assert.deepEqual(memberNames(db, bId), ['Excision', 'Wooli']);
  assert.deepEqual(memberNames(db, nId), [], 'no-artist row has no links');

  // Guard: a second call is a no-op because the link table is now non-empty.
  const r2 = backfillArtists(db, {});
  assert.equal(r2.ran, false);
  db.close();
});

test('backfill — no-op on an empty media table', { skip }, () => {
  const db = freshDb();
  const r = backfillArtists(db, {});
  assert.equal(r.ran, false);
  assert.equal(r.rows, 0);
  db.close();
});
