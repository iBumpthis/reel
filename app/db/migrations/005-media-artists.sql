-- ============================================================
-- Migration 005: media_artists (many-to-many artist normalization)
-- ============================================================
-- ADDITIVE ONLY. Introduces a relational artist model alongside the existing
-- denormalized media.artist text column. media.artist is DELIBERATELY KEPT:
-- it is FTS-indexed (migration 001 indexes filename/title/artist/description),
-- read on every card, the artist=/sort facet column today, the inline-edit
-- target, and for b2b sets it holds the rebuilt display string ("A b2b B").
-- Dropping it would be a breaking read-path + FTS change. So:
--   media_artists = the RELATIONAL source of truth (membership).
--   media.artist  = the DISPLAY / FULL-TEXT-SEARCH projection (cache).
--
-- This migration changes NO read path. Stage A only WRITES these tables
-- (scanner dual-write + one-time backfill); the facet/filter reads are
-- repointed in Stage B. Nothing reads media_artists until then, so applying
-- 005 cannot alter any existing behaviour.
--
-- Shape mirrors tags/media_tags (migration 001) intentionally.
--
-- CASING — IMPORTANT, READ BEFORE "FIXING" `normalized`:
-- `normalized` is CASE-PRESERVING in Stage A (it equals the member name as
-- stored). It is the UNIQUE dedup/lookup key, NOT a case-folded key. This is
-- a deliberate choice, not an oversight, and it differs from tags.normalized
-- (which IS lower()):
--   * The artist facet/filter is CASE-SENSITIVE today (GROUP BY / `=` on the
--     media.artist text column). Folding here would make Stage B's facet
--     silently merge "Rezz"/"REZZ" — a behaviour change beyond the intended
--     b2b de-fragmentation. media_artists must be a FAITHFUL projection of the
--     existing display logic, so distinct casings stay distinct ROWS for now.
--   * Deliberate casing/canonical merge (REZZ -> Rezz, without renaming files)
--     is the explicit job of Stage C, which layers a canonical mapping on top
--     of these tables. Keeping `name` (display) and `normalized` (lookup key)
--     as separate columns now makes that an ADDITIVE Stage C change.
-- If early case-folding is ever wanted, it is a one-line change to the derive
-- helper in services/scanner.js plus a backfill re-run (DB-only) — NOT a schema
-- change. Do not flip this column to lower() in isolation.

CREATE TABLE artists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalized TEXT NOT NULL UNIQUE   -- case-preserving identity key; see header
);

CREATE TABLE media_artists (
    media_id  INTEGER NOT NULL REFERENCES media(id)   ON DELETE CASCADE,
    artist_id INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
    PRIMARY KEY (media_id, artist_id)
);

-- media_id is the PK prefix (already indexed for the per-row link lookups the
-- scanner does); artist_id needs its own index for the Stage B facet counts
-- (GROUP BY artist_id / membership EXISTS).
CREATE INDEX idx_media_artists_artist ON media_artists(artist_id);

-- ON DELETE CASCADE note: with soft-delete (004) media rows are never hard-
-- deleted on a normal scan, so this cascade never fires on a disappearance. It
-- fires only on a deliberate purge-missing, which SHOULD clear the artist links
-- too (same intent as the existing markers/media_tags cascade).

INSERT INTO schema_version (version, description)
VALUES (5, 'media_artists: many-to-many artist normalization (additive; media.artist kept as display/FTS cache)');
