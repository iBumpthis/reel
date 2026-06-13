export default async function tagRoutes(fastify) {
  const db = fastify.db;

  const allTags = db.prepare(`
    SELECT t.id, t.name, COUNT(mt.media_id) AS count
    FROM tags t
    LEFT JOIN media_tags mt ON mt.tag_id = t.id
    GROUP BY t.id
    ORDER BY t.name ASC
  `);

  const mediaExists = db.prepare('SELECT id FROM media WHERE id = ?');
  const clearMediaTags = db.prepare('DELETE FROM media_tags WHERE media_id = ?');
  const findTag = db.prepare('SELECT id FROM tags WHERE normalized = ?');
  const insertTag = db.prepare('INSERT INTO tags (name, normalized) VALUES (@name, @normalized)');
  const linkTag = db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (@media_id, @tag_id)');
  const getMediaTags = db.prepare(`
    SELECT t.id, t.name
    FROM media_tags mt
    JOIN tags t ON t.id = mt.tag_id
    WHERE mt.media_id = ?
    ORDER BY t.name ASC
  `);

  // GET /api/tags
  fastify.get('/api/tags', async () => {
    return { tags: allTags.all() };
  });

  // GET /api/artists
  const allArtists = db.prepare(`
    SELECT artist AS name, COUNT(*) AS count
    FROM media
    WHERE artist IS NOT NULL AND artist != ''
    GROUP BY artist
    ORDER BY artist ASC
  `);

  fastify.get('/api/artists', async () => {
    return { artists: allArtists.all() };
  });

  // POST /api/media/:id/tags — replace-all semantics
  fastify.post('/api/media/:id/tags', async (request, reply) => {
    const { id } = request.params;
    const media = mediaExists.get(id);
    if (!media) return reply.code(404).send({ error: 'Media not found' });

    const { tags } = request.body ?? {};
    if (!Array.isArray(tags)) {
      return reply.code(400).send({ error: 'Body must contain "tags" (array of strings)' });
    }

    const mediaId = parseInt(id, 10);

    const tx = db.transaction(() => {
      clearMediaTags.run(mediaId);

      for (const tagName of tags) {
        const name = String(tagName).trim();
        if (!name) continue;

        const normalized = name.toLowerCase();
        let tagRow = findTag.get(normalized);

        if (!tagRow) {
          const result = insertTag.run({ name, normalized });
          tagRow = { id: result.lastInsertRowid };
        }

        linkTag.run({ media_id: mediaId, tag_id: tagRow.id });
      }
    });

    tx();

    return { tags: getMediaTags.all(mediaId) };
  });
}
