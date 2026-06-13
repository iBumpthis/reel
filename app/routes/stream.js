import { sendRangeStream } from '../services/stream.js';
import { mimeForExt } from '../services/mime.js';

export default async function streamRoutes(fastify) {
  const db = fastify.db;

  const getMedia = db.prepare('SELECT abs_path, ext FROM media WHERE id = ?');

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

      const mime = mimeForExt(row.ext) ?? 'application/octet-stream';
      return sendRangeStream(request, reply, row.abs_path, mime);
    },
  });
}
