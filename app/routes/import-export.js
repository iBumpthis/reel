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

      // FTS sync is handled per-row by the media_fts_au trigger (migration
      // 003): each updateMeta UPDATE that changes an indexed column resyncs
      // just that row, inside this same transaction. No full rebuild.
    });

    tx();
    return { matched, skipped, errors };
  });

  // GET /api/export — JSON or CSV
  fastify.get('/api/export', async (request, reply) => {
    const { format = 'json', lib } = request.query;

    // Markers CSV — one row per marker with media identification
    if (format === 'markers-csv') {
      let markerSql = `
        SELECT m.filename, m.rel_path, mk.start_seconds, mk.end_seconds, mk.label
        FROM markers mk
        JOIN media m ON m.id = mk.media_id
        JOIN libraries l ON l.id = m.library_id
      `;
      const markerParams = {};
      if (lib) {
        markerSql += ' WHERE l.name = @lib';
        markerParams.lib = lib;
      }
      markerSql += ' ORDER BY m.filename, mk.start_seconds, mk.sort_order';

      const markerRows = db.prepare(markerSql).all(markerParams);
      const data = markerRows.map(r => ({
        filename: r.filename,
        rel_path: r.rel_path,
        start: r.start_seconds,
        end: r.end_seconds,
        label: r.label,
      }));

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename="reel-markers.csv"');
      return toCsv(data);
    }

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

  // POST /api/import/markers — bulk marker import from CSV
  // Columns: filename, rel_path, start, end, label
  // Replace-all semantics per matched media item
  fastify.post('/api/import/markers', async (request, reply) => {
    const body = request.body;
    let records;

    if (typeof body === 'string') {
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
    const deleteMarkers = db.prepare('DELETE FROM markers WHERE media_id = ?');
    const insertMarker = db.prepare(`
      INSERT INTO markers (media_id, start_seconds, end_seconds, label, raw_line, sort_order)
      VALUES (@media_id, @start_seconds, @end_seconds, @label, @raw_line, @sort_order)
    `);

    // Group records by media (filename/rel_path)
    const byMedia = new Map();
    for (const rec of records) {
      const key = rec.rel_path || rec.filename || '';
      if (!key) continue;
      if (!byMedia.has(key)) byMedia.set(key, []);
      byMedia.get(key).push(rec);
    }

    let matched = 0;
    let skipped = 0;
    let markerCount = 0;
    const errors = [];

    const tx = db.transaction(() => {
      for (const [key, recs] of byMedia) {
        try {
          let row = null;
          if (recs[0].rel_path) row = findByRelPath.get(recs[0].rel_path);
          if (!row && recs[0].filename) row = findByFilename.get(recs[0].filename);

          if (!row) { skipped++; continue; }

          // Replace all markers for this media item
          deleteMarkers.run(row.id);

          const sortedRecs = recs
            .map(r => ({
              start: parseFloat(r.start),
              end: r.end ? parseFloat(r.end) : null,
              label: (r.label || '').trim(),
            }))
            .filter(r => Number.isFinite(r.start) && r.label)
            .sort((a, b) => a.start - b.start);

          for (let i = 0; i < sortedRecs.length; i++) {
            insertMarker.run({
              media_id: row.id,
              start_seconds: sortedRecs[i].start,
              end_seconds: sortedRecs[i].end,
              label: sortedRecs[i].label,
              raw_line: null,
              sort_order: i,
            });
            markerCount++;
          }

          matched++;
        } catch (err) {
          errors.push({ key, error: err.message });
        }
      }
    });

    tx();
    return { matched, skipped, markerCount, errors };
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

/**
 * Characters that can trigger formula execution in Excel/Sheets/LibreOffice
 * when they appear as the first character of a CSV cell. Prefixed with a
 * leading apostrophe to neutralize them. The apostrophe is visible in the
 * cell but prevents formula interpretation.
 *
 * OWASP CSV Injection reference characters: = + - @ | \t \r
 * We include = + - @ as these are the practical risk set for user-generated
 * media metadata. Filenames starting with '-' are uncommon but possible;
 * the apostrophe prefix is the accepted tradeoff for safety.
 */
const CSV_FORMULA_CHARS = new Set(['=', '+', '-', '@']);

function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    let s = String(v ?? '');
    // Neutralize formula injection: prefix dangerous first characters
    if (s.length > 0 && CSV_FORMULA_CHARS.has(s[0])) {
      s = "'" + s;
    }
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
