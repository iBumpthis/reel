import { parseFilename } from '../services/metadata.js';

export default async function mediaRoutes(fastify) {
  const db = fastify.db;

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

  // FTS rebuild after metadata changes (content-synced table requires rebuild)
  const rebuildFts = db.prepare(
    `INSERT INTO media_fts(media_fts) VALUES('rebuild')`
  );

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
      year: row.year ?? parsed.year,
      album: row.album ?? null,
      trackNumber: row.track_number ?? null,
      description: row.description,
      markers,
      tags,
      streamUrl: `/stream/${row.id}`,
      defaultPlaybackMode: row.media_type === 'audio' ? 'audio' : 'video',
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

    const updateTx = db.transaction(() => {
      db.prepare(`UPDATE media SET ${fields.join(', ')} WHERE id = @id`).run(params);
      rebuildFts.run();
    });

    updateTx();

    // Return fresh record
    const updated = getMedia.get(id);
    return buildResponse(updated);
  });
}
