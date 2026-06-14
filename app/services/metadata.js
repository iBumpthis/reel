/**
 * Parse structured metadata from a filename.
 * Supports: "Artist - Title (Year).ext", "Artist - Title.ext", "Title (Year).ext", "Title.ext"
 * Strips leading track numbers ("01 ", "01. ", "1. ") and disc prefixes ("(Disc 2) ").
 *
 * @param {string} filename - just the filename (with or without extension)
 * @returns {{ artist: string|null, title: string, year: number|null }}
 */
export function parseFilename(filename) {
  // Strip extension
  let base = filename.replace(/\.[^.]+$/, '');

  let artist = null;
  let title = base;
  let year = null;

  // Strip leading disc/CD prefix: "(Disc 2) ", "(CD 1) ", etc.
  base = base.replace(/^\((?:Disc|CD)\s*\d+\)\s*/i, '');

  // Strip leading track number: "01 ", "01. ", "1. ", "01 - " (track-dash, not artist-dash)
  // Only strip if followed by non-digit content (avoids eating "2024 ..." year-prefixed titles)
  base = base.replace(/^\d{1,3}(?:\.\s*|\s+-\s+|\s+)(?=\D)/, '');

  title = base;

  // Extract year from trailing (YYYY) — must be 4 digits, 1900-2099
  const yearMatch = base.match(/\((\d{4})\)\s*$/);
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10);
    if (y >= 1900 && y <= 2099) {
      year = y;
      title = base.slice(0, yearMatch.index).trim();
    }
  }

  // Split on " - " for artist/title (only first occurrence)
  const sepIndex = title.indexOf(' - ');
  if (sepIndex > 0) {
    artist = title.slice(0, sepIndex).trim();
    title = title.slice(sepIndex + 3).trim();
  }

  // Clean up any remaining whitespace
  title = title.trim() || filename.replace(/\.[^.]+$/, '');
  artist = artist?.trim() || null;

  return { artist, title, year };
}
