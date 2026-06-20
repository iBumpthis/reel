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

### v1.9.2 — Visualizer Selection UX

Two isolated frontend fixes surfaced while testing the v1.9.1 Bars redesign.
No new modes, no backend/schema/dependency changes. Deliberately kept separate
from the feedback-engine work (the next patch) so a ready quick-win isn't held
behind the larger infra build.

- **Viz style + theme highlights now track the active mode, not the cached
  selection.** On a fresh player load (video mode) a visualizer style and a
  theme were both painted active even though only the video was playing — the
  highlight reflected the cached default rather than what was on screen.
  `initModes` no longer paints active state unconditionally; `setMode` clears
  the viz/theme highlights on the video/audio branches and re-applies them on
  entering the visualizer. `setVizStyle`/`setTheme` still update cached state
  from any mode but only paint while the visualizer is active, so the cached
  selection lights up exactly when it starts playing (including via the die's
  load-last-selection click). No layout shift: viz buttons keep a constant 1px
  border and theme dots use a layout-neutral `box-shadow` ring, so adding or
  removing the highlight never reflows the row.
- **Radial pole bars no longer double-draw.** At 12 o'clock (`i === 0`) and
  6 o'clock (`i === halfBins - 1`) both mirrored angles resolve to the same
  point, so those two bars were drawn twice. Invisible for the opaque outer
  bars, but it compounded the `0.35`-alpha inner mirror to ~`0.58`, leaving two
  over-bright anchor spires. The poles are now drawn once so every inner mirror
  shares one alpha.

### v1.9.3 — Feedback Engine, Visualizer Pack & Performance Pass

The Visualizer Pack, restructured mid-phase from "a few more modes" into a
combined engine build, control-band reorg, performance pass, and a Terminal
rework. Two net-new visualizer modes (ten total) on a reusable feedback engine,
an eighth theme, a frame-persistence modifier, a toolbar reorganization, a
render-rate cap that resolved a large GPU/refresh-rate coupling, and a
pause-aware Terminal. Entirely frontend — no backend, schema, or dependency
changes.

- **Feedback engine (ping-pong).** A reusable accumulator engine shared by the
  two new modes. Each frame draws the previous accumulator into a fresh buffer
  dimmed and transformed (zoom/rotate about center), stamps new content on top,
  blits to the visible canvas, and swaps. Built ping-pong (two detached
  buffers, clean read → clean write) rather than same-canvas self-draw, whose
  read==write aliasing smears worst in the strong-center-zoom case. Detached
  `<canvas>`, not `OffscreenCanvas`, for target compatibility (the Xbox Edge
  clone). Per-mode transform knobs (`decay`, `zoom`, `rot`, `bassZoom`) live in
  `FEEDBACK_PARAMS`. `FEEDBACK_SCALE` renders the buffers at a fraction of
  canvas resolution — held at 1.0, wired as the primary lever for a future
  Lite/performance mode.
- **Wormhole** (mode 9). A reactive frequency ring stamped near center each
  frame; slow decay + steady zoom carry rings out to the frame edge as a
  filling tunnel, with a slow corkscrew. The ring is mirrored left/right (bass
  at top, treble at bottom) for balance, with no central core — a bright center
  reads as an object approaching, fighting the depth illusion.
- **Cascade** (mode 10). A crystalline spiral mandala: a 5-arm rosette of
  crystal shards (off-center content the rotation trails into spiral arms) plus
  a 7-facet convex crystal seed, rotation-dominant with gentle zoom. Shapes
  chosen to avoid recognizable symbols (no hexagram/pentagram). Arm extension
  is bass- and peak-reactive so the rosette punches outward on hits. The
  centerpiece is flagged for a future revisit (see Planned).
- **Trails modifier.** Optional per-mode frame persistence for six modes (Bars,
  Radial, Lines, Particles, Nova, Matrix). Lowers each mode's clear-alpha so
  frames streak — not an engine-level clear-swap. Toggled by the `G` key and a
  modifiers button, both routed through a single `toggleTrails`. Spectro,
  Terminal, and the two feedback modes are exempt — their own clears/decay are
  their persistence.
