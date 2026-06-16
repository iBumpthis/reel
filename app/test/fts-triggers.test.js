/**
 * DB-level tests for the FTS5 trigger-based sync (migration 003).
 *
 * Unlike the other suites in this directory, this one exercises the real
 * SQLite engine via better-sqlite3 — the triggers are a database-level
 * feature, so the only meaningful test runs them against the actual schema.
 * It applies the REAL migration files (001 + 002 + 003) into an in-memory DB,
 * so it validates the SQL that actually ships, not a copy.
 *
 * better-sqlite3 is a native module. In an environment where it hasn't been
 * built (e.g. `npm test` run without `npm install`), these tests SKIP rather
 * than fail, so the zero-dependency pure-logic suites still pass anywhere.
 * In Reel's dev/deploy environments (Node 24, module built) they run for real.
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

// Try to load the native module; skip the suite cleanly if it isn't built.
let Database = null;
let loadError = null;
try {
  ({ default: Database } = await import('better-sqlite3'));
} catch (err) {
  loadError = err;
}
const skip = Database
  ? false
  : `better-sqlite3 native module unavailable (${loadError?.code || loadError?.message}) — DB trigger tests skipped`;

/**
 * Build a fresh in-memory DB with the real migrations applied, mirroring the
 * runner bootstrap in db/index.js (schema_version is created before any
 * migration file runs).
 */
function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    description TEXT
  )`);
  for (const f of ['001-initial.sql', '002-album-track.sql', '003-fts-triggers.sql']) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  db.exec(`INSERT INTO libraries (id, name, path) VALUES (1, 'Music', '/m')`);
  return db;
}

const insertStmt = (db) => db.prepare(`
  INSERT INTO media (library_id, abs_path, rel_path, filename, ext, media_type,
                     size_bytes, mtime_ms, title, artist, album, description, last_seen_scan)
  VALUES (1, @abs, @rel, @fn, 'mp3', 'audio', @sz, @mt, @title, @artist, @album, @desc, @scan)
