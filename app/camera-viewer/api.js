// Backend access for the camera viewer: camera list, image list, and the
// presigned preview URLs (which expire, hence the cache).
//
// API_BASE is a global const injected by /config.php, loaded as a classic
// script before this module.

/** Fetch all pages for an endpoint, following DRF pagination. */
async function fetchAll(url) {
  const results = [];
  let next = url;
  while (next) {
    const resp = await fetch(next);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} — ${next}`);
    const data = await resp.json();
    // Paginated response has {results, next} — plain list has no .next
    if (Array.isArray(data)) {
      results.push(...data);
      break;
    }
    results.push(...(data.results ?? data));
    next = data.next ?? null;
  }
  return results;
}

/** @returns {Promise<Array<{slug: string, camera_name: string}>>} */
export function fetchCameras() {
  return fetchAll(`${API_BASE}/cams/cameras/`);
}

/**
 * Fetch every image of a camera, reporting progress as pages arrive.
 *
 * @param {string} slug Camera slug.
 * @param {(count: number) => void} onProgress Called with the running total.
 */
export async function fetchCameraImages(slug, onProgress) {
  const images = [];
  let next = `${API_BASE}/cams/images/?camera=${encodeURIComponent(slug)}&page_size=500`;
  while (next) {
    const resp = await fetch(next);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const results = data.results ?? data;
    images.push(...results);
    onProgress(images.length);
    // Ensure next-page URL matches the current scheme (guards against http→https proxy issues)
    next = data.next ? data.next.replace(/^http:\/\//, `${location.protocol}//`) : null;
  }
  return images;
}

// ── Presigned URL cache ──────────────────────────────────────────────────────

const urlCache = new Map(); // image id → {url, expiresAt}
const URL_TTL_MS = 12 * 60 * 1000; // 12 min (presigned URLs valid 15 min)

export function clearUrlCache() {
  urlCache.clear();
}

export async function getPreviewUrl(img) {
  const cached = urlCache.get(img.id);
  if (cached && Date.now() < cached.expiresAt) return cached.url;
  const resp = await fetch(`${API_BASE}/cams/images/${img.id}/preview-url/`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const { url } = await resp.json();
  urlCache.set(img.id, { url, expiresAt: Date.now() + URL_TTL_MS });
  return url;
}