- **Alpine theme** (theme 8). A glacier-blue → forest-green → snow-white
  three-stop ramp with a distinct dark-green mid waypoint, differentiated from
  Ocean (stays saturated) and Matrix (phosphor green, no red/blue). Tunable via
  `ALPINE_*` consts.
- **Track B — control-band reorg.** The toolbar now groups transport/mode | viz
  styles (ten, wrapping) | modifiers | a labeled theme row (eight swatches incl.
  alpine). All viz controls stay always-visible — grouped, not hidden — with no
  height bounce. Mirrored into the fullscreen bar.
- **Performance — 60fps render cap (`TARGET_FPS`).** The draw loop rendered at
  display refresh, so a 120/240Hz panel paid multiples of the GPU cost AND ran
  every mode's per-frame physics proportionally faster (particles, rain, and
  feedback all advance once per rendered frame). The cap normalizes both —
  every display targets ~60fps, so cost and motion speed are consistent
  regardless of refresh rate. On a 240Hz test panel this brought fullscreen GPU
  from the 40-55% range to under 20%. The motion/fps coupling is now explicit;
  delta-time-independent physics is the proper long-term fix, parked.
- **Performance — pause gate.** When playback is paused the analyser is silent,
  so every mode freezes or decays to nothing — rendering it just burns GPU. The
  loop now freezes on the last frame while paused (Terminal excepted). Idle GPU
  dropped from ~9% to near the browser-compositor floor.
- **Terminal — pause-aware rework.** Terminal is the one mode deliberately
  exempt from the pause gate, so it can run a pause story instead of freezing.
  Reframed as `tail -f /var/log/reel/audio_output.log`: the first line on every
  (re)start is the tail command, and freq lines stream in below it. A
  four-phase machine — `streaming → ^C → drain → idle` — drops a `^C` on pause,
  drains the buffer up and off the top, and settles to an idle prompt with a
  blinking block cursor; resume re-runs the tail. The idle phase self-throttles
  to the cursor blink rate (~2 full redraws/sec, not 60), so the exemption
  stays near the idle floor — the full-canvas clear, not the text, is
  Terminal's per-frame cost. A resync guard (`TERM_RESYNC_MS`) prevents the
  wall-clock catch-up loop from burst-spawning on resume or after a
  backgrounded tab. The monolithic draw split into `seedStream` /
  `spawnTermLines` / `renderTermLines` / `drawTermIdlePrompt` so the drain
  reuses the line renderer with a vertical offset.
- **Module header** themes comment updated to include `alpine` (was stale).

### v1.10.0 — Data Durability: Soft-Delete (Orphan Retention)

Opens the Data Durability phase. Stage 1 of a multi-stage track; backend +
schema + one frontend toast string. The first deferred *feature*-track item
(metadata/marker durability), prioritized because it's the only one whose
failure mode is permanent loss rather than a missing nicety.

The bug it fixes: media identity was the absolute path (`abs_path UNIQUE`), and
`markers` + `media_tags` both `ON DELETE CASCADE` off `media(id)`. The scanner
HARD-deleted any row whose file wasn't seen on a pass. So a single rename/move
of a file between scans silently destroyed that file's markers, tags, and
hand-entered metadata — and none of the existing mount-down guards tripped,
because a healthy library that walks files normally looks exactly like one
where a file was renamed. Export/import existed as disaster recovery, but it's
manual and matches on `rel_path`/`filename`, so it couldn't even repair a
rename after the fact.

- **Migration 004 — `present` / `missing_since` columns.** `present INTEGER NOT
  NULL DEFAULT 1` (existing rows backfill to present), `missing_since TEXT`
  (set once on first disappearance, cleared on return). Partial index on the
  rare `present = 0` rows for the maintenance/purge view.
- **Scanner — mark-missing instead of delete.** The stale step is now
  `UPDATE … SET present = 0` instead of `DELETE`. The cascade never fires;
  markers/tags/metadata are retained. The per-library mount-down guards (walk
  error / zero-files-with-existing-rows / scan error) still gate it, now to
  avoid hiding a whole library on a transient failure.
