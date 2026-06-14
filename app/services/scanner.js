import { readdir, stat } from 'node:fs/promises';
import { join, relative, extname, basename } from 'node:path';
import { mediaTypeForExt } from './mime.js';
import { parseFilename } from './metadata.js';
import { parseFile } from 'music-metadata';

/** Audio extensions where embedded tag reading is worthwhile. */
const TAG_READABLE = new Set([
  'mp3', 'm4a', 'flac', 'ogg', 'opus', 'aac', 'wav', 'wma',
]);

/**
 * Recursively walk a directory, yielding file paths.
 * Uses async fs.promises so the event loop stays responsive.
 * Symlinks are resolved via stat() so linked files/dirs are included;
 * broken links are counted and skipped.
 */
async function* walkDir(dir, counters) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full, counters);
    } else if (entry.isFile()) {
      yield full;
    } else if (entry.isSymbolicLink()) {
      // Resolve the link target; recurse into dirs, yield files
      try {
        const target = await stat(full); // stat follows symlinks
        if (target.isDirectory()) {
          yield* walkDir(full, counters);
        } else if (target.isFile()) {
          yield full;
        }
      } catch {
        counters.brokenSymlinks++;
      }
    }
  }
}

/**
 * Scan all configured libraries and upsert media records.
 *
 * Stale deletion is scoped PER LIBRARY and is skipped for any library that:
 *   a) threw during its walk (mount missing, permission change), or
 *   b) walked zero media files while the DB has existing rows for it
 *      (mounted-but-empty, e.g. wrong volume path).
 * This prevents a transient mount failure from cascading into deletion of
 * all media rows — and with them, all markers and tag links (ON DELETE CASCADE).
 *
 * Tag-read optimization (v1.4): embedded tag reading via music-metadata is
 * skipped for files that already exist in the DB. The upsert's ON CONFLICT
 * clause only updates size/mtime/scan tracking — it does not overwrite
 * title/artist/year/album/track_number. So tag reads for existing files are
 * pure I/O waste; the results would be discarded by the upsert. If a file
 * is re-encoded at the same path, the user should delete the DB row and
 * re-scan (or edit metadata manually) to pick up new embedded tags.
 *
 * @param {object} config - app config with libraries and allowedExtensions
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{ scanId: number, totalUpserts: number, totalDeletes: number, skippedLibraries: string[], brokenSymlinks: number }>}
 */
