/**
 * Parse structured metadata from a filename.
 * Supports: "Artist - Title (Year).ext", "Artist - Title.ext", "Title (Year).ext", "Title.ext"
 * Strips leading track numbers ("01 ", "01. ", "1. ") and disc prefixes ("(Disc 2) ").
 *
 * Back-to-back (b2b) sets: when the artist chunk contains " b2b " (case-
 * insensitive, whitespace-delimited), it is split into individual artists.
 * e.g. "Excision b2b Wooli b2b Crankdat - Lost Lands (2024)" yields
 *   artists: ['Excision', 'Wooli', 'Crankdat'], isB2B: true.
 * The `artist` DISPLAY string re-joins them with `b2bJoin` (default " b2b ",
 * i.e. preserved verbatim). The individual `artists` array is what the scanner
 * turns into per-artist tags; the display string is what lands in media.artist.
 *
 * Group/act alias: a trailing "[Name]" on the artist chunk (e.g.
 * "Crankdat b2b Wooli [WANKDAT]") is extracted as `alias` — the collective
 * name for the set of artists — and stripped from the artist display. It is
 * reserved to the artist position only; brackets in the event/title are kept.
 *
 * @param {string} filename - just the filename (with or without extension)
 * @param {object} [opts]
 * @param {string} [opts.b2bJoin=' b2b '] - separator used to re-join b2b
 *   artists into the display string. Default preserves "b2b" (domain-correct,
 *   lossless). Set to ' | ' (or similar) for a piped display.
 * @returns {{ artist: string|null, artists: string[], alias: string|null, isB2B: boolean, title: string, year: number|null }}
 */
export function parseFilename(filename, opts = {}) {
  const b2bJoin = opts.b2bJoin ?? ' b2b ';

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

  // Group/act alias: a trailing "[Name]" on the artist chunk (e.g.
  // "Crankdat b2b Wooli [WANKDAT]" or "Eptic b2b Space Laces b2b SVDDEN DEATH
  // [MASTERHVND]") is the collective name for this set of artists. It is
  // extracted as `alias` (the scanner turns it into a tag) and stripped from
  // the artist chunk BEFORE the b2b split, so it never glues onto the last
  // artist or leaks into the display string. Anchored to the END of the artist
  // chunk (which is everything before the first " - "), so a "[...]" appearing
  // later — in the event/title portion — is NOT touched and stays literal
  // title text. `[...]` is therefore a reserved structured slot in the artist
  // position only.
  let alias = null;
  if (artist) {
    const aliasMatch = artist.match(/\s*\[([^\]]+)\]\s*$/);
    if (aliasMatch) {
      alias = aliasMatch[1].trim() || null;
      artist = artist.slice(0, aliasMatch.index).trim() || null;
    }
  }

  // Back-to-back split. Operates on the parsed artist chunk only (post dash-
  // split), matching the "a1 b2b a2 - Event (YYYY)" grammar. The delimiter is
  // a whitespace-bounded, case-insensitive "b2b" so it won't fire on an artist
  // whose name merely contains the substring.
  let artists = [];
  let isB2B = false;
  if (artist) {
    const parts = artist.split(/\s+b2b\s+/i).map(s => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      isB2B = true;
      artists = parts;
      artist = parts.join(b2bJoin); // display string (default preserves "b2b")
    } else {
      artists = [artist];
    }
  }

  return { artist, artists, alias, isB2B, title, year };
}