`);

// Search via the external-content join, returning matched media ids.
const search = (db, q) => db.prepare(
  `SELECT m.id FROM media_fts f JOIN media m ON m.id = f.rowid WHERE media_fts MATCH ? ORDER BY rank`
).all(q).map(r => r.id);

// Row count of the FTS data shadow table — a proxy for index write churn.
const ftsDataCount = (db) => db.prepare(`SELECT COUNT(*) AS n FROM media_fts_data`).get().n;

function seedTwo(db) {
  const ins = insertStmt(db);
  ins.run({ abs: '/m/daft.mp3', rel: 'daft.mp3', fn: 'daft.mp3', sz: 100, mt: 1000,
            title: 'Around the World', artist: 'Daft Punk', album: 'Homework', desc: '', scan: 1 });
  ins.run({ abs: '/m/work.mp3', rel: 'work.mp3', fn: 'work.mp3', sz: 200, mt: 2000,
            title: 'Harder Better', artist: 'Daft Punk', album: 'Discovery', desc: '', scan: 1 });
}

// ============================================================
// AFTER INSERT trigger
// ============================================================
test('migration 003 applies and reaches schema_version 3', { skip }, () => {
  const db = freshDb();
  const v = db.prepare(`SELECT MAX(version) AS v FROM schema_version`).get().v;
  assert.equal(v, 3);
  db.close();
});

test('AFTER INSERT: new rows are immediately searchable', { skip }, () => {
  const db = freshDb();
  seedTwo(db);
  assert.equal(search(db, 'daft*').length, 2);
  assert.equal(search(db, 'around*').length, 1);
  assert.equal(search(db, 'homework*').length, 1, 'album column is indexed');
  db.close();
});

// ============================================================
// AFTER UPDATE trigger (indexed-column change)
// ============================================================
test('AFTER UPDATE: retitle removes old term and indexes new term', { skip }, () => {
  const db = freshDb();
  seedTwo(db);
  const id = db.prepare(`SELECT id FROM media WHERE abs_path = '/m/daft.mp3'`).get().id;
  db.prepare(`UPDATE media SET title = 'Technologic', updated_at = datetime('now') WHERE id = ?`).run(id);
  assert.equal(search(db, 'around*').length, 0, 'old title term gone');
  assert.equal(search(db, 'technologic*').length, 1, 'new title term present');
  db.close();
});

test('AFTER UPDATE: description change is indexed', { skip }, () => {
  const db = freshDb();
  seedTwo(db);
  const id = db.prepare(`SELECT id FROM media WHERE abs_path = '/m/daft.mp3'`).get().id;
  db.prepare(`UPDATE media SET description = 'liveset bootleg' WHERE id = ?`).run(id);
  assert.equal(search(db, 'bootleg*').length, 1);
  db.close();
});

// ============================================================
// WHEN-gate (the deferred blocker): no churn on non-indexed updates
// ============================================================
test('WHEN-gate: update touching only non-indexed columns writes 0 FTS rows', { skip }, () => {
  const db = freshDb();
  seedTwo(db);
  const id = db.prepare(`SELECT id FROM media WHERE abs_path = '/m/daft.mp3'`).get().id;
  const before = ftsDataCount(db);
  db.prepare(`UPDATE media SET size_bytes = 999, mtime_ms = 12345, last_seen_scan = 2,
              updated_at = datetime('now') WHERE id = ?`).run(id);
  assert.equal(ftsDataCount(db), before, 'no FTS shadow-table write for non-indexed update');
  db.close();
});

test('WHEN-gate: scanner no-op re-set (same filename, new size/mtime/scan) writes 0 FTS rows', { skip }, () => {
  // Mirrors the scanner ON CONFLICT(abs_path) DO UPDATE SET, which re-sets
  // filename to the same value (filename is derived from the unchanged
  // abs_path) plus size/mtime/last_seen_scan. The guard must evaluate false.
  const db = freshDb();
  seedTwo(db);
  const id = db.prepare(`SELECT id FROM media WHERE abs_path = '/m/daft.mp3'`).get().id;
  const before = ftsDataCount(db);
  db.prepare(`UPDATE media SET rel_path = 'daft.mp3', filename = 'daft.mp3',
              size_bytes = 1001, mtime_ms = 22222, last_seen_scan = 3,
              updated_at = datetime('now') WHERE id = ?`).run(id);
  assert.equal(ftsDataCount(db), before, 'a no-op re-scan must not churn the FTS index');
  db.close();
});

test('AFTER UPDATE: a genuine filename change still fires', { skip }, () => {
  const db = freshDb();
  seedTwo(db);
  const id = db.prepare(`SELECT id FROM media WHERE abs_path = '/m/daft.mp3'`).get().id;
  db.prepare(`UPDATE media SET filename = 'renamed.mp3' WHERE id = ?`).run(id);
  assert.equal(search(db, 'renamed*').length, 1);
  db.close();
});

// ============================================================
// AFTER DELETE trigger
// ============================================================
test('AFTER DELETE: removed row drops out of the index', { skip }, () => {
  const db = freshDb();
  seedTwo(db);
  const id = db.prepare(`SELECT id FROM media WHERE abs_path = '/m/work.mp3'`).get().id;
  db.prepare(`DELETE FROM media WHERE id = ?`).run(id);
  assert.equal(search(db, 'daft*').length, 1, 'other row still indexed');
  assert.equal(search(db, 'harder*').length, 0, 'deleted row term gone');
  db.close();
});

// ============================================================
// Integrity + no-drift vs full rebuild
// ============================================================
test('FTS integrity-check passes after trigger-driven mutations', { skip }, () => {
  const db = freshDb();
  seedTwo(db);
  const id = db.prepare(`SELECT id FROM media WHERE abs_path = '/m/daft.mp3'`).get().id;
  db.prepare(`UPDATE media SET title = 'Technologic' WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM media WHERE abs_path = '/m/work.mp3'`).run();
  assert.doesNotThrow(() => db.exec(`INSERT INTO media_fts(media_fts) VALUES('integrity-check')`));
  db.close();
});

test('trigger-synced index matches a full rebuild (no drift)', { skip }, () => {
  const db = freshDb();
  seedTwo(db);
  const id = db.prepare(`SELECT id FROM media WHERE abs_path = '/m/daft.mp3'`).get().id;
  db.prepare(`UPDATE media SET title = 'Technologic' WHERE id = ?`).run(id);
  db.prepare(`DELETE FROM media WHERE abs_path = '/m/work.mp3'`).run();

  const q = `'technologic*' OR 'daft*' OR 'renamed*'`;
  const beforeRebuild = db.prepare(`SELECT rowid FROM media_fts WHERE media_fts MATCH ${q}`).all().map(r => r.rowid).sort();
  db.exec(`INSERT INTO media_fts(media_fts) VALUES('rebuild')`);
  const afterRebuild = db.prepare(`SELECT rowid FROM media_fts WHERE media_fts MATCH ${q}`).all().map(r => r.rowid).sort();
  assert.deepEqual(beforeRebuild, afterRebuild);
  db.close();
});
