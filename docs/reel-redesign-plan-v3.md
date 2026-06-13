# Reel — Ground-Up Redesign Plan (v3, Updated)

> Renamed from "TapeC v2." Reel = tape reel, film reel. Short, media-evocative,
> works at any scale from personal tool to Jellyfin/Plex replacement scope.

### v3 Changes (Session 4)

- **Cursor spec amended:** keyset pagination cursor now encodes
  `(sort_value, id)` with row-value comparison semantics, not a bare id.
  An id-only cursor is only correct when sorting by id; for title/artist/etc
  it silently skips rows. The implementation was corrected in the Session 3→4
  code review (P3); this amendment brings the plan spec in line.
- **`tapec.service` → `reel.service`:** fixed naming drift in Session 4 scope.
- **`parseFilename` clarified as server-side only:** the frontend copy
  planned for Session 2 was never needed because the API resolves
  title/artist/year fallbacks before responding. The stale instruction to
  create a frontend copy has been removed.

---

## Stack Validation

The v1 TapeC stack was last audited during the early sessions. Here's what changed
and what the rebuild targets:

| Dependency | TapeC v1.0 | Reel | Why |
|---|---|---|---|
| Node.js | 22 LTS (Jod) | **24 LTS (Krypton)** | 22 entered Maintenance LTS; 24 is Active LTS since Oct 2025. EOL Apr 2028. Correct target for new work. |
| Fastify | ^5.8.0 | **^5.8.5** | Same major line. Patch includes CVE-2026-25224 and CVE-2026-33806 fixes. |
| @fastify/static | ^9.0.0 | **^9.1.3** | **Critical.** v9.1.1 fixes CVE-2026-6410 (path traversal). v1's ^9.0.0 range is vulnerable. |
| better-sqlite3 | ^12.8.0 | **^12.10.0** | Same major. v12.8.0 fixed V8 API breakage for Node 24. v12.10.0 is current. |
| Docker base | node:22-slim | **node:24-slim** | Matches runtime target. |

### Why not node:sqlite?

