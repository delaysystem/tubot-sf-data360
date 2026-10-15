/**
 * Cloudflare Cache API TTL caching layer for tubot-sf-data360.
 *
 * Cached values are non-secret operational hints only (catalog payloads,
 * last-good snapshots, channel-map resolutions). Tokens, secrets, and PII
 * must never be cached through this module.
 *
 * The layer never throws: any error, or an unavailable Cache API (plain
 * Bun/Node runtimes), degrades to null (get) or no-op (put/delete).
 */

export const CACHE_TTL = {
  catalog: 21600,
  lastGood: 604800,
  channelMap: 86400,
};

export function catalogCacheKey(orgId: string): string {
  return `catalog/${orgId}`;
}

export function lastGoodCacheKey(orgId: string, family: string): string {
  return `last-good/${orgId}/${family}`;
}

export function channelMapCacheKey(orgId: string, identifier: string): string {
  return `channel-map/${orgId}/${identifier}`;
}

const KEY_PATTERN = /^[A-Za-z0-9/_.-]+$/;
const CACHE_BASE_URL = "https://cache.internal/v1/";

interface EdgeCacheLike {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
  delete(request: Request): Promise<boolean>;
}

function getDefaultCache(): EdgeCacheLike | null {
  try {
    const cachesStore = (
      globalThis as unknown as { caches?: { default?: EdgeCacheLike } }
    ).caches;
    const cache = cachesStore?.default;
    if (!cache) return null;
    if (
      typeof cache.match !== "function" ||
      typeof cache.put !== "function" ||
      typeof cache.delete !== "function"
    ) {
      return null;
    }
    return cache;
  } catch {
    return null;
  }
}

function isValidKey(key: string): boolean {
  return typeof key === "string" && KEY_PATTERN.test(key);
}

function cacheRequestFor(key: string): Request {
  return new Request(`${CACHE_BASE_URL}${key}`);
}

export async function cacheGetJSON<T>(key: string): Promise<T | null> {
  try {
    if (!isValidKey(key)) return null;
    const cache = getDefaultCache();
    if (!cache) return null;
    const res = await cache.match(cacheRequestFor(key));
    if (!res) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function cachePutJSON(
  key: string,
  value: unknown,
  ttlSeconds: number
): Promise<void> {
  try {
    if (!isValidKey(key)) return;
    const cache = getDefaultCache();
    if (!cache) return;
    const res = Response.json(value, {
      headers: { "Cache-Control": `max-age=${ttlSeconds}` },
    });
    await cache.put(cacheRequestFor(key), res);
  } catch {
    // Degrade to no-op.
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    if (!isValidKey(key)) return;
    const cache = getDefaultCache();
    if (!cache) return;
    await cache.delete(cacheRequestFor(key));
  } catch {
    // Degrade to no-op.
  }
}
