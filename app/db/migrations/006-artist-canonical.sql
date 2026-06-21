-- ============================================================
-- Migration 006: artist canonical layer (casing fold + alias-as-act)
-- ============================================================
-- ADDITIVE ONLY. Three columns on `artists`; no row deletion, no change to
-- `normalized` (which stays CASE-PRESERVING — see 005's header). This is the
-- "canonical mapping layer" 005 anticipated: it GROUPS case-variant rows for
-- browse without merging or renaming them, so per-file display fidelity is
-- preserved (a file named "REZZ - …" still shows REZZ on its card) while the
-- facet/filter group it under one canonical "Rezz".
--
--   media.artist      = per-file DISPLAY / FTS / sort (unchanged, untouched).
--   artists.normalized= case-preserving identity key (unchanged; Rezz ≠ REZZ
--                       remain distinct ROWS).
--   artists.canonical_id = the NEW grouping. NULL ⇒ this row is its own
--                       canonical. A variant row points at its canonical row.
--
-- DO NOT flip normalized to lower(); the canonical layer is what replaces that
-- idea (005's header explicitly warned against folding normalized in isolation).
--
-- v1.16.0 (C1) uses canonical_id + canonical_source for the casing fold. `kind`
-- ships now (additive, defaulted) but is exercised by C2 (v1.16.1), which
-- promotes a [ALIAS] act to a first-class browsable entity (kind='act'); acts
-- are their own canonical and are NOT case-folded into artists. Shipping the
-- column now keeps C2 a code-only change with no further migration.

-- Canonical grouping for casing/variant fold. Self-referential; NULL = own
-- canonical. Indexed for the facet GROUP BY / filter EXISTS that resolve through
-- COALESCE(canonical_id, id).
ALTER TABLE artists ADD COLUMN canonical_id INTEGER REFERENCES artists(id);

-- 'artist' (default) | 'act' (a promoted [ALIAS] collective, C2).
ALTER TABLE artists ADD COLUMN kind TEXT NOT NULL DEFAULT 'artist';

-- Provenance for the canonical assignment, so a future MANUAL pin is additive
-- and the auto-fold won't clobber it. NULL = unprocessed; 'auto' = assigned by
-- the fold pass / scan seam; 'manual' = hand-pinned (reserved, not yet written).
ALTER TABLE artists ADD COLUMN canonical_source TEXT;

CREATE INDEX idx_artists_canonical ON artists(canonical_id);

INSERT INTO schema_version (version, description)
VALUES (6, 'artist canonical layer: casing fold (C1) + kind column for alias-as-act (C2); additive, media.artist unchanged');
