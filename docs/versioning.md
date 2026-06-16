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

### v1.6.1 — Bug Fixes + Polish

- **Fullscreen controls staying visible:** CSS specificity bug — the hover
  rules (0-4-0) beat the fullscreen opacity rules (0-3-0), keeping controls
  permanently visible since `:hover` is always true in fullscreen. Fixed by
  adding `:not(:fullscreen)` to the hover selectors so fullscreen visibility
  is exclusively controlled by the idle timer.
- **Viz style buttons inert outside visualizer mode:** Clicking a viz style
  button (Bars, Lines, etc.) while not in visualizer mode now automatically
  switches to visualizer mode. Previously the button only updated the
  internal state without switching modes.
- **Matrix Rain head character:** Two improvements — (1) trail alpha starts
  at 0.7 after the head (30% drop from head to second character), and
  (2) white overlay on peaks. Head characters blend toward white when
  amplitude is high (cubic falloff gates it so only genuine peaks produce
  white-hot heads, matching the movie aesthetic).
- **Mode toolbar layout:** Restructured from a single flex row to a two-row
  centered column. Row 1: mode buttons + viz style buttons (inline with
  border-left divider). Row 2: theme dots. The `viz-options` wrapper div
  was removed; `viz-style-selector` and `theme-selector` are now direct
  children of the toolbar.

---

### v1.7.0 — Terminal Visualizer

