-- ============================================================
-- Migration 004: Soft-delete (orphan retention)
-- ============================================================
-- Durability fix. Previously the scanner HARD-deleted media rows whose
-- files were no longer seen on a pass (DELETE FROM media WHERE
-- last_seen_scan < scanId). Because markers and media_tags both declare
-- ON DELETE CASCADE off media(id) — and the user-editable metadata columns
-- (title/artist/year/album/track_number/description) live ON the media row
-- — a single rename/move between scans silently destroyed all hand-authored
-- data for that file. The scanner's mount-down guards never tripped: a
-- healthy library that walks >0 files with 0 walkErrors deletes stale rows
-- normally, and a rename looks exactly like that.
--
-- This migration introduces a presence flag. The scanner now MARKS stale
-- rows missing (present = 0) instead of deleting them. The cascade never
-- fires; markers/tags/metadata are retained. A missing file that reappears
-- at the SAME abs_path auto-reactivates (handled in the scanner upsert's
-- ON CONFLICT clause). Actual deletion is a deliberate, user-initiated
-- "purge missing" action only — never automatic.
--
-- FTS note: media_fts is external-content over filename/title/artist/album/
-- description. `present` is NOT indexed and is NOT in the media_fts_au
-- WHEN-gate (migration 003), so flipping it fires no FTS churn. Missing rows
-- therefore REMAIN in the FTS index; search visibility is controlled purely
-- by a `present = 1` predicate in the library query, not by index mutation.
-- A purge (hard DELETE) fires media_fts_ad and removes the row from FTS as
-- normal. The index thus always mirrors the set of non-purged rows.

-- present: 1 = file seen on its most recent scan; 0 = stale/missing, retained.
-- NOT NULL DEFAULT 1 with a constant default backfills every existing row to
-- present on apply (SQLite permits NOT NULL ADD COLUMN with a constant default).
ALTER TABLE media ADD COLUMN present INTEGER NOT NULL DEFAULT 1;

-- missing_since: ISO timestamp of the scan that first marked the row missing.
-- NULL while present. Set once (COALESCE) so it records the first disappearance,
-- not the latest scan. Cleared on reactivation.
ALTER TABLE media ADD COLUMN missing_since TEXT;

-- Partial index over only the (expected-rare) missing rows. The maintenance /
-- purge path queries "show me the orphans"; present rows are the overwhelming
-- majority and are already served by the existing library_id/type/sort indexes,
-- so a full index on `present` would be mostly dead weight.
CREATE INDEX idx_media_missing ON media(present) WHERE present = 0;

INSERT INTO schema_version (version, description)
VALUES (4, 'Soft-delete: present/missing_since columns for orphan retention');
