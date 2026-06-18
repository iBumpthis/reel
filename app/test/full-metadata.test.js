/**
 * DB-level tests for the Full Metadata Scan upsert (forceTagReread path).
 *
 * The refresh contract is a database-level property of the upsertMediaForceMeta
 * statement: on a same-path conflict it must
 *   - overwrite metadata columns ONLY where the embedded tag is present
 *     (COALESCE(@meta_x, x)), preserving hand-edited values when a tag is null,
 *   - reactivate a missing row (present -> 1, missing_since -> NULL), and
 *   - leave description, markers, and tag links untouched.
 *
 * Runs against real SQLite via better-sqlite3, applying the actual migrations
 * (001-004) into an in-memory DB. Skips cleanly if better-sqlite3 isn't built.
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
  : `better-sqlite3 native module unavailable (${loadError?.code || loadError?.message}) — full-metadata DB tests skipped`;

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
  ]) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  db.exec(`INSERT INTO libraries (id, name, path) VALUES (1, 'Music', '/m')`);
  return db;
}

// Mirrors scanner.js upsertMediaForceMeta (the Full Metadata Scan variant).
const forceMeta = (db) => db.prepare(`
  INSERT INTO media (library_id, abs_path, rel_path, filename, ext, media_type,
                     size_bytes, mtime_ms, title, artist, year, album, track_number,
                     last_seen_scan)
  VALUES (1, @abs, @rel, @fn, 'mp3', 'audio', @sz, @mt, @title, @artist, @year,
          @album, @track, @scan)
  ON CONFLICT(abs_path) DO UPDATE SET
    rel_path = @rel, filename = @fn, size_bytes = @sz, mtime_ms = @mt,
    last_seen_scan = @scan, present = 1, missing_since = NULL,
    title = COALESCE(@meta_title, title),
    artist = COALESCE(@meta_artist, artist),
    year = COALESCE(@meta_year, year),
    album = COALESCE(@meta_album, album),
    track_number = COALESCE(@meta_track_number, track_number),
    updated_at = datetime('now')
`);

// Mirrors the NORMAL upsert (no metadata refresh) for baseline inserts.
const normalUpsert = (db) => db.prepare(`
  INSERT INTO media (library_id, abs_path, rel_path, filename, ext, media_type,
                     size_bytes, mtime_ms, title, artist, year, album, track_number,
                     last_seen_scan)
  VALUES (1, @abs, @rel, @fn, 'mp3', 'audio', @sz, @mt, @title, @artist, @year,
          @album, @track, @scan)
  ON CONFLICT(abs_path) DO UPDATE SET
    rel_path = @rel, filename = @fn, size_bytes = @sz, mtime_ms = @mt,
    last_seen_scan = @scan, present = 1, missing_since = NULL,
    updated_at = datetime('now')
`);

function seed(db, over = {}) {
  normalUpsert(db).run({
    abs: '/m/a.mp3', rel: 'a.mp3', fn: 'a.mp3', sz: 100, mt: 1, scan: 1,
    title: 'Orig Title', artist: 'Orig Artist', year: 2000,
    album: 'Orig Album', track: 1, ...over,
  });
  return db.prepare('SELECT * FROM media WHERE abs_path = ?').get('/m/a.mp3');
}

test('force-meta overwrites metadata when the embedded tag is present', { skip }, () => {
  const db = freshDb();
  seed(db);
  forceMeta(db).run({
    abs: '/m/a.mp3', rel: 'a.mp3', fn: 'a.mp3', sz: 100, mt: 1, scan: 2,
    title: 'x', artist: 'x', year: 1, album: 'x', track: 1,
    meta_title: 'New Title', meta_artist: 'New Artist', meta_year: 2024,
    meta_album: 'New Album', meta_track_number: 7,
  });
  const row = db.prepare('SELECT * FROM media WHERE abs_path = ?').get('/m/a.mp3');
  assert.equal(row.title, 'New Title');
  assert.equal(row.artist, 'New Artist');
  assert.equal(row.year, 2024);
  assert.equal(row.album, 'New Album');
  assert.equal(row.track_number, 7);
});

test('force-meta PRESERVES existing values when the embedded tag is null', { skip }, () => {
  const db = freshDb();
  seed(db);
  // Every meta_* null — simulates a file with no readable embedded tags.
  forceMeta(db).run({
    abs: '/m/a.mp3', rel: 'a.mp3', fn: 'a.mp3', sz: 100, mt: 1, scan: 2,
    title: 'x', artist: 'x', year: 1, album: 'x', track: 1,
    meta_title: null, meta_artist: null, meta_year: null,
    meta_album: null, meta_track_number: null,
  });
  const row = db.prepare('SELECT * FROM media WHERE abs_path = ?').get('/m/a.mp3');
  assert.equal(row.title, 'Orig Title');
  assert.equal(row.artist, 'Orig Artist');
  assert.equal(row.year, 2000);
  assert.equal(row.album, 'Orig Album');
  assert.equal(row.track_number, 1);
});

test('force-meta refreshes per-field — present tags win, absent tags preserved', { skip }, () => {
  const db = freshDb();
  seed(db);
  // Only artist carries a new embedded value; the rest are absent.
  forceMeta(db).run({
    abs: '/m/a.mp3', rel: 'a.mp3', fn: 'a.mp3', sz: 100, mt: 1, scan: 2,
    title: 'x', artist: 'x', year: 1, album: 'x', track: 1,
    meta_title: null, meta_artist: 'Tagged Artist', meta_year: null,
    meta_album: null, meta_track_number: null,
  });
  const row = db.prepare('SELECT * FROM media WHERE abs_path = ?').get('/m/a.mp3');
  assert.equal(row.artist, 'Tagged Artist'); // refreshed
  assert.equal(row.title, 'Orig Title');     // preserved
  assert.equal(row.album, 'Orig Album');     // preserved
});

test('force-meta leaves description, markers, and tags intact', { skip }, () => {
  const db = freshDb();
  const seeded = seed(db);
  const id = seeded.id;
  db.prepare('UPDATE media SET description = ? WHERE id = ?').run('hand notes', id);
  db.prepare('INSERT INTO markers (media_id, start_seconds, label) VALUES (?, 12, ?)')
    .run(id, 'Intro');
  const tagId = db.prepare("INSERT INTO tags (name, normalized) VALUES ('Live','live')").run().lastInsertRowid;
  db.prepare('INSERT INTO media_tags (media_id, tag_id) VALUES (?, ?)').run(id, tagId);

  forceMeta(db).run({
    abs: '/m/a.mp3', rel: 'a.mp3', fn: 'a.mp3', sz: 100, mt: 1, scan: 2,
    title: 'x', artist: 'x', year: 1, album: 'x', track: 1,
    meta_title: 'New Title', meta_artist: null, meta_year: null,
    meta_album: null, meta_track_number: null,
  });

  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
  assert.equal(row.title, 'New Title');
  assert.equal(row.description, 'hand notes'); // description NOT embedded-derived
  const markerCount = db.prepare('SELECT COUNT(*) AS n FROM markers WHERE media_id = ?').get(id).n;
  const tagCount = db.prepare('SELECT COUNT(*) AS n FROM media_tags WHERE media_id = ?').get(id).n;
  assert.equal(markerCount, 1);
  assert.equal(tagCount, 1);
});

test('force-meta reactivates a missing row', { skip }, () => {
  const db = freshDb();
  const seeded = seed(db);
  db.prepare("UPDATE media SET present = 0, missing_since = datetime('now') WHERE id = ?")
    .run(seeded.id);

  forceMeta(db).run({
    abs: '/m/a.mp3', rel: 'a.mp3', fn: 'a.mp3', sz: 100, mt: 2, scan: 2,
    title: 'x', artist: 'x', year: 1, album: 'x', track: 1,
    meta_title: null, meta_artist: null, meta_year: null,
    meta_album: null, meta_track_number: null,
  });

  const row = db.prepare('SELECT present, missing_since FROM media WHERE id = ?').get(seeded.id);
  assert.equal(row.present, 1);
  assert.equal(row.missing_since, null);
});
