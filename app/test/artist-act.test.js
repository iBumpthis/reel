/**
 * Tests for the artist canonical layer — C2 (v1.16.1): alias-as-act, dynamic
 * anchor, and inline-edit re-sync.
 *
 *   C2-a  alias-as-act    — a trailing "[ALIAS]" is promoted to a browsable
 *                           kind='act' member (own canonical, NOT case-folded
 *                           into a same-spelled person); reachable via the act
 *                           AND via each artist member.
 *   C2-b  dynamic anchor  — backfillCanonical re-picks most-used on EVERY run,
 *                           so a usage shift (a rename) moves the canonical
 *                           display; still a no-op when usage is unchanged; a
 *                           'manual' pin still wins.
 *   C2-c  re-sync on edit — the PATCH artist re-sync seam (mirrored from
 *                           routes/media.js) makes the facet/filter reflect an
 *                           artist edit immediately; b2b multiplicity comes from
 *                           the filename; clearing to null re-points to the
 *                           filename fallback; a new casing gets canonical.
 *
 * DB-level only; SKIPS cleanly when better-sqlite3 isn't built, same pattern as
 * artist-canonical.test.js. The SQL constants mirror routes/tags.js,
 * routes/library.js and routes/media.js so route drift surfaces here. The C2-c
 * block mirrors the re-sync block in routes/media.js (the route is a thin
 * wrapper over the same syncArtistLinks + deriveArtistMembers seam the scanner
 * runs), the same way the C1 test mirrors the route SQL.
 *
 * media.artist (display/FTS/sort) is never touched by any of this.
 *
 * Run: npm test   (or: node --test)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  deriveArtistMembers,
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
  : `better-sqlite3 native module unavailable (${loadError?.code || loadError?.message}) — act DB tests skipped`;

// SQL mirrored from the live routes (see routes/tags.js, routes/library.js,
// routes/media.js). The facet emits `kind`, so an act surfaces as its own entry.
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

/** Add a media row + sync its links via the real typed (act-aware) seam. */
function addMedia(db, stmts, filename, artist, present = 1) {
  const id = Number(insertMedia(db).run({
    abs: '/m/' + filename, rel: filename, fn: filename, artist, present,
  }).lastInsertRowid);
  const parsed = parseFilename(filename);
  const eff = artist ?? parsed.artist;
  syncArtistLinks(id, deriveArtistMembers(parsed, eff), stmts);
  return id;
}

/** Mirror routes/media.js PATCH: update media.artist, then re-sync the relation. */
function editArtist(db, stmts, id, newArtist) {
  db.prepare('UPDATE media SET artist = @a WHERE id = @id').run({ a: newArtist, id });
  const row = db.prepare('SELECT filename, artist FROM media WHERE id = ?').get(id);
  const parsed = parseFilename(row.filename);
  const eff = row.artist ?? parsed.artist;
  syncArtistLinks(id, deriveArtistMembers(parsed, eff), stmts);
}

const facetRows = (db) => db.prepare(FACET_SQL).all();
const facetMap = (db) => Object.fromEntries(facetRows(db).map(r => [r.name, r.count]));
const facetKind = (db, name) => (facetRows(db).find(r => r.name === name) || {}).kind;
const filterIds = (db, name) => db.prepare(FILTER_SQL).all({ artist: name }).map(r => r.id);

// ============================================================
// C2-a — alias-as-act
// ============================================================

test('act — b2b-with-alias links each member AND a kind=act row; act is self-canonical', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  const id = addMedia(db, stmts, 'Eptic b2b Space Laces [WANKDAT] - Set (2026).mp4', 'Eptic b2b Space Laces');

  const mem = db.prepare(MEMBERS_SQL).all(id);
  const byName = Object.fromEntries(mem.map(m => [m.name, m]));
  assert.ok(byName['Eptic'] && byName['Eptic'].kind === 'artist');
  assert.ok(byName['Space Laces'] && byName['Space Laces'].kind === 'artist');
  assert.ok(byName['WANKDAT'], 'the act is a member');
  assert.equal(byName['WANKDAT'].kind, 'act');
  assert.equal(byName['WANKDAT'].canonical, 'WANKDAT', 'act is its own canonical');

  const actRow = db.prepare("SELECT canonical_id FROM artists WHERE name='WANKDAT'").get();
  assert.equal(actRow.canonical_id, null, 'act row has no canonical pointer (self-canonical)');
  db.close();
});

test('act — facet shows the act with kind=act; filtering it returns the set', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  const id = addMedia(db, stmts, 'Eptic b2b Space Laces [WANKDAT] - Set (2026).mp4', 'Eptic b2b Space Laces');

  assert.equal(facetMap(db).WANKDAT, 1, 'the act appears as a facet entry');
  assert.equal(facetKind(db, 'WANKDAT'), 'act', 'facet carries kind=act');
  assert.equal(facetKind(db, 'Eptic'), 'artist');
  assert.deepEqual(filterIds(db, 'WANKDAT'), [id], 'filtering the act returns its set');
  db.close();
});

