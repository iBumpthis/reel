import { readdir, stat } from 'node:fs/promises';
import { join, relative, extname, basename } from 'node:path';
import { mediaTypeForExt } from './mime.js';
import { parseFilename } from './metadata.js';

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
 * @param {object} config - app config with libraries and allowedExtensions
 * @param {import('better-sqlite3').Database} db
 * @returns {Promise<{ scanId: number, totalUpserts: number, totalDeletes: number, skippedLibraries: string[], brokenSymlinks: number }>}
 */
export async function scanLibraries(config, db) {
  const allowedSet = new Set(config.allowedExtensions);

  // Generate a unique scan ID (monotonic counter)
  const scanId = Date.now();

  // Prepare statements outside the loop
  const getLibrary = db.prepare('SELECT id FROM libraries WHERE name = ?');
  const countMedia = db.prepare('SELECT COUNT(*) AS n FROM media WHERE library_id = ?');
  const upsertMedia = db.prepare(`
    INSERT INTO media (library_id, abs_path, rel_path, filename, ext, media_type,
                       size_bytes, mtime_ms, title, artist, year, last_seen_scan)
    VALUES (@library_id, @abs_path, @rel_path, @filename, @ext, @media_type,
            @size_bytes, @mtime_ms, @title, @artist, @year, @last_seen_scan)
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

  let totalUpserts = 0;
  let totalDeletes = 0;
  const skippedLibraries = [];
  const counters = { brokenSymlinks: 0 };

  for (const lib of config.libraries) {
    const row = getLibrary.get(lib.name);
    if (!row) {
      console.warn(`[reel] Library "${lib.name}" not found in DB, skipping`);
      continue;
    }
    const libraryId = row.id;

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
        const { artist, title, year } = parseFilename(filename);

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
          last_seen_scan: scanId,
        });

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

  // Rebuild FTS index
  rebuildFts(db);

  console.log(`[reel] Scan complete: ${totalUpserts} upserted, ${totalDeletes} deleted` +
    (skippedLibraries.length ? `, stale-delete skipped for: ${skippedLibraries.join(', ')}` : ''));
  return { scanId, totalUpserts, totalDeletes, skippedLibraries, brokenSymlinks: counters.brokenSymlinks };
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
