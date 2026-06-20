import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, syncLibraries } from './config.js';
import { openDatabase } from './db/index.js';
import { backfillArtists } from './services/artists.js';
import healthRoutes from './routes/health.js';
import streamRoutes from './routes/stream.js';
import libraryRoutes from './routes/library.js';
import mediaRoutes from './routes/media.js';
import markerRoutes from './routes/markers.js';
import tagRoutes from './routes/tags.js';
import scanRoutes from './routes/scan.js';
import importExportRoutes from './routes/import-export.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const config = loadConfig();
const db = openDatabase(config.dbPath);
syncLibraries(db, config);
// One-time media_artists backfill (migration 005). Guarded internally: only
// runs when the link table is empty but media exists, so it populates on the
// deploy that ships 005 and is a no-op thereafter. DB-only, no NAS reads.
backfillArtists(db, config);

const app = Fastify({ logger: true });

// Decorate so routes can access db and config
app.decorate('db', db);
app.decorate('config', config);

// Serve static frontend files
app.register(fastifyStatic, {
  root: resolve(__dirname, 'public'),
  prefix: '/',
});

// Register routes
app.register(healthRoutes);
app.register(streamRoutes);
app.register(libraryRoutes);
app.register(mediaRoutes);
app.register(markerRoutes);
app.register(tagRoutes);
app.register(scanRoutes);
app.register(importExportRoutes);

// Graceful shutdown
const shutdown = async () => {
  console.log('[reel] Shutting down...');
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start
try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`[reel] Listening on ${config.host}:${config.port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