Node.js now ships a built-in `node:sqlite` module (RC status in Node 25.7.0+,
experimental in Node 24). On paper, it eliminates the native module compilation
that requires python3/make/g++ in the Docker build stage. In practice, there's
a hard blocker: **node:sqlite is compiled without FTS5 support.** The bundled
SQLite binary doesn't include `ENABLE_FTS5`, so `CREATE VIRTUAL TABLE ... USING
fts5(...)` fails with "no such module: fts5."

This is a real-world issue documented across multiple projects (OpenClaw, Nuxt
Content). The recommended workaround in every case is "switch to better-sqlite3,
which ships its own SQLite build with FTS5 compiled in."

Since the Reel schema uses FTS5 for full-text search across media metadata,
better-sqlite3 isn't tech debt — it's the only option that supports the feature
set. The two-stage Docker build stays.

**Future migration path:** If node:sqlite reaches stable with FTS5 compiled in
(plausible for Node 27+ under the new annual release model), the synchronous
API surface (`DatabaseSync`, `prepare()`, `exec()`) is close enough to
better-sqlite3 that a swap would be mechanical. We don't need to design around
this, but we shouldn't couple to better-sqlite3-specific features unnecessarily
either. The main one to be aware of: better-sqlite3's `transaction()` helper
wraps a function in BEGIN/COMMIT/ROLLBACK automatically. node:sqlite has this
too as of Node 25 (`database.transaction()`), so we're safe.

### Why not Node 26?

Node 26 shipped May 5, 2026 with Temporal API enabled by default and V8 14.6.
It's Current (not LTS until October 2026). For a personal tool where you control
the deployment, running Current is viable — but better-sqlite3 prebuilt binaries
target LTS versions. Building from source on Current works but adds friction.
Node 26 is also the last release under the old even/odd model before Node 27
switches to annual releases. No benefit to being an early adopter here.

### Why not a different framework?

Fastify v5 is still actively maintained (6.7M weekly downloads, regular security
patches), has the plugin architecture we use (@fastify/static), and there's no
competitor that offers a meaningful improvement for this use case. Hono is fast
but optimized for edge/multi-runtime; Express would be a regression; h3/Nitro
adds unnecessary abstraction layers.

---

## Naming

**Reel.** Tape reel, film reel. One syllable, clear media connotation, works as a
CLI command (`reel`), a Docker container name, and a product name at scale. No
attachment to the TapeC origin story.

If you hate it, alternatives considered: Deck (tape deck), Crate (record crate),
Spool (tape spool). All fine, none as clean.

---

## Schema, Architecture, Format Support

No changes from v1 of this document. The schema, server structure, MIME mapping,
and codec compatibility table are all correct as written. Key decisions carried
forward:

- **DB is single source of truth.** No sidecar `.meta.json` files.
- **FTS5 for search.** Ranked full-text across filename + title + artist + description.
- **Libraries as a DB table** with config-to-DB sync on startup.
- **`media_type` stored at scan time**, not inferred at runtime.
- **Versioned migration files** with `schema_version` table.
- **Tags use normalized dedup.** Display name "Jazz" + normalized key "jazz".
  Same conclusion as the 0.6 planning session. Still correct.
- **Markers use REAL for seconds.** Sub-second precision.
- **Async scanning.** `fs.promises` throughout. No event loop blocking.

---

## Feature Decisions

### Definitely building (integrated into sessions 2-3)

| Feature | Lift | Why |
|---|---|---|
| Keyboard shortcuts | ~30 min | Spacebar play/pause, arrows seek, N/P markers, M mute. Enormous UX win for zero cost. |
| Playback speed | ~20 min | 0.5x–2x selector. `<video>.playbackRate` is native. No reason not to. |
| Playback error detection | ~30 min | `error` event on `<video>` → codec-specific message + link to compatibility docs. Required for MKV/AV1/HEVC files. |
| In-place marker editing | ~1.5 hrs | Click a marker label to edit it, PATCH single marker by ID. The markers are in the DB now with proper IDs, so the API is trivial. Better UX than re-importing the whole list. |
| CSV metadata import | ~1.5 hrs | Upload or paste CSV, match on filename/path, bulk-update metadata fields. Important for Rob's "import, not API scan" requirement. |

### Deferred (successor project scope)

| Feature | Lift | Why deferred |
|---|---|---|
| Waveform seekbar | 4-6 hrs | Requires either ffmpeg in the container for pre-computation or lazy Web Audio decode. Cool feature, significant backend work, not core. |
| Thumbnail generation | 3-4 hrs | Requires ffmpeg in Docker image. Meaningful image weight increase. Better as a successor feature where the container already has ffmpeg for transcoding. |
| Playback history/resume | 2-3 hrs | Nice-to-have but the data model question (localStorage vs DB?) depends on whether this is single-user or multi-user. The successor project answers that. |
| Playlists | 4-6 hrs | Schema addition (`playlists` + `playlist_items`), auto-advance logic, queue management. Real feature, but out of scope for a "TapeC with good architecture" rebuild. Belongs in the successor. |

### Rationale for the cut

Everything in "definitely building" is under 2 hours combined and ships as part
of the session it belongs to. Everything in "deferred" either requires ffmpeg in
the container (which changes the deployment model) or raises design questions
that the successor project needs to answer first. Pulling them into Reel would
be premature optimization — they'd get built to Reel's simpler assumptions and
then rebuilt for the successor anyway.

---

## Updated Rollout Plan: 4 Sessions

### Session 1: Foundation + Core Backend
*Deliverable: Working backend, testable with curl. No frontend.*

- `package.json` targeting Node 24, Fastify ^5.8.5, better-sqlite3 ^12.10.0, @fastify/static ^9.1.3
- `config.js` — load, validate, merge env vars
- `db/index.js` + `db/migrations/001-initial.sql` — full schema, migration runner
- All services: scanner (async), stream, mime, markers (v1 parsing engine), metadata
- All routes: health, library (paginated), media (CRUD), markers, tags, stream, scan, import/export
- `server.js` — bootstrap only (~30 lines)
- Docker + compose files targeting node:24-slim
- `config.example.json` with all supported extensions

### Session 2: Library Page
*Deliverable: Complete home page that replaces v1's file browser with a real media library.*

- CSS architecture (base + library + shared components)
- JS modules (shared/utils.js, shared/api.js, library.js)
- Paginated media grid with search, filter (type/tag/library/ext), sort
- Media cards with metadata display
- Inline metadata editing (title, artist, year, description, tags)
- Tag autocomplete
- Scan button (always visible, shows result: "Found 3 new, removed 1 stale")
- CSV import UI

### Session 3: Player Page
*Deliverable: Full player with feature parity + enhancements.*

- Modular JS (player/index, controls, visualizer, markers, modes)
- Player CSS (player + controls)
- All v1 functionality: video/audio/visualizer modes, custom controls, markers,
  now-playing strip, fullscreen toast, browse overlay, notes, marker import
- New: keyboard shortcuts, playback speed, in-place marker editing, codec error
  detection
- Extended format support (MKV, WebM, FLAC, OGG, OPUS, AV1 — served correctly,
  browser handles decoding)

### Session 4: Polish + Deployment
*Deliverable: Production-ready release.*

- Export endpoints (JSON, CSV, marker text)
- `docs/codec-compatibility.md`
- `docs/import-format.md`
- Updated README (setup, config, deployment, format support)
- Docker build verification on node:24-slim
- deploy.sh + reel.service updates
- Cross-browser testing notes
- Final review pass

---

## Handoff Prompt: Session 1

```
# Reel — Session 1: Foundation + Core Backend

