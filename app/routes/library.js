import { parseFilename } from '../services/metadata.js';

const VALID_SORT = new Set(['title', 'artist', 'album', 'year', 'mtime', 'size', 'created']);
// All sort expressions must be non-null so row-value cursor comparison
// never hits NULL (which would silently drop rows from later pages).
const SORT_COLUMN_MAP = {
  title: 'COALESCE(m.title, m.filename)',
  artist: 'COALESCE(m.artist, m.filename)',
  album: 'COALESCE(m.album, m.filename)',
  year: 'COALESCE(m.year, 0)',
  mtime: 'm.mtime_ms',
  size: 'm.size_bytes',
  created: 'm.created_at',
};

/**
 * Sanitize raw user input into a safe FTS5 MATCH expression.
 * FTS5 MATCH input is a query language — bare quotes, hyphens, parens,
 * and operators like NEAR either throw SQLITE_ERROR or change meaning.
 * Strategy: split on whitespace, wrap each token in double quotes
 * (doubling internal quotes), append * to the last token for
 * prefix-matching during search-as-you-type.
 * Returns null when nothing searchable remains.
 */
function toFtsQuery(q) {
  const tokens = String(q).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens
    .map((t, i) => {
      const quoted = `"${t.replace(/"/g, '""')}"`;
      return i === tokens.length - 1 ? `${quoted}*` : quoted;
    })
    .join(' ');
}

