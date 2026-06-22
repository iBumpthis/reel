/**
 * Tests for the v1.18.0 filter bar additions to GET /api/library and the new
 * GET /api/library/random ("Surprise Me"):
 *   - the `markers=has|none` presence predicate
 *   - that the random route shares the SAME filter predicate as the list route
 *     (the whole point of factoring buildFilters() — the two must never drift)
 *   - that both compose with the pre-existing type / present filters
 *
 * As with library-artists.test.js, the route modules need a Fastify instance to
 * load and the value under test is the SQL, so the predicates are inlined here
 * kept byte-aligned with routes/library.js (buildFilters). DB-backed → SKIPS
 * cleanly when better-sqlite3 isn't built; the SQL is additionally validated
 * end-to-end against the real 001–006 migration chain via node:sqlite in-sandbox.
 *
 * Run: npm test   (or: node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', 'db', 'migrations');

// ============================================================
// SQL under test — kept aligned with routes/library.js buildFilters()
// ============================================================

// The marker-presence branches. No bound param — the predicate is fixed per
// branch (markers === 'has' | 'none').
const MARKERS_HAS = 'EXISTS (SELECT 1 FROM markers mk WHERE mk.media_id = m.id)';
const MARKERS_NONE = 'NOT EXISTS (SELECT 1 FROM markers mk WHERE mk.media_id = m.id)';

/** Compose a SELECT with the default present=1 + an extra condition list. */
function listSql(extra = []) {
  const conds = ['m.present = 1', ...extra];
  return `SELECT m.id, m.filename FROM media m
          JOIN libraries l ON l.id = m.library_id
          WHERE ${conds.join(' AND ')}
          ORDER BY m.id`;
}

/** The random route's query shape: same WHERE, ORDER BY RANDOM() LIMIT 1. */
function randomSql(extra = []) {
  const conds = ['m.present = 1', ...extra];
  return `SELECT m.id FROM media m
          JOIN libraries l ON l.id = m.library_id
          WHERE ${conds.join(' AND ')}
          ORDER BY RANDOM() LIMIT 1`;
}

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
  : `better-sqlite3 native module unavailable (${loadError?.code || loadError?.message}) — library filter DB tests skipped`;

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
                     size_bytes, mtime_ms, present, last_seen_scan)
  VALUES (1, @abs, @rel, @fn, @ext, @type, 1, 1, @present, 1)
`);
const insertMarker = (db) => db.prepare(`
  INSERT INTO markers (media_id, start_seconds, end_seconds, label)
  VALUES (@mid, @start, @end, @label)
