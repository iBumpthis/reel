/**
 * Parse structured metadata from a filename.
 * Supports: "Artist - Title (Year).ext", "Artist - Title.ext", "Title (Year).ext", "Title.ext"
 *
 * @param {string} filename - just the filename (with or without extension)
 * @returns {{ artist: string|null, title: string, year: number|null }}
 */
export function parseFilename(filename) {
  // Strip extension
  const base = filename.replace(/\.[^.]+$/, '');

  let artist = null;
  let title = base;
  let year = null;

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
  title = title.trim() || base;
  artist = artist?.trim() || null;

  return { artist, title, year };
}
