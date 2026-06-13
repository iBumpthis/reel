import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Open the database and run any pending migrations.
 * Returns the open better-sqlite3 handle.
 */
export function openDatabase(dbPath) {
  const absPath = resolve(dbPath);
  console.log(`[reel] Opening database: ${absPath}`);

  const db = new Database(absPath);

  // WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

function runMigrations(db) {
  // Ensure schema_version exists (bootstraps itself)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      description TEXT
    )
  `);

  const currentVersion = db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM schema_version'
  ).get().v;

  // Read migration files, sorted by numeric prefix
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort((a, b) => {
      const numA = parseInt(a.split('-')[0], 10);
      const numB = parseInt(b.split('-')[0], 10);
      return numA - numB;
    });

  let applied = 0;

  for (const file of files) {
    const version = parseInt(file.split('-')[0], 10);
    if (isNaN(version)) {
      console.warn(`[reel] Skipping migration file with non-numeric prefix: ${file}`);
      continue;
    }
    if (version <= currentVersion) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');

    // The migration SQL may contain its own INSERT INTO schema_version,
    // so we wrap in a transaction but don't double-insert.
    const migrate = db.transaction(() => {
      db.exec(sql);

      // Check if the migration already inserted its own version record
      const exists = db.prepare(
        'SELECT 1 FROM schema_version WHERE version = ?'
      ).get(version);

      if (!exists) {
        db.prepare(
          'INSERT INTO schema_version (version, description) VALUES (?, ?)'
        ).run(version, file);
      }
    });

    migrate();
    applied++;
    console.log(`[reel] Applied migration ${file} (version ${version})`);
  }

  if (applied === 0) {
    console.log(`[reel] Database schema up to date (version ${currentVersion})`);
  } else {
    console.log(`[reel] Applied ${applied} migration(s)`);
  }
}
