import { parseMarkerBlock, formatMarkerBlock } from '../services/markers.js';

export default async function markerRoutes(fastify) {
  const db = fastify.db;

  const mediaExists = db.prepare('SELECT id FROM media WHERE id = ?');
  const getMarkers = db.prepare(`
    SELECT start_seconds, end_seconds, label
    FROM markers
    WHERE media_id = ?
    ORDER BY start_seconds ASC, sort_order ASC
  `);
  const getMarkerById = db.prepare(`
    SELECT id, media_id, start_seconds, end_seconds, label, raw_line,
           was_adjusted, adjust_reason, sort_order
    FROM markers
    WHERE id = ? AND media_id = ?
  `);
  const deleteMarkers = db.prepare('DELETE FROM markers WHERE media_id = ?');
  const insertMarker = db.prepare(`
    INSERT INTO markers (media_id, start_seconds, end_seconds, label, raw_line,
                         was_adjusted, adjust_reason, sort_order)
    VALUES (@media_id, @start_seconds, @end_seconds, @label, @raw_line,
            @was_adjusted, @adjust_reason, @sort_order)
  `);

  function formatMarkerRow(row) {
    return {
      id: row.id,
      startSeconds: row.start_seconds,
      endSeconds: row.end_seconds,
      label: row.label,
      rawLine: row.raw_line,
      wasAdjusted: !!row.was_adjusted,
      adjustReason: row.adjust_reason,
      sortOrder: row.sort_order,
    };
  }

  // POST /api/media/:id/markers — replace-all semantics
  fastify.post('/api/media/:id/markers', async (request, reply) => {
    const { id } = request.params;
    const media = mediaExists.get(id);
    if (!media) return reply.code(404).send({ error: 'Media not found' });

    const body = request.body ?? {};
    let markers, errors;

    if (body.markerText && typeof body.markerText === 'string') {
      // Parse from text block
      const result = parseMarkerBlock(body.markerText);
      markers = result.markers;
      errors = result.errors;
    } else if (Array.isArray(body.markers)) {
      // Direct array — validate shape
      markers = body.markers.map((m, i) => ({
        startSeconds: Number(m.startSeconds ?? m.start_seconds),
        endSeconds: m.endSeconds != null || m.end_seconds != null
          ? Number(m.endSeconds ?? m.end_seconds)
          : null,
        label: String(m.label ?? '').trim(),
        rawLine: m.rawLine ?? m.raw_line ?? null,
        wasAdjusted: false,
        adjustReason: null,
        sortOrder: i,
      })).filter(m => Number.isFinite(m.startSeconds) && m.label);
      errors = [];
    } else {
      return reply.code(400).send({
        error: 'Body must contain "markerText" (string) or "markers" (array)',
      });
    }

    const mediaId = parseInt(id, 10);

    const tx = db.transaction(() => {
      deleteMarkers.run(mediaId);
      for (const m of markers) {
        insertMarker.run({
          media_id: mediaId,
          start_seconds: m.startSeconds,
          end_seconds: m.endSeconds,
          label: m.label,
          raw_line: m.rawLine,
          was_adjusted: m.wasAdjusted ? 1 : 0,
          adjust_reason: m.adjustReason,
          sort_order: m.sortOrder,
        });
      }
    });

    tx();

    return {
      ok: true,
      importErrors: errors,
      saved: { markerCount: markers.length },
    };
  });

  // DELETE /api/media/:id/markers
  fastify.delete('/api/media/:id/markers', async (request, reply) => {
    const { id } = request.params;
    const media = mediaExists.get(id);
    if (!media) return reply.code(404).send({ error: 'Media not found' });

    const result = deleteMarkers.run(parseInt(id, 10));
    return { ok: true, deleted: result.changes };
  });

  // GET /api/media/:id/markers/export — re-importable tracklist text
  fastify.get('/api/media/:id/markers/export', async (request, reply) => {
    const { id } = request.params;
    const media = mediaExists.get(id);
    if (!media) return reply.code(404).send({ error: 'Media not found' });

    const rows = getMarkers.all(parseInt(id, 10));
    const markers = rows.map(r => ({
      startSeconds: r.start_seconds,
      endSeconds: r.end_seconds,
      label: r.label,
    }));

    const text = formatMarkerBlock(markers);
    reply.header('Content-Type', 'text/plain; charset=utf-8');
    return text;
  });

  // PATCH /api/media/:id/markers/:markerId — update individual marker
  fastify.patch('/api/media/:id/markers/:markerId', async (request, reply) => {
    const { id, markerId } = request.params;
    const media = mediaExists.get(id);
    if (!media) return reply.code(404).send({ error: 'Media not found' });

    const mediaId = parseInt(id, 10);
    const mId = parseInt(markerId, 10);
    const marker = getMarkerById.get(mId, mediaId);
    if (!marker) return reply.code(404).send({ error: 'Marker not found' });

    const body = request.body ?? {};
    const fields = [];
    const params = { id: mId };

    if ('label' in body) {
      const label = String(body.label ?? '').trim();
      if (!label) return reply.code(400).send({ error: 'label must not be empty' });
      fields.push('label = @label');
      params.label = label;
    }
    if ('startSeconds' in body) {
      const start = Number(body.startSeconds);
      if (!Number.isFinite(start) || start < 0) {
        return reply.code(400).send({ error: 'startSeconds must be a non-negative number' });
      }
      fields.push('start_seconds = @start_seconds');
      params.start_seconds = start;
    }
    if ('endSeconds' in body) {
      if (body.endSeconds != null) {
        const end = Number(body.endSeconds);
        if (!Number.isFinite(end)) {
          return reply.code(400).send({ error: 'endSeconds must be a number or null' });
        }
        fields.push('end_seconds = @end_seconds');
        params.end_seconds = end;
      } else {
        fields.push('end_seconds = NULL');
      }
    }

    if (fields.length === 0) {
      return { ok: true, marker: formatMarkerRow(marker) };
    }

    db.prepare(`UPDATE markers SET ${fields.join(', ')} WHERE id = @id`).run(params);

    const updated = getMarkerById.get(mId, mediaId);
    return { ok: true, marker: formatMarkerRow(updated) };
  });
}