`);

/** Insert a media row; optionally give it `markerCount` markers. */
function addMedia(db, filename, { type = 'video', ext = 'mp4', present = 1, markerCount = 0 } = {}) {
  const id = insertMedia(db).run({
    abs: '/m/' + filename, rel: filename, fn: filename, ext, type, present,
  }).lastInsertRowid;
  for (let i = 0; i < markerCount; i++) {
    insertMarker(db).run({ mid: id, start: i * 10, end: i * 10 + 5, label: `M${i}` });
  }
  return id;
}

const names = (db, sql) => db.prepare(sql).all().map(r => r.filename);

// ------------------------------------------------------------
// markers=has / markers=none
// ------------------------------------------------------------

test('markers=has — only media with at least one marker', { skip }, () => {
  const db = freshDb();
  addMedia(db, 'with-one.mp4', { markerCount: 1 });
  addMedia(db, 'with-three.mp4', { markerCount: 3 });
  addMedia(db, 'bare.mp4', { markerCount: 0 });
  assert.deepEqual(names(db, listSql([MARKERS_HAS])), ['with-one.mp4', 'with-three.mp4']);
  db.close();
});

test('markers=none — only media with zero markers', { skip }, () => {
  const db = freshDb();
  addMedia(db, 'with-one.mp4', { markerCount: 1 });
  addMedia(db, 'bare-a.mp4', { markerCount: 0 });
  addMedia(db, 'bare-b.aac', { type: 'audio', ext: 'aac', markerCount: 0 });
  assert.deepEqual(names(db, listSql([MARKERS_NONE])), ['bare-a.mp4', 'bare-b.aac']);
  db.close();
});

test('markers=has — a soft-deleted (present=0) marked file is excluded', { skip }, () => {
  const db = freshDb();
  addMedia(db, 'live.mp4', { markerCount: 2 });
  addMedia(db, 'gone.mp4', { markerCount: 2, present: 0 });
  assert.deepEqual(names(db, listSql([MARKERS_HAS])), ['live.mp4'], 'present filter still applies');
  db.close();
});

test('markers has/none partition the present set exactly', { skip }, () => {
  const db = freshDb();
  addMedia(db, 'a.mp4', { markerCount: 1 });
  addMedia(db, 'b.mp4', { markerCount: 0 });
  addMedia(db, 'c.mp4', { markerCount: 5 });
  addMedia(db, 'd.mp4', { markerCount: 0 });
  const has = names(db, listSql([MARKERS_HAS]));
  const none = names(db, listSql([MARKERS_NONE]));
  assert.deepEqual(has, ['a.mp4', 'c.mp4']);
  assert.deepEqual(none, ['b.mp4', 'd.mp4']);
  assert.deepEqual([...has, ...none].sort(), ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4'], 'no overlap, no gap');
  db.close();
});

// ------------------------------------------------------------
// composition with the type filter
// ------------------------------------------------------------

test('type=audio + markers=none compose (AND)', { skip }, () => {
  const db = freshDb();
  addMedia(db, 'song.aac', { type: 'audio', ext: 'aac', markerCount: 0 });
  addMedia(db, 'song-marked.aac', { type: 'audio', ext: 'aac', markerCount: 1 });
  addMedia(db, 'set.mp4', { type: 'video', markerCount: 0 });
  const sql = listSql(['m.media_type = @type', MARKERS_NONE]);
  const got = db.prepare(sql).all({ type: 'audio' }).map(r => r.filename);
  assert.deepEqual(got, ['song.aac'], 'audio AND unmarked only');
  db.close();
});

// ------------------------------------------------------------
// random route shares the same predicate
// ------------------------------------------------------------

test('random — picks from the SAME filtered set as the list route', { skip }, () => {
  const db = freshDb();
  addMedia(db, 'marked-1.mp4', { markerCount: 1 });
  addMedia(db, 'marked-2.mp4', { markerCount: 2 });
  addMedia(db, 'bare.mp4', { markerCount: 0 });
  // The eligible set under markers=has is {marked-1, marked-2}. Drawing many
  // times, every pick must be a member — never the bare file.
  const eligible = new Set(names(db, listSql([MARKERS_HAS])));
  const stmt = db.prepare(randomSql([MARKERS_HAS]));
  for (let i = 0; i < 50; i++) {
    const row = stmt.get();
    assert.ok(row, 'a match exists, so a row is returned');
    const fn = db.prepare('SELECT filename FROM media WHERE id = ?').get(row.id).filename;
    assert.ok(eligible.has(fn), `random pick ${fn} is within the filtered set`);
  }
  db.close();
});

test('random — no match returns undefined (→ route emits id:null)', { skip }, () => {
  const db = freshDb();
  addMedia(db, 'bare.mp4', { markerCount: 0 });
  // markers=has over a library with no marked files → empty set.
  const row = db.prepare(randomSql([MARKERS_HAS])).get();
  assert.equal(row, undefined, 'no row; the route maps this to { id: null }');
  db.close();
});

test('random — respects type + present like the list route', { skip }, () => {
  const db = freshDb();
  addMedia(db, 'keep.aac', { type: 'audio', ext: 'aac', markerCount: 0 });
  addMedia(db, 'wrong-type.mp4', { type: 'video', markerCount: 0 });
  addMedia(db, 'missing.aac', { type: 'audio', ext: 'aac', markerCount: 0, present: 0 });
  const stmt = db.prepare(randomSql(['m.media_type = @type']));
  for (let i = 0; i < 25; i++) {
    const row = stmt.get({ type: 'audio' });
    const fn = db.prepare('SELECT filename FROM media WHERE id = ?').get(row.id).filename;
    assert.equal(fn, 'keep.aac', 'only the present audio file is ever drawn');
  }
  db.close();
});