- **Scanner — same-path reactivation.** A missing file seen again at the same
  `abs_path` flips back to `present = 1`, `missing_since = NULL` via the
  upsert's `ON CONFLICT` clause. Transient unmounts and vanished-mid-walk files
  self-heal on the next clean scan. Scan now reports `totalMissing` /
  `totalReactivated` (replacing `totalDeletes`, which is no longer possible
  from a scan).
- **Read-path filtering.** `/api/library` browse/search/count filter
  `present = 1` by default; a new `missing` query param (`only` / `include`)
  exposes orphans for the maintenance view. `/stream/:id` returns **410 Gone**
  for a missing file. `/api/tags` and `/api/artists` counts exclude missing
  rows so badges match what browsing shows. Media detail now carries
  `present` / `missingSince`.
- **FTS note.** `present` is a non-indexed column, so flipping it fires no
  trigger — a missing row STAYS in the FTS index and is hidden from search by
  the query's `present = 1` predicate, not by index mutation. A purge fires the
  delete trigger and removes it normally. The index always mirrors non-purged
  rows.
- **Purge endpoint (backend only this release).** `GET /api/scan/missing`
  returns the orphan count; `POST /api/scan/purge-missing` hard-deletes
  `present = 0` rows (the one deliberate, user-initiated cascade), gated against
  a concurrent scan. The two-click confirm UI lands with the Settings menu
  (next).
- **Tests.** New `app/test/soft-delete.test.js` — DB-backed (real migrations
  001–004 in-memory, skips without better-sqlite3) — locks retention, purge
  cascade, reactivation, idempotent mark-missing, and the FTS retain/filter
  behavior.

Interim gap (by design): a rename leaves a retained orphan (old path, all data,
marked missing) plus a fresh empty row (new path). No data is lost, but
reconciling them is manual until Stage 2. See Planned.

**Settings surface + Purge UI + Full Metadata Scan (same 1.10.0).** The
frontend the Stage 1 backend was waiting on, plus one small scanner flag:

- **Settings overlay.** A first in-app server-settings surface, opened by a gear
  affordance beside the header Scan button (reuses the existing `.overlay`
  pattern). Deliberately minimal — a single "Maintenance" section for now,
  framed to grow (page-level theme/visualizer/light dials are the obvious next
  tenants). Closes on backdrop, ✕, or Escape; reopening resets transient state.
- **Purge Missing — two-click confirm.** First click reads the LIVE count from
  `GET /api/scan/missing` and arms the button (`Confirm: delete N items`, solid
  red); second click calls `POST /api/scan/purge-missing`, toasts the purged
  count, and refreshes sidebar + grid. Zero-count first click no-ops with a
  toast. Lives in the Settings panel, NOT beside Scan — the adjacency to a
  frequent, harmless action is exactly what invites an accidental irreversible
  click. No new backend; both endpoints shipped with Stage 1.
- **View missing.** A toggle in the purge row lists the orphan rows
  (`GET /api/library?missing=only`, capped at 200), showing each item's title,
  artist/library, and marker count — a sanity check on what an irreversible
  purge will take before arming it.
