/**
 * Tests for the CSV import boundary: the quote-aware parser (notably its
 * handling of quoted fields with embedded newlines, which the previous
 * line-split parser mangled) and the column-shape detectors that route a CSV
 * to the correct importer.
 *
 * These exercise pure exported functions from the route module — no DB, no
 * better-sqlite3 — so they run in the sandbox without skips.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, hasMarkerColumns, hasMetadataColumns } from '../routes/import-export.js';

test('parseCsv: basic header + rows', () => {
  const recs = parseCsv('filename,title\na.mp4,Hello\nb.mp4,World');
  assert.equal(recs.length, 2);
  assert.deepEqual(recs[0], { filename: 'a.mp4', title: 'Hello' });
  assert.deepEqual(recs[1], { filename: 'b.mp4', title: 'World' });
});

test('parseCsv: quoted field containing a comma', () => {
  const recs = parseCsv('filename,title\na.mp4,"Hello, World"');
  assert.equal(recs[0].title, 'Hello, World');
});

test('parseCsv: escaped double-quote inside a quoted field', () => {
  const recs = parseCsv('filename,title\na.mp4,"She said ""hi"""');
  assert.equal(recs[0].title, 'She said "hi"');
});

test('parseCsv: quoted field with an embedded newline (the regression)', () => {
  // A marker label pasted from a multi-line tracklist. The old line-split
  // parser broke this into two malformed records; the tokenizer keeps it whole.
  const csv = 'filename,start,end,label\nmix.mp4,0,120,"Intro\nthen the drop"';
  const recs = parseCsv(csv);
  assert.equal(recs.length, 1, 'embedded newline must not split the record');
  assert.equal(recs[0].label, 'Intro\nthen the drop');
  assert.equal(recs[0].start, '0');
});

test('parseCsv: CRLF line endings', () => {
  const recs = parseCsv('filename,title\r\na.mp4,Hello\r\nb.mp4,World');
  assert.equal(recs.length, 2);
  assert.equal(recs[1].title, 'World');
});

test('parseCsv: blank physical lines are dropped, not parsed as records', () => {
  const recs = parseCsv('filename,title\na.mp4,Hello\n\n\nb.mp4,World\n');
  assert.equal(recs.length, 2);
});

test('parseCsv: header only yields no records', () => {
  assert.deepEqual(parseCsv('filename,title'), []);
});

test('parseCsv: a single non-CSV line yields no records (route 400s on this)', () => {
  // A lone line (e.g. a search query pasted by accident) has no data row, so it
  // parses to []. The import routes reject records.length === 0 rather than
  // looping over nothing and reporting a hollow matched:0 success.
  assert.deepEqual(parseCsv('Trappin in Japan - Volume 26'), []);
  assert.deepEqual(parseCsv(''), []);
});

test('hasMarkerColumns: true for a markers CSV, false for metadata', () => {
  const markers = parseCsv('filename,rel_path,start,end,label\nm.mp4,a/m.mp4,0,10,Track');
  const meta = parseCsv('filename,title,artist\nm.mp4,Title,Artist');
  assert.equal(hasMarkerColumns(markers), true);
  assert.equal(hasMarkerColumns(meta), false);
  assert.equal(hasMarkerColumns([]), false);
});

test('hasMetadataColumns: true for metadata, false for a markers CSV', () => {
  const markers = parseCsv('filename,rel_path,start,end,label\nm.mp4,a/m.mp4,0,10,Track');
  const meta = parseCsv('filename,title,artist\nm.mp4,Title,Artist');
  assert.equal(hasMetadataColumns(meta), true);
  assert.equal(hasMetadataColumns(markers), false);
  assert.equal(hasMetadataColumns([]), false);
});

test('shape guard logic: a markers CSV is rejected by the metadata importer', () => {
  // Mirrors the /api/import guard condition.
  const markers = parseCsv('filename,rel_path,start,end,label\nm.mp4,a/m.mp4,0,10,Track');
  assert.equal(hasMarkerColumns(markers) && !hasMetadataColumns(markers), true);
});

test('shape guard logic: a normal metadata CSV passes the metadata importer', () => {
  const meta = parseCsv('filename,title,artist,year,album,track_number,description,tags\nm.mp4,T,A,2024,Al,1,desc,tag');
  assert.equal(hasMarkerColumns(meta) && !hasMetadataColumns(meta), false);
});
