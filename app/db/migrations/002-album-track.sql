-- ============================================================
-- Migration 002: Album + track number, FTS5 rebuild with album
-- ============================================================

-- New metadata columns for audio files (nullable — only populated when
-- embedded tags exist or user sets them manually).
ALTER TABLE media ADD COLUMN album TEXT;
ALTER TABLE media ADD COLUMN track_number INTEGER;

-- Index for album (sort, filter, future sidebar section)
CREATE INDEX idx_media_album ON media(album);

-- Rebuild FTS5 virtual table to include album.
-- Content-synced FTS5 tables can't have columns added — drop and recreate.
DROP TABLE IF EXISTS media_fts;

CREATE VIRTUAL TABLE media_fts USING fts5(
    filename, title, artist, album, description,
    content='media', content_rowid='id'
);

-- Populate the new FTS index from existing data
INSERT INTO media_fts(media_fts) VALUES('rebuild');

INSERT INTO schema_version (version, description)
VALUES (2, 'Album and track_number columns, FTS5 rebuild with album');