- **Full Metadata Scan.** The non-destructive replacement for the removed
  "delete the row and re-scan to refresh tags" footgun. Implemented as a
  `forceTagReread` option on the existing scanner (`POST /api/scan` with body
  `{ fullMetadata: true }`), NOT a second scan engine: it runs the normal walk
  + present/missing reconciliation, but (a) flips the `!existingMedia` tag-read
  gate so `music-metadata` runs for existing audio files too, and (b) routes
  those rows through `upsertMediaForceMeta`, whose ON CONFLICT clause refreshes
  the metadata columns. Scan response gains `totalMetaUpdated`.
  - **COALESCE refresh, not blind overwrite (deviation from the handoff's
    "updates the metadata columns").** Each refreshed column is
    `COALESCE(@meta_x, x)` — the embedded value wins ONLY when the file actually
    carries that tag; an absent or unreadable tag leaves the existing (possibly
    hand-edited) value alone instead of nulling it or stamping a filename guess.
    `description`, markers, and tag links are never touched — they aren't
    embedded-tag-derived. Net: where a file HAS a tag it overwrites your edit
    (that's the point of "refresh from tags"), but it can't silently erase data
    a missing tag would otherwise blank.
  - **Cost note (carry-forward).** This is the one operation that pays the real
    CIFS read cost the normal scan avoids — it reads every existing audio file's
    header. Trivial at current scale, but it's why it's a deliberate maintenance
    button, never on the hot scan path.
- **Tests.** New `app/test/full-metadata.test.js` — DB-backed (same skip-clean
  pattern as soft-delete) — locks the COALESCE contract: present tags overwrite,
  absent tags preserve, per-field mixing, description/markers/tags survive, and
  missing-row reactivation through the force upsert.

---

### v1.11.0 — Back-to-Back (b2b) Set Parsing

Filename-grammar decision (the b2b gate): adopt the **simple** grammar —
`Artist - Event (YYYY).ext` and `A1 b2b A2 [b2b A3 …] - Event (YYYY).ext`. The
Plex-rich `[1080p - x264 …]` encoding block is explicitly out of scope (it was
only ever a discussion example).

- **Parser (`services/metadata.js`).** `parseFilename` now splits a `b2b` artist
  chunk into individual artists. Return shape expanded from
  `{ artist, title, year }` to `{ artist, artists, isB2B, title, year }`:
  - `artists` — array of individual artists (length 1 for solo, `[]` for no
    artist). `isB2B` — true only when more than one b2b participant is present.
  - `artist` — the DISPLAY string. b2b participants are re-joined with the
    `b2bJoin` option (default `" b2b "`, i.e. preserved verbatim — domain-correct
    and lossless). The scanner passes `config.b2bDisplayJoin`.
  - The `b2b` delimiter is whitespace-bounded and case-insensitive
    (`/\s+b2b\s+/i`), so it won't fire on a substring inside an artist name.
    Split operates on the post-dash artist chunk only (matches the stated
    grammar); a dash-less `A b2b B.mp4` is treated as a title, not split.
  - **Group/act alias.** A trailing `[Name]` on the artist chunk (e.g.
    `Crankdat b2b Wooli [WANKDAT]`, `Eptic b2b Space Laces b2b SVDDEN DEATH
    [MASTERHVND]`) is extracted as a new `alias` field — the collective name for
    the set of artists — and stripped from the artist chunk BEFORE the b2b split,
    so it never glues onto the last artist or leaks into the display. Anchored to
    the end of the artist chunk (before the first ` - `), so a `[...]` in the
    event/title portion stays literal title text. Return shape is now
    `{ artist, artists, alias, isB2B, title, year }`.
- **Scanner (`services/scanner.js`).** When `b2bTagging` is enabled (default) and
  a file is a b2b set, each individual artist becomes a tag and a literal `b2b`
  tag is added — via the same idempotent `applyTag` path as directory/keyword
  auto-tagging, so a **normal scan backfills** b2b tags onto already-imported
  files (no Full Metadata Scan needed). Only b2b participants are tagged, not
  every solo artist, to keep the tag list bounded. Tag emission is
  filename-derived, independent of any embedded artist tag that wins the column.
  A parsed `[alias]` is applied as a tag too (same `b2bTagging` gate), so a
  named act / pairing alias becomes a one-click facet across all its sets.
- **Config.** New `b2bTagging` (bool, default `true`) and `b2bDisplayJoin`
  (string, default `" b2b "`). Documented in README.
- **Discovery model.** "All sets by artist X" (solo + b2b) is served by the
  existing search box — `q` already matches the FTS-indexed `artist` column
  *and* tag names, so a piped/joined display string still tokenizes each
  participant. The `b2b` tag is a one-click filter for all back-to-back sets.
- **Known limitation (deferred).** The artist sidebar *facet* is exact-match on
  the `artist` column, so a b2b set does not appear under a solo participant's
  facet, and a participant tag shows only that artist's b2b sets. Search bridges
  both. The clean unification (a `media_artists` join table feeding both facet
  and filter) is a separate normalization session, deferred until the
  fragmentation is an actual annoyance.
- **Tests.** `app/test/metadata.test.js` extended with b2b cases (two/three
  artists, custom join, case-insensitivity, substring non-trigger, solo,
  dash-less) and alias cases (duo/trio alias, title-position bracket left
  literal, solo alias). Existing `deepEqual` cases updated for the expanded
  return shape.

### v1.12.0 — Usability Polish: Search Clear + In-App Help

Frontend-only polish pass. No schema migration, no backend or scanner changes —
markup, client JS, CSS, and docs only.

- **Search clear button.** The header search box gains a clear (✕) affordance
  that appears only when the box has content. Clicking it wipes the query,
  reloads immediately (an explicit action, so it bypasses the 250 ms input
  debounce), and returns focus to the box. The inconsistent native WebKit search
  cancel button (`::-webkit-search-cancel-button`) is suppressed in favor of this
  custom control. Visibility is centralized in a `syncSearchClear()` helper so the
  existing `Esc`-to-clear path and the button stay in sync.
- **Header layout.** The header moves from a two-zone flex (`space-between`) to a
  three-column grid (`1fr · search · 1fr`) so the search box is pinned to the
  centre of the page regardless of left/right content widths. The right cluster
  is ordered `[Scan] [Help] [Settings]` — the destructive-adjacent Settings
  (which holds Purge) sits furthest from the primary Scan action. Below 640px the
  header reverts to a flex row with the search wrapping full-width underneath.
- **In-app Help overlay.** A static reference panel reachable from a header `?`
  icon or a footer link, built on the existing Settings-overlay pattern (same
  `.overlay` / `.settings-section` markup and the shared `[data-close]` handler —
  no new overlay machinery). Stacked sections are separated by an adjacent-sibling
  divider (`.settings-section + .settings-section`), which doesn't fire in the
  single-section Settings overlay. Three sections:
  - **Library shortcuts** — `/` to focus search, `Esc` to clear/close.
  - **Player shortcuts** — mirrors the player's `keydown` switch exactly,
    including `Shift+V` / `Shift+T` reverse-cycle for visualizer mode and theme.
  - **Filename conventions** — solo, b2b, and `[GROUP]` alias grammar, using the
    generic placeholders (`Artist1`, `GROUP`) per the docs convention, plus a note
    that search unifies solo + b2b discovery.
- **Docs.** README's Library Page section documents the clear button, the `/` and
  `Esc` library shortcuts, and the Help panel; the Player Page hotkey line is
  corrected to include the `Shift+V` / `Shift+T` reverse-cycle the code already
  implements (previously undocumented).
- **Housekeeping.** `app/package-lock.json` root self-version, which had drifted
  to 1.10.0 (the 1.11.0 bump missed it — b2b added no dependencies), is brought
  current to 1.12.0. No dependency versions changed.
- **Tests.** No new tests — the changes are DOM/CSS with no unit-testable logic in
  the zero-dependency harness. Suite unchanged at **52 pass / 0 fail / 21 skip**.

#### Carried-open verification (not a code gap)

- **Full Metadata Scan positive path** — the COALESCE refresh contract
  (`title = COALESCE(@meta_title, title)`, etc.) is already covered by
  `app/test/full-metadata.test.js`: overwrite-when-present, preserve-when-absent
  (does **not** blank an existing value when the embedded tag is null), per-field
  mixing, and missing-row reactivation. The only piece not exercisable in the dev
  container is the real-file `music-metadata` read; that remains a live spot-check
  on knope, not a code change.

### v1.13.1 — CSV Round-Trip Fix (Formula Guard) + Tidy-Ups

A post-1.13.0 code review caught one genuine correctness bug in the headline
import/export work, fixed here along with two doc/code tidy-ups. No schema
change, no new dependencies.

- **CSV formula-injection guard is now reversed on import (the bug).** `toCsv`
  prefixes a leading apostrophe to any field starting with `= + - @` (OWASP
  CSV-injection mitigation), applied via the shared escape path so it also
  touches the identity columns `filename`/`rel_path`. `parseCsv` never undid it,
  so an export→import cycle was **not lossless**:
  - *Silent match failure (the dangerous half):* a file named `-Foo` or under a
    folder starting with `@`/`-`/`=`/`+` exported its key as `'-Foo`/`'@…`; on
    re-import the literal apostrophe'd key failed to match the un-guarded DB
    value, so the row was **silently skipped** (counted in `skipped`, not
    `errors`). This is exactly the shape of name the Music library carries —
    contradicting the "markers round-trip is sound end to end" claim.
  - *Value corruption:* a label/title like `=ID= Drop` accreted an apostrophe
    each cycle, permanently becoming `'=ID= Drop`.

  Fixed at the root by stripping exactly one leading `'` when the next char is a
  formula trigger, inside `parseCsv` — the shared inverse of `toCsv`, so it
  covers both importers symmetrically. The export-side guard is unchanged
  (still neutralizes formula chars in spreadsheets). JSON imports bypass
  `parseCsv` and are unaffected. The only false positive is a value literally
  beginning `'=`/`'-`/`'+`/`'@` in the DB — never guarded on export anyway, and
  vanishingly rare for media metadata; the accepted tradeoff.
- **Tidy-ups.** Dropped the duplicate `POST /api/import/markers` row from the
  README API table; removed the redundant `records.length &&` from the markers
  importer's shape guard (`records.length` is already guaranteed non-zero by the
  preceding early return).
