import { parseFilename } from '../services/metadata.js';
import { deriveArtistMembers, makeArtistStmts, syncArtistLinks } from '../services/artists.js';

export default async function mediaRoutes(fastify) {
  const db = fastify.db;

  // Artist link statements for the inline-edit re-sync (C2-c). Built once at
  // registration; fastify.config is decorated in server.js. b2bJoin mirrors the
  // scanner (note the pre-existing config.js passthrough gap — b2bDisplayJoin
  // isn't wired through config.js, so this is effectively always " b2b ";
  // intentionally left alone, just mirrored here so PATCH and scan agree).
  const artistStmts = makeArtistStmts(db, fastify.config);
  const b2bJoin = fastify.config.b2bDisplayJoin ?? ' b2b ';

  const getMedia = db.prepare(`
    SELECT m.*, l.name AS library_name
    FROM media m
    JOIN libraries l ON l.id = m.library_id
    WHERE m.id = ?
  `);

  const getMarkers = db.prepare(`
    SELECT id, start_seconds, end_seconds, label, raw_line,
           was_adjusted, adjust_reason, sort_order
    FROM markers
    WHERE media_id = ?
    ORDER BY start_seconds ASC, sort_order ASC
  `);

  const getTags = db.prepare(`
    SELECT t.id, t.name
    FROM media_tags mt
    JOIN tags t ON t.id = mt.tag_id
    WHERE mt.media_id = ?
    ORDER BY t.name ASC
  `);

  // Relational artist members (media_artists, 005) with their CANONICAL name
  // (006). The player walks the display string on the LITERAL `name` (so a
  // "REZZ"-cased file still reconstructs + links) but hrefs the `canonical`,
  // so the deep link lands on the populated canonical-filtered view rather than
  // dead-ending (the facet/filter resolve on canonical). canonical_id NULL ⇒
  // canonical === name (nothing folded). kind surfaced for C2 act links.
  const getArtistMembers = db.prepare(`
    SELECT a.name AS name, can.name AS canonical, a.kind AS kind
    FROM media_artists ma
    JOIN artists a   ON a.id  = ma.artist_id
    JOIN artists can ON can.id = COALESCE(a.canonical_id, a.id)
    WHERE ma.media_id = ?
  `);

  // FTS sync is handled by the media_fts_au trigger (migration 003): the
  // UPDATE below fires it automatically, and only when an FTS-indexed column
  // actually changes. No manual rebuild.

  function buildResponse(row) {
    const parsed = parseFilename(row.filename);
    const markers = getMarkers.all(row.id).map(m => ({
      id: m.id,
      startSeconds: m.start_seconds,
      endSeconds: m.end_seconds,
      label: m.label,
      rawLine: m.raw_line,
      wasAdjusted: !!m.was_adjusted,
      adjustReason: m.adjust_reason,
      sortOrder: m.sort_order,
    }));
    const tags = getTags.all(row.id).map(t => ({ id: t.id, name: t.name }));

    // Ordered artist members for the player's per-member deep links. Each is
    // { name (literal, for the display-string walk), canonical (the href
    // target), kind }. Ordered by the literal name's position in the display
    // string so a b2b set reconstructs in order; members absent from the display
    // (e.g. an inline artist edit not yet re-synced by a rescan) sort last and
    // the player falls back to plain text for the unmatched portion.
    const displayArtist = row.artist ?? parsed.artist;
    const members = getArtistMembers.all(row.id);
    const artists = displayArtist
      ? members.slice().sort((x, y) => {
          const ix = displayArtist.indexOf(x.name);
          const iy = displayArtist.indexOf(y.name);
          return (ix < 0 ? Infinity : ix) - (iy < 0 ? Infinity : iy);
        })
      : members;

    return {
      id: row.id,
      libraryName: row.library_name,
      filename: row.filename,
      absPath: row.abs_path,
      relPath: row.rel_path,
      ext: row.ext,
      mediaType: row.media_type,
      sizeBytes: row.size_bytes,
      mtimeMs: row.mtime_ms,
      title: row.title ?? parsed.title,
      artist: row.artist ?? parsed.artist,
      artists,
      year: row.year ?? parsed.year,
      album: row.album ?? null,
      trackNumber: row.track_number ?? null,
      description: row.description,
      markers,
      tags,
      streamUrl: `/stream/${row.id}`,
      defaultPlaybackMode: row.media_type === 'audio' ? 'audio' : 'video',
      present: !!row.present,
      missingSince: row.missing_since,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // GET /api/media/:id
  fastify.get('/api/media/:id', async (request, reply) => {
    const row = getMedia.get(request.params.id);
    if (!row) return reply.code(404).send({ error: 'Media not found' });
    return buildResponse(row);
  });

  // PATCH /api/media/:id
  fastify.patch('/api/media/:id', async (request, reply) => {
    const { id } = request.params;
    const existing = getMedia.get(id);
    if (!existing) return reply.code(404).send({ error: 'Media not found' });

    const body = request.body ?? {};

    // Build dynamic SET clause: only update fields present in the body.
    // This allows explicit null (to clear back to filename fallback).
    const fields = [];
    const params = { id: parseInt(id, 10) };

    if ('title' in body) { fields.push('title = @title'); params.title = body.title; }
    if ('artist' in body) { fields.push('artist = @artist'); params.artist = body.artist; }
    if ('album' in body) { fields.push('album = @album'); params.album = body.album; }
    if ('year' in body) {
      // Coerce to integer or null — SQLite's flexible typing would otherwise
      // store strings in the INTEGER column and break sort/compare.
      let year = body.year;
      if (year != null) {
        year = parseInt(year, 10);
        if (!Number.isInteger(year)) {
          return reply.code(400).send({ error: 'year must be an integer or null' });
        }
      }
      fields.push('year = @year'); params.year = year;
    }
    if ('trackNumber' in body) {
      let tn = body.trackNumber;
      if (tn != null) {
        tn = parseInt(tn, 10);
        if (!Number.isInteger(tn)) {
          return reply.code(400).send({ error: 'trackNumber must be an integer or null' });
        }
      }
      fields.push('track_number = @track_number'); params.track_number = tn;
    }
    if ('description' in body) { fields.push('description = @description'); params.description = body.description; }

    if (fields.length === 0) {
      return buildResponse(existing);
    }

    fields.push("updated_at = datetime('now')");

    // Single statement; the media_fts_au trigger keeps the FTS index in sync
    // atomically within the statement (no explicit transaction needed).
    db.prepare(`UPDATE media SET ${fields.join(', ')} WHERE id = @id`).run(params);

    // Return fresh record
    const updated = getMedia.get(id);

    // C2-c — re-sync the relational artist membership when the artist column was
    // edited, so the facet/filter reflect the change in THIS request instead of
    // only after a rescan (closes the long-open "edit reflects after a rescan"
    // gap). This is a write-path data mutation on a user action, but it reuses
    // the SAME proven diff-replace syncArtistLinks the scanner runs (covered by
    // the Stage A accretion regression test) — it only rewrites this one row's
    // links, and only when they actually changed.
    //
    // b2b multiplicity comes from the (unchanged) FILENAME, not the edited
    // string — so editing the display of a b2b set does not collapse it. The
    // EFFECTIVE display (`updated.artist ?? parsed.artist`, Decision H) is used
    // so clearing the artist to null re-points membership to the filename
    // fallback that the card still shows (not an empty relation). A new casing
    // introduced by the edit gets its canonical assigned by the fold seam inside
    // syncArtistLinks; group RE-ANCHORING still waits for the next
    // backfillCanonical (restart), consistent with the rename story.
    if ('artist' in body) {
      const parsed = parseFilename(updated.filename, { b2bJoin });
      const eff = updated.artist ?? parsed.artist;
      syncArtistLinks(updated.id, deriveArtistMembers(parsed, eff), artistStmts);
    }

    return buildResponse(updated);
  });
}