/** Encode/decode the composite keyset cursor: { v: sortValue, id }. */
function encodeCursor(sortValue, id) {
  return Buffer.from(JSON.stringify({ v: sortValue, id })).toString('base64url');
}
function decodeCursor(cursor) {
  try {
    const obj = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Number.isInteger(obj.id) || !('v' in obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

export default async function libraryRoutes(fastify) {
  const db = fastify.db;

  fastify.get('/api/library', async (request, reply) => {
    const {
      lib, type, ext, tag, q, artist, missing,
      sort = 'mtime',
      order = 'desc',
      limit: rawLimit = '50',
      cursor,
    } = request.query;

    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 200);
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';

    if (!VALID_SORT.has(sort)) {
      return reply.code(400).send({
        error: `Invalid sort field: ${sort}. Valid: ${[...VALID_SORT].join(', ')}`,
      });
    }

    const sortColumn = SORT_COLUMN_MAP[sort];

    // Build WHERE clauses
    const conditions = [];
    const params = {};

    // Presence filter (soft-delete, migration 004). Rows whose files have gone
    // missing are RETAINED but hidden from normal browse/search by default.
    // `missing=only` powers the maintenance / purge-confirm view; `include`
    // shows both. Added first so it propagates into the totalCount query too.
    if (missing === 'only') {
      conditions.push('m.present = 0');
    } else if (missing !== 'include') {
      conditions.push('m.present = 1');
    }

    if (lib) {
      conditions.push('l.name = @lib');
      params.lib = lib;
    }
    if (type) {
      conditions.push('m.media_type = @type');
      params.type = type;
    }
    if (ext) {
      conditions.push('m.ext = @ext');
      params.ext = ext.toLowerCase();
    }
    if (artist) {
      conditions.push('m.artist = @artist');
      params.artist = artist;
    }
    if (tag) {
      // Support comma-separated tags (AND logic — item must have all tags)
      const tagNames = tag.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
      if (tagNames.length > 0) {
        conditions.push(`m.id IN (
          SELECT mt.media_id FROM media_tags mt
          JOIN tags t ON t.id = mt.tag_id
          WHERE t.normalized IN (${tagNames.map((_, i) => `@tag${i}`).join(',')})
          GROUP BY mt.media_id
          HAVING COUNT(DISTINCT t.id) = @tagCount
        )`);
        tagNames.forEach((t, i) => { params[`tag${i}`] = t; });
        params.tagCount = tagNames.length;
      }
    }
    if (q) {
      const ftsQuery = toFtsQuery(q);
      if (ftsQuery) {
        conditions.push(`(m.id IN (SELECT rowid FROM media_fts WHERE media_fts MATCH @q) OR m.id IN (SELECT mt.media_id FROM media_tags mt JOIN tags t ON t.id = mt.tag_id WHERE t.normalized LIKE '%' || @qLower || '%'))`);
        params.q = ftsQuery;
        params.qLower = q.toLowerCase();
      }
    }

    // Snapshot filter conditions BEFORE the cursor predicate —
    // used by the totalCount query below.
    const filterConditions = [...conditions];

    // Composite keyset pagination: (sortColumn, id) row-value comparison
    // matching the ORDER BY direction. An id-only cursor is only correct
    // when sorting by id; for title/artist/etc it skips rows.
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        return reply.code(400).send({ error: 'Invalid cursor' });
      }
      const op = sortDir === 'ASC' ? '>' : '<';
      conditions.push(`(${sortColumn}, m.id) ${op} (@cursorV, @cursorId)`);
      params.cursorV = decoded.v;
      params.cursorId = decoded.id;
    }

    const whereClause = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';

    // Main query — id tiebreaker must follow the same direction as the
    // sort column for the row-value comparison to be a valid keyset.
    const sql = `
      SELECT m.id, m.library_id, l.name AS library_name, m.filename, m.ext,
             m.media_type, m.size_bytes, m.mtime_ms,
             m.title, m.artist, m.year, m.album, m.description,
             m.present, m.missing_since,
             m.created_at, m.updated_at,
             ${sortColumn} AS sort_value,
             (SELECT COUNT(*) FROM markers mk WHERE mk.media_id = m.id) AS marker_count
      FROM media m
      JOIN libraries l ON l.id = m.library_id
      ${whereClause}
      ORDER BY ${sortColumn} ${sortDir}, m.id ${sortDir}
      LIMIT @limit
    `;
    params.limit = limit + 1; // fetch one extra for nextCursor detection

    let rows;
    try {
      rows = db.prepare(sql).all(params);
    } catch (err) {
      // Backstop — malformed FTS input should be impossible after
      // sanitization, but a query failure should be a 400, not a 500.
      fastify.log.warn(err, 'Library query failed');
      return reply.code(400).send({ error: 'Invalid query' });
    }

    // Check if there's a next page
    let nextCursor = null;
    if (rows.length > limit) {
      rows.pop(); // remove the extra row
      const last = rows[rows.length - 1];
      nextCursor = encodeCursor(last.sort_value, last.id);
    }

    // Get tags for all returned items in one query
    const ids = rows.map(r => r.id);
    let tagMap = {};
    if (ids.length > 0) {
      const tagSql = `
        SELECT mt.media_id, t.name
        FROM media_tags mt
        JOIN tags t ON t.id = mt.tag_id
        WHERE mt.media_id IN (${ids.map(() => '?').join(',')})
      `;
      const tagRows = db.prepare(tagSql).all(...ids);
      for (const tr of tagRows) {
        if (!tagMap[tr.media_id]) tagMap[tr.media_id] = [];
        tagMap[tr.media_id].push(tr.name);
      }
    }

    // Build items with fallback metadata from filename
    const items = rows.map(row => {
      const parsed = parseFilename(row.filename);
      return {
        id: row.id,
        libraryName: row.library_name,
        filename: row.filename,
        ext: row.ext,
        mediaType: row.media_type,
        sizeBytes: row.size_bytes,
        mtimeMs: row.mtime_ms,
        title: row.title ?? parsed.title,
        artist: row.artist ?? parsed.artist,
        year: row.year ?? parsed.year,
        album: row.album ?? null,
        description: row.description,
        tags: tagMap[row.id] ?? [],
        markerCount: row.marker_count,
        present: !!row.present,
        missingSince: row.missing_since,
      };
    });

    // Total count (same filters, no pagination)
    const countWhere = filterConditions.length > 0
      ? 'WHERE ' + filterConditions.join(' AND ')
      : '';
    const countParams = { ...params };
    delete countParams.limit;
    delete countParams.cursorV;
    delete countParams.cursorId;
    const countSql = `
      SELECT COUNT(*) AS total
      FROM media m
      JOIN libraries l ON l.id = m.library_id
      ${countWhere}
    `;
    const totalCount = db.prepare(countSql).get(countParams).total;

    // Library list
    const libraries = db.prepare('SELECT id, name, path FROM libraries').all();

    return { items, libraries, nextCursor, totalCount };
  });
}