test('act — reachable via the act AND via each member', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  const id = addMedia(db, stmts, 'Eptic b2b Space Laces [WANKDAT] - Set (2026).mp4', 'Eptic b2b Space Laces');
  assert.deepEqual(filterIds(db, 'Eptic'), [id]);
  assert.deepEqual(filterIds(db, 'Space Laces'), [id]);
  assert.deepEqual(filterIds(db, 'WANKDAT'), [id]);
  db.close();
});

test('act — a solo-with-alias also promotes the act', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  const id = addMedia(db, stmts, 'Skrillex [OWSLA] - VIP (2025).mp4', 'Skrillex');
  const kinds = Object.fromEntries(db.prepare(MEMBERS_SQL).all(id).map(m => [m.name, m.kind]));
  assert.equal(kinds['Skrillex'], 'artist');
  assert.equal(kinds['OWSLA'], 'act');
  assert.deepEqual(filterIds(db, 'OWSLA'), [id]);
  db.close();
});

test('act — an act is NOT case-folded into a same-spelled artist', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  // An artist literally named "Wankdat" (lowercase variant) and an act "WANKDAT".
  const artistFile = addMedia(db, stmts, 'Wankdat - Solo (2024).mp4', 'Wankdat');
  const actFile = addMedia(db, stmts, 'A b2b B [WANKDAT] - Set (2025).mp4', 'A b2b B');

  const rows = db.prepare("SELECT name, kind, canonical_id FROM artists WHERE lower(name)='wankdat' ORDER BY id").all();
  assert.equal(rows.length, 2, 'distinct rows: the person and the act');
  const act = rows.find(r => r.kind === 'act');
  const person = rows.find(r => r.kind === 'artist');
  assert.ok(act && person, 'one of each kind');
  assert.equal(act.canonical_id, null, 'act stays self-canonical (not folded into the person)');
  // Facet keeps them as separate entries (the act was not folded under the person).
  const names = facetRows(db).map(r => r.name).filter(n => n.toLowerCase() === 'wankdat').sort();
  assert.deepEqual(names, ['WANKDAT', 'Wankdat'], 'both surface as distinct facet entries');
  db.close();
});

test('act — name colliding case-PRESERVINGLY with an artist reuses the row (UNIQUE normalized)', { skip }, () => {
  // The schema has UNIQUE(normalized) single-column: an act whose name EXACTLY
  // matches an existing artist cannot become a distinct row — it reuses it and
  // keeps the first-writer's kind. Documented rare case.
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  addMedia(db, stmts, 'Zomboy - Solo (2024).mp4', 'Zomboy'); // kind=artist first
  addMedia(db, stmts, 'X b2b Y [Zomboy] - Set (2025).mp4', 'X b2b Y'); // act "Zomboy"
  const rows = db.prepare("SELECT kind FROM artists WHERE name='Zomboy'").all();
  assert.equal(rows.length, 1, 'one row only (UNIQUE normalized)');
  assert.equal(rows[0].kind, 'artist', 'first-writer kind retained');
  db.close();
});

// ============================================================
// C2-b — dynamic anchor (re-pick most-used every run)
// ============================================================

test('dynamic anchor — a usage shift re-anchors the whole group on the next run', { skip }, () => {
  const db = freshDb();
  const cfg = { artistCanonicalFold: true };
  const stmts = makeArtistStmts(db, cfg);
  // Start: Rezz=2, REZZ=1 → Rezz is most-used.
  const r1 = addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  const r2 = addMedia(db, stmts, 'Rezz - B (2024).mp4', 'Rezz');
  const z1 = addMedia(db, stmts, 'REZZ - C (2024).mp4', 'REZZ');
  backfillCanonical(db, cfg);
  assert.equal(facetMap(db).Rezz, 3, 'canonical is Rezz initially');

  // Simulate "rename the majority to REZZ": re-point the two Rezz files' display
  // + relation to REZZ, so now REZZ=3, Rezz=0 by usage.
  editArtist(db, stmts, r1, 'REZZ');
  editArtist(db, stmts, r2, 'REZZ');

  // Pre-restart: canonical display is still frozen at Rezz (re-anchor is a
  // backfillCanonical/startup concern, not a scan/edit concern).
  assert.ok(facetMap(db).Rezz != null, 'still anchored at Rezz before the re-anchor pass');

  // The restart pass re-picks most-used → REZZ.
  backfillCanonical(db, cfg);
  const anchors = db.prepare("SELECT name FROM artists WHERE lower(name)='rezz' AND canonical_id IS NULL").all().map(r => r.name);
  assert.deepEqual(anchors, ['REZZ'], 're-anchored to the new majority casing');
  assert.equal(facetMap(db).REZZ, 3, 'all three now under REZZ');
  assert.equal(facetMap(db).Rezz, undefined, 'old canonical no longer a facet entry');
  void z1;
  db.close();
});