## Context

Reel is a ground-up rewrite of TapeC (github.com/iBumpthis/tapec), a self-hosted
personal media cataloging and playback tool. The v1 codebase is reference only.
This session builds the entire backend from a schema-first design. No frontend.

The full redesign plan exists in the project — read it for architectural context.
This prompt specifies exactly what to build.

## Stack

- Node.js 24 LTS
- Fastify ^5.8.5
- better-sqlite3 ^12.10.0
- @fastify/static ^9.1.3
- ESM modules throughout (`"type": "module"` in package.json)

## Project Name: Reel

Use "Reel" in all naming: package.json name, health endpoint, log prefixes,
Docker container name, README title.

## File Structure

app/
  server.js              # Bootstrap only (~30 lines)
  config.js              # Config loading, validation, defaults
  db/
    index.js             # DB open + migration runner
    migrations/
      001-initial.sql    # Full schema
  routes/
    library.js           # GET /api/library (paginated, filterable, FTS)
    media.js             # GET /api/media/:id, PATCH /api/media/:id
    markers.js           # POST /api/media/:id/markers, DELETE
    stream.js            # GET /stream/:id
    tags.js              # GET /api/tags, POST /api/media/:id/tags
    scan.js              # POST /api/scan
    import-export.js     # POST /api/import, GET /api/export
    health.js            # GET /api/health
  services/
    scanner.js           # Async directory walk + upsert
    markers.js           # Marker text parsing engine (carry from v1)
    stream.js            # Range-based file streaming (carry from v1)
    mime.js              # Extension → MIME + media type mapping
    metadata.js          # Filename parsing (single source)
  public/                # Empty for now — Session 2 builds the frontend
    .gitkeep
  package.json
deploy/
  Dockerfile
  docker-compose.example.yml
  deploy.sh

## Database Schema

(Paste the full 001-initial.sql from the redesign doc — the schema section
with libraries, media, media_fts, tags, media_tags, markers, schema_version)

## Migration System

db/index.js should:
1. Create schema_version table if it doesn't exist
2. Read all .sql files from db/migrations/, sorted by numeric prefix
3. For each file whose version > max applied version, execute in a transaction
   and record in schema_version
4. Log applied migrations at startup
5. Return the opened db handle

## Config Model

config.js loads config.json (required, fatal if missing), merges env var
overrides (REEL_HOST, REEL_PORT, REEL_DB_PATH), validates:
- libraries: array of {name, path} (required, non-empty)
- dbPath: string (required)
- port: number (default 32410)
- host: string (default "0.0.0.0")
- allowedExtensions: array (default: all supported formats)

