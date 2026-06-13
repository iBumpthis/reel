# Import Formats

Reel supports two import mechanisms: **CSV/JSON metadata import** for bulk
updates to media metadata, and **marker text import** for tracklist/chapter
markers on individual media items.

## CSV Metadata Import

**Endpoint:** `POST /api/import`
**UI:** Library page → Import button → paste CSV text

### Format

Standard CSV with a header row. Fields are matched by header name, not position.

```csv
filename,title,artist,year,description,tags
"Virtual Riot - Throwback Mix.mp4",Throwback Mix,Virtual Riot,2024,Live set from EDC,"electronic, dubstep, live"
"podcast-episode-42.mp3",Episode 42 - Guest Interview,The Podcast,2025,,podcast
```

### Matching

Records are matched to existing media in the database. Matching is tried in
order:

1. **`rel_path`** — relative path within the library (e.g. `subfolder/file.mp4`).
   Most precise match. Use this when filenames aren't unique across libraries.
2. **`filename`** — just the filename with extension. Used when `rel_path` is
   absent or doesn't match.

Unmatched records are silently skipped (reported in the `skipped` count).
Media must already exist in the database from a prior scan — import does not
create new media records.

### Updatable Fields

| Field | Type | Notes |
|-------|------|-------|
| `title` | string | Display title. Empty/missing preserves existing value. |
| `artist` | string | Artist name. Empty/missing preserves existing value. |
| `year` | integer | Release year. Must be numeric. Empty/missing preserves existing value. |
| `description` | string | Free-text description. Empty/missing preserves existing value. |
| `tags` | string | Comma-separated tag names. Replaces all tags for the matched item. Empty/missing leaves existing tags unchanged. |

Empty CSV cells preserve existing values — they don't clear them. To clear a
field, use the inline editor in the UI or the `PATCH /api/media/:id` endpoint
with an explicit `null`.

### JSON Alternative

The same endpoint accepts a JSON array instead of CSV:

```json
[
  {
    "filename": "Virtual Riot - Throwback Mix.mp4",
    "title": "Throwback Mix",
    "artist": "Virtual Riot",
    "year": 2024,
    "tags": ["electronic", "dubstep", "live"]
  }
]
```

Or wrapped: `{ "csv": "filename,title,...\n..." }`

### Round-Trip with Export

`GET /api/export?format=csv` produces a CSV with all the fields above plus
read-only metadata (id, ext, media_type, size_bytes, etc.). You can export,
edit the CSV in a spreadsheet, and re-import. Read-only fields are ignored on
import; only the updatable fields listed above are applied.

```bash
# Export
curl -s http://localhost:32410/api/export?format=csv > library.csv

# Edit library.csv...

# Re-import
curl -X POST http://localhost:32410/api/import \
  -H "Content-Type: application/json" \
  -d "{\"csv\": $(jq -Rs . < library.csv)}"
```

### Response

```json
{
  "matched": 12,
  "skipped": 3,
  "errors": [
    { "line": 7, "error": "SQLITE_CONSTRAINT: NOT NULL constraint failed" }
  ]
}
```

## Marker Text Import

**Endpoint:** `POST /api/media/:id/markers` with `{ "markerText": "..." }`
**UI:** Player page → Import Markers button → paste tracklist text

### Supported Formats

Markers are parsed one per line. Blank lines are skipped. All common tracklist
formats are recognized:

**Time-first (most common):**
```
0:00 Track Title
3:45 Another Track
1:02:30 Deep Cut
```

**Time-first with separator:**
```
0:00 - Track Title
3:45 - Another Track
```

**Time-last:**
```
Track Title 0:00
Another Track 3:45
```

**Range with brackets or parentheses:**
```
Track Title [0:00-3:45]
Another Track (3:45-7:20)
[0:00-3:45] Track Title
```

**Bare range (no brackets):**
```
0:00-3:45 Track Title
Track Title 0:00-3:45
```

**Mixed formats in one block** are supported — each line is parsed independently.

### Time Formats

- `M:SS` — e.g. `3:45` (3 minutes 45 seconds)
- `MM:SS` — e.g. `03:45`
- `H:MM:SS` — e.g. `1:02:30` (1 hour 2 minutes 30 seconds)
- `HH:MM:SS` — e.g. `01:02:30`

### Semantics

- **Replace-all:** Importing markers replaces all existing markers for the
  media item. There is no append/merge mode.
- **Overlap repair:** When range markers overlap (previous marker's end extends
  past the next marker's start), the previous marker's end is truncated to the
  next marker's start. The new marker's start timestamp is preserved — it
  represents the actual transition point (critical for DJ mixes where the next
  track layers in at that timestamp).
- **Sorting:** Markers are sorted by start time regardless of input order.
  Original line order is used as a tiebreaker for markers at the same timestamp.
- **Unparseable lines** are skipped and reported in `importErrors`.

### Marker Text Export

**Endpoint:** `GET /api/media/:id/markers/export`

Returns the current markers as plain text in time-first format, suitable for
re-import:

```
0:00 Track One
3:45 Track Two
7:20 Track Three
```

Range markers include the end time:

```
0:00-3:45 Track One
3:45-7:20 Track Two
```

### JSON Alternative

For programmatic access, markers can also be set via JSON array:

```json
{
  "markers": [
    { "startSeconds": 0, "label": "Track One" },
    { "startSeconds": 225, "endSeconds": 440, "label": "Track Two" },
    { "startSeconds": 440, "label": "Track Three" }
  ]
}
```

### Response

```json
{
  "ok": true,
  "importErrors": [
    { "line": 4, "text": "this line couldn't be parsed" }
  ],
  "saved": { "markerCount": 12 }
}
```
