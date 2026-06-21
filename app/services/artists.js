/**
 * Artist normalization (media_artists, migration 005; canonical layer 006).
 *
 * Kept in its own module — separate from the scanner — so the artist logic is
 * importable WITHOUT pulling in the scanner's `music-metadata` (and transitively
 * `better-sqlite3`) dependencies. This mirrors metadata.js: a dependency-free
 * unit whose pure logic (deriveArtistMembers) can be unit-tested with no native
 * build and no `npm install`, while the DB-touching helpers are exercised only
 * under the better-sqlite3-gated test section.
 *
 * media_artists is the RELATIONAL source of truth for artist membership;
 * media.artist remains the denormalized DISPLAY / FULL-TEXT-SEARCH projection
 * (it is FTS-indexed, read on every card, the facet/sort column, and the
 * inline-edit target — see migration 005's header).
 *
 * C2 (v1.16.1) — alias-as-act: a trailing "[ALIAS]" collective is promoted from
 * a tag to a first-class browsable member with kind='act' (its own canonical,
 * never case-folded into a person). deriveArtistMembers is the typed seam;
 * deriveArtistNames is kept as a behaviour-identical artist-only wrapper for the
 * Stage A/B callers and tests.
 */
import { parseFilename } from './metadata.js';

/**
 * Derive the TYPED relational artist member list for a media row (C2). SHARED by
 * the scanner dual-write and the one-time backfill so the two can never diverge.
 *
 *   - b2b set: artist members come from the FILENAME (parsed.artists). An
 *     embedded ID3/M4A tag collapses a set to a flat string, so the filename is
 *     the only source that preserves multiplicity.
 *   - solo: the single artist member is the DISPLAY artist — i.e. the stored
 *     media.artist value (embedded-tag-wins-else-filename, the existing
 *     precedence). Callers pass that stored value as `displayArtist` so the
 *     projection mirrors what the UI shows. A null/empty display artist yields
 *     no artist member.
 *   - act ("[WANKDAT]"): if parsed.alias is present (independent of isB2B), it
 *     is appended as a kind='act' member. The act is the collective name for the
 *     set; it is NOT case-folded into a same-spelled person (see syncArtistLinks
 *     / migration 006). It is appended LAST so a degenerate collision with a
 *     member name (act named like one of its own members) de-dupes to the artist
 *     row rather than displacing it.
 *
 * @param {{ isB2B: boolean, artists: string[], alias: string|null }} parsed
 * @param {string|null} displayArtist - the stored media.artist display value
 * @returns {Array<{name: string, kind: 'artist'|'act'}>}
 */
export function deriveArtistMembers(parsed, displayArtist) {
  const members = [];
  if (parsed.isB2B) {
    for (const name of parsed.artists) members.push({ name, kind: 'artist' });
  } else if (displayArtist) {
    members.push({ name: displayArtist, kind: 'artist' });
  }
  // Act promotion (C2). SINGLE predicate, SINGLE place — a trailing "[...]" in
  // the artist position is reserved EXCLUSIVELY for an act name (never a
  // version/edit/mastering marker). If that reservation ever needs to become
  // conditional (a sigil convention, a config allowlist), this is the one gate
  // to change; the rest of the pipeline only sees the kind on the member.
  if (parsed.alias) {
    members.push({ name: parsed.alias, kind: 'act' });
  }
  return members;
}

/**
 * Artist-only member NAMES (back-compat wrapper). Behaviour-identical to the
 * pre-C2 deriveArtistNames: b2b => parsed.artists; solo => [displayArtist] or [];
 * the alias is excluded (it is now an 'act' member, surfaced via
 * deriveArtistMembers). Retained for callers/tests that only want the person
 * names; production write paths use deriveArtistMembers.
 *
 * @returns {string[]}
 */
export function deriveArtistNames(parsed, displayArtist) {
  return deriveArtistMembers(parsed, displayArtist)
    .filter(m => m.kind === 'artist')
    .map(m => m.name);
}

/** Prepared statements for the artist find-or-create + per-row link sync. */
export function makeArtistStmts(db, config = {}) {
  return {
    // Casing-fold gate (migration 006). Default ON; `artistCanonicalFold: false`
    // in config disables the canonical grouping entirely (rows still created,
    // canonical_id just stays NULL => the facet/filter degrade to Stage B's
    // per-casing behaviour via COALESCE).
    foldEnabled: config.artistCanonicalFold !== false,
    // Kind-blind by design: artists.normalized is UNIQUE (single-column, not
    // (normalized, kind)), so a name maps to AT MOST one row regardless of kind.
    // An act whose name collides case-preservingly with an existing artist
    // reuses that row and keeps the first-writer's kind (rare; documented).
    findArtist: db.prepare('SELECT id, kind FROM artists WHERE normalized = ?'),
    insertArtist: db.prepare('INSERT INTO artists (name, normalized, kind) VALUES (@name, @normalized, @kind)'),
    linkArtist: db.prepare('INSERT OR IGNORE INTO media_artists (media_id, artist_id) VALUES (@media_id, @artist_id)'),
    listLinks: db.prepare(
      `SELECT a.normalized FROM media_artists ma
       JOIN artists a ON a.id = ma.artist_id
       WHERE ma.media_id = ?`
    ),
    clearLinks: db.prepare('DELETE FROM media_artists WHERE media_id = ?'),
    // Casing fold (migration 006): when a NEW kind='artist' row is created, find
    // an existing case-variant sibling and attach the new row to that sibling's
    // canonical, so the facet/filter group them. Prefers an established anchor
    // (canonical_id NULL) sibling, then lowest id, for a deterministic target.
    // Scoped to kind='artist' so an act is never folded into a person.
    findFoldSibling: db.prepare(
      `SELECT id, canonical_id FROM artists
       WHERE kind = 'artist' AND lower(name) = lower(?) AND id != ?
       ORDER BY (canonical_id IS NULL) DESC, id ASC LIMIT 1`
    ),
    setCanonicalAuto: db.prepare(
      "UPDATE artists SET canonical_id = @canon, canonical_source = 'auto' " +
      "WHERE id = @id AND canonical_source IS NOT 'manual'"
    ),
  };
}