- **Terminal visualizer mode (8th mode):** Bash terminal aesthetic — lines
  scroll bottom-to-top at ~8 lines/sec. Each line shows a
  `visualizer@reel:~$` prompt followed by 16 frequency bin labels (20 Hz
  through 16 kHz) whose brightness maps to audio amplitude at that frequency.
  Square falloff (gentler than Matrix Rain's cubic) keeps labels readable.
  Bin mapping is sample-rate-aware via `audioCtx.sampleRate`.
- **Easter egg system:** Single-line eggs (~1 in 150 lines, ~every 18-20s)
  and multi-line eggs (~1 in 400 lines, ~every 50s) inject shell commands,
  fake errors, and interactive output. Pool includes ~19 single-line entries
  (whoami, wrong-platform typos like `ipconfig /all` and `Get-Process`,
  command-not-found errors) and ~10 multi-line entries (uptime with playback
  position and bass/mid/high as load averages, stat with current track
  metadata, ssh loop, fake segfault, sudo rm -rf /silence with 10 blank
  lines, apt/aptitude two-parter with ASCII tape cassette art where v-count
  = line count, and `claude && /skill quote` with movie quotes from Hackers,
  Tron, The Matrix, and WarGames — including a tic-tac-toe stalemate board).
  Cooldown prevents back-to-back eggs (12-line minimum gap).
- **White-hot peaks on frequency labels:** Same double-draw technique as
  Matrix Rain heads — labels at high amplitude get a white overlay, punching
  through on darker themes (muted, matrix, ocean).
- **OLED protection:** Scrolling cycles all pixel positions. Easter egg
  responses break the prompt pattern at the left edge. Some eggs use
  alternate prompts (`root@reel:~#`) to shift left-edge characters.

### v1.8.0 — Stability & Review

A stability pass after three feature-heavy visualizer sessions (v1.5–v1.7).
Full read-through of the frontend and backend with fixes for the concrete
problems it surfaced. No new visualizer modes (those move to v1.9).

- **Mid-stream decode recovery:** `MEDIA_ERR_DECODE` (error code 3) is now
  split by timing. An error within the first 2 seconds is treated as codec
  incompatibility (unrecoverable — surfaced with a clear message). An error
  during active playback is treated as mid-stream corruption (common from
  some yt-dlp backup captures): the player reloads the source, seeks ~3s past
  the bad segment, and resumes, with a *"Skipped bad segment at H:MM:SS"*
  toast. Capped at 5 recovery attempts per page load with a 1s cooldown
  between attempts; exhaustion surfaces *"Too many decode errors — file may
  be corrupt."* The visualizer's audio graph survives the reload because the
  `MediaElementAudioSourceNode` stays bound to the element across `src`
  reassignment.
- **Scanner: resilient directory walk.** An unreadable subdirectory
  (permission change, transient I/O, vanished mid-walk) is now counted and
  skipped instead of aborting the entire library walk. The scanner ingests
  every directory it *can* read. Stale-delete is still suppressed for any
  library whose walk hit one or more errors, so a partial read can never
  delete rows that were merely unreadable this pass — the same fail-safe as
  before, now without losing the readable files. Reported via a new
  `walkErrors` count in the scan response.
- **Scanner: symlink cycle guard.** A symlink pointing at an ancestor
  directory previously recursed until the stack/heap was exhausted. Directory
  symlink targets are now resolved with `realpath` and skipped if already
  visited (per-library), seeded with the library root.
- **Default port aligned to 32411.** The config default fallback, example
  config, systemd unit, and example compose were still `32410` (TapeC's
  port) while the real deploy and Dockerfile `EXPOSE` used `32411`. All
  Reel-facing references now default to `32411` to avoid a silent collision
  with TapeC on a bare local run. (The historical redesign plan retains its
  original `32410` as an archival snapshot.)
- **Hardening:** `exportMarkers` now checks response status before copying
  (an error body no longer gets copied to the clipboard as "success");
  `media.ext`/`item.ext` uppercase calls in the player and browse overlay
  are guarded against a missing extension.
- **"Term" → "Terminal":** Visualizer style button relabeled in both the
  main toolbar and the fullscreen bar.
- **Test harness:** First automated tests (`app/test/`, `npm test` via
  `node --test`, zero dependencies) covering the pure logic most exposed to
  silent regression — the marker parser, the filename metadata parser, and
  the shared time/byte formatters. 40 assertions, all green.
- **FTS5 trigger-sync evaluation:** Documented and empirically validated a
  move from full-rebuild-on-every-write to incremental trigger sync
  (~1200× faster edits at 50K rows; the deferred "false trigger fires"
  blocker solved with a `WHEN`-gated UPDATE trigger). Evaluation only — see
  `docs/fts-trigger-evaluation.md`. Proposed for v1.8.1.

### v1.8.1 — FTS5 trigger-based sync

Implements the FTS5 trigger sync evaluated in v1.8.0. Schema-only change plus
the removal of three manual-rebuild call sites; no API or UI change.

- **Migration 003 — FTS triggers.** Three triggers on `media` now keep the
  `media_fts` external-content index current incrementally: `AFTER INSERT`
  and `AFTER DELETE` mirror row changes, and a `WHEN`-gated `AFTER UPDATE`
  resyncs a row only when an FTS-indexed column (`filename`, `title`,
  `artist`, `album`, `description`) actually changes. A one-time `rebuild`
  baseline runs in the migration so the index is known-good before the
  triggers take over. Purely additive and reversible (`DROP TRIGGER`); the
  blast radius if wrong is stale search results, not data loss (FTS is
  derived). The migration leaves migration 002's historical rebuild intact.
- **Removed full-rebuild call sites.** `services/scanner.js` (per scan),
  `routes/media.js` (every metadata PATCH), and `routes/import-export.js`
  (per import) no longer run `INSERT INTO media_fts(media_fts)
  VALUES('rebuild')`. The triggers do the equivalent work targeted to the
  changed rows: O(1) per changed row on the edit/import paths instead of an
  O(n) full reindex, and zero FTS work on a no-op re-scan (the scanner's
  `ON CONFLICT` re-sets `filename` to the same value, so the `WHEN`-gate is
  false). Empirically ~1200× faster on a single edit at 50K rows.
- **DB-level trigger tests.** `app/test/fts-triggers.test.js` exercises the
  real migration SQL (001+002+003) against the actual SQLite engine via
  `better-sqlite3`: insert/update/delete indexing, the `WHEN`-gate writing
  zero FTS rows on non-indexed and no-op-rescan updates, `integrity-check`,
  and a no-drift check that the trigger-synced index equals a full rebuild.
  The suite skips cleanly (rather than failing) where the native module
  isn't built, so the existing zero-dependency parser suites still run
  anywhere via `npm test`.

### v1.9.0 — Player Polish

First release on the v1.9 line, scoped as a small frontend polish patch ahead
of the visualizer work (which moves to v1.9.1). Frontend only — no backend,
schema, or dependency changes.

- **Now-playing current pill pinned to a fixed footprint on both axes.** The
  center pill previously used a `180–320px` width range and a `min-height`
  floor, so a short marker label rendered a visibly smaller pill than a long
  one. It is now fixed (`width: 320px`, `height` = the two-line border-box)
  with short labels centered inside via blank padding rather than shrinking
  the box. Overflow past two lines stays clamped on the inner `.np-label` with
  an ellipsis (the full, untruncated label always lives in the markers
  sidebar). Result: the prev / current / next strip is a constant visual
  reference frame regardless of which marker is playing, and nothing below it
  shifts on marker change. `max-width: 100%` added as a safety valve against
  horizontal overflow on a very narrow column.
- **Visualizer mode icon changed from an equalizer glyph to a die.** The bars
  glyph collided with the literal "Bars" mode and misread as one specific
  visualizer rather than the suite-entry button; it also conflicted with the
  waveform iconography being reserved for future waveform features (seekbar /
  waveform visualizer mode). A die communicates the button's
  randomize-on-reclick behavior. Icon-only change — no behavior change.

### v1.9.1 — Bars Redesign

First substantive step of the v1.9.X visualizer work. Frontend only — single
mode rewrite, no new modes, no buttons, no backend/schema/dependency changes.
Roster unchanged at eight modes.

- **`drawBars` rewritten as a linear end-to-end spectrum.** The prior layout was
  center-mirrored (bass duplicated at the center, highs to both edges, anchored
  at the bottom). It is now a single horizontal sweep: bass at the left edge,
  treble at the right, spanning the full width — Radial's treatment unrolled
  flat. The main band fills the top 2/3 of the canvas, growing up from a thin
  baseline; a dimmed (`alpha 0.28`), shortened (`0.5×`) reflection drops into
  the bottom 1/3 below the baseline. Bars are drawn with rounded outer caps
  (rounded top on the main bar, rounded bottom on the reflection, square where
  they meet the baseline).
- **White-hot peak tips.** Bars whose amplitude crosses `0.82` get a fixed-height
  white cap, alpha-scaled by how far past threshold they push — the same
  double-draw technique already used in Matrix Rain and Terminal.
- **Bin-range cap preserved (and documented in code).** Bars still samples only
  the lower `0.38` fraction of FFT bins. In lossy MP4 the upper register is
  dead, so sampling only the populated low band is what fills the frame; without
  it the real spectrum collapses into the left third. This is a truncation, not
  interpolation/fill — the in-code comment now states this explicitly so it
  isn't reinvented or dropped in a future rewrite. (Deliberately absent in
  Terminal, which shows the true spectrum against fixed Hz labels.)
