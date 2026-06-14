import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG_PATH = resolve(process.cwd(), 'config.json');

const DEFAULT_EXTENSIONS = [
  'mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v',
  'mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac', 'wma',
];

/**
 * Load and validate config. Fatal on missing file or invalid shape.
 * Env vars override file values: REEL_HOST, REEL_PORT, REEL_DB_PATH.
 */
export function loadConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch (err) {
    console.error(`[reel] FATAL: config.json not found at ${CONFIG_PATH}`);
    process.exit(1);
  }

  let file;
  try {
    file = JSON.parse(raw);
  } catch (err) {
    console.error(`[reel] FATAL: config.json is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const config = {
    host: process.env.REEL_HOST ?? file.host ?? '0.0.0.0',
    port: Number(process.env.REEL_PORT ?? file.port ?? 32410),
    dbPath: process.env.REEL_DB_PATH ?? file.dbPath,
    libraries: file.libraries,
    allowedExtensions: file.allowedExtensions ?? DEFAULT_EXTENSIONS,
    autoTagDepth: file.autoTagDepth ?? 0,
    autoTagExclude: file.autoTagExclude ?? [],
    tagRules: file.tagRules ?? [],
  };

  // Validate required fields
  if (!config.dbPath || typeof config.dbPath !== 'string') {
    console.error('[reel] FATAL: config.json must specify "dbPath" (string)');
    process.exit(1);
  }

  if (!Array.isArray(config.libraries) || config.libraries.length === 0) {
    console.error('[reel] FATAL: config.json must specify "libraries" (non-empty array of {name, path})');
    process.exit(1);
  }

  for (const lib of config.libraries) {
    if (!lib.name || typeof lib.name !== 'string' || !lib.path || typeof lib.path !== 'string') {
      console.error(`[reel] FATAL: each library must have "name" (string) and "path" (string), got: ${JSON.stringify(lib)}`);
      process.exit(1);
    }
  }

  if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
    console.error(`[reel] FATAL: invalid port: ${config.port}`);
    process.exit(1);
  }

  // Normalize extensions to lowercase, no leading dots
  config.allowedExtensions = config.allowedExtensions.map(e =>
    e.toLowerCase().replace(/^\./, '')
  );

  // Validate and normalize auto-tag config
  config.autoTagDepth = Math.max(0, Math.floor(Number(config.autoTagDepth) || 0));
  if (!Array.isArray(config.autoTagExclude)) {
    config.autoTagExclude = [];
  }
  config.autoTagExclude = config.autoTagExclude.map(s => String(s).toLowerCase());

  // Validate tag rules
  if (!Array.isArray(config.tagRules)) {
    config.tagRules = [];
  }
  config.tagRules = config.tagRules.filter(rule => {
    if (!rule || typeof rule !== 'object') return false;
    if (!rule.match || typeof rule.match !== 'string') {
      console.warn(`[reel] Skipping invalid tag rule (missing "match"): ${JSON.stringify(rule)}`);
      return false;
    }
    if (!rule.tag || typeof rule.tag !== 'string') {
      console.warn(`[reel] Skipping invalid tag rule (missing "tag"): ${JSON.stringify(rule)}`);
      return false;
    }
    return true;
  });

  // Normalize per-library autoTag config (depth/exclude on library objects)
  for (const lib of config.libraries) {
    if (lib.autoTagDepth != null) {
      lib.autoTagDepth = Math.max(0, Math.floor(Number(lib.autoTagDepth) || 0));
    }
    if (lib.autoTagExclude != null) {
      if (!Array.isArray(lib.autoTagExclude)) {
        lib.autoTagExclude = [];
      }
      lib.autoTagExclude = lib.autoTagExclude.map(s => String(s).toLowerCase());
    }
  }

  return config;
}

/**
 * Sync config libraries into the DB. Insert new, update path if changed.
 */
export function syncLibraries(db, config) {
  const upsert = db.prepare(`
    INSERT INTO libraries (name, path) VALUES (@name, @path)
    ON CONFLICT(name) DO UPDATE SET path = @path
  `);

  const tx = db.transaction(() => {
    for (const lib of config.libraries) {
      upsert.run({ name: lib.name, path: lib.path });
    }
  });

  tx();
  console.log(`[reel] Synced ${config.libraries.length} library/libraries from config`);
}
