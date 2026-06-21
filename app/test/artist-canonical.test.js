/**
 * Tests for the artist canonical layer — C1 casing fold (migration 006).
 *
 * Covers the read-path grouping (facet/filter resolve through
 * COALESCE(canonical_id, id)), the scan-time fold-on-insert seam, the one-time
 * backfillCanonical pass (most-used anchor policy, idempotent), the player
 * member payload ({ name, canonical }) that keeps deep links landing on the
 * canonical view, and the config gate that degrades to v1.15 per-casing browse.
 *
 * DB-level only; SKIPS cleanly when better-sqlite3 isn't built, same pattern as
 * the other DB tests. The SQL constants mirror routes/tags.js, routes/library.js
 * and routes/media.js so a drift in the routes shows up here.
 *
 * media.artist (display/FTS/sort) is never touched by any of this — the fold is
 * a browse-grouping concern only, and casing variants remain distinct rows.
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
  backfillCanonical,
} from '../services/artists.js';
import { parseFilename } from '../services/metadata.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'db', 'migrations');

let Database = null;
let loadError = null;
try {
  ({ default: Database } = await import('better-sqlite3'));
} catch (err) {
  loadError = err;
}
const skip = Database
  ? false
  : `better-sqlite3 native module unavailable (${loadError?.code || loadError?.message}) — canonical fold DB tests skipped`;

// SQL mirrored from the live routes.
const FACET_SQL = `
  SELECT can.name AS name, can.kind AS kind, COUNT(DISTINCT m.id) AS count
  FROM media m
  JOIN media_artists ma ON ma.media_id = m.id
  JOIN artists a   ON a.id  = ma.artist_id
  JOIN artists can ON can.id = COALESCE(a.canonical_id, a.id)
  WHERE m.present = 1
  GROUP BY can.id
  ORDER BY can.name ASC
`;
const FILTER_SQL = `
  SELECT m.id, m.artist
  FROM media m
  WHERE m.present = 1
    AND EXISTS (SELECT 1 FROM media_artists ma
                JOIN artists a   ON a.id  = ma.artist_id
                JOIN artists can ON can.id = COALESCE(a.canonical_id, a.id)
                WHERE ma.media_id = m.id AND can.name = @artist)
  ORDER BY m.id
`;
const MEMBERS_SQL = `
  SELECT a.name AS name, can.name AS canonical, a.kind AS kind
  FROM media_artists ma
  JOIN artists a   ON a.id  = ma.artist_id
  JOIN artists can ON can.id = COALESCE(a.canonical_id, a.id)
  WHERE ma.media_id = ?
`;

/** Fresh in-memory DB with migrations 001–006 applied, mirroring db/index.js. */
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
    '006-artist-canonical.sql',
  ]) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  db.exec(`INSERT INTO libraries (id, name, path) VALUES (1, 'Music', '/m')`);
  return db;
}

const insertMedia = (db) => db.prepare(`
  INSERT INTO media (library_id, abs_path, rel_path, filename, ext, media_type,
                     size_bytes, mtime_ms, artist, present, last_seen_scan)
  VALUES (1, @abs, @rel, @fn, 'mp4', 'video', 1, 1, @artist, @present, 1)
`);

/** Add a media row + sync its relational artist links via the real seam. */
function addMedia(db, stmts, filename, artist, present = 1) {
  const id = Number(insertMedia(db).run({
    abs: '/m/' + filename, rel: filename, fn: filename, artist, present,
  }).lastInsertRowid);
  syncArtistLinks(id, deriveArtistNames(parseFilename(filename), artist), stmts);
  return id;
}

const facetMap = (db) => Object.fromEntries(
  db.prepare(FACET_SQL).all().map(r => [r.name, r.count])
);
const filterBy = (db, name) => db.prepare(FILTER_SQL).all({ artist: name }).map(r => r.artist);

// ============================================================
// Fold-on-insert + facet/filter grouping
// ============================================================

test('fold — casing variants fold to one canonical facet entry; counts summed', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'REZZ - B (2024).mp4', 'REZZ');
  addMedia(db, stmts, 'rezz - C (2024).mp4', 'rezz');
  addMedia(db, stmts, 'Wooli - D (2024).mp4', 'Wooli');

  const fm = facetMap(db);
  assert.equal(fm.Rezz, 3, 'three casings counted under one canonical');
  assert.equal(fm.REZZ, undefined);
  assert.equal(fm.rezz, undefined);
  assert.equal(fm.Wooli, 1, 'a distinct artist is unaffected');
  db.close();
});

test('fold — filter by canonical returns every casing; a variant casing returns none', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'REZZ - B (2024).mp4', 'REZZ');
  assert.deepEqual(filterBy(db, 'Rezz'), ['Rezz', 'REZZ']);
  assert.deepEqual(filterBy(db, 'REZZ'), [], 'facet only emits the canonical name');
  db.close();
});

test('fold — soft-deleted variants are excluded from canonical counts', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'REZZ - Gone (2019).mp4', 'REZZ', 0); // missing
  assert.equal(facetMap(db).Rezz, 1, 'only the present file counts');
  assert.deepEqual(filterBy(db, 'Rezz'), ['Rezz']);
  db.close();
});