test('dynamic anchor — stable no-op when usage is unchanged', { skip }, () => {
  const db = freshDb();
  const cfg = { artistCanonicalFold: true };
  const stmts = makeArtistStmts(db, cfg);
  addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'Rezz - B (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'REZZ - C (2024).mp4', 'REZZ');
  backfillCanonical(db, cfg);
  const snap1 = db.prepare('SELECT id, canonical_id, canonical_source FROM artists ORDER BY id').all();
  backfillCanonical(db, cfg);
  backfillCanonical(db, cfg);
  const snap2 = db.prepare('SELECT id, canonical_id, canonical_source FROM artists ORDER BY id').all();
  assert.deepEqual(snap2, snap1, 'repeated runs are a stable no-op');
  db.close();
});

test('dynamic anchor — a manual pin still wins over most-used', { skip }, () => {
  const db = freshDb();
  const cfg = { artistCanonicalFold: true };
  const stmts = makeArtistStmts(db, cfg);
  addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz');
  addMedia(db, stmts, 'Rezz - B (2024).mp4', 'Rezz');
  const zId = db.prepare("SELECT id FROM artists WHERE name='REZZ'").get?.() ?? null;
  void zId;
  addMedia(db, stmts, 'REZZ - C (2024).mp4', 'REZZ');
  // Hand-pin the LESS-used casing (REZZ) as the canonical.
  const rezzId = db.prepare("SELECT id FROM artists WHERE name='REZZ'").get().id;
  db.prepare("UPDATE artists SET canonical_id = NULL, canonical_source = 'manual' WHERE id = ?").run(rezzId);
  db.prepare("UPDATE artists SET canonical_id = ?, canonical_source = 'auto' WHERE name = 'Rezz'").run(rezzId);

  backfillCanonical(db, cfg);
  const anchors = db.prepare("SELECT name, canonical_source FROM artists WHERE lower(name)='rezz' AND canonical_id IS NULL").all();
  assert.deepEqual(anchors, [{ name: 'REZZ', canonical_source: 'manual' }], 'manual pin held despite Rezz being most-used');
  db.close();
});

// ============================================================
// C2-c — inline-edit re-sync (mirrors routes/media.js PATCH)
// ============================================================

test('edit re-sync — editing the artist updates the facet/filter immediately', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  const id = addMedia(db, stmts, 'Eptic - Set (2025).mp4', 'Eptic');
  assert.equal(facetMap(db).Eptic, 1);

  editArtist(db, stmts, id, 'Subtronics');
  assert.equal(facetMap(db).Eptic, undefined, 'old artist no longer linked');
  assert.equal(facetMap(db).Subtronics, 1, 'new artist linked immediately');
  assert.deepEqual(filterIds(db, 'Subtronics'), [id]);
  db.close();
});

test('edit re-sync — b2b multiplicity comes from the filename, not the edited string', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  // Filename is a b2b; the user edits the DISPLAY string to something flat.
  const id = addMedia(db, stmts, 'Excision b2b Wooli - Set (2024).mp4', 'Excision b2b Wooli');
  editArtist(db, stmts, id, 'Excision & Wooli (live)'); // arbitrary flat display

  // Members still come from the filename's b2b structure, so both remain linked.
  const names = db.prepare(MEMBERS_SQL).all(id).map(m => m.name).sort();
  assert.deepEqual(names, ['Excision', 'Wooli'], 'b2b members preserved from filename');
  db.close();
});

test('edit re-sync — clearing the artist to null re-points to the filename fallback', { skip }, () => {
  const db = freshDb();
  const stmts = makeArtistStmts(db, { artistCanonicalFold: true });
  // Solo file whose stored display differs from the filename artist.
  const id = addMedia(db, stmts, 'eptic - Set (2025).mp4', 'Eptic Official');
  assert.equal(facetMap(db)['Eptic Official'], 1);

  editArtist(db, stmts, id, null); // clear → effective display becomes parsed.artist 'eptic'
  assert.equal(facetMap(db)['Eptic Official'], undefined);
  assert.equal(facetMap(db).eptic, 1, 'relation re-points to the filename fallback, not empty');
  assert.deepEqual(filterIds(db, 'eptic'), [id]);
  db.close();
});

test('edit re-sync — a NEW casing introduced by the edit gets a canonical assigned', { skip }, () => {
  const db = freshDb();
  const cfg = { artistCanonicalFold: true };
  const stmts = makeArtistStmts(db, cfg);
  const anchor = addMedia(db, stmts, 'Rezz - A (2024).mp4', 'Rezz'); // canonical Rezz
  const other = addMedia(db, stmts, 'Wooli - B (2024).mp4', 'Wooli');

  // Edit Wooli's file to a NEW casing of Rezz ("REZZ") — the fold seam should
  // attach it to the established Rezz canonical at sync time.
  editArtist(db, stmts, other, 'REZZ');
  const variant = db.prepare("SELECT canonical_id FROM artists WHERE name='REZZ'").get();
  const rezzId = db.prepare("SELECT id FROM artists WHERE name='Rezz'").get().id;
  assert.equal(variant.canonical_id, rezzId, 'new REZZ casing folded under existing Rezz canonical');
  assert.equal(facetMap(db).Rezz, 2, 'both files browse under the one canonical');
  void anchor;
  db.close();
});