On startup, config.js also syncs libraries from config → DB (insert if name
doesn't exist, update path if changed).

Note the env var prefix change: REEL_ not TAPEC_.

## API Endpoints

### GET /api/health
Returns: { ok: true, name: "Reel", version }
Version from package.json.

### GET /api/library
Query params:
- lib (library name filter)
- type (audio|video)
- ext (extension filter)
- tag (tag name filter, comma-separated for multiple)
- q (full-text search via FTS5)
- sort (title|artist|year|mtime|size|created, default: mtime)
- order (asc|desc, default: desc)
- limit (page size, default 50, max 200)
- cursor (opaque base64url token encoding `{sort_value, id}`, compared with row-value semantics for correct keyset pagination across all sort fields)

Returns: { items: [...], libraries: [...], nextCursor, totalCount }

Items include: id, library name, filename, ext, media_type, size_bytes,
mtime_ms, title (DB or parsed from filename), artist (DB or parsed),
year (DB or parsed), description, tags (array of names), marker_count.

totalCount uses a separate COUNT(*) query with the same filters (excluding
pagination). This is fine for SQLite on datasets under 100k rows.

### GET /api/media/:id
Returns full record with all metadata, markers (sorted by start_seconds),
tags, stream URL, default playback mode.

### PATCH /api/media/:id
Body: { title?, artist?, year?, description? }
Updates user-editable metadata. Sets updated_at. Syncs FTS5 index.
Returns updated record.

### POST /api/media/:id/markers
Body: { markerText } OR { markers: [...] }
Replace-all semantics (DELETE + INSERT in transaction).
For markerText: use the marker parsing engine from v1.
Returns: { ok, importErrors, saved: { markerCount } }

### DELETE /api/media/:id/markers
Clears all markers for the item.

### GET /stream/:id
Range-based streaming. Correct MIME from extension via mime.js.
4MB default chunk size. Proper 206/416 responses.
Support HEAD requests (browsers probe before Range requests).

### POST /api/scan
User-initiated scan. This is the PRIMARY way new media enters the system.
The web UI has a Scan button on the home page — no SSH, no CLI, no
scheduled jobs. Drop a file on the NAS, tap Scan in the browser, done.

Response waits for scan to complete (synchronous HTTP, async internals
via fs.promises so the event loop stays responsive for concurrent
stream requests). For a personal NAS with hundreds-to-thousands of
files, this completes in under a second.

No filesystem watching, no polling, no scan-on-startup by default.
The read-only NAS mount is intentional security posture; the scanner
runs only when explicitly triggered.

Returns: { ok, totalUpserts, totalDeletes }
(Not a scan ID / poll-for-status pattern — that's over-engineering
for this scale.)

### GET /api/tags
Returns: { tags: [{ id, name, count }] } sorted by name.
Count is number of media items with that tag.

### POST /api/media/:id/tags
Body: { tags: ["tag1", "tag2"] }
Replace-all semantics. Auto-creates new tags (normalized dedup).
Returns updated tag list for the item.

### POST /api/import
Body: CSV text or JSON array.
Match on filename or rel_path. Update title, artist, year, description.
Optionally set tags (comma-separated in CSV).
Returns: { matched, skipped, errors }

### GET /api/export
Query params: format (json|csv), lib (optional)
Returns full metadata dump.

## Services Detail

### scanner.js
- scanLibraries(config, db) — async internally (fs.promises), but the
  route awaits completion before responding
- Classifies media_type from extension (AUDIO_EXTS set vs VIDEO_EXTS set)
- On upsert: if title/artist/year are null, populate from parseFilename()
  so there's always searchable metadata even before manual editing
- Syncs FTS5 index via INSERT triggers or manual rebuild after scan
- Returns { scanId, totalUpserts, totalDeletes }

### markers.js
- parseMarkerBlock(text) and parseMarkerLine(line)
- Port the full regex suite from v1 server.js lines 142-271
- Same format support: bracket ranges, time-first, time-last, overlap repair
- Clean up: extract TIME_RE, cleanTitle, normalizeDashes as named constants
- No functional changes — this code is solid

### stream.js
- sendRangeStream(reply, absPath, mime)
- Port from v1 server.js lines 102-140
- Add HEAD request support
- No other changes needed

### mime.js
- mimeForExt(ext) — comprehensive map (see redesign doc)
- mediaTypeForExt(ext) — returns 'audio' or 'video'
- AUDIO_EXTS and VIDEO_EXTS sets for scanner classification

### metadata.js
- parseFilename(filename) — extract { artist, title, year }
- Port from v1, but ONLY ONE COPY (v1 had it in both app.js and player.js)
- This is server-side only. The API resolves title/artist/year fallbacks
  before sending to the frontend, so a frontend copy is unnecessary.

## Deployment

### Dockerfile
Two-stage build:
- Stage 1: node:24-slim + python3/make/g++, npm ci --omit=dev
- Stage 2: node:24-slim, copy node_modules + app code
- ENV NODE_ENV=production, EXPOSE 32410, CMD ["node", "server.js"]

### docker-compose.example.yml
Same bind-mount pattern as v1, with updated env var names:
- REEL_DB_PATH=/data/db/reel.sqlite
- REEL_HOST, REEL_PORT

### config.example.json
All supported extensions. Linux paths (not Windows UNC).
Example:
{
  "libraries": [
    { "name": "Music", "path": "/media/music" },
    { "name": "Video", "path": "/media/video" }
  ],
  "dbPath": "/data/db/reel.sqlite",
  "port": 32410,
  "allowedExtensions": [
    "mp4", "mkv", "webm", "avi", "mov", "m4v",
    "mp3", "m4a", "wav", "flac", "ogg", "opus", "aac", "wma"
  ]
}

## Build Order

1. package.json
2. config.js
3. db/index.js + db/migrations/001-initial.sql
4. services/mime.js
5. services/metadata.js
6. services/stream.js
7. services/markers.js
8. services/scanner.js
9. Routes: health → stream → library → media → markers → tags → scan → import-export
10. server.js (bootstrap)
11. deploy/ files
12. config.example.json

Test with curl after each route is built. Verify:
- Health returns version
- Scan finds files and populates DB
- Library returns paginated results with filters
- Stream serves files with Range support
- Markers import and retrieve correctly
- Tags CRUD works
- Import/export round-trips
```