/**
 * Make a media row's media_artists links EXACTLY match `members` (find-or-create
 * each artist by its case-preserving identity, then replace the row's link set
 * IFF it differs from what's stored).
 *
 * `members` may be typed objects `{name, kind}` (C2) or bare strings (treated as
 * kind='artist' for back-compat). `kind` only matters when a NEW row is created:
 *   - kind='artist' => run the C1 fold-sibling canonical assignment.
 *   - kind='act'    => skip folding (an act is self-canonical).
 *
 * Unlike applyTag — which is additive/sticky by design — the artist projection
 * must be EXACT: it mirrors media.artist, a value that legitimately CHANGES
 * (embedded-tag refresh via Full Metadata Scan, inline edit, a future rename).
 * A plain INSERT-OR-IGNORE would ACCRETE stale members: e.g. a solo audio file
 * whose embedded tag won media.artist on first scan, then a later NORMAL scan
 * re-derives — embedded tags aren't re-read for existing files, so the parsed
 * filename artist would differ and a second, wrong link would stick. Reading
 * the current link set and rewriting only on a real change keeps the projection
 * faithful while doing ZERO writes on the common no-op re-scan.
 *
 * De-dupe is by `normalized` (= name, case-preserving) ONLY — NOT by kind. With
 * the UNIQUE(normalized) constraint two members sharing a normalized key map to
 * one row anyway, so an act named identically to a member collapses to that one
 * row (first occurrence in `members` wins; act is appended last, so the person
 * survives). Rare/degenerate; matches the schema's single-identity guarantee.
 *
 * Atomicity: like the rest of the per-file scan work this is not wrapped in a
 * transaction. A crash between clearLinks and the re-insert leaves the row with
 * fewer/zero links; the next scan's sync self-heals it. (The backfill DOES wrap
 * its whole pass in one transaction — a bulk one-shot, where atomicity is cheap.)
 */
