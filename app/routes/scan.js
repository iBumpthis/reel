import { scanLibraries } from '../services/scanner.js';

// Module-level in-flight flag — prevents two concurrent scans from
// interleaving upserts/stale-deletes with different scan IDs.
let scanInFlight = false;

export default async function scanRoutes(fastify) {
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
        totalDeletes: result.totalDeletes,
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
}