- **`toCsv` is now exported** so the regression test can drive the real
  export→import cycle rather than re-implementing it.
- **Tests.** `app/test/import-csv.test.js` gains four pure-function round-trip
  cases: an `@`/`-`-leading filename + `=`-leading label survive `toCsv→parseCsv`
  byte-identical; a formula-leading key matches its own DB value after import; an
  ordinary leading apostrophe (`'Til the drop`) is left untouched; and the
  export-side guard is confirmed still intact. Suite: **68 pass / 0 fail / 21
  skip** (was 64/0/21; +4 new).
- **Version.** `package.json` + both root entries of `package-lock.json` bumped
  to 1.13.1.

### v1.13.0 — Import/Export Consolidation + Markers Import UI

Closes the top-priority import-UX gap surfaced during the Mixtapes marker
migration: a markers CSV pasted into the only CSV-import UI silently no-op'd
through the *metadata* importer and reported success. The fix consolidates all
data operations into the Settings overlay, gives the (previously UI-less)
bulk markers importer a front end, and makes mis-routed CSVs fail loudly.

- **Settings overlay is now the home for all data operations.** Three sections —
  **Import** (Import Metadata CSV, Import Markers CSV), **Export** (Metadata
  CSV/JSON, Markers CSV), and the existing **Maintenance** (Full Metadata Scan,
  Purge Missing) — built on the existing `.settings-row` pattern. Maintenance
  stays visually last so the destructive `btn-danger` Purge isn't adjacent to a
  paste box. The footer is reduced to the version string; its scattered Help /
  Import CSV / Export links are gone (Help remains the header `?` icon).
