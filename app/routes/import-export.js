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

    // Reject a marker-shaped CSV pasted into the metadata importer. Without
    // this, marker rows match by filename, run updateMeta with all-undefined
    // metadata columns (COALESCE no-ops, nothing blanked), skip the tag block,
    // and report a cheerful `matched` count while importing zero markers — the
    // silent-success trap. Markers belong on POST /api/import/markers.
    if (hasMarkerColumns(records) && !hasMetadataColumns(records)) {
      return reply.code(400).send({
        error: 'This looks like a markers CSV (start/end/label, no metadata columns). Use Import Markers, not Import Metadata.',
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

    // Reject a non-markers CSV (e.g. a metadata export pasted here by mistake).
    // Replace-all semantics mean a CSV lacking start/label would DELETE every
    // matched file's existing markers and insert nothing — a silent marker
    // wipe. Bail before touching the DB.
    if (records.length && !hasMarkerColumns(records)) {
      return reply.code(400).send({
        error: 'This CSV has no start/label columns — expected a markers CSV (filename, rel_path, start, end, label). Nothing was changed.',
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

/**
 * CSV parser with full RFC-4180-style quote handling. Unlike a naive
 * line-split, this tokenizes the whole text so a quoted field may contain
 * commas AND embedded newlines (e.g. a marker label pasted from a multi-line
 * tracklist) without the record splitting across "lines." Handles `""`
 * escaping and LF / CRLF / lone-CR endings. Returns records keyed by the
 * header row; field values are trimmed (matching prior behaviour) and blank
 * physical rows are dropped.
 *
 * Exported for unit testing (the route plugin is the default export).
 */
export function parseCsv(text) {
  const rows = tokenizeCsv(text);
  if (rows.length < 2) return [];

  const headers = rows[0].map(h => h.trim());
  const records = [];

  for (let r = 1; r < rows.length; r++) {
    const values = rows[r];
    // Drop genuinely blank lines (a single empty field). Emptiness that lives
    // inside quotes never reaches here as its own row — it stays within the
    // quoted field's record.
    if (values.length === 1 && values[0].trim() === '') continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (values[idx] ?? '').trim(); });
    records.push(obj);
  }

  return records;
}

/**
 * Tokenize CSV text into rows of raw field strings, quote-aware across line
 * boundaries so embedded newlines inside quoted fields survive. Trimming is
 * the caller's job so intentional internal whitespace is preserved here.
 */
function tokenizeCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // CRLF: let the following \n close the row. Lone CR: close it here.
      if (text[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += ch;
    }
  }

  // Flush a trailing record that wasn't newline-terminated.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

/**
 * Column-shape detectors used to reject mis-routed CSVs at the import boundary
 * — a markers CSV pasted into the metadata importer, or a metadata CSV pasted
 * into the markers importer. Both inspect the header set of the first record.
 * Exported for unit testing.
 */
const META_COLS = ['title', 'artist', 'year', 'album', 'track_number', 'description', 'tags'];

export function hasMarkerColumns(records) {
  if (!records.length) return false;
  const keys = new Set(Object.keys(records[0]).map(k => k.toLowerCase()));
  return keys.has('start') && keys.has('label');
}

export function hasMetadataColumns(records) {
  if (!records.length) return false;
  const keys = new Set(Object.keys(records[0]).map(k => k.toLowerCase()));
  return META_COLS.some(c => keys.has(c));
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
