export default async function importExportRoutes(fastify) {
  const db = fastify.db;

  // POST /api/import — CSV text or JSON array
  fastify.post('/api/import', async (request, reply) => {
    const body = request.body;
    let records;

    if (typeof body === 'string') {
      // CSV text
      records = parseCsv(body);
    } else if (Array.isArray(body)) {
      records = body;
    } else if (body && typeof body === 'object' && typeof body.csv === 'string') {
      records = parseCsv(body.csv);
    } else {
      return reply.code(400).send({
        error: 'Body must be CSV text, JSON array, or { csv: "..." }',
      });
    }

    const findByFilename = db.prepare('SELECT id FROM media WHERE filename = ?');
    const findByRelPath = db.prepare('SELECT id FROM media WHERE rel_path = ?');
    const updateMeta = db.prepare(`
      UPDATE media
      SET title = COALESCE(@title, title),
          artist = COALESCE(@artist, artist),
          year = COALESCE(@year, year),
          album = COALESCE(@album, album),
          track_number = COALESCE(@track_number, track_number),
          description = COALESCE(@description, description),
          updated_at = datetime('now')
      WHERE id = @id
    `);
    const rebuildFts = db.prepare(
      `INSERT INTO media_fts(media_fts) VALUES('rebuild')`
    );
    const findTag = db.prepare('SELECT id FROM tags WHERE normalized = ?');
    const insertTag = db.prepare('INSERT INTO tags (name, normalized) VALUES (@name, @normalized)');
    const clearTags = db.prepare('DELETE FROM media_tags WHERE media_id = ?');
    const linkTag = db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (@media_id, @tag_id)');

    let matched = 0;
    let skipped = 0;
    const errors = [];

    const tx = db.transaction(() => {
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        try {
          // Match on rel_path first, then filename
          let row = null;
          if (rec.rel_path) row = findByRelPath.get(rec.rel_path);
          if (!row && rec.filename) row = findByFilename.get(rec.filename);

          if (!row) {
            skipped++;
            continue;
          }

          updateMeta.run({
            id: row.id,
            title: rec.title || null,
            artist: rec.artist || null,
            year: rec.year ? parseInt(rec.year, 10) : null,
            album: rec.album || null,
            track_number: rec.track_number ? parseInt(rec.track_number, 10) : null,
            description: rec.description || null,
          });

          // Tags (comma-separated string or array)
          if (rec.tags) {
            const tagNames = Array.isArray(rec.tags)
              ? rec.tags
              : String(rec.tags).split(',').map(t => t.trim()).filter(Boolean);

            clearTags.run(row.id);
            for (const name of tagNames) {
              const normalized = name.toLowerCase();
              let tagRow = findTag.get(normalized);
              if (!tagRow) {
                const result = insertTag.run({ name, normalized });
                tagRow = { id: result.lastInsertRowid };
              }
              linkTag.run({ media_id: row.id, tag_id: tagRow.id });
            }
          }

          matched++;
        } catch (err) {
          errors.push({ line: i + 1, error: err.message });
        }
      }

      // Rebuild FTS once after all updates
      if (matched > 0) rebuildFts.run();
    });

    tx();
    return { matched, skipped, errors };
  });

  // GET /api/export — JSON or CSV
  fastify.get('/api/export', async (request, reply) => {
    const { format = 'json', lib } = request.query;

    let sql = `
      SELECT m.id, m.filename, m.rel_path, m.ext, m.media_type,
             m.size_bytes, m.mtime_ms, m.title, m.artist, m.year,
             m.album, m.track_number, m.description, l.name AS library_name,
             m.created_at, m.updated_at
      FROM media m
      JOIN libraries l ON l.id = m.library_id
    `;
    const params = {};

    if (lib) {
      sql += ' WHERE l.name = @lib';
      params.lib = lib;
    }

    sql += ' ORDER BY l.name, m.filename';

    const rows = db.prepare(sql).all(params);

    // Attach tags
    const tagSql = `
      SELECT mt.media_id, t.name
      FROM media_tags mt
      JOIN tags t ON t.id = mt.tag_id
    `;
    const tagRows = db.prepare(tagSql).all();
    const tagMap = {};
    for (const tr of tagRows) {
      if (!tagMap[tr.media_id]) tagMap[tr.media_id] = [];
      tagMap[tr.media_id].push(tr.name);
    }

    const data = rows.map(r => ({
      ...r,
      tags: (tagMap[r.id] ?? []).join(', '),
    }));

    if (format === 'csv') {
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename="reel-export.csv"');
      return toCsv(data);
    }

    return { items: data };
  });
}

/** Minimal CSV parser — handles quoted fields and commas within quotes. */
function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = parseCSVLine(lines[0]);
  const records = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h.trim()] = values[idx]?.trim() ?? ''; });
    records.push(obj);
  }

  return records;
}

function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        fields.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    const s = String(v ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(h => escape(row[h])).join(','));
  }
  return lines.join('\n');
}