- **Markers CSV import UI (new).** `POST /api/import/markers` finally has a front
  end: a paste overlay opened from Settings → Import. Because the endpoint is
  **replace-all per matched file** (it deletes a matched file's existing markers
  before inserting the CSV's rows), the import button uses a **two-click confirm**
  mirroring Purge Missing, and the copy spells out the destructive, can't-be-undone
  behaviour. Editing the textarea after arming re-requires confirmation.
- **Mis-paste guards (both directions).** The metadata importer (`POST /api/import`)
  now rejects a markers-shaped CSV (`start`/`end`/`label`, no metadata columns)
  with a 400 instead of matching rows and reporting a hollow success. The markers
  importer rejects a CSV lacking `start`/`label` — without this, a metadata CSV
  pasted there would delete every matched file's markers and insert nothing (a
  silent wipe). Both also reject **zero-parsed-records** input (a lone line with
  no header row — e.g. a stray search query pasted by accident — parses to no
  rows; previously this looped over nothing and toasted "Done"). All guards bail
  before touching the DB. Shape detection is factored into exported
  `hasMarkerColumns` / `hasMetadataColumns` helpers.
- **Loud client-side outcomes.** Both import overlays now toast `success` only
  when at least one item actually matched (and there were no errors); a
  matched:0 result or a 4xx rejection toasts `error` and surfaces the server
  message, so a no-op can no longer read as a win.
- **CSV parser rewrite (latent-bug fix).** `parseCsv` previously split on
  `\r?\n` *before* parsing quotes, so a quoted field containing a newline (a
  marker label pasted from a multi-line tracklist) mis-parsed. It's now a
  single-pass, quote-aware tokenizer that preserves embedded newlines and handles
  `""` escaping and LF/CRLF/lone-CR endings. Strictly a superset of prior
  behaviour; the dead `parseCSVLine` helper is removed.
