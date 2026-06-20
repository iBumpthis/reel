/**
 * Artist normalization (media_artists, migration 005).
 *
 * Kept in its own module — separate from the scanner — so the artist logic is
 * importable WITHOUT pulling in the scanner's `music-metadata` (and transitively
 * `better-sqlite3`) dependencies. This mirrors metadata.js: a dependency-free
 * unit whose pure logic (deriveArtistNames) can be unit-tested with no native
 * build and no `npm install`, while the DB-touching helpers are exercised only
 * under the better-sqlite3-gated test section.
 *
 * media_artists is the RELATIONAL source of truth for artist membership;
 * media.artist remains the denormalized DISPLAY / FULL-TEXT-SEARCH projection
 * (it is FTS-indexed, read on every card, the facet/sort column, and the
 * inline-edit target — see migration 005's header).
 */
import { parseFilename } from './metadata.js';

/**
 * Derive the relational artist member list for a media row. SHARED by the
 * scanner dual-write and the one-time backfill so the two can never diverge.
 *
 *   - b2b set: members come from the FILENAME (parsed.artists). An embedded
 *     ID3/M4A tag collapses a set to a flat string, so the filename is the only
 *     source that preserves multiplicity.
 *   - solo: the single member is the DISPLAY artist — i.e. the stored
 *     media.artist value (embedded-tag-wins-else-filename, the existing
 *     precedence). Callers pass that stored value as `displayArtist` so the
 *     projection mirrors what the UI shows. A null/empty display artist yields
 *     no members (no link).
 *   - alias ("[WANKDAT]") is intentionally NOT a member here — it remains a tag
 *     in Stage A; Stage C promotes it to a canonical label over the member set.
 *
 * @param {{ isB2B: boolean, artists: string[] }} parsed - parseFilename() result
 * @param {string|null} displayArtist - the stored media.artist display value
 * @returns {string[]} member artist names (de-duped by the caller's sync)
 */
export function deriveArtistNames(parsed, displayArtist) {
  if (parsed.isB2B) return parsed.artists;
  return displayArtist ? [displayArtist] : [];
}

/** Prepared statements for the artist find-or-create + per-row link sync. */
export function makeArtistStmts(db) {
  return {
    findArtist: db.prepare('SELECT id FROM artists WHERE normalized = ?'),
    insertArtist: db.prepare('INSERT INTO artists (name, normalized) VALUES (@name, @normalized)'),
    linkArtist: db.prepare('INSERT OR IGNORE INTO media_artists (media_id, artist_id) VALUES (@media_id, @artist_id)'),
    listLinks: db.prepare(
      `SELECT a.normalized FROM media_artists ma
       JOIN artists a ON a.id = ma.artist_id
       WHERE ma.media_id = ?`
    ),
    clearLinks: db.prepare('DELETE FROM media_artists WHERE media_id = ?'),
  };
}

/**
 * Make a media row's media_artists links EXACTLY match `names` (find-or-create
 * each artist by its case-preserving identity, then replace the row's link set
 * IFF it differs from what's stored).
 *
 * Unlike applyTag — which is additive/sticky by design — the artist projection
 * must be EXACT: it mirrors media.artist, a value that legitimately CHANGES
 * (embedded-tag refresh via Full Metadata Scan, inline edit, a future rename).
 * A plain INSERT-OR-IGNORE would ACCRETE stale members: e.g. a solo audio file
 * whose embedded tag won media.artist on first scan, then a later NORMAL scan
 * re-derives — embedded tags aren't re-read for existing files, so the parsed
 * filename artist would differ and a second, wrong link would stick. Reading
 * the current link set and rewriting only on a real change keeps the projection
 * faithful while doing ZERO writes on the common no-op re-scan (consistent with
 * the scanner's existing "don't pay for unchanged rows" philosophy).
 *
 * `normalized` is case-PRESERVING in Stage A (identity = name) — see migration
 * 005's header for why folding here would be a behaviour change, not a cleanup.
 *
 * Atomicity: like the rest of the per-file scan work this is not wrapped in a
 * transaction. A crash between clearLinks and the re-insert leaves the row with
 * fewer/zero links; the next scan's sync self-heals it. Acceptable and matches
 * the existing non-transactional per-file design. (The backfill DOES wrap its
 * whole pass in one transaction — a bulk one-shot, where atomicity is cheap.)
 */
export function syncArtistLinks(mediaId, names, stmts) {
  const { findArtist, insertArtist, linkArtist, listLinks, clearLinks } = stmts;

  // De-dupe within this row by case-preserving identity.
  const desired = [];
  const desiredKeys = new Set();
  for (const name of names) {
    const normalized = name; // case-preserving identity key (Stage A)
    if (!normalized || desiredKeys.has(normalized)) continue;
    desiredKeys.add(normalized);
    desired.push({ name, normalized });
  }

  const current = new Set(listLinks.all(mediaId).map(r => r.normalized));

  // Set-equal? Nothing to write.
  if (current.size === desiredKeys.size && [...desiredKeys].every(k => current.has(k))) {
    return;
  }

  clearLinks.run(mediaId);
  for (const { name, normalized } of desired) {
    let row = findArtist.get(normalized);
    if (!row) {
      const res = insertArtist.run({ name, normalized });
      row = { id: res.lastInsertRowid };
    }
    linkArtist.run({ media_id: mediaId, artist_id: row.id });
  }
}

/**
 * One-time backfill of media_artists from existing media rows. Migrations are
 * SQL-only and the runner can't express this (it re-parses filenames), so it
 * runs once at startup after the DB is open and config is in hand.
 *
 * DB-ONLY: it re-parses the STORED filename column (pure string work, zero NAS
 * I/O — Rob is CIFS-cost sensitive) and reads the stored media.artist display
 * value; it never touches the filesystem. It re-uses deriveArtistNames +
 * syncArtistLinks, so its output is byte-identical to what a scan would write.
 *
 * Guard: runs only when media_artists is EMPTY while media is NON-EMPTY, so it
 * populates links immediately on the deploy that ships migration 005 (no need
 * to force a scan), then never fights the scanner on later boots. Idempotent
 * regardless via the guard. Covers ALL rows incl. soft-deleted (present=0):
 * their identity/markers/tags are retained, so their artist links should be too.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config - app config (uses b2bDisplayJoin, default " b2b ")
 * @returns {{ ran: boolean, rows: number }}
 */
export function backfillArtists(db, config) {
  const haveLinks = db.prepare('SELECT 1 FROM media_artists LIMIT 1').get();
  const haveMedia = db.prepare('SELECT 1 FROM media LIMIT 1').get();
  if (haveLinks || !haveMedia) {
    return { ran: false, rows: 0 };
  }

  const b2bDisplayJoin = config.b2bDisplayJoin ?? ' b2b ';
  const stmts = makeArtistStmts(db);
  const rows = db.prepare('SELECT id, filename, artist FROM media').all();

  const run = db.transaction(() => {
    for (const row of rows) {
      const parsed = parseFilename(row.filename, { b2bJoin: b2bDisplayJoin });
      syncArtistLinks(row.id, deriveArtistNames(parsed, row.artist), stmts);
    }
  });
  run();

  console.log(`[reel] Backfilled media_artists from ${rows.length} media row(s)`);
  return { ran: true, rows: rows.length };
}
