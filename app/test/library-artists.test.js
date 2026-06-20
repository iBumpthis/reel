/**
 * Tests for the Stage B artist READ paths (v1.15.0): the de-fragmented
 * `/api/artists` facet and the `media_artists`-backed `artist=` filter.
 *
 * Stage A (media-artists.test.js) proved the WRITE side — derive + sync +
 * backfill populate the relation correctly. Stage B repoints the reads at it,
 * so these tests exercise the exact SQL the routes now run:
 *   - facet aggregation over artists ⋈ media_artists ⋈ media (tags.js)
 *   - the EXISTS membership predicate in the library filter (library.js)
 *
 * The SQL is inlined here (kept byte-aligned with the routes) rather than
 * imported, mirroring media-artists.test.js — the route modules need a Fastify
 * instance to load, and the value under test is the query, not the plumbing.
 *
 * DB-backed, so it SKIPS cleanly when better-sqlite3 isn't built (same gate as
 * the other DB tests). The new SQL is additionally validated end-to-end against
 * the real 001–005 migration chain via node:sqlite during development, which is
 * what actually exercises it in-sandbox where the native module is unavailable.
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
} from '../services/artists.js';
import { parseFilename } from '../services/metadata.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'db', 'migrations');

// ============================================================
// SQL under test — kept aligned with routes/tags.js + routes/library.js
// ============================================================

// routes/tags.js — GET /api/artists facet.
const FACET_SQL = `
  SELECT a.name AS name, COUNT(*) AS count
  FROM artists a
  JOIN media_artists ma ON ma.artist_id = a.id
  JOIN media m          ON m.id = ma.media_id
  WHERE m.present = 1
  GROUP BY a.id
  ORDER BY a.name ASC
`;

// routes/library.js — the EXISTS membership predicate the artist filter pushes
// onto the WHERE list, plus the surrounding present filter, as a standalone
// query for the test.
const FILTER_SQL = `
  SELECT m.id, m.artist
  FROM media m
  WHERE m.present = 1
    AND EXISTS (SELECT 1 FROM media_artists ma JOIN artists a ON a.id = ma.artist_id
                WHERE ma.media_id = m.id AND a.name = @artist)
  ORDER BY m.id
`;

// ============================================================
// DB-level (skips cleanly without the native module)
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
  : `better-sqlite3 native module unavailable (${loadError?.code || loadError?.message}) — library/artist read-path DB tests skipped`;

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
                     size_bytes, mtime_ms, artist, present, last_seen_scan)
  VALUES (1, @abs, @rel, @fn, @ext, @type, 1, 1, @artist, @present, 1)
`);

/** Insert a media row AND sync its artist links the way the scanner would. */
function addMedia(db, stmts, filename, artist, present = 1) {
  const id = insertMedia(db).run({
    abs: '/m/' + filename, rel: filename, fn: filename,
    ext: 'mp4', type: 'video', artist, present,
  }).lastInsertRowid;
  syncArtistLinks(id, deriveArtistNames(parseFilename(filename), artist), stmts);
  return id;
}

const facet = (db) => db.prepare(FACET_SQL).all();
const facetMap = (db) => Object.fromEntries(facet(db).map(r => [r.name, r.count]));
const filterBy = (db, name) => db.prepare(FILTER_SQL).all({ artist: name }).map(r => r.artist);

// ------------------------------------------------------------
// Facet (GET /api/artists)
// ------------------------------------------------------------

test('facet — b2b set is de-fragmented: members listed individually, no combined entry', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  addMedia(db, stmts, 'Excision - Lost Lands (2025).mp4', 'Excision');
  addMedia(db, stmts, 'Excision b2b Wooli - LL (2024).mp4', 'Excision b2b Wooli');
  addMedia(db, stmts, 'Wooli - Set (2025).mp4', 'Wooli');

  const fm = facetMap(db);
  assert.equal(fm.Excision, 2, 'Excision counted across its solo + b2b set');
  assert.equal(fm.Wooli, 2, 'Wooli counted across its solo + b2b set');
  assert.ok(!('Excision b2b Wooli' in fm), 'the combined display string is NOT a facet row');
  assert.deepEqual(facet(db).map(r => r.name), ['Excision', 'Wooli'], 'individual artists, sorted');
  db.close();
});

test('facet — soft-deleted (present = 0) media are excluded from counts', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  addMedia(db, stmts, 'Excision - A (2025).mp4', 'Excision');
  addMedia(db, stmts, 'Excision - Gone (2020).mp4', 'Excision', 0); // missing

  assert.equal(facetMap(db).Excision, 1, 'only the present set counts; links retained but hidden');
  db.close();
});

test('facet — an artist whose only sets are all missing drops off the facet', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  addMedia(db, stmts, 'Ghost - Old (2019).mp4', 'Ghost', 0);
  assert.ok(!('Ghost' in facetMap(db)), 'no present media → not listed');
  db.close();
});

test('facet — distinct casings stay distinct facet rows (case-exact, Stage A)', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  addMedia(db, stmts, 'Rezz - X (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'REZZ - Y (2024).mp4', 'REZZ');
  const fm = facetMap(db);
  assert.equal(fm.Rezz, 1);
  assert.equal(fm.REZZ, 1);
  db.close();
});

// ------------------------------------------------------------
// Filter (GET /api/library?artist=)
// ------------------------------------------------------------

test('filter — a b2b participant returns BOTH solo and b2b sets', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  addMedia(db, stmts, 'Excision - Lost Lands (2025).mp4', 'Excision');
  addMedia(db, stmts, 'Excision b2b Wooli - LL (2024).mp4', 'Excision b2b Wooli');
  addMedia(db, stmts, 'Wooli - Set (2025).mp4', 'Wooli');

  assert.deepEqual(filterBy(db, 'Excision'), ['Excision', 'Excision b2b Wooli']);
  assert.deepEqual(filterBy(db, 'Wooli'), ['Excision b2b Wooli', 'Wooli']);
  db.close();
});

test('filter — a pure solo artist returns just their set', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  addMedia(db, stmts, 'Eptic - Show (2024).mp4', 'Eptic');
  assert.deepEqual(filterBy(db, 'Eptic'), ['Eptic']);
  db.close();
});

test('filter — stays case-exact: Rezz and REZZ do not cross-match', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  addMedia(db, stmts, 'Rezz - X (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'REZZ - Y (2024).mp4', 'REZZ');
  assert.deepEqual(filterBy(db, 'Rezz'), ['Rezz']);
  assert.deepEqual(filterBy(db, 'REZZ'), ['REZZ']);
  db.close();
});

test('filter — soft-deleted matches are excluded', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  addMedia(db, stmts, 'Excision - Live (2025).mp4', 'Excision');
  addMedia(db, stmts, 'Excision - Gone (2020).mp4', 'Excision', 0);
  assert.deepEqual(filterBy(db, 'Excision'), ['Excision'], 'missing set not returned');
  db.close();
});

test('filter — a b2b set contributes to each member exactly once', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db);
  const bId = addMedia(db, stmts, 'A b2b B - E (2024).mp4', 'A b2b B');
  // The set surfaces under both members, and is the same single row each time.
  assert.deepEqual(filterBy(db, 'A'), ['A b2b B']);
  assert.deepEqual(filterBy(db, 'B'), ['A b2b B']);
  const linkCount = db.prepare('SELECT COUNT(*) AS n FROM media_artists WHERE media_id = ?').get(bId).n;
  assert.equal(linkCount, 2, 'exactly two membership rows for the pair');
  db.close();
});