export async function scanLibraries(config, db) {
  const allowedSet = new Set(config.allowedExtensions);
  const globalAutoTagDepth = config.autoTagDepth || 0;
  const globalAutoTagExclude = new Set((config.autoTagExclude || []).map(s => s.toLowerCase()));
  const tagRules = config.tagRules || [];

  // Generate a unique scan ID (monotonic counter)
  const scanId = Date.now();

  // Prepare statements outside the loop
  const getLibrary = db.prepare('SELECT id FROM libraries WHERE name = ?');
  const countMedia = db.prepare('SELECT COUNT(*) AS n FROM media WHERE library_id = ?');
  const upsertMedia = db.prepare(`
    INSERT INTO media (library_id, abs_path, rel_path, filename, ext, media_type,
                       size_bytes, mtime_ms, title, artist, year, album, track_number,
                       last_seen_scan)
    VALUES (@library_id, @abs_path, @rel_path, @filename, @ext, @media_type,
            @size_bytes, @mtime_ms, @title, @artist, @year, @album, @track_number,
            @last_seen_scan)
    ON CONFLICT(abs_path) DO UPDATE SET
      rel_path = @rel_path,
      filename = @filename,
      size_bytes = @size_bytes,
      mtime_ms = @mtime_ms,
      last_seen_scan = @last_seen_scan,
      updated_at = datetime('now')
  `);
  const deleteStaleForLibrary = db.prepare(
    'DELETE FROM media WHERE library_id = ? AND last_seen_scan < ?'
  );

  // Auto-tag prepared statements
  const findTag = db.prepare('SELECT id FROM tags WHERE normalized = ?');
  const insertTag = db.prepare('INSERT INTO tags (name, normalized) VALUES (@name, @normalized)');
  const linkTag = db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (@media_id, @tag_id)');
  const getMediaByPath = db.prepare('SELECT id FROM media WHERE abs_path = ?');

  let totalUpserts = 0;
  let totalDeletes = 0;
  let tagReadsSkipped = 0;
  const skippedLibraries = [];
  const counters = { brokenSymlinks: 0 };

  // Build per-library auto-tag config lookup
  const libAutoTagMap = new Map();
  for (const lib of config.libraries) {
    const depth = lib.autoTagDepth ?? globalAutoTagDepth;
    const excludeSet = lib.autoTagExclude
      ? new Set(lib.autoTagExclude.map(s => s.toLowerCase()))
      : globalAutoTagExclude;
    libAutoTagMap.set(lib.name, { depth, excludeSet });
  }

  for (const lib of config.libraries) {
    const row = getLibrary.get(lib.name);
    if (!row) {
      console.warn(`[reel] Library "${lib.name}" not found in DB, skipping`);
      continue;
    }
    const libraryId = row.id;
    const autoTag = libAutoTagMap.get(lib.name);

    let libUpserts = 0;
    let walkFailed = false;

    try {
      for await (const absPath of walkDir(lib.path, counters)) {
        const ext = extname(absPath).slice(1).toLowerCase();
        if (!allowedSet.has(ext)) continue;

        const mediaType = mediaTypeForExt(ext);
        if (!mediaType) continue;

        let fileStat;
        try {
          fileStat = await stat(absPath);
        } catch {
          continue; // skip unreadable files
        }

        const filename = basename(absPath);
        const relPath = relative(lib.path, absPath);
        const parsed = parseFilename(filename);

        // Check if this file already exists in the DB.
        // If it does, skip the expensive music-metadata tag read — the upsert's
        // ON CONFLICT clause doesn't update metadata fields, so the read result
        // would be discarded anyway.
        const existingMedia = getMediaByPath.get(absPath);

        // ID3 tag reading for NEW audio files only — fall back to parseFilename
        let artist = parsed.artist;
        let title = parsed.title;
        let year = parsed.year;
        let album = null;
        let trackNumber = null;

        if (mediaType === 'audio' && TAG_READABLE.has(ext) && !existingMedia) {
          try {
            const meta = await parseFile(absPath, { skipCovers: true, duration: false });
            const c = meta.common;
            if (c.artist) artist = c.artist;
            if (c.title) title = c.title;
            if (c.album) album = c.album;
            if (c.year) year = c.year;
            if (c.track?.no) trackNumber = c.track.no;
          } catch {
            // Tag read failed — use parseFilename values (already set above)
          }
        } else if (mediaType === 'audio' && TAG_READABLE.has(ext) && existingMedia) {
          tagReadsSkipped++;
        }

        upsertMedia.run({
          library_id: libraryId,
          abs_path: absPath,
          rel_path: relPath,
          filename,
          ext,
          media_type: mediaType,
          size_bytes: fileStat.size,
          mtime_ms: Math.floor(fileStat.mtimeMs),
          title,
          artist,
          year,
          album,
          track_number: trackNumber,
          last_seen_scan: scanId,
        });

        // Get the media ID for tagging (re-query since upsert may have inserted)
        const mediaRow = existingMedia || getMediaByPath.get(absPath);
        if (!mediaRow) continue;
        const mediaId = mediaRow.id;

        // Auto-tag from directory path segments
        if (autoTag.depth > 0) {
          const segments = relPath.split(/[/\\]/).slice(0, -1); // drop filename
          const tagSegments = segments
            .slice(0, autoTag.depth)
            .filter(seg => seg && !autoTag.excludeSet.has(seg.toLowerCase()));

          for (const tagName of tagSegments) {
            applyTag(tagName, mediaId, findTag, insertTag, linkTag);
          }
        }

        // Filename-pattern tag rules (keyword matching)
        if (tagRules.length > 0) {
          const filenameLower = filename.toLowerCase();
          for (const rule of tagRules) {
            if (rule.match && filenameLower.includes(rule.match.toLowerCase())) {
              applyTag(rule.tag, mediaId, findTag, insertTag, linkTag);
            }
          }
        }

        libUpserts++;
      }
    } catch (err) {
      walkFailed = true;
      console.error(`[reel] Error scanning library "${lib.name}" (${lib.path}): ${err.message}`);
    }

    totalUpserts += libUpserts;

    // Stale-delete safety: never delete from a library whose walk failed,
    // or that returned zero files when the DB previously had rows for it.
    const existingCount = countMedia.get(libraryId).n;
    if (walkFailed || (libUpserts === 0 && existingCount > 0)) {
      skippedLibraries.push(lib.name);
      console.warn(
        `[reel] Skipping stale-delete for library "${lib.name}" ` +
        `(${walkFailed ? 'scan error' : `0 files walked, ${existingCount} rows in DB`})`
      );
      continue;
    }

    const result = deleteStaleForLibrary.run(libraryId, scanId);
    totalDeletes += result.changes;
  }

  if (counters.brokenSymlinks > 0) {
    console.warn(`[reel] Skipped ${counters.brokenSymlinks} broken symlink(s) during scan`);
  }

  if (tagReadsSkipped > 0) {
    console.log(`[reel] Skipped ${tagReadsSkipped} tag read(s) for existing files`);
  }

  // Rebuild FTS index
  rebuildFts(db);

  console.log(`[reel] Scan complete: ${totalUpserts} upserted, ${totalDeletes} deleted` +
    (skippedLibraries.length ? `, stale-delete skipped for: ${skippedLibraries.join(', ')}` : ''));
  return { scanId, totalUpserts, totalDeletes, skippedLibraries, brokenSymlinks: counters.brokenSymlinks };
}

/**
 * Apply a tag to a media item (find-or-create + link).
 */
function applyTag(tagName, mediaId, findTag, insertTag, linkTag) {
  const normalized = tagName.toLowerCase();
  let tagRow = findTag.get(normalized);
  if (!tagRow) {
    const tagResult = insertTag.run({ name: tagName, normalized });
    tagRow = { id: tagResult.lastInsertRowid };
  }
  linkTag.run({ media_id: mediaId, tag_id: tagRow.id });
}

/**
 * Rebuild the FTS5 index from the media table.
 * Uses the rebuild command which is safe for content-sync'd tables.
 */
function rebuildFts(db) {
  // For content-synced FTS5 tables, use the 'rebuild' command.
  // This re-reads all content from the source table.
  db.exec(`INSERT INTO media_fts(media_fts) VALUES('rebuild')`);
}
