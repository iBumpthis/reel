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

### v1.2.0 — Smart Metadata & Tag Rules

- **Embedded tag reading:** Scanner reads ID3/M4A tags from audio files using
  `music-metadata`. Artist, title, album, year, and track number from embedded
  tags take priority over filename parsing. Video files continue using filename
  parsing only. Read-only — Reel never writes to media files.
- **Schema migration 002:** `album` (TEXT) and `track_number` (INTEGER) columns
  added to media table. FTS5 index rebuilt to include album in full-text search.
- **Filename parsing cleanup:** `parseFilename()` now strips leading track
  numbers (`01 `, `01. `, `04. `) and disc prefixes (`(Disc 2) `, `(CD 1) `)
  before the artist/title split. Fixes garbage artist names from numbered
  MP3 files.
- **Tag rules engine:** Config-driven keyword matching against filenames for
  auto-tagging. Rules are `{match, tag}` objects — case-insensitive substring
  match applies the named tag. Complements directory-based auto-tagging for
  event names embedded in filenames (EDC, Lost Lands, Rampage, etc.).
- **Per-library auto-tag config:** Libraries can override global `autoTagDepth`
  and `autoTagExclude`, allowing different tagging strategies per library
  (e.g. Music disables directory tags while Video uses depth 1).
- **Album in UI:** Album displayed on library cards (italic, below artist),
  editable in inline metadata editor, available as a sort option, included
  in CSV import/export.
- **Config documentation:** README updated with config.json location warning
  for Docker users (`deploy/` directory, not project root).
- **Deployment note:** DB wipe recommended before first v1.2 scan to get clean
  metadata from embedded tags. Existing DBs will work but won't benefit from
  ID3 data for previously scanned files until the next fresh scan.

### v1.3.0 — Marker Workflow + Polish

- **Per-marker PATCH endpoint:** `PATCH /api/media/:id/markers/:markerId`
  updates individual marker fields (label, startSeconds, endSeconds) without
  replacing all markers. Uses the `'field' in body` dynamic SET pattern.
- **Marker timestamp inline editing:** Edit button on marker rows now shows
  both a timestamp input and a label input. Uses per-marker PATCH instead of
  the previous replace-all approach. Invalid time formats show an error toast.
  If the timestamp changes, markers re-sort and the list re-renders.
- **Markers CSV export:** `GET /api/export?format=markers-csv` exports all
  markers as CSV with columns: `filename`, `rel_path`, `start`, `end`, `label`.
  Filterable by library with `?lib=name`. Link added to library page footer.
- **Bulk markers CSV import:** `POST /api/import/markers` accepts the same
  CSV format. Replace-all semantics per matched media item.
- **Export markers from player:** "Export Markers" button copies the tracklist
  text to clipboard via the existing markers/export endpoint.
- **Edit form CSS fix:** Card with an open inline edit form now spans the full
  grid width (`grid-column: 1 / -1`) with a highlighted border, preventing
  overlap with adjacent cards on smaller screens.
- **Scan progress indicator:** Animated spinner with "Scanning libraries..."
  text appears in the media grid during scan. Replaces the previous
  toolbar-text-only feedback.
- **Stale marker ID fix:** After marker deletion (which uses replace-all POST),
  markers are reloaded from the server to prevent subsequent edits from
  targeting invalidated row IDs.
- **Deployment hardening (v1.2.1):** `.dockerignore` added to prevent host
  `node_modules` from poisoning Docker builds. Dockerfile `EXPOSE` corrected
  to 32411. Lockfile regenerated with correct version and dependency tree.
- **Bug fixes (v1.3.1):** Clipboard fallback for HTTP LAN deployments
  (`execCommand('copy')` when `navigator.clipboard` unavailable). Seek-on-click
  no longer fires when clicking into marker edit inputs.

### v1.4.0 — Technical Debt + Hardening

- **CSV formula injection escaping:** CSV exports now prefix cells starting
  with `=`, `+`, `-`, `@` with a leading apostrophe to prevent spreadsheet
  formula injection. Applies to both metadata and markers CSV exports.
- **Scan tag-read optimization:** The scanner now skips embedded tag reading
  (music-metadata `parseFile()`) for files that already exist in the database.
  The upsert's ON CONFLICT clause only updates size/mtime/scan tracking — it
  does not overwrite metadata fields — so tag reads for existing files were
  pure I/O waste. This significantly reduces scan time for subsequent scans
  on NAS storage. If a file is re-encoded at the same path, delete the DB
  row and re-scan to pick up new embedded tags.
- **Version bump:** package.json and package-lock.json updated from 1.3.0 to
  1.4.0 (skipping the intermediate 1.3.1 that was merged without a bump).

### v1.4.1 — Dockerfile Revert

- **Reverted `USER node` Dockerfile change:** The v1.4.0 build included a
  `USER node` directive that broke streaming on CIFS/SMB NAS mounts. The
  displayed 777 permissions on Synology CIFS mounts are cosmetic — actual
  access is restricted to the mount owner uid (1027), so the `node` user
  (uid 1000) gets EACCES on `stat()`, which the stream handler returns as
  404. Dockerfile reverted to match v1.3.x (running as root). See the
  "Evaluated and deferred" note under v1.4.0 for full rationale.

