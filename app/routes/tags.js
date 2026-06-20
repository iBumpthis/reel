export default async function tagRoutes(fastify) {
  const db = fastify.db;

  const allTags = db.prepare(`
    SELECT t.id, t.name,
           COUNT(CASE WHEN m.present = 1 THEN 1 END) AS count
    FROM tags t
    LEFT JOIN media_tags mt ON mt.tag_id = t.id
    LEFT JOIN media m ON m.id = mt.media_id
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
  // Reads the RELATIONAL artist model (media_artists, migration 005) rather than
  // GROUP BY on the denormalized media.artist text. The old query grouped on the
  // display string, so a b2b set ("A b2b B") was its own facet row and its
  // members fragmented away from their solo sets. Aggregating over the relation
  // lists each artist once and counts every present media they're linked to
  // (solo + b2b). The combined "A b2b B" string no longer appears as a facet.
  //
  // CASE-EXACT: a.name is the case-preserving identity (Stage A); "Rezz" and
  // "REZZ" stay distinct rows. Case folding is Stage C, deliberately parked.
  //
  // present = 1: soft-deleted (missing) media keep their links but stay hidden,
  // matching the read-path filtering applied everywhere else.
  const allArtists = db.prepare(`
    SELECT a.name AS name, COUNT(*) AS count
    FROM artists a
    JOIN media_artists ma ON ma.artist_id = a.id
    JOIN media m          ON m.id = ma.media_id
    WHERE m.present = 1
    GROUP BY a.id
    ORDER BY a.name ASC
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