test('fold — casing variants remain distinct identity rows (no merge/delete)', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'REZZ - B (2024).mp4', 'REZZ');
  const rows = db.prepare("SELECT name, canonical_id FROM artists WHERE lower(name) = 'rezz' ORDER BY name").all();
  assert.equal(rows.length, 2, 'both Rezz and REZZ rows persist');
  const rezzId = db.prepare("SELECT id FROM artists WHERE name = 'Rezz'").get().id;
  const variant = rows.find(r => r.name === 'REZZ');
  assert.equal(variant.canonical_id, rezzId, 'REZZ points at Rezz as canonical');
  db.close();
});

// ============================================================
// Player member payload (Hazard 1: deep links land on canonical)
// ============================================================

test('members — payload carries literal name + canonical for the player link', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  const variantId = addMedia(db, stmts, 'REZZ - B (2024).mp4', 'REZZ');
  const mem = db.prepare(MEMBERS_SQL).all(variantId);
  assert.equal(mem.length, 1);
  assert.equal(mem[0].name, 'REZZ', 'literal casing for the display-string walk');
  assert.equal(mem[0].canonical, 'Rezz', 'canonical casing for the href target');
  db.close();
});

// ============================================================
// backfillCanonical: most-used anchor, idempotent, config gate
// ============================================================

test('backfill — most-used casing wins the canonical over first-seen', { skip }, () => {
  const db = freshDb();
  const cfg = { artistCanonicalFold: true };
  const stmts = makeArtistStmts(db, cfg);
  // First-seen is REZZ (1 file); most-used is Rezz (3 files).
  addMedia(db, stmts, 'REZZ - First (2024).mp4', 'REZZ');
  addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'Rezz - B (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'Rezz - C (2024).mp4', 'Rezz');

  const before = db.prepare("SELECT name FROM artists WHERE lower(name)='rezz' AND canonical_id IS NULL").all().map(r => r.name);
  assert.deepEqual(before, ['REZZ'], 'inline fold made first-seen REZZ the anchor');

  backfillCanonical(db, cfg);
  const after = db.prepare("SELECT name FROM artists WHERE lower(name)='rezz' AND canonical_id IS NULL").all().map(r => r.name);
  assert.deepEqual(after, ['Rezz'], 'backfill re-anchored to the most-used casing');
  assert.equal(facetMap(db).Rezz, 4, 'all four files now under canonical Rezz');
  db.close();
});

test('backfill — idempotent (second run is a stable no-op)', { skip }, () => {
  const db = freshDb();
  const cfg = { artistCanonicalFold: true };
  const stmts = makeArtistStmts(db, cfg);
  addMedia(db, stmts, 'REZZ - First (2024).mp4', 'REZZ');
  addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'Rezz - B (2024).mp4', 'Rezz');

  backfillCanonical(db, cfg);
  const snap1 = db.prepare('SELECT id, canonical_id, canonical_source FROM artists ORDER BY id').all();
  backfillCanonical(db, cfg);
  const snap2 = db.prepare('SELECT id, canonical_id, canonical_source FROM artists ORDER BY id').all();
  assert.deepEqual(snap2, snap1, 'canonical assignment is stable across re-runs');
  db.close();
});

test('backfill — a manual pin is respected and not clobbered', { skip }, () => {
  const db = freshDb();
  const cfg = { artistCanonicalFold: true };
  const stmts = makeArtistStmts(db, cfg);
  addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'Rezz - B (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'REZZ - C (2024).mp4', 'REZZ');
  // Hand-pin REZZ as the canonical (reserved future-override shape).
  const rezzId = db.prepare("SELECT id FROM artists WHERE name='Rezz'").get().id;
  const REZZid = db.prepare("SELECT id FROM artists WHERE name='REZZ'").get().id;
  db.prepare("UPDATE artists SET canonical_id=NULL, canonical_source='manual' WHERE id=?").run(REZZid);
  db.prepare("UPDATE artists SET canonical_id=?, canonical_source='manual' WHERE id=?").run(REZZid, rezzId);

  backfillCanonical(db, cfg);
  const anchor = db.prepare("SELECT name FROM artists WHERE lower(name)='rezz' AND canonical_id IS NULL").all().map(r => r.name);
  assert.deepEqual(anchor, ['REZZ'], 'manual anchor survives the auto pass despite Rezz being most-used');
  db.close();
});

test('fold OFF — config gate degrades to per-casing browse (v1.15 behaviour)', { skip }, () => {
  const db = freshDb();
  const cfg = { artistCanonicalFold: false };
  const stmts = makeArtistStmts(db, cfg);
  addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'REZZ - B (2024).mp4', 'REZZ');
  backfillCanonical(db, cfg); // returns early, no-op
  const fm = facetMap(db);
  assert.equal(fm.Rezz, 1);
  assert.equal(fm.REZZ, 1, 'casings stay separate when folding is disabled');
  assert.deepEqual(filterBy(db, 'REZZ'), ['REZZ']);
  db.close();
});

test('fold — a lone artist is self-canonical (canonical_id NULL)', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  addMedia(db, stmts, 'Eptic - Show (2024).mp4', 'Eptic');
  const row = db.prepare("SELECT canonical_id FROM artists WHERE name='Eptic'").get();
  assert.equal(row.canonical_id, null, 'no variants ⇒ own canonical');
  assert.equal(facetMap(db).Eptic, 1);
  db.close();
});