**Evaluated and deferred:**

- **Dockerfile non-root user:** Evaluated running the container as `USER node`
  (uid 1000) instead of root. Incompatible with CIFS/SMB NAS mounts — the
  displayed 777 permissions are a CIFS artifact; actual access is restricted
  to the mount owner uid (1027 on the Synology NAS). The stream endpoint
  returns 404 (EACCES caught as file-not-found) for all media files. Since
  Reel's security model is explicitly trusted-LAN with no internet exposure,
  root-in-container with read-only media mounts is an accepted tradeoff.
  Revisit if deployment model changes.
- **FTS5 trigger-based sync:** Evaluated replacing the full FTS5 rebuild on
  every metadata PATCH with incremental triggers. The scanner's ON CONFLICT
  clause includes `filename` in its SET list, which would cause the update
  trigger to fire on every scan upsert even when filename doesn't change.
  Fixing this requires either conditional WHEN clauses or removing filename
  from the scan SET. At ~3K items the full rebuild is under 20ms. Deferred
  until scale warrants the migration complexity.
- **Inline-edit double-save race:** Enter fires save, then blur also fires
  save. Second save is a no-op with identical data. Benign — not worth a
  guard flag.

### v1.5.0 — Logo/Branding + Visualizer Upgrades

- **Header logo:** SVG icon (beamed eighth note with film reel sprocket hubs)
  added to the app header on both library and player pages. Inline SVG uses
  `currentColor` — renders in accent amber, transitions to accent-hover on
  hover. Standalone logo file at `app/public/img/logo.svg`.
- **Four new visualizer modes:**
  - **Radial:** Frequency bars arranged in a 360° circle with mirrored inner
    ring. Uses 80 bins with rounded line caps.
  - **Spectrogram:** Scrolling time × frequency heatmap. Each theme provides
    an `amplitudeColor(0-255)` function for mapping amplitude to heat color.
    Scrolls at 2px per frame, clears on canvas resize.
  - **Particles:** 180 audio-reactive particles. Bass energy drives velocity
    force, mid-range drives opacity. Particles drift toward center during
    silence. Lazy-initialized with canvas dimension tracking.
  - **Nova:** 100 large particles with three-layer glow (core, mid, outer
    halo). Stronger center gravity and expansion multiplier than Particles.
    Slower trail decay for longer streaks.
- **Four new color themes:** Neon (cyan↔magenta), Fire (red→orange→yellow),
  Matrix (green monochrome), Ocean (deep blue→teal). All seven themes include
  `amplitudeColor` for spectrogram compatibility.
- **FFT resolution bump:** `analyser.fftSize` increased from 256 to 2048,
  giving the spectrogram 1024 frequency bins. Bars mode caps at 64 bins via
  subsampling to preserve the existing visual density. Waveform mode benefits
  from smoother data (2048 points vs 256).
- **Viz options layout:** `flex-wrap` added to the viz-options and
  viz-style-selector containers to handle the expanded button set on narrower
  viewports.

### v1.6.0 — Visualizer UX + Matrix Rain

- **Always-visible viz options:** Visualizer mode and theme selectors are now
  visible in the mode toolbar regardless of active playback mode. Pre-select
  a mode or theme before switching to visualizer without needing to toggle
  visualizer mode first.
- **Fullscreen viz controls:** Hover-reveal panel at the top of the fullscreen
  view provides access to all viz mode and theme selectors without leaving
  fullscreen. Uses the same idle timer as the transport controls (3s).
- **Keyboard shortcuts for viz cycling:** `V` cycles through visualizer modes,
  `T` cycles through themes. Shift+V and Shift+T cycle in reverse. Pressing
  `V` while not in visualizer mode switches to visualizer automatically.
- **Visualizer randomizer:** Clicking the visualizer mode button while already
  in visualizer mode now randomizes the mode and theme (always picks a
  different combination than the current one).
- **Matrix Rain visualizer mode:** Falling characters in columns mapped to
  frequency bins. Amplitude at each bin controls character brightness via a
  cubic falloff curve — low-energy bins produce invisible characters, creating
  organic density gaps. Characters mutate randomly for the classic flicker
  effect. Pairs naturally with the Matrix green theme. Performance-conscious:
  cubic falloff skips ~60-70% of columns per frame, keeping draw calls well
  within budget for headless servers.
- **Documentation fixes:** v1.5.0 release notes and README corrected to list
  all seven visualizer modes (Nova was omitted from both). Keyboard shortcuts
  list updated.

---

## Planned

### v1.7 — Feature Evaluation

Review deferred features from the original project plan and evaluate for
inclusion based on real usage patterns:

- SPA-style media switching (in-page swap vs URL navigation — preserves
  AudioContext and visualizer state between tracks).
- Waveform seekbar (requires ffmpeg in container).
- Thumbnail generation (requires ffmpeg, increases Docker image size).
- Playback history / resume position (data model depends on user scope).
- Playlists (schema addition, auto-advance, queue management).
