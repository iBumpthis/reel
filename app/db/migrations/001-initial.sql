-- ============================================================
-- Migration 001: Initial schema
-- ============================================================
-- NOTE: schema_version table is created by the migration runner bootstrap,
-- not here. This migration only inserts its version record at the end.

CREATE TABLE libraries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
    abs_path TEXT NOT NULL UNIQUE,
    rel_path TEXT NOT NULL,
    filename TEXT NOT NULL,
    ext TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('audio', 'video')),
    size_bytes INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    -- User-editable metadata (nullable = not yet set, falls back to filename parse)
    title TEXT,
    artist TEXT,
    year INTEGER,
    description TEXT NOT NULL DEFAULT '',
    -- Scan tracking
    last_seen_scan INTEGER NOT NULL DEFAULT 0,
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_media_library ON media(library_id);
CREATE INDEX idx_media_ext ON media(ext);
CREATE INDEX idx_media_type ON media(media_type);
CREATE INDEX idx_media_title ON media(title);
CREATE INDEX idx_media_artist ON media(artist);
CREATE INDEX idx_media_mtime ON media(mtime_ms);
CREATE INDEX idx_media_scan ON media(last_seen_scan);

-- Full-text search on filename + title + artist + description
CREATE VIRTUAL TABLE media_fts USING fts5(
    filename, title, artist, description,
    content='media', content_rowid='id'
);

CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    normalized TEXT NOT NULL UNIQUE
);

CREATE TABLE media_tags (
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (media_id, tag_id)
);

CREATE INDEX idx_media_tags_tag ON media_tags(tag_id);

CREATE TABLE markers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    media_id INTEGER NOT NULL REFERENCES media(id) ON DELETE CASCADE,
    start_seconds REAL NOT NULL,
    end_seconds REAL,
    label TEXT NOT NULL,
    raw_line TEXT,
    was_adjusted INTEGER NOT NULL DEFAULT 0,
    adjust_reason TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_markers_media ON markers(media_id);
CREATE INDEX idx_markers_time ON markers(media_id, start_seconds);

INSERT INTO schema_version (version, description)
VALUES (1, 'Initial schema');