export function syncArtistLinks(mediaId, members, stmts) {
  const { findArtist, insertArtist, linkArtist, listLinks, clearLinks } = stmts;

  // Normalise input shape: bare string => kind='artist'.
  const typed = members.map(m => (typeof m === 'string' ? { name: m, kind: 'artist' } : m));

  // De-dupe within this row by case-preserving identity (normalized = name).
  const desired = [];
  const desiredKeys = new Set();
  for (const { name, kind } of typed) {
    const normalized = name; // case-preserving identity key
    if (!normalized || desiredKeys.has(normalized)) continue;
    desiredKeys.add(normalized);
    desired.push({ name, normalized, kind: kind ?? 'artist' });
  }

  const current = new Set(listLinks.all(mediaId).map(r => r.normalized));

  // Set-equal? Nothing to write.
  if (current.size === desiredKeys.size && [...desiredKeys].every(k => current.has(k))) {
    return;
  }

  clearLinks.run(mediaId);
  for (const { name, normalized, kind } of desired) {
    let row = findArtist.get(normalized);
    if (!row) {
      const res = insertArtist.run({ name, normalized, kind });
      row = { id: res.lastInsertRowid };
      // Casing fold (migration 006): attach a NEW kind='artist' casing variant
      // to an existing sibling's canonical so browse groups them. First-of-its-
      // name rows have no sibling and stay self-canonical (canonical_id NULL).
      // An act (kind='act') is self-canonical and never folded.
      if (stmts.foldEnabled && kind === 'artist') {
        const sib = stmts.findFoldSibling.get(name, row.id);
        if (sib) {
          stmts.setCanonicalAuto.run({ id: row.id, canon: sib.canonical_id ?? sib.id });
        }
      }
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
 * value; it never touches the filesystem. It re-uses deriveArtistMembers +
 * syncArtistLinks, so its output is byte-identical to what a scan would write —
 * including act members (C2).
 *
 * Guard: runs only when media_artists is EMPTY while media is NON-EMPTY, so it
 * populates links immediately on the deploy that ships migration 005 (no need
 * to force a scan), then never fights the scanner on later boots. Idempotent
 * regardless via the guard. NOTE (C2): on a system where this guard already
 * fired in v1.14–v1.16.0, the link table is non-empty, so this will NOT re-run
 * to add acts — acts populate on the NEXT library scan instead (the scanner's
 * always-run sync now includes the act in the desired set). This mirrors how
 * b2b tags backfill onto already-imported files today.
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
  const stmts = makeArtistStmts(db, config);
  const rows = db.prepare('SELECT id, filename, artist FROM media').all();

  const run = db.transaction(() => {
    for (const row of rows) {
      const parsed = parseFilename(row.filename, { b2bJoin: b2bDisplayJoin });
      // Effective display (Decision H): mirror buildResponse's
      // `row.artist ?? parsed.artist` so a cleared-but-filename-has-artist solo
      // file still links its member. Aligns backfill, scan, and PATCH.
      const eff = row.artist ?? parsed.artist;
      syncArtistLinks(row.id, deriveArtistMembers(parsed, eff), stmts);
    }
  });
  run();

  console.log(`[reel] Backfilled media_artists from ${rows.length} media row(s)`);
  return { ran: true, rows: rows.length };
}

/**
 * Casing-fold pass (migration 006). Groups existing kind='artist' rows by
 * case-insensitive name and points each variant at a single canonical row, so
 * the facet/filter (which resolve through COALESCE(canonical_id, id)) show one
 * entry per artist instead of one per casing. Runs at startup after
 * backfillArtists: DB-only (no NAS I/O), idempotent.
 *
 * Anchor policy (Decision A + C2-b): the MOST-USED casing wins (count of media
 * links), lowest id as the tiebreak. C2-b makes this DYNAMIC — the anchor is
 * re-picked on EVERY run, so a deliberate rename of the majority casing
 * (rename files => rescan => redeploy) MOVES the canonical display to the new
 * majority. (Pre-C2 the anchor was frozen once and never drifted.) A 'manual'
 * pin (reserved for a future override) is always respected and never clobbered.
 * The WHERE guards make every UPDATE a no-op when usage is unchanged
 * (idempotent) and re-point the whole group when the most-used casing flips.
 *
 * RESTART CAVEAT: this runs at STARTUP only. A rename re-anchors on the next
 * container restart; `./deploy.sh` restarts, so the real flow (rename => rescan
 * => redeploy) works. A bare rescan does NOT re-anchor. Documented manual step
 * until the settings-menu arc adds a UI restart/rescan.
 *
 * Gated by config.artistCanonicalFold (default ON). normalized is untouched —
 * variants remain distinct identity ROWS; only the grouping changes. Acts
 * (kind='act') are excluded from grouping entirely.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} config - app config (uses artistCanonicalFold)
 * @returns {{ ran: boolean, groups: number }}
 */
export function backfillCanonical(db, config = {}) {
  if (config.artistCanonicalFold === false) return { ran: false, groups: 0 };

  const groups = db.prepare(`
    SELECT lower(name) AS k
    FROM artists
    WHERE kind = 'artist'
    GROUP BY lower(name)
    HAVING COUNT(*) > 1
  `).all();
  if (groups.length === 0) return { ran: false, groups: 0 };

  const membersOf = db.prepare(`
    SELECT a.id, a.canonical_id, a.canonical_source,
           (SELECT COUNT(*) FROM media_artists ma WHERE ma.artist_id = a.id) AS uses
    FROM artists a
    WHERE a.kind = 'artist' AND lower(a.name) = ?
    ORDER BY uses DESC, a.id ASC
  `);
  // Anchor: become self-canonical + mark processed. No-op once already so.
  const setAnchor = db.prepare(
    "UPDATE artists SET canonical_id = NULL, canonical_source = 'auto' " +
    "WHERE id = @id AND canonical_source IS NOT 'manual' " +
    "AND (canonical_id IS NOT NULL OR canonical_source IS NULL)"
  );
  // Variant: point at the anchor. No-op once already pointing there as 'auto'.
  const setVariant = db.prepare(
    "UPDATE artists SET canonical_id = @canon, canonical_source = 'auto' " +
    "WHERE id = @id AND canonical_source IS NOT 'manual' " +
    "AND (canonical_id IS NOT @canon OR canonical_source IS NULL)"
  );

  let processed = 0;
  const run = db.transaction(() => {
    for (const g of groups) {
      const members = membersOf.all(g.k);
      // C2-b — DYNAMIC anchor: re-pick most-used every run (membersOf is ordered
      // uses DESC, id ASC, so members[0] IS the most-used). A 'manual' pin still
      // wins (reserved for a future override). No settled-anchor stickiness —
      // that's what froze the canonical display pre-C2.
      const anchor = members.find(m => m.canonical_source === 'manual') ?? members[0];
      for (const m of members) {
        if (m.id === anchor.id) {
          if (m.canonical_source !== 'manual') setAnchor.run({ id: m.id });
        } else {
          setVariant.run({ id: m.id, canon: anchor.id });
        }
      }
      processed++;
    }
  });
  run();

  console.log(`[reel] Canonical-folded ${processed} artist casing group(s)`);
  return { ran: true, groups: processed };
}
