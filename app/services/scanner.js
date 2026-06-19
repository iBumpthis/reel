import { readdir, stat, realpath } from 'node:fs/promises';
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
 *
 * Resilience: an unreadable directory (permission change, transient I/O,
 * or a directory that vanished mid-walk) is counted in counters.walkErrors
 * and skipped rather than aborting the whole library walk. scanLibraries
 * treats a non-zero per-library walkError count the same as a hard failure
 * for mark-missing purposes, so a partial read can never flag rows missing
 * that were simply unreadable this pass.
 *
 * Cycle safety: a symlinked directory is only recursed into after resolving
 * its real path and checking it against `visited`. A symlink pointing at an
 * ancestor would otherwise recurse until the stack/heap is exhausted.
 */
async function* walkDir(dir, counters, visited) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    counters.walkErrors++;
    console.warn(`[reel] Cannot read directory, skipping: ${dir} (${err.code || err.message})`);
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkDir(full, counters, visited);
    } else if (entry.isFile()) {
      yield full;
    } else if (entry.isSymbolicLink()) {
      // Resolve the link target; recurse into dirs, yield files
      let target;
      try {
        target = await stat(full); // stat follows symlinks
      } catch {
        counters.brokenSymlinks++;
        continue;
      }

      if (target.isDirectory()) {
        let real;
        try {
          real = await realpath(full);
        } catch {
          counters.brokenSymlinks++;
          continue;
        }
        if (visited.has(real)) {
          console.warn(`[reel] Symlink cycle skipped: ${full} -> ${real}`);
          continue;
        }
        visited.add(real);
        yield* walkDir(full, counters, visited);
      } else if (target.isFile()) {
        yield full;
      }
    }
  }
}

/**
 * Scan all configured libraries and upsert media records.
 *
 * Stale handling is SOFT-DELETE (migration 004): a row whose file was not
 * seen this pass is MARKED missing (present = 0, missing_since set), never
 * hard-deleted. The ON DELETE CASCADE on markers/media_tags therefore never
 * fires on a disappearance, and the user-editable metadata columns survive
 * with the row. A file that reappears at the SAME abs_path auto-reactivates
 * (present = 1, missing_since = NULL) via the upsert's ON CONFLICT clause.
 * Actual row deletion happens ONLY through the explicit "purge missing"
 * maintenance action — never automatically here.
 *
 * The mark-missing step is still scoped PER LIBRARY and skipped for any
 * library that:
 *   a) threw during its walk (unexpected error not handled inside walkDir), or
 *   b) hit one or more unreadable directories during its walk (permission
 *      change, transient I/O, vanished mid-walk — counted in walkErrors), or
 *   c) walked zero media files while the DB has existing rows for it
 *      (mounted-but-empty, e.g. wrong volume path).
 * This prevents a transient mount/permission failure from flagging an entire
 * library's rows missing (which would hide everything from the UI until the
 * next clean scan). The walk still ingests every directory it CAN read; only
 * the mark-missing step is suppressed when the read was incomplete.
 *
 * Tag-read optimization (v1.4): embedded tag reading via music-metadata is
 * skipped for files that already exist in the DB. The upsert's ON CONFLICT
 * clause only updates size/mtime/scan tracking — it does not overwrite
 * title/artist/year/album/track_number. So tag reads for existing files are
 * pure I/O waste; the results would be discarded by the upsert. If a file
 * is re-encoded at the same path, a Full Metadata Scan (forced tag re-read,
 * planned maintenance action) should be used to pick up new embedded tags —
 * NOT row deletion, which would cascade away the file's markers and tags.
 *
 * @param {object} config - app config with libraries and allowedExtensions
 * @param {import('better-sqlite3').Database} db
 * @param {object} [options]
 * @param {boolean} [options.forceTagReread=false] - Full Metadata Scan: also
 *   re-read embedded tags for existing audio files and refresh their metadata
 *   columns (COALESCE — present tags only; markers/tags/description untouched).
 * @returns {Promise<{ scanId: number, totalUpserts: number, totalMissing: number, totalReactivated: number, totalMetaUpdated: number, skippedLibraries: string[], brokenSymlinks: number }>}
 */