- **`roundRect` feature-detected once** with a square-corner fallback, since it
  is not present on every Reel target's canvas context (notably the Xbox Edge
  clone).
- Tuning knobs (`BARS_*` consts: bar count, reflection scale/alpha, peak
  threshold, corner radius) are pulled to module scope for direct adjustment.

---

## Planned

### v1.9.X — Visualizer Pack

Additional and punched-up visualizer modes, plus the control-band layout pass
deferred from v1.9.0. The toolbar reorganization is intentionally held until
the new mode count is known: a single added mode likely fits the current row,
whereas several modes — or a sub-mode selector — changes the layout
materially. Scope, candidate modes, and reusable patterns are tracked in the
v1.9.1 handoff document. Particles and Nova remain the quality bar. Current
roster: Bars, Lines, Radial, Spectro, Particles, Nova, Matrix, Terminal (eight
modes; the row is at comfortable density, so net-new modes drive the layout
decision).

### Future — Feature Evaluation

Deferred features from the original project plan, evaluated for inclusion
based on real usage patterns:

- SPA-style media switching (in-page swap vs URL navigation — preserves
  AudioContext and visualizer state between tracks).
- Waveform seekbar (requires ffmpeg in container).
- Thumbnail generation (requires ffmpeg, increases Docker image size).
- Playback history / resume position (data model depends on user scope).
- Playlists (schema addition, auto-advance, queue management).
