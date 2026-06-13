/**
 * Marker parsing engine — ported from TapeC v1 with corrections.
 *
 * Supported formats:
 *   Bracket/paren range: "Title [00:00-01:30]" or "[00:00-01:30] Title"
 *                        "Title (00:00-01:30)" or "(00:00-01:30) Title"
 *   Bare range-first:    "00:00-01:30 Title"
 *   Bare range-last:     "Title 00:00-01:30"
 *   Time-first:          "00:00 Title" or "00:00 - Title"
 *   Time-last:           "Title 00:00" or "Title - 00:00"
 *   Mixed: any combination in a single block
 *
 * Times: H:MM:SS, HH:MM:SS, M:SS, MM:SS
 */

// Matches H:MM:SS, HH:MM:SS, M:SS, MM:SS (as a source string for embedding)
const TIME_PAT = `(\\d{1,2}:\\d{2}(?::\\d{2})?)`;

/**
 * Normalize various dash characters to a standard hyphen.
 */
function normalizeDashes(str) {
  return str.replace(/[–—―]/g, '-');
}

/**
 * Clean up a marker label string.
 * Strips leading/trailing dashes, pipes, and whitespace.
 */
function cleanTitle(str) {
  return str.replace(/^[\s\-|]+/, '').replace(/[\s\-|]+$/, '').trim();
}

/**
 * Parse a time string (H:MM:SS or MM:SS) into total seconds.
 * Returns null if the time is malformed.
 *
 * @param {string} str
 * @returns {number|null}
 */
export function parseTime(str) {
  const parts = str.split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return null;

  if (parts.length === 3) {
    const [h, m, s] = parts;
    if (h < 0 || m < 0 || m > 59 || s < 0 || s > 59) return null;
    return h * 3600 + m * 60 + s;
  }

  if (parts.length === 2) {
    const [m, s] = parts;
    if (m < 0 || s < 0 || s > 59) return null;
    return m * 60 + s;
  }

  return null;
}

/**
 * Parse a single marker line.
 *
 * @param {string} line - raw text line
 * @returns {{ startSeconds: number, endSeconds: number|null, label: string, rawLine: string } | null}
 *   null if the line can't be parsed
 */
export function parseMarkerLine(line) {
  const rawLine = line;
  const s = normalizeDashes(String(line ?? '')).trim();
  if (!s) return null;

  // 1) Bracket/paren range anywhere: Title [00:00-00:40] or Title (00:00-00:40)
  //    Text allowed before and after the delimiter.
  {
    const re = new RegExp(`^(.*?)[\\[(]\\s*${TIME_PAT}\\s*-\\s*${TIME_PAT}\\s*[\\])](.*)$`);
    const m = s.match(re);
    if (m) {
      const start = parseTime(m[2]);
      const end = parseTime(m[3]);
      if (start == null || end == null || end < start) return null;
      const label = cleanTitle(`${m[1]} ${m[4]}`.replace(/\s{2,}/g, ' '));
      return { startSeconds: start, endSeconds: end, label: label || `Track @ ${m[2]}`, rawLine };
    }
  }

  // 2) Bare range-first: 00:00-00:40 Title
  {
    const re = new RegExp(`^${TIME_PAT}\\s*-\\s*${TIME_PAT}\\s+(.+)$`);
    const m = s.match(re);
    if (m) {
      const start = parseTime(m[1]);
      const end = parseTime(m[2]);
      if (start == null || end == null || end < start) return null;
      const label = cleanTitle(m[3]);
      return { startSeconds: start, endSeconds: end, label: label || `Track @ ${m[1]}`, rawLine };
    }
  }

  // 3) Bare range-last: Title 00:00-00:40
  {
    const re = new RegExp(`^(.+?)\\s+${TIME_PAT}\\s*-\\s*${TIME_PAT}\\s*$`);
    const m = s.match(re);
    if (m) {
      const start = parseTime(m[2]);
      const end = parseTime(m[3]);
      if (start == null || end == null || end < start) return null;
      const label = cleanTitle(m[1]);
      return { startSeconds: start, endSeconds: end, label: label || `Track @ ${m[2]}`, rawLine };
    }
  }

  // 4) Time-first: 0:00 Title  OR  0:00 - Title
  {
    const re = new RegExp(`^${TIME_PAT}\\s*(?:-\\s*)?(.+)$`);
    const m = s.match(re);
    if (m) {
      const start = parseTime(m[1]);
      if (start == null) return null;
      const label = cleanTitle(m[2]);
      return { startSeconds: start, endSeconds: null, label: label || `Track @ ${m[1]}`, rawLine };
    }
  }

  // 5) Time-last: Title 0:00  OR  Title - 0:00
  {
    const re = new RegExp(`^(.+?)(?:\\s*-)?\\s*${TIME_PAT}\\s*$`);
    const m = s.match(re);
    if (m) {
      const start = parseTime(m[2]);
      if (start == null) return null;
      const label = cleanTitle(m[1]);
      return { startSeconds: start, endSeconds: null, label: label || `Track @ ${m[2]}`, rawLine };
    }
  }

  return null;
}

/**
 * Format seconds as H:MM:SS or M:SS (inverse of parseTime).
 * @param {number} sec
 * @returns {string}
 */
export function formatTime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format an array of marker objects as a re-importable text block.
 * Uses time-first format: "H:MM:SS Label" for point markers,
 * "H:MM:SS-H:MM:SS Label" for range markers.
 * Output round-trips through parseMarkerBlock.
 *
 * @param {Array<{startSeconds: number, endSeconds?: number|null, label: string}>} markers
 * @returns {string}
 */
export function formatMarkerBlock(markers) {
  return markers
    .map(m => {
      const start = formatTime(m.startSeconds);
      if (m.endSeconds != null) {
        return `${start}-${formatTime(m.endSeconds)} ${m.label}`;
      }
      return `${start} ${m.label}`;
    })
    .join('\n');
}

/**
 * Parse a full marker text block (multiple lines).
 * Performs overlap repair on range markers.
 *
 * @param {string} text - multiline marker text
 * @returns {{ markers: Array<object>, errors: Array<{line: number, text: string}> }}
 */
export function parseMarkerBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const parsed = [];
  const errors = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    const result = parseMarkerLine(trimmed);
    if (result) {
      parsed.push({
        ...result,
        wasAdjusted: false,
        adjustReason: null,
        _i: idx,
      });
    } else {
      errors.push({ line: idx + 1, text: trimmed });
    }
  });

  // Sort by start time; preserve original line order for ties
  parsed.sort((a, b) => (a.startSeconds - b.startSeconds) || (a._i - b._i));

  // Overlap repair: if previous marker has an explicit endSeconds that
  // extends past the next marker's startSeconds, truncate the previous
  // marker's end. This preserves the new marker's start time (the actual
  // transition point in a mix) rather than shifting it forward.
  for (let i = 1; i < parsed.length; i++) {
    const prev = parsed[i - 1];
    const curr = parsed[i];

    if (prev.endSeconds != null && prev.endSeconds > curr.startSeconds) {
      const oldEnd = prev.endSeconds;
      prev.endSeconds = curr.startSeconds;
      prev.wasAdjusted = true;
      prev.adjustReason = `End truncated from ${oldEnd}s to ${curr.startSeconds}s (overlap with next marker)`;
    }
  }

  // Assign sort_order and clean internal fields
  for (let i = 0; i < parsed.length; i++) {
    parsed[i].sortOrder = i;
    delete parsed[i]._i;
  }

  return { markers: parsed, errors };
}
