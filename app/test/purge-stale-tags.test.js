/**
 * DB-level tests for the stale-tag sweep on purge (REEL-019).
 *
 * Property under test: purging missing media must cascade their media_tags
 * link rows away (FK ON DELETE CASCADE), and the follow-on orphan sweep must
 * then delete exactly the tags left with no remaining links — while tags still
 * shared by a present media survive. Run against real SQLite via better-sqlite3
 * with the actual migration chain (001–006) so it validates the SQL that ships
 * (the same two statements routes/scan.js wires into its purge transaction).
 *
 * better-sqlite3 is a native module; if it isn't built (e.g. `npm test` without
 * `npm install`), the suite SKIPs cleanly rather than failing — matching
 * soft-delete.test.js.
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
  : `better-sqlite3 native module unavailable (${loadError?.code || loadError?.message}) — purge stale-tag DB tests skipped`;

/** Fresh in-memory DB with migrations 001–006 applied, mirroring db/index.js. */
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
    '005-media-artists.sql',
    '006-artist-canonical.sql',
  ]) {
    db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  db.exec(`INSERT INTO libraries (id, name, path) VALUES (1, 'Music', '/m')`);
  return db;
}

// The two statements routes/scan.js runs inside its purge transaction.
function makePurge(db) {
  const purgeMissing = db.prepare('DELETE FROM media WHERE present = 0');
  const deleteOrphanTags = db.prepare(
    'DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM media_tags)'
  );
  return db.transaction(() => {
    const purged = purgeMissing.run().changes;
    const staleTags = deleteOrphanTags.run().changes;
    return { purged, staleTags };
  });
}

let mediaSeq = 0;
function addMedia(db, present) {
  mediaSeq += 1;
  const info = db.prepare(`
    INSERT INTO media (library_id, abs_path, rel_path, filename, ext, media_type,
                       size_bytes, mtime_ms, present, missing_since)
    VALUES (1, @abs, @rel, @fn, 'mp3', 'audio', 123, 456, @present, @missing)
  `).run({
    abs: `/m/f${mediaSeq}.mp3`, rel: `f${mediaSeq}.mp3`, fn: `f${mediaSeq}.mp3`,
    present: present ? 1 : 0,
    missing: present ? null : '2026-01-01T00:00:00Z',
  });
  return info.lastInsertRowid;
}

function addTag(db, name) {
  const info = db.prepare('INSERT INTO tags (name, normalized) VALUES (?, ?)')
    .run(name, name.toLowerCase());
  return info.lastInsertRowid;
}

function link(db, mediaId, tagId) {
  db.prepare('INSERT INTO media_tags (media_id, tag_id) VALUES (?, ?)').run(mediaId, tagId);
}

const tagNames = (db) =>
  db.prepare('SELECT name FROM tags ORDER BY name').all().map(r => r.name);
const tagCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM tags').get().n;
const linkCount = (db) => db.prepare('SELECT COUNT(*) AS n FROM media_tags').get().n;

test('purge cascades media_tags, then sweeps only the now-orphaned tag', { skip }, () => {
  const db = freshDb();

  const present = addMedia(db, true);
  const missing = addMedia(db, false);

  const shared = addTag(db, 'shared');   // on both present + missing
  const lonely = addTag(db, 'lonely');   // on missing only -> should be swept

  link(db, present, shared);
  link(db, missing, shared);
  link(db, missing, lonely);

  assert.equal(linkCount(db), 3, 'pre-purge link rows');

  const { purged, staleTags } = makePurge(db)();

  assert.equal(purged, 1, 'one missing media purged');
  assert.equal(staleTags, 1, 'exactly one tag orphaned and swept');
  // Cascade removed the two links that hung off the purged media.
  assert.equal(linkCount(db), 1, 'only the present media\'s link survives');
  assert.deepEqual(tagNames(db), ['shared'], 'shared tag kept, lonely tag gone');

  db.close();
});

test('purge does not delete a tag still shared by a present media', { skip }, () => {
  const db = freshDb();
  const a = addMedia(db, true);
  const b = addMedia(db, false);
  const t = addTag(db, 'keep');
  link(db, a, t);
  link(db, b, t);

  const { staleTags } = makePurge(db)();
  assert.equal(staleTags, 0, 'tag survives because a present media still links it');
  assert.deepEqual(tagNames(db), ['keep']);
  db.close();
});

test('sweep is broad: a pre-existing orphan (no links at all) is also removed', { skip }, () => {
  // Orphans can exist independent of purge — e.g. the tag-edit replace-all flow
  // clears links then relinks without a tag. The purge sweep mops these up too.
  const db = freshDb();
  addMedia(db, true); // a present media with no tags
  addTag(db, 'ghost'); // never linked

  const { purged, staleTags } = makePurge(db)();
  assert.equal(purged, 0, 'nothing missing to purge');
  assert.equal(staleTags, 1, 'the unlinked ghost tag is swept');
  assert.equal(tagCount(db), 0);
  db.close();
});

test('empty media_tags: NOT IN over an empty subquery sweeps all tags', { skip }, () => {
  // SQL edge: `id NOT IN (SELECT ... empty)` is TRUE for every row, so with no
  // links at all every tag is (correctly) orphaned. NULL-safe because
  // media_tags.tag_id is NOT NULL — the subquery can never yield NULL.
  const db = freshDb();
  addTag(db, 'a');
  addTag(db, 'b');
  assert.equal(linkCount(db), 0);

  const { staleTags } = makePurge(db)();
  assert.equal(staleTags, 2);
  assert.equal(tagCount(db), 0);
  db.close();
});
