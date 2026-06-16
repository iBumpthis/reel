# FTS5 Trigger-Sync Evaluation

**Status:** IMPLEMENTED in v1.8.1 (migration 003 + removal of the three manual
`rebuild` call sites + `app/test/fts-triggers.test.js`). This document is
retained as the design rationale and validation record.
**Date:** June 2026 (evaluation) / implemented v1.8.1

---

## Problem

`media_fts` is an external-content FTS5 table (`content='media'`,
`content_rowid='id'`) indexing `filename, title, artist, album, description`.
It has **no triggers** — every sync is a manual full reindex:

```sql
INSERT INTO media_fts(media_fts) VALUES('rebuild');
```

`rebuild` re-reads and re-indexes the **entire** `media` table. It runs at
three places on every write:

| Call site | Frequency |
|-----------|-----------|
| `services/scanner.js` (`rebuildFts`) | once per scan |
| `routes/media.js` (PATCH handler) | every metadata edit |
| `routes/import-export.js` (POST /api/import) | once per import (gated on `matched > 0`) |

Plus the one-time backfill in `migrations/002` (correct — leave it).

At Reel's current scale (~3K items) a rebuild is sub-20 ms and imperceptible.
The cost is **O(n) per edit**, so it scales linearly with library size — and
Reel exists partly to prototype patterns for a much larger media server. This
is the one piece of debt that's load-bearing for that stated direction.

## Why it was deferred, and why the blocker is now solved

The handoff noted: *"trigger-based sync deferred — scanner's `ON CONFLICT`
includes `filename` in SET, causing false trigger fires."*

The scanner upsert's `ON CONFLICT` clause re-sets `filename, rel_path,
size_bytes, mtime_ms, last_seen_scan` for every existing file on every scan.
Because `filename` is an FTS-indexed column, a naive `AFTER UPDATE` trigger
would fire for every file on every scan — redundant FTS churn even when the
indexed text didn't change.

The fix is a **`WHEN` guard** that only fires when an FTS-relevant column
actually changes. `IS NOT` is null-safe, so it handles the nullable
`title/artist/album` columns correctly:

```sql
AFTER UPDATE ON media
WHEN old.filename    IS NOT new.filename
  OR old.title       IS NOT new.title
  OR old.artist      IS NOT new.artist
  OR old.album       IS NOT new.album
  OR old.description IS NOT new.description
```

A re-scan that only touches `size_bytes/mtime_ms/last_seen_scan` (and re-sets
`filename` to the same value) changes no indexed text, so the guard evaluates
false and the trigger does not fire.

## Empirical validation

Validated against the exact 001+002 schema using SQLite's FTS5 (via Node's
`node:sqlite`). All checks pass:

**Correctness (trigger-synced):**
- insert → searchable; `daft*` matches both rows, `around*` matches one
- retitle via UPDATE → old term (`around`) gone, new term (`harder`) found
- DELETE → row removed from index (`voyager` → 0, `daft` → 1)
- FTS `integrity-check` command passes

**`WHEN`-gate (the deferred blocker):**
- scanner-style no-op update (same `filename`, new size/mtime/scan):
  **0 FTS shadow-table writes** — trigger correctly suppressed
- real rename (`filename` changes): trigger fires, `renamed*` searchable

**Cost of one metadata edit at 50,000 rows:**

| Approach | Time |
|----------|------|
| manual full `rebuild` | ~130 ms |
| triggered targeted resync | ~0.1 ms |
| **speedup** | **~1200×** |

The trigger approach is strictly better on **both** hot paths:
- **Edit/import:** O(1) per changed row instead of O(n) full reindex.
- **Scan:** only new/renamed/edited files touch FTS, instead of a full
  reindex every scan regardless of what changed.

## Proposed migration 003

Purely additive — three triggers plus a one-time baseline rebuild. No column
or data changes. Fully reversible (`DROP TRIGGER`). All referenced columns
exist after migration 002.

```sql
-- ============================================================
-- Migration 003: FTS5 trigger-based incremental sync
-- ============================================================
-- Replaces full-rebuild-on-every-write with targeted triggers.
-- The AFTER UPDATE trigger is WHEN-gated so scanner re-scans that only
-- touch size/mtime/last_seen_scan do not churn the FTS index.

