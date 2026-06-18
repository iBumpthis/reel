/**
 * DB-level tests for soft-delete / orphan retention (migration 004).
 *
 * The durability guarantee is a database-level property: marking a media row
 * missing must NOT cascade away its markers/tags/metadata, while an explicit
 * purge MUST. These run against real SQLite via better-sqlite3, applying the
 * actual migration files (001–004) into an in-memory DB so they validate the
 * SQL that ships.
 *
 * better-sqlite3 is a native module; if it isn't built (e.g. `npm test`
 * without `npm install`), the suite SKIPs cleanly rather than failing.
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

let Database = null;
let loadError = null;
try {
  ({ default: Database } = await import('better-sqlite3'));
} catch (err) {
  loadError = err;
}
const skip = Database
  ? false
  : `better-sqlite3 native module unavailable (${loadError?.code || loadError?.message}) — soft-delete DB tests skipped`;

/** Fresh in-memory DB with migrations 001–004 applied, mirroring db/index.js. */
function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON'); // CASCADE only fires with this ON
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
  ]) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  db.exec(`INSERT INTO libraries (id, name, path) VALUES (1, 'Music', '/m')`);
  return db;
}

// Mirrors the scanner upsert's reactivation-relevant columns + ON CONFLICT.
const upsert = (db) => db.prepare(`
  INSERT INTO media (library_id, abs_path, rel_path, filename, ext, media_type,
                     size_bytes, mtime_ms, last_seen_scan)
  VALUES (1, @abs, @rel, @fn, 'mp3', 'audio', @sz, @mt, @scan)
  ON CONFLICT(abs_path) DO UPDATE SET
    rel_path = @rel, filename = @fn, size_bytes = @sz, mtime_ms = @mt,
    last_seen_scan = @scan, present = 1, missing_since = NULL,
    updated_at = datetime('now')
`);

const markMissing = (db) => db.prepare(
  `UPDATE media SET present = 0,
                    missing_since = COALESCE(missing_since, datetime('now'))
   WHERE library_id = ? AND last_seen_scan < ? AND present = 1`
);

function seedWithChildData(db) {
  const id = upsert(db).run({ abs: '/m/a.mp3', rel: 'a.mp3', fn: 'a.mp3', sz: 100, mt: 1, scan: 1 }).lastInsertRowid;
  db.prepare(`UPDATE media SET title = 'Hand Titled', artist = 'Me' WHERE id = ?`).run(id);
  db.prepare(`INSERT INTO markers (media_id, start_seconds, label) VALUES (?, 12.5, 'Drop')`).run(id);
  const tagId = db.prepare(`INSERT INTO tags (name, normalized) VALUES ('Live', 'live')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO media_tags (media_id, tag_id) VALUES (?, ?)`).run(id, tagId);
  return id;
}

const markerCount = (db, id) => db.prepare(`SELECT COUNT(*) AS n FROM markers WHERE media_id = ?`).get(id).n;
const tagLinkCount = (db, id) => db.prepare(`SELECT COUNT(*) AS n FROM media_tags WHERE media_id = ?`).get(id).n;

// ============================================================
// Migration shape
// ============================================================
test('004 — existing rows backfill to present=1, missing_since NULL', { skip }, () => {
  const db = freshDb();
  const id = upsert(db).run({ abs: '/m/x.mp3', rel: 'x.mp3', fn: 'x.mp3', sz: 1, mt: 1, scan: 1 }).lastInsertRowid;
  const row = db.prepare(`SELECT present, missing_since FROM media WHERE id = ?`).get(id);
  assert.equal(row.present, 1);
  assert.equal(row.missing_since, null);
  db.close();
});

