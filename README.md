# Reel

Self-hosted personal media library and player. Catalog, search, tag, and play
audio and video files from a browser — no app install, no account, no cloud.

Reel is designed for a single user managing a personal media collection on a
home server or NAS. It is the successor to
[TapeC](https://github.com/iBumpthis/tapec), rebuilt from scratch with a
schema-first architecture.

## Quick Start (Docker)

```bash
git clone https://github.com/iBumpthis/reel.git
cd reel/deploy

# Create config.json (see Configuration below)
cp ../app/config.example.json config.json
# Edit config.json with your library paths

docker compose up --build -d
```

Open `http://your-server:32410` in a browser. Click **Scan** to index your
media libraries.

## Configuration

Reel reads `config.json` from the working directory. Environment variables
override file values where noted.

> **Docker users:** The `config.json` that the container reads is the one in
> the `deploy/` directory (bind-mounted via `./config.json:/app/config.json:ro`
> in docker-compose). The `./` path resolves relative to the compose file's
> directory, **not** the project root. Editing a `config.json` elsewhere has no
> effect on the running container. After editing `deploy/config.json`, restart
> the container: `docker compose down && docker compose up -d` from the
> `deploy/` directory. No `--build` is needed for config-only changes.

```json
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
  ],
  "autoTagDepth": 0,
  "autoTagExclude": [],
  "tagRules": []
}
```

| Field | Required | Env Override | Notes |
|-------|----------|-------------|-------|
| `libraries` | Yes | — | Array of `{name, path}`. Names must be unique. Paths are absolute filesystem paths to media directories. Per-library `autoTagDepth` and `autoTagExclude` overrides are optional. |
| `dbPath` | Yes | `REEL_DB_PATH` | Path to the SQLite database file. Created automatically if it doesn't exist. |
| `port` | No | `REEL_PORT` | Default `32410`. |
| `host` | No | `REEL_HOST` | Default `0.0.0.0`. |
| `allowedExtensions` | No | — | File extensions to index. Default includes all supported formats. |
| `autoTagDepth` | No | — | Number of directory segments (from library root) to auto-tag on scan. Default `0` (disabled). Can be overridden per-library. |
| `autoTagExclude` | No | — | Array of directory names to skip when auto-tagging (case-insensitive). Can be overridden per-library. |
| `tagRules` | No | — | Array of `{match, tag}` keyword rules for filename-based auto-tagging. See below. |

### Auto-Tagging

When `autoTagDepth` is set to a value greater than 0, the scanner automatically
creates tags from the directory path of each media file relative to its library
root.

For example, with `autoTagDepth: 2` and a library rooted at `/media/video`, a
file at `/media/video/Concerts/EDC Las Vegas 2026/set.mp4` produces two path
segments: `Concerts` and `EDC Las Vegas 2026`. Each becomes a tag unless it
appears in `autoTagExclude`.

```json
{
  "autoTagDepth": 2,
  "autoTagExclude": ["Concerts", "Music", "Video", "Misc"]
}
```

With this config, the file above would be auto-tagged `EDC Las Vegas 2026`
(the `Concerts` segment is excluded). Tags are additive — auto-tagging never
removes existing tags, and manually-set tags are unaffected.

#### Per-Library Auto-Tag Config

Libraries can override the global `autoTagDepth` and `autoTagExclude`. This
is useful when different libraries have different directory structures:

```json
{
  "libraries": [
    { "name": "Music", "path": "/media/music", "autoTagDepth": 0 },
    { "name": "Video", "path": "/media/video", "autoTagDepth": 1, "autoTagExclude": ["Misc"] }
  ],
  "autoTagDepth": 2,
  "autoTagExclude": ["Concerts"]
}
```

In this example, the Music library disables directory auto-tagging (relying
on embedded tags instead), while the Video library uses depth 1 with its own
exclude list. Libraries without overrides fall back to the global values.

### Tag Rules (Filename Keyword Matching)

Tag rules apply tags based on keywords found in filenames. This complements
directory-based auto-tagging for cases where the useful metadata is in the
filename rather than the directory structure.

```json
{
  "tagRules": [
    { "match": "EDC", "tag": "EDC" },
    { "match": "Lost Lands", "tag": "Lost Lands" },
    { "match": "Rampage", "tag": "Rampage" }
  ]
}
```

Each rule checks whether the filename contains the `match` string
(case-insensitive). If it does, the `tag` is applied. Like directory
auto-tagging, tag rules are additive and never remove existing tags.

For example, with the rules above, a file named
`Eptic - EDC Orlando Virtual Rave-A-Thon (2020).mp4` would be tagged `EDC`.

### Embedded Metadata (ID3 Tags)

For audio files (MP3, M4A, FLAC, OGG, Opus, AAC, WAV, WMA), the scanner
reads embedded ID3/M4A tags and uses them for artist, title, album, year,
and track number. This takes priority over filename parsing — embedded tags
are used when present, with `parseFilename()` as the fallback.

Video files continue using filename parsing only (concert recordings rarely
have meaningful embedded metadata).

Reel never writes to media files. The database is the sole source of truth
for user-edited metadata; embedded tags are read-only source data.

## Usage

### Scan Workflow

The scan is the primary way media enters Reel. The workflow is:

1. Drop files onto the NAS / media directory
2. Open Reel in a browser
3. Click **Scan**
4. New files appear in the library

No SSH, no CLI, no scheduled jobs. The scan button is always visible on the
library page. Scanning is fast — a personal library of hundreds to thousands of
files completes in under a second.

There is no filesystem watching, no polling, and no scan-on-startup. Media
libraries are mounted read-only; the scanner only runs when you explicitly
trigger it.

### Library Page

Browse, search, filter, and edit your media collection. Features include:

- Full-text search across filenames, titles, artists, and descriptions
- Sidebar browse panel with artists, tags, and libraries
- Filter by clicking artists, tags, or libraries in the sidebar
- Sort by title, artist, year, modification time, size, or creation date
- Responsive multi-column card grid
- Inline metadata editing (title, artist, year, description, tags)
- Tag autocomplete from existing tags
- CSV metadata import for bulk updates

### Player Page

Click any media item to open the player. Features include:

- Video, audio, and visualizer playback modes
- Frequency bars and waveform visualizer with three color themes
- Custom transport controls (play/pause, seek, volume, speed, fullscreen)
- Marker sidebar synced to playback position
- Now-playing strip with previous/current/next marker pills
- Fullscreen marker toast on track transitions
- Browse overlay to switch media without returning to the library
- Inline marker editing (label and timestamp) and deletion
- Marker text import (paste a tracklist)
- Marker export to clipboard
- Keyboard shortcuts: Space (play/pause), ←/→ (±5s), ↑/↓ (volume), M (mute), F (fullscreen)

## Security Model

**Reel is designed for trusted-LAN deployment only. Do not expose it directly
to the internet.**

There is no authentication, no authorization, and no rate limiting. The stream
endpoint serves any file path recorded in the database. The scan endpoint
triggers a full filesystem walk. The import endpoint writes to the database.

For remote access, put Reel behind a VPN (WireGuard, Tailscale) or an
authenticating reverse proxy (Caddy with basicauth, nginx with
`auth_basic`, Authelia, etc.).

Media libraries are mounted read-only in the Docker configuration. This is
intentional — Reel reads media files but never modifies them. The database
volume is the only writable persistent state.

## Deployment

### Docker (Primary)

The Docker setup uses a two-stage build: the first stage compiles
`better-sqlite3`'s native module (requires python3/make/g++), and the second
stage copies the built artifacts into a clean `node:24-slim` image.

```yaml
# deploy/docker-compose.example.yml
services:
  reel:
    container_name: reel
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    ports:
      - "32410:32410"
    volumes:
      - ./config.json:/app/config.json:ro
      - reel-db:/data/db
      - /mnt/media/music:/media/music:ro
      - /mnt/media/video:/media/video:ro
    environment:
      - REEL_DB_PATH=/data/db/reel.sqlite
      - REEL_HOST=0.0.0.0
      - REEL_PORT=32410
    restart: unless-stopped

volumes:
  reel-db:
```

Adjust volume mounts to match your media library paths. The `config.json`
library paths must match the container-side mount points (e.g. `/media/music`,
not the host path).

**Deploying updates:**

```bash
cd /path/to/reel/deploy

# First time only: make deploy.sh executable
chmod +x deploy.sh

./deploy.sh
```

If you prefer not to set the execute bit, you can also run `bash deploy.sh`
directly.

`deploy.sh` pulls the latest code, rebuilds the container, and restarts.

### Bare-Metal / systemd (Alternate)

For development or environments where Docker isn't preferred.

**Requirements:** Node.js 24 LTS, npm

```bash
cd /opt/reel/app  # or wherever you cloned the repo
npm ci
node server.js
```

A systemd unit file is provided at `deploy/reel.service`:

```bash
# Create a dedicated user
sudo useradd -r -s /bin/false reel

# Set up the application
sudo mkdir -p /opt/reel/data
sudo cp -r app/ /opt/reel/app
sudo cp deploy/reel.service /etc/systemd/system/
sudo chown -R reel:reel /opt/reel

# Create config.json at /opt/reel/app/config.json
# Edit paths and dbPath to match your system

# Install dependencies
cd /opt/reel/app
sudo -u reel npm ci

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable reel
sudo systemctl start reel
sudo journalctl -u reel -f
```

Environment variables in the unit file (`REEL_HOST`, `REEL_PORT`,
`REEL_DB_PATH`) override `config.json` values. Edit the unit file to match
your paths.

## Scanner Behavior

### Stale File Deletion

When a scan runs, files that were previously indexed but no longer exist on
disk are removed from the database. This deletion is scoped per library and
includes safety guards:

- If a library's filesystem walk **fails** (mount down, permission error), no
  rows are deleted from that library. The scan response includes the library
  name in `skippedLibraries`, and the UI shows an error toast:
  *"Library unavailable, nothing removed: [name]"*.

- If a library's walk returns **zero files** but the database has existing rows
  for it (mounted-but-empty, e.g. wrong volume path), deletion is also skipped.

This prevents a transient mount failure from cascading into deletion of all
media rows for a library — which would also destroy all markers and tag
associations via `ON DELETE CASCADE`.

**Intentional asymmetry:** if you genuinely empty a library's directory, the
guard blocks cleanup — stale rows persist until at least one media file exists
in the library or the library is removed from config. The bias is deliberate:
Reel never auto-wipes an entire library.

### Symlinks

Symlinks are followed. Linked directories are recursed, linked files are
ingested. Broken symlinks are counted and reported in the scan response
(`brokenSymlinks`) but don't cause errors.

### Concurrent Scans

A second scan request while one is already running returns `409 Conflict`.

## Format Support

Reel serves media files with correct MIME types and relies on the browser for
decoding. See [docs/codec-compatibility.md](docs/codec-compatibility.md) for
the full browser compatibility matrix.

**Short version:** MP4 (H.264/AAC) for video and MP3/FLAC for audio work
everywhere. MKV and WMA don't play in any browser — re-mux or re-encode.

Supported container formats: MP4, M4V, MKV, WebM, AVI, MOV, MP3, M4A, WAV,
FLAC, OGG, Opus, AAC, WMA.

## Import and Export

### Metadata (CSV/JSON)

Export your full library metadata with `GET /api/export?format=csv`, edit it,
and re-import with `POST /api/import`. See
[docs/import-format.md](docs/import-format.md) for field details and examples.

### Markers (Tracklist Text)

Import tracklists by pasting text into the player's Import Markers overlay,
or via `POST /api/media/:id/markers`. Export a media item's markers as
re-importable text with `GET /api/media/:id/markers/export`. See
[docs/import-format.md](docs/import-format.md#marker-text-import) for
supported formats.

### Markers (CSV — Bulk)

Export all markers across the library as CSV with
`GET /api/export?format=markers-csv`. Columns: `filename`, `rel_path`,
`start`, `end`, `label`. Filter by library with `?lib=name`.

Re-import with `POST /api/import/markers` (same CSV format). Markers are
replaced per matched media item — all existing markers for a matched file
are deleted and the CSV rows are inserted. Matching uses `rel_path` first,
then `filename` as fallback.

## API Reference

All endpoints return JSON unless noted. Errors return `{ error: "message" }`
with appropriate HTTP status codes.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | `{ ok, name, version }` |
| GET | `/api/library` | Paginated media list with search, filter, sort |
| GET | `/api/media/:id` | Full media record with markers, tags, stream URL |
| PATCH | `/api/media/:id` | Update metadata (title, artist, album, year, trackNumber, description) |
| POST | `/api/media/:id/markers` | Replace markers (text or JSON array) |
| PATCH | `/api/media/:id/markers/:markerId` | Update individual marker (label, startSeconds, endSeconds) |
| DELETE | `/api/media/:id/markers` | Clear all markers |
| GET | `/api/media/:id/markers/export` | Markers as re-importable plain text |
| GET | `/api/tags` | All tags with usage counts |
| GET | `/api/artists` | All artists with media counts |
| POST | `/api/media/:id/tags` | Replace tags for a media item |
| POST | `/api/scan` | Trigger library scan |
| POST | `/api/import` | Bulk metadata import (CSV or JSON) |
| POST | `/api/import/markers` | Bulk marker import (CSV or JSON, replace-all per media item) |
| GET | `/api/export` | Full metadata export (`?format=json\|csv\|markers-csv`, `?lib=name`) |
| GET/HEAD | `/stream/:id` | Range-based media streaming |

### Library Query Parameters

| Param | Description |
|-------|-------------|
| `q` | Full-text search (FTS5, prefix-matching on last token) |
| `lib` | Filter by library name |
| `type` | `audio` or `video` |
| `ext` | Filter by file extension |
| `artist` | Filter by exact artist name |
| `tag` | Comma-separated tag names (AND logic) |
| `sort` | `title`, `artist`, `album`, `year`, `mtime`, `size`, `created` (default: `mtime`) |
| `order` | `asc` or `desc` (default: `desc`) |
| `limit` | Page size, 1–200 (default: 50) |
| `cursor` | Opaque pagination token from `nextCursor` |

## Browser Compatibility

Reel's frontend is vanilla JS/HTML/CSS with no build step and no framework.
It uses ES modules, CSS custom properties, Web Audio API, and Fullscreen API.

| Feature | Chrome 90+ | Firefox 90+ | Safari 15.4+ | Notes |
|---------|-----------|------------|-------------|-------|
| Core playback | Yes | Yes | Yes | |
| Visualizer | Yes | Yes | Yes | Requires Web Audio API |
| Fullscreen | Yes | Yes | Yes | |
| Keyboard shortcuts | Yes | Yes | Yes | |
| CSS Grid layout | Yes | Yes | Yes | |

**Mobile:** The interface is functional on mobile browsers but is designed
primarily for desktop use. The playback speed selector is hidden below 640px
to save control bar space.

**Firefox on Linux:** If video playback stutters on capable hardware, ensure
VA-API hardware acceleration is enabled. See
[docs/codec-compatibility.md](docs/codec-compatibility.md#hardware-acceleration).

## Stack

- **Runtime:** Node.js 24 LTS
- **Framework:** Fastify 5
- **Database:** SQLite via better-sqlite3 (with FTS5 for full-text search)
- **Frontend:** Vanilla JS, HTML, CSS (no build step, no framework)
- **Container:** Docker on node:24-slim

## Versioning

See [docs/versioning.md](docs/versioning.md) for the release history and
planned roadmap.

## License

Reel is free software licensed under the
[GNU General Public License v3.0](LICENSE). You are free to use, modify, and
distribute it under the terms of that license. See the LICENSE file for the
full text.

Copyright (c) 2026 iBumpthis