- **Docs.** README's feature list, Import/Export prose, and API table document
  `/api/import/markers` and the Settings-overlay location; `docs/import-format.md`
  gains a full **Markers CSV Import (Bulk)** section and a corrected metadata-import
  UI pointer.
- **Version.** `package.json` + both root entries of `package-lock.json` bumped
  to 1.13.0. No dependency versions changed; no schema migration.
- **Tests.** New `app/test/import-csv.test.js` covers the tokenizer (embedded
  newline, quoted comma, escaped quote, CRLF, blank-line drop, header-only) and
  the shape detectors / guard logic against pure exported functions (no DB, no
  skips). Suite: **64 pass / 0 fail / 21 skip** (was 52/0/21; +12 new).

---

### v1.14.0 — Artist Normalization, Stage A (`media_artists` additive schema)

Stage A of the `media_artists` arc: a many-to-many `media ↔ artists` relation
that becomes the **relational** source of truth for artist membership.
**Additive and non-breaking** — no read path changes in this release.
`media.artist` is deliberately kept as the denormalized **display / full-text
search** projection (it is FTS-indexed, read on every card, the facet/sort
column, the inline-edit target, and for b2b sets holds the rebuilt display
string). Stage A only *populates* the new relation; Stage B repoints the artist
facet and `artist=` filter through it (next session).

- **Migration `005-media-artists.sql`** (additive). New `artists` table
  (`id`, `name`, `normalized UNIQUE`) and `media_artists` junction
  (`media_id`/`artist_id` composite PK, both `ON DELETE CASCADE`), plus
  `idx_media_artists_artist` for the reverse (artist → media) lookup Stage B's
  facet needs. The forward lookup is already covered by the composite PK prefix.
  Cascade is benign under soft-delete (004): media rows aren't hard-deleted on a
  normal scan, so links only clear on a deliberate purge-missing — which *should*
  drop them.
- **`normalized` is case-PRESERVING in Stage A** (`normalized = name`, not
  `lower(name)`). Folding casings here would silently merge `Rezz`/`REZZ` and
  change facet behaviour vs. today's exact-match column — that is Stage C's job
  (canonical/alias layer), not a free cleanup. Distinct casings therefore create
  distinct `artists` rows — *no worse than today's exact-match facet.*
