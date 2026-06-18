import { sendRangeStream } from '../services/stream.js';
import { mimeForExt } from '../services/mime.js';

export default async function streamRoutes(fastify) {
  const db = fastify.db;

  const getMedia = db.prepare('SELECT abs_path, ext, present FROM media WHERE id = ?');

  // Support both GET and HEAD
  fastify.route({
    method: ['GET', 'HEAD'],
    url: '/stream/:id',
    handler: async (request, reply) => {
      const { id } = request.params;
      const row = getMedia.get(id);

      if (!row) {
        return reply.code(404).send({ error: 'Media not found' });
      }

      // Soft-deleted (missing) media: the row is retained for its markers/tags/
      // metadata, but the underlying file is gone. 410 Gone is the precise
      // semantic — the resource existed and no longer does — and avoids a messy
      // ENOENT from the range streamer.
      if (!row.present) {
        return reply.code(410).send({ error: 'Media file is missing (file not found on last scan)' });
      }

      const mime = mimeForExt(row.ext) ?? 'application/octet-stream';
      return sendRangeStream(request, reply, row.abs_path, mime);
    },
  });
}
