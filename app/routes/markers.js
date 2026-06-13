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
  const deleteMarkers = db.prepare('DELETE FROM markers WHERE media_id = ?');
  const insertMarker = db.prepare(`
    INSERT INTO markers (media_id, start_seconds, end_seconds, label, raw_line,
                         was_adjusted, adjust_reason, sort_order)
    VALUES (@media_id, @start_seconds, @end_seconds, @label, @raw_line,
            @was_adjusted, @adjust_reason, @sort_order)
  `);

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
}
