const MIME_MAP = {
  // Video
  mp4:  'video/mp4',
  m4v:  'video/mp4',
  mkv:  'video/x-matroska',
  webm: 'video/webm',
  avi:  'video/x-msvideo',
  mov:  'video/quicktime',
  // Audio
  mp3:  'audio/mpeg',
  m4a:  'audio/mp4',
  wav:  'audio/wav',
  flac: 'audio/flac',
  ogg:  'audio/ogg',
  opus: 'audio/opus',
  aac:  'audio/aac',
  wma:  'audio/x-ms-wma',
};

export const AUDIO_EXTS = new Set(['mp3', 'm4a', 'wav', 'flac', 'ogg', 'opus', 'aac', 'wma']);
export const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov']);

/**
 * Get MIME type for a file extension.
 * @param {string} ext - lowercase, no leading dot
 * @returns {string|null}
 */
export function mimeForExt(ext) {
  return MIME_MAP[ext] ?? null;
}

/**
 * Get media type classification for a file extension.
 * @param {string} ext - lowercase, no leading dot
 * @returns {'audio'|'video'|null}
 */
export function mediaTypeForExt(ext) {
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}
