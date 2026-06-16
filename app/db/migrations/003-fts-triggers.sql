-- ============================================================
-- Migration 003: FTS5 trigger-based incremental sync
-- ============================================================
-- Replaces full-rebuild-on-every-write (INSERT INTO media_fts VALUES('rebuild'))
-- with targeted AFTER INSERT / DELETE / UPDATE triggers on the media table.
--
-- media_fts is an external-content FTS5 table (content='media',
-- content_rowid='id') over: filename, title, artist, album, description.
--
-- The AFTER UPDATE trigger is WHEN-gated so it only fires when an
-- FTS-indexed column actually changes. IS NOT is null-safe, so the nullable
-- title/artist/album columns are handled correctly. A scanner re-scan that
-- only re-sets size_bytes/mtime_ms/last_seen_scan (and filename to the same
-- value, since filename is derived from the unchanged abs_path conflict key)
-- changes no indexed text, so the trigger does not fire — no FTS churn.

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
-- (The 'rebuild' command operates on media_fts directly; it does not issue
-- DML on the media table, so it does not fire the triggers created above.)
INSERT INTO media_fts(media_fts) VALUES('rebuild');

INSERT INTO schema_version (version, description)
VALUES (3, 'FTS5 trigger-based incremental sync');
