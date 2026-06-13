# Reel — Version Roadmap

Reel uses semantic versioning: `MAJOR.MINOR.PATCH`.

- **MAJOR** — reserved for breaking changes (schema migrations that aren't
  backward-compatible, config format changes, API contract changes).
- **MINOR** — new features, non-breaking schema additions, UI rework.
- **PATCH** — bug fixes, documentation, dependency updates.

At Reel's current scale (personal tool, single user, single deployment), the
versioning is primarily for tracking what changed between deploys and
maintaining clean handoff context between development sessions.

---

## Released

### v1.0.0 — Initial Release

Full backend and frontend built across four development sessions:

- **Backend:** Fastify 5 server, SQLite schema with FTS5, versioned migrations,
  async scanner with stale-delete guards, marker parsing engine, range-based
  streaming, tag system, CSV import/export.
- **Library page:** Media grid, FTS search, tag filtering, cursor-based
  pagination, inline metadata editing with tag autocomplete, CSV import
  overlay, scan workflow.
- **Player page:** Video/audio/visualizer modes, Web Audio API visualizer
  (frequency bars + waveform lines, three color themes), custom controls,
  now-playing strip, fullscreen marker toast, browse overlay, inline marker
  editing/deletion, keyboard shortcuts, playback speed, codec error detection.
- **Deployment:** Docker two-stage build, deploy.sh, systemd unit file.

### v1.1.0 — Library Overhaul + Auto-Tagging

- **Library page rework:** Sidebar browse panel (artists, tags, libraries),
  multi-column responsive card grid, active filter chips, simplified toolbar.
  Replaces the dropdown filter bar with a discovery-oriented sidebar.
- **Card layout improvements:** Artist name given more visual weight, meta and
  tags laid out in a combined info row to reduce vertical stacking.
- **Auto-tagging:** Scanner auto-creates tags from directory path segments.
  Configurable depth and exclusion list. Additive only — never removes
  existing tags.
- **New endpoint:** `GET /api/artists` — artist names with media counts.
- **New query param:** `artist` filter on `GET /api/library`.
- **Deployment fix:** README documents `chmod +x deploy/deploy.sh` requirement.

---

## Planned

### v1.2 — Marker Workflow

- Marker timestamp inline editing (not just label editing).
- Per-marker PATCH endpoint (original plan spec, never built in v1.0).
- Markers included in CSV export/import (currently metadata-only).
- Individual marker export/import UI surfaced more prominently.

### v1.3 — Technical Debt

Documented tradeoffs from v1.0 that are worth resolving:

- CSV export formula injection escaping (leading `=`).
- `USER node` in Dockerfile (one-line hardening + volume ownership).
- Lockfile regeneration under Node 24.
- FTS5 rebuild-on-every-edit → trigger-based sync (scale blocker).
- Evaluate: benign inline-edit double-save race (Enter + blur).

### v1.4 — Visualizer Upgrades

- Additional visualizer modes: circular/radial, spectrogram, particle field.
- Visualizer mode selector (beyond the current bars/lines toggle).
- Theme additions beyond the current three color palettes.

### v1.5 — Feature Evaluation

Review deferred features from the original project plan and evaluate for
inclusion based on real usage patterns:

- Waveform seekbar (requires ffmpeg in container).
- Thumbnail generation (requires ffmpeg, increases Docker image size).
- Playback history / resume position (data model depends on user scope).
- Playlists (schema addition, auto-advance, queue management).
- SPA-style media switching (in-page swap vs URL navigation).
