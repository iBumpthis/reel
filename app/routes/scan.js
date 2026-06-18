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

  // POST /api/scan — synchronous HTTP, async internals
  fastify.post('/api/scan', async (request, reply) => {
    if (scanInFlight) {
      return reply.code(409).send({ ok: false, error: 'Scan already in progress' });
    }
    scanInFlight = true;
    try {
      const result = await scanLibraries(fastify.config, fastify.db);
      return {
        ok: true,
        totalUpserts: result.totalUpserts,
        totalMissing: result.totalMissing,
        totalReactivated: result.totalReactivated,
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
  // DESTRUCTIVE and irreversible: cascades to markers + tag links. Intended to
  // be called only behind an explicit two-click confirmation in the UI. Gated
  // against a concurrent scan so it can't delete rows mid-reactivation.
  fastify.post('/api/scan/purge-missing', async (request, reply) => {
    if (scanInFlight) {
      return reply.code(409).send({ ok: false, error: 'Scan in progress — try again after it completes' });
    }
    const result = purgeMissing.run();
    if (result.changes > 0) {
      fastify.log.warn(`Purged ${result.changes} missing media row(s) (cascaded markers + tags)`);
    }
    return { ok: true, purged: result.changes };
  });
}
