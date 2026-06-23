import { scanLibraries } from '../services/scanner.js';

// Module-level in-flight flag — prevents two concurrent scans from
// interleaving upserts/mark-missing with different scan IDs. Also gates the
// purge endpoint: purging while a scan is reactivating rows would race.
let scanInFlight = false;

export default async function scanRoutes(fastify) {
  const db = fastify.db;

  const countMissing = db.prepare('SELECT COUNT(*) AS n FROM media WHERE present = 0');
  // Hard delete of soft-deleted rows. This is the ONLY path that actually
  // removes media (and, via ON DELETE CASCADE, their markers + tag links).
  // Deliberate, user-initiated, never automatic — the scanner only ever
  // marks rows missing.
  const purgeMissing = db.prepare('DELETE FROM media WHERE present = 0');

  // Stale-tag sweep (REEL-019). Purging media cascades the media_tags link
  // rows away (FK media_tags.media_id -> media(id) ON DELETE CASCADE, with
  // foreign_keys=ON), but the tags rows themselves have NO cascade — a tag
  // whose every media has been purged lingers as a count-0 ghost (the
  // test-artist tags left over from parsing experiments are exactly this).
  // This deletes every orphaned tag (no remaining media_tags row). The sweep
  // is intentionally broad: it also mops up orphans left by the tag-edit
  // replace-all flow (routes/tags.js clears then relinks), not only ones this
  // purge created. Safe because there is no path to create a standalone empty
  // tag — tags only ever come into existence via linking — so an orphan tag
  // is always genuinely dead. tag_id is NOT NULL in media_tags, so the NOT IN
  // subquery cannot hit the NULL-membership trap.
  const deleteOrphanTags = db.prepare(
    'DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM media_tags)'
  );

  // One transaction: the media DELETE fires the media_tags cascade FIRST, then
  // the orphan-tag sweep runs against the post-cascade state. Atomic so a crash
  // between the two statements can't leave a half-swept DB, and so the returned
  // counts are mutually consistent.
  const purgeTx = db.transaction(() => {
    const purged = purgeMissing.run().changes;
    const staleTags = deleteOrphanTags.run().changes;
    return { purged, staleTags };
  });

  // POST /api/scan — synchronous HTTP, async internals.
  // Optional body { fullMetadata: true } runs a Full Metadata Scan: the same
  // walk + present/missing reconciliation, plus a forced embedded-tag re-read
  // that refreshes metadata columns on EXISTING audio files (the normal scan
  // skips that read as I/O waste). Same in-flight gate either way — a metadata
  // scan and a normal scan can't run concurrently.
  fastify.post('/api/scan', async (request, reply) => {
    if (scanInFlight) {
      return reply.code(409).send({ ok: false, error: 'Scan already in progress' });
    }
    const fullMetadata = request.body?.fullMetadata === true;
    scanInFlight = true;
    try {
      const result = await scanLibraries(fastify.config, fastify.db, { forceTagReread: fullMetadata });
      return {
        ok: true,
        totalUpserts: result.totalUpserts,
        totalMissing: result.totalMissing,
        totalReactivated: result.totalReactivated,
        totalMetaUpdated: result.totalMetaUpdated,
        skippedLibraries: result.skippedLibraries,
        brokenSymlinks: result.brokenSymlinks,
        walkErrors: result.walkErrors,
      };
    } catch (err) {
      fastify.log.error(err, 'Scan failed');
      return reply.code(500).send({ ok: false, error: err.message });
    } finally {
      scanInFlight = false;
    }
  });

  // GET /api/scan/missing — count of retained-but-missing rows. Powers the
  // purge-confirm dialog ("Confirm? X items will be removed").
  fastify.get('/api/scan/missing', async () => {
    return { count: countMissing.get().n };
  });

  // POST /api/scan/purge-missing — permanently delete all missing rows.
  // DESTRUCTIVE and irreversible: cascades to markers + tag links, then sweeps
  // any tags thereby orphaned (REEL-019). Intended to be called only behind an
  // explicit two-click confirmation in the UI. Gated against a concurrent scan
  // so it can't delete rows mid-reactivation.
  fastify.post('/api/scan/purge-missing', async (request, reply) => {
    if (scanInFlight) {
      return reply.code(409).send({ ok: false, error: 'Scan in progress — try again after it completes' });
    }
    const { purged, staleTags } = purgeTx();
    if (purged > 0 || staleTags > 0) {
      fastify.log.warn(`Purged ${purged} missing media row(s) (cascaded markers + tags); removed ${staleTags} stale tag(s)`);
    }
    return { ok: true, purged, staleTags };
  });
}
