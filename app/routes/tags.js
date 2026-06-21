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
  // GROUP BY the CANONICAL row (006): case-variant rows (Rezz/REZZ) fold to one
  // entry, and a promoted act (kind='act', C2) shows as its own entry.
  // canonical_id NULL ⇒ the row is its own canonical, so COALESCE(canonical_id,
  // id) is the grouping key and this degrades to the v1.15 per-casing facet when
  // nothing is folded (e.g. artistCanonicalFold off). COUNT(DISTINCT m.id): a
  // media linked to two variants of one canonical counts once. kind is surfaced
  // so the sidebar can mark acts. Display = the canonical (most-used) casing.
  //
  // present = 1: soft-deleted (missing) media keep their links but stay hidden,
  // matching the read-path filtering applied everywhere else.
  const allArtists = db.prepare(`
    SELECT can.name AS name, can.kind AS kind, COUNT(DISTINCT m.id) AS count
    FROM media m
    JOIN media_artists ma ON ma.media_id = m.id
    JOIN artists a   ON a.id  = ma.artist_id
    JOIN artists can ON can.id = COALESCE(a.canonical_id, a.id)
    WHERE m.present = 1
    GROUP BY can.id
    ORDER BY can.name ASC
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