CREATE TRIGGER media_fts_ai AFTER INSERT ON media BEGIN
  INSERT INTO media_fts(rowid, filename, title, artist, album, description)
  VALUES (new.id, new.filename, new.title, new.artist, new.album, new.description);
END;

CREATE TRIGGER media_fts_ad AFTER DELETE ON media BEGIN
  INSERT INTO media_fts(media_fts, rowid, filename, title, artist, album, description)
  VALUES ('delete', old.id, old.filename, old.title, old.artist, old.album, old.description);
END;

CREATE TRIGGER media_fts_au AFTER UPDATE ON media
WHEN old.filename    IS NOT new.filename
  OR old.title       IS NOT new.title
  OR old.artist      IS NOT new.artist
  OR old.album       IS NOT new.album
  OR old.description IS NOT new.description
BEGIN
  INSERT INTO media_fts(media_fts, rowid, filename, title, artist, album, description)
  VALUES ('delete', old.id, old.filename, old.title, old.artist, old.album, old.description);
  INSERT INTO media_fts(rowid, filename, title, artist, album, description)
  VALUES (new.id, new.filename, new.title, new.artist, new.album, new.description);
END;

-- One-time baseline so the index is known-good before triggers take over.
INSERT INTO media_fts(media_fts) VALUES('rebuild');

INSERT INTO schema_version (version, description)
VALUES (3, 'FTS5 trigger-based incremental sync');
```

## Code changes that go with it

Once triggers own the sync, the manual `rebuild` calls become dead weight and
should be removed (leaving them is harmless but does the O(n) work the
triggers exist to avoid):

- `services/scanner.js` — remove the `rebuildFts(db)` call and the
  `rebuildFts` helper.
- `routes/media.js` — drop `rebuildFts` from the PATCH transaction (the
  `UPDATE media` statement now fires the trigger). The transaction wrapper
  can stay or go; with a single UPDATE it's no longer doing double duty.
- `routes/import-export.js` — remove the `rebuildFts.run()` after the import
  loop (each `UPDATE media` fires the trigger inside the existing
  transaction).
- `migrations/002` — **unchanged.** Its one-time rebuild is historical.

Tags are unaffected: they were never in the FTS table (the library search
matches tags via a separate `LIKE` branch on `tags.normalized`), so tag edits
never triggered a rebuild and still don't.

## Risk assessment

- **Risk class:** schema migration touching the search-sync path. Low, but
  non-zero — it changes how the search index stays current.
- **Reversibility:** `DROP TRIGGER media_fts_ai/ad/au` + restore the manual
  rebuild calls. The data is untouched.
- **Blast radius if wrong:** stale or missing search results (not data loss —
  FTS is derived). A `rebuild` re-syncs at any time.
- **Regression net:** the v1.8 test harness covers the pure parsers; a
  DB-level test of the triggers (insert/update/delete/no-op) should run in the
  real `better-sqlite3` environment as part of this change, mirroring the
  `node:sqlite` checks above.

## Recommendation

Ship as **v1.8.1**, separate from the v1.8 stability deploy. Rationale:
v1.8 is already a coherent reviewed unit; isolating the FTS migration keeps
its deploy (and any rollback) unambiguous, and means any post-deploy search
oddity points straight at this change. There is no current performance pain
forcing it, so the only reason to do it now rather than at 2.0 is that the
blocker is solved, the design is validated, and it removes a call-site that
otherwise keeps getting copied. If 2.0 is close, folding it into that
groundwork is equally defensible.

## 2.0 groundwork note

Two scaling axes surfaced during the v1.8 review, both relevant to a
larger-scale rewrite:

1. **FTS sync (this doc):** O(n)-per-edit → O(1)-per-edit via triggers.
2. **Stream path / CIFS:** every seek issues a fresh Range request, and each
   request does a `stat()` + open + read against the NAS over CIFS. Under
   concurrent users this is a real cost axis — worth designing around (larger
   or reused read handles, a thin local cache, or pre-warmed metadata) rather
   than per-request `stat` + open on a network mount.