- **Population precedence** (faithful projection of the existing display logic):
  b2b multiplicity always comes from the **filename** (`parsed.artists` — an
  embedded ID3/M4A tag collapses a set to a flat string and can't express it);
  a solo member is the **display artist** (the stored `media.artist`,
  i.e. embedded-tag-wins-else-filename). Alias (`[WANKDAT]`) stays a *tag* in
  Stage A; Stage C promotes it to a canonical label over the member set.
- **New module `services/artists.js`** (dependency-free, mirrors `metadata.js`).
  Holds the shared `deriveArtistNames` + the DB helpers so the artist logic is
  importable for unit tests **without** pulling in the scanner's
  `music-metadata`/`better-sqlite3` chain (which would break the suite's
  run-with-skips-even-without-`npm install` property). The scanner and the
  backfill both call `deriveArtistNames`, so they can never diverge.
- **Scanner dual-write** is **diff-and-replace, not accretive.** `syncArtistLinks`
  reads a row's current link set and rewrites only when it actually differs —
  zero writes on the common unchanged re-scan. A plain `INSERT OR IGNORE` would
  *accrete* stale members: on a normal re-scan embedded tags aren't re-read for
  known files, so the parsed filename artist differs from the embedded value that
  first won `media.artist`, and a second wrong link would stick. The member is
  derived from the **post-upsert stored `media.artist`** (consistent across
  new / normal / force-metadata paths and identical to what the backfill reads).
- **One-time backfill** (`backfillArtists`, DB-only — zero NAS I/O; re-parses the
  stored `filename` column). Runs once at startup on the deploy that ships 005,
  guarded on "`media_artists` empty while `media` non-empty," so it populates
  links immediately without forcing a scan and never fights the scanner on later
  boots. The whole pass is wrapped in one transaction.
- **Tests.** `app/test/media-artists.test.js`: 5 pure `deriveArtistNames` cases
  (run unconditionally) + 9 DB-backed cases under the standard better-sqlite3
  graceful-skip — migration applies / `schema_version` = 5; solo → 1; b2b → N
  with a shared artist row; **accretion regression** (changed display *replaces*,
  not accretes); distinct casings → distinct rows; idempotent no-op; purge
  cascade clears links; backfill populates + one-shot guard; backfill no-op on
  empty. Migration chain + logic also validated end-to-end via `node:sqlite`
  (better-sqlite3 can't build natively in-sandbox — documented pattern).
  Suite: **73 pass / 0 fail / 30 skip** (was 68/0/21; +5 pure, +9 DB-gated).
- **Version.** `package.json` + both root entries of `package-lock.json` bumped
  to 1.14.0. No dependency changes.

**Smoke-test gate before Stage B:** migration 005 applies on the real DB;
backfill populates `media_artists` (spot-check a b2b file → N member rows, a solo
file → 1); a normal scan refreshes links idempotently; **existing facet / search
/ cards visibly unchanged** (still read `media.artist`).

---

## Planned

### Data Durability (continued, post-1.10.0)

- **Stage 2 — content fingerprint + auto-relink.** Make rename/move transparent
  instead of "safe but manual." A stable, path-independent fingerprint (size +
  mtime + a partial head/tail hash — NOT a full-file hash, given CIFS cost) lets
  the next scan auto-merge a `present = 0` orphan whose file resurfaced at a new
  path, rather than leaving an orphan + an empty new row. Depends on 1.10.0's
  retention (there must be an orphan to relink to). Carries real design surface
  — fingerprint cost over CIFS, and collision/ambiguity handling when two
  missing files could match one new path — which is why it's split out of the
  safety fix.

### Visualizer polish (post-1.9.3)

Deferred from the v1.9.3 feedback-engine phase — quality passes to revisit
after the build ships and gets tested on real (and ideally slower) hardware.
Both are "it works and is liked as-is, but there's a clear next step":

- **Post-FPS-cap Matrix / Particles tuning.** The v1.9.3 60fps render cap
  normalized motion speed across refresh rates, but because these modes advance
  their per-frame physics once per rendered frame, their wall-clock motion is
  now slower than it was on a high-refresh display — Matrix Rain in particular
  reads more as a light drizzle than driving rain (the difference is most
  obvious with the pre-cap build open side by side). The fix is to retune the
  per-frame motion constants up to the intended feel at 60fps (Matrix fall
  speed; particle force/velocity/damping), NOT to remove the cap. The deeper
  fix — delta-time-independent physics so motion is decoupled from framerate
  entirely — is the larger refactor this defers, and it would touch the
  Particles/Nova code that's otherwise considered done.
- **Cascade centerpiece — spikier and more shape-y.** The current 7-facet
  convex crystal seed reads as a clean gem but is visually quiet against the
  reactive rosette arms. Target vibe: a faceted polyhedron that grows poly
  spikes on hits — the "Bit" from the original Tron, dialed back (the
  shape-plus-spike-on-peak behavior, not the literal character or its
  extremes). Implementation direction: reactive spike extrusion from the seed
  faces on bass/peak, layered over the existing rosette. The arms and overall
  motion are considered good; this is specifically the centerpiece.

### v1.9.X — Visualizer Pack (shipped as v1.9.3)

Shipped. The two feedback modes (Wormhole, Cascade), the eighth theme (Alpine),
the Trails modifier, the Track B control-band reorg, and the performance pass
all landed in v1.9.3. Roster is now ten modes: Bars, Lines, Radial, Spectro,
Particles, Nova, Matrix, Terminal, Wormhole, Cascade.

### Future — Feature Evaluation

Deferred features from the original project plan, evaluated for inclusion
based on real usage patterns:

- SPA-style media switching (in-page swap vs URL navigation — preserves
  AudioContext and visualizer state between tracks).
- Waveform seekbar (requires ffmpeg in container).
- Thumbnail generation (requires ffmpeg, increases Docker image size).
- Playback history / resume position (data model depends on user scope).
- Playlists (schema addition, auto-advance, queue management).