// ============================================================
// Core guarantee: soft-delete retains child data, purge cascades it away
// ============================================================
test('soft-delete (present=0) retains markers, tags, and metadata', { skip }, () => {
  const db = freshDb();
  const id = seedWithChildData(db);

  // Simulate a scan pass that did NOT see this file (newer scan id).
  const changed = markMissing(db).run(1, 2).changes;
  assert.equal(changed, 1, 'one row transitioned to missing');

  const row = db.prepare(`SELECT present, missing_since, title, artist FROM media WHERE id = ?`).get(id);
  assert.equal(row.present, 0);
  assert.ok(row.missing_since, 'missing_since stamped');
  assert.equal(row.title, 'Hand Titled', 'user metadata retained');
  assert.equal(row.artist, 'Me');
  assert.equal(markerCount(db, id), 1, 'marker retained (no cascade)');
  assert.equal(tagLinkCount(db, id), 1, 'tag link retained (no cascade)');
  db.close();
});

test('purge (hard DELETE) cascades markers + tag links away', { skip }, () => {
  const db = freshDb();
  const id = seedWithChildData(db);
  markMissing(db).run(1, 2);

  const purged = db.prepare(`DELETE FROM media WHERE present = 0`).run().changes;
  assert.equal(purged, 1);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM media WHERE id = ?`).get(id).n, 0);
  assert.equal(markerCount(db, id), 0, 'markers cascaded');
  assert.equal(tagLinkCount(db, id), 0, 'tag links cascaded');
  db.close();
});

// ============================================================
// Reactivation: same path reappears -> present=1, missing_since cleared,
// child data still intact (it was never removed).
// ============================================================
test('reactivation — same abs_path re-upsert flips present back, keeps child data', { skip }, () => {
  const db = freshDb();
  const id = seedWithChildData(db);
  markMissing(db).run(1, 2);
  assert.equal(db.prepare(`SELECT present FROM media WHERE id = ?`).get(id).present, 0);

  // Next scan walks the file again at the same path.
  upsert(db).run({ abs: '/m/a.mp3', rel: 'a.mp3', fn: 'a.mp3', sz: 100, mt: 1, scan: 3 });

  const row = db.prepare(`SELECT id, present, missing_since FROM media WHERE abs_path = '/m/a.mp3'`).get();
  assert.equal(row.id, id, 'same row, not a new insert');
  assert.equal(row.present, 1, 'reactivated');
  assert.equal(row.missing_since, null, 'missing_since cleared');
  assert.equal(markerCount(db, id), 1, 'markers survived the whole cycle');
  assert.equal(tagLinkCount(db, id), 1, 'tags survived the whole cycle');
  db.close();
});

test('mark-missing only counts fresh transitions (idempotent across scans)', { skip }, () => {
  const db = freshDb();
  seedWithChildData(db);
  assert.equal(markMissing(db).run(1, 2).changes, 1, 'first miss transitions');
  assert.equal(markMissing(db).run(1, 3).changes, 0, 'already-missing row not re-counted');
  db.close();
});

// ============================================================
// FTS interaction: present is a non-indexed column, so flipping it fires no
// trigger — the missing row REMAINS searchable in the index. This is why the
// library query filters present=1 at query level rather than mutating FTS.
// ============================================================
test('soft-delete leaves the row in the FTS index (query-level filtering required)', { skip }, () => {
  const db = freshDb();
  const id = seedWithChildData(db); // title 'Hand Titled'
  markMissing(db).run(1, 2);

  const ftsHit = db.prepare(
    `SELECT rowid FROM media_fts WHERE media_fts MATCH 'Hand*'`
  ).all().map(r => r.rowid);
  assert.ok(ftsHit.includes(id), 'missing row still present in FTS index');

  // The browse/search guard is the present=1 predicate, not the index.
  const visible = db.prepare(
    `SELECT m.id FROM media_fts f JOIN media m ON m.id = f.rowid
     WHERE media_fts MATCH 'Hand*' AND m.present = 1`
  ).all();
  assert.equal(visible.length, 0, 'present=1 filter hides the missing row from search');
  db.close();
});
