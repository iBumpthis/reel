/**
 * API client for Reel backend.
 * All methods return parsed JSON responses.
 */

const BASE = '';

async function request(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** GET /api/health → { ok, name, version } */
export function getHealth() {
  return request('/api/health');
}

/**
 * GET /api/library
 * @param {Object} params - query parameters
 * @returns {Promise<{items, libraries, nextCursor, totalCount}>}
 */
export function getLibrary(params = {}) {
  const url = new URL('/api/library', location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  return request(url.pathname + url.search);
}

/** GET /api/media/:id → full media record with markers, tags, streamUrl */
export function getMedia(id) {
  return request(`/api/media/${encodeURIComponent(id)}`);
}

/** PATCH /api/media/:id → update metadata fields */
export function updateMedia(id, body) {
  return request(`/api/media/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** POST /api/media/:id/markers → replace markers */
export function setMarkers(id, body) {
  return request(`/api/media/${encodeURIComponent(id)}/markers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** DELETE /api/media/:id/markers */
export function clearMarkers(id) {
  return request(`/api/media/${encodeURIComponent(id)}/markers`, {
    method: 'DELETE',
  });
}

/** PATCH /api/media/:id/markers/:markerId — update single marker */
export function patchMarker(mediaId, markerId, body) {
  return request(`/api/media/${encodeURIComponent(mediaId)}/markers/${encodeURIComponent(markerId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** GET /api/media/:id/markers/export — text format */
export function exportMarkers(id) {
  return fetch(`/api/media/${encodeURIComponent(id)}/markers/export`).then(r => r.text());
}

/** GET /api/tags → { tags: [{ id, name, count }] } */
export function getTags() {
  return request('/api/tags');
}

/** GET /api/artists → { artists: [{ name, count }] } */
export function getArtists() {
  return request('/api/artists');
}

/** POST /api/media/:id/tags → replace tags for media */
export function setMediaTags(id, tags) {
  return request(`/api/media/${encodeURIComponent(id)}/tags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  });
}

/** POST /api/scan → { ok, totalUpserts, totalDeletes } */
export function scan() {
  return request('/api/scan', { method: 'POST' });
}

/** POST /api/import → bulk metadata import */
export function importData(body) {
  return request('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** GET /api/export → metadata dump */
export function exportData(params = {}) {
  const url = new URL('/api/export', location.origin);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }
  return request(url.pathname + url.search);
}