export async function scanLibraries(config, db, options = {}) {
  // forceTagReread (Full Metadata Scan): re-read embedded tags for EXISTING
  // audio files too — normally skipped as I/O waste — and route them through
  // an upsert variant that refreshes metadata columns on conflict. See the
  // upsertMediaForceMeta statement and the tag-read block below.
  const { forceTagReread = false } = options;
  const allowedSet = new Set(config.allowedExtensions);
  const globalAutoTagDepth = config.autoTagDepth || 0;
  const globalAutoTagExclude = new Set((config.autoTagExclude || []).map(s => s.toLowerCase()));
  const tagRules = config.tagRules || [];

  // Back-to-back (b2b) parsing. `b2bTagging` (default ON) controls whether each
  // individual artist in a b2b set AND a literal `b2b` tag are emitted. The
  // `b2bDisplayJoin` is the separator the parser uses to rebuild the artist
  // DISPLAY string ("Excision b2b Wooli" by default; set to " | " for piped).
  // Tag emission is filename-derived (like dir/keyword auto-tag), independent
  // of any embedded artist tag that may win the media.artist column.
  const b2bTagging = config.b2bTagging !== false;
  const b2bDisplayJoin = config.b2bDisplayJoin ?? ' b2b ';

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
      -- Reactivate: a previously-missing file seen again at the SAME path is
      -- live again, with all its retained markers/tags/metadata intact.
      present = 1,
      missing_since = NULL,
      updated_at = datetime('now')
  `);
  const markMissingForLibrary = db.prepare(
    `UPDATE media SET present = 0,
                      missing_since = COALESCE(missing_since, datetime('now'))
     WHERE library_id = ? AND last_seen_scan < ? AND present = 1`
  );

  // Full Metadata Scan upsert variant. Identical to upsertMedia for the INSERT
  // (new file) path, but its ON CONFLICT clause ALSO refreshes the embedded-
  // tag-derived metadata columns. Each refresh column is COALESCE(@meta_x, x):
  // the new value wins ONLY when the file actually carries that tag, otherwise
  // the existing (possibly hand-edited) value is preserved — an absent or
  // unreadable tag never clobbers good data with NULL or a filename guess.
  // `description`, markers, and tag links are deliberately untouched: they are
  // not embedded-tag-derived and must survive a metadata refresh.
  const upsertMediaForceMeta = db.prepare(`
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
      present = 1,
      missing_since = NULL,
      title = COALESCE(@meta_title, title),
      artist = COALESCE(@meta_artist, artist),
      year = COALESCE(@meta_year, year),
      album = COALESCE(@meta_album, album),
      track_number = COALESCE(@meta_track_number, track_number),
      updated_at = datetime('now')
  `);

  // Auto-tag prepared statements
  const findTag = db.prepare('SELECT id FROM tags WHERE normalized = ?');
  const insertTag = db.prepare('INSERT INTO tags (name, normalized) VALUES (@name, @normalized)');
  const linkTag = db.prepare('INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (@media_id, @tag_id)');
  const getMediaByPath = db.prepare('SELECT id, present FROM media WHERE abs_path = ?');

  let totalUpserts = 0;
  let totalMissing = 0;
  let totalReactivated = 0;
  let totalMetaUpdated = 0;
  let tagReadsSkipped = 0;
  const skippedLibraries = [];
  const counters = { brokenSymlinks: 0, walkErrors: 0 };

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
    const errorsBefore = counters.walkErrors;

    // Per-library cycle-detection set, seeded with the library root's real
    // path so a symlink back to the root is caught on the first hop.
    const visited = new Set();
    try {
      visited.add(await realpath(lib.path));
    } catch {
      // Root unresolvable (mount down) — walkDir's readdir will fail and be
      // counted, which suppresses mark-missing below. Nothing to seed.
    }

    try {
      for await (const absPath of walkDir(lib.path, counters, visited)) {
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
        const parsed = parseFilename(filename, { b2bJoin: b2bDisplayJoin });

        // Check if this file already exists in the DB.
        // If it does, skip the expensive music-metadata tag read — the upsert's
        // ON CONFLICT clause doesn't update metadata fields, so the read result
        // would be discarded anyway.
        const existingMedia = getMediaByPath.get(absPath);

        // A previously-missing row about to be re-upserted at the same path is
        // a reactivation (the ON CONFLICT clause flips present back to 1).
        if (existingMedia && existingMedia.present === 0) totalReactivated++;

        // Embedded-tag read. Normally done for NEW audio files only — the
        // normal upsert's ON CONFLICT clause doesn't touch metadata columns,
        // so re-reading an existing file's tags would be pure I/O waste (the
        // one real CIFS read cost). Full Metadata Scan (forceTagReread) opts
        // existing files back in: read their tags AND route through the
        // metadata-refreshing upsert variant below.
        const wantTagRead = mediaType === 'audio' && TAG_READABLE.has(ext)
          && (!existingMedia || forceTagReread);

        // Embedded values, NULL when the tag is absent/empty or the read fails.
        // Kept separate from the parseFilename fallback so the force upsert can
        // COALESCE — overwriting only fields the file actually carries. The
        // `|| null` (not `??`) preserves the original new-file behavior exactly:
        // empty-string / zero tags collapse to null and fall back, same as the
        // prior `if (c.field)` truthy guards.
        let embArtist = null, embTitle = null, embYear = null, embAlbum = null, embTrack = null;

        if (wantTagRead) {
          try {
            const meta = await parseFile(absPath, { skipCovers: true, duration: false });
            const c = meta.common;
            embArtist = c.artist || null;
            embTitle = c.title || null;
            embAlbum = c.album || null;
            embYear = c.year || null;
            embTrack = c.track?.no || null;
          } catch {
            // Tag read failed — embedded values stay null (fallbacks apply)
          }
        } else if (mediaType === 'audio' && TAG_READABLE.has(ext) && existingMedia) {
          tagReadsSkipped++;
        }

        // INSERT values (new file): embedded tag wins, else parseFilename.
        const artist = embArtist || parsed.artist;
        const title = embTitle || parsed.title;
        const year = embYear || parsed.year;
        const album = embAlbum;
        const trackNumber = embTrack;

        const base = {
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
        };

        if (existingMedia && forceTagReread) {
          // Metadata-refresh path: COALESCE-update from embedded tags only.
          upsertMediaForceMeta.run({
            ...base,
            meta_title: embTitle,
            meta_artist: embArtist,
            meta_year: embYear,
            meta_album: embAlbum,
            meta_track_number: embTrack,
          });
          totalMetaUpdated++;
        } else {
          upsertMedia.run(base);
        }

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

        // Back-to-back (b2b) tags. For a b2b set, each individual artist becomes
        // a tag and a literal `b2b` tag is added. Like dir/keyword auto-tag, this
        // is idempotent (linkTag is INSERT OR IGNORE) and runs for existing rows
        // too, so a normal scan backfills b2b tags onto already-imported files —
        // no Full Metadata Scan required. Only b2b PARTICIPANTS are tagged, not
        // every solo artist, to keep the tag sidebar bounded; solo-artist browse
        // stays on the artist facet / search.
        if (b2bTagging && parsed.isB2B) {
          for (const a of parsed.artists) {
            applyTag(a, mediaId, findTag, insertTag, linkTag);
          }
          applyTag('b2b', mediaId, findTag, insertTag, linkTag);
        }

        // Group/act alias tag (e.g. "[WANKDAT]", "[MASTERHVND]"). The collective
        // name for a set of artists, parsed from a trailing "[...]" on the artist
        // chunk. Tagged whenever present (independent of isB2B — a named act need
        // not be written as a b2b chain), gated by the same b2bTagging switch.
        if (b2bTagging && parsed.alias) {
          applyTag(parsed.alias, mediaId, findTag, insertTag, linkTag);
        }

        libUpserts++;
      }
    } catch (err) {
      walkFailed = true;
      console.error(`[reel] Error scanning library "${lib.name}" (${lib.path}): ${err.message}`);
    }

    totalUpserts += libUpserts;

    // Mark-missing safety: never flag rows missing in a library whose walk
    // failed, that hit unreadable directories this pass, or that returned zero
    // files when the DB previously had rows for it. (A transient failure must
    // not hide a whole library from the UI.)
    const libWalkErrors = counters.walkErrors - errorsBefore;
    const existingCount = countMedia.get(libraryId).n;
    if (walkFailed || libWalkErrors > 0 || (libUpserts === 0 && existingCount > 0)) {
      skippedLibraries.push(lib.name);
      const reason = walkFailed
        ? 'scan error'
        : libWalkErrors > 0
          ? `${libWalkErrors} unreadable dir(s)`
          : `0 files walked, ${existingCount} rows in DB`;
      console.warn(`[reel] Skipping mark-missing for library "${lib.name}" (${reason})`);
      continue;
    }

    const result = markMissingForLibrary.run(libraryId, scanId);
    totalMissing += result.changes;
  }

  if (counters.brokenSymlinks > 0) {
    console.warn(`[reel] Skipped ${counters.brokenSymlinks} broken symlink(s) during scan`);
  }

  if (counters.walkErrors > 0) {
    console.warn(`[reel] Encountered ${counters.walkErrors} unreadable director(ies) during scan`);
  }

  if (tagReadsSkipped > 0) {
    console.log(`[reel] Skipped ${tagReadsSkipped} tag read(s) for existing files`);
  }

  // FTS index stays in sync via the media_fts_ai/ad/au triggers (migration
  // 003). New files fire AFTER INSERT; the WHEN-gated AFTER UPDATE means a
  // no-op re-scan (only size/mtime/scan re-set, filename unchanged) does no
  // FTS work. Soft-delete (present = 0) is an UPDATE on a NON-indexed column,
  // so it fires NO trigger — missing rows stay in the FTS index and are hidden
  // from search by the library query's `present = 1` predicate instead. Only a
  // purge (hard DELETE) fires AFTER DELETE and removes the row from the index.

  console.log(`[reel] Scan complete: ${totalUpserts} upserted, ${totalMissing} marked missing, ${totalReactivated} reactivated` +
    (forceTagReread ? `, ${totalMetaUpdated} metadata-refreshed` : '') +
    (skippedLibraries.length ? `, mark-missing skipped for: ${skippedLibraries.join(', ')}` : ''));
  return { scanId, totalUpserts, totalMissing, totalReactivated, totalMetaUpdated, skippedLibraries, brokenSymlinks: counters.brokenSymlinks, walkErrors: counters.walkErrors };
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
