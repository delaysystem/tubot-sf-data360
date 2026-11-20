/**
 * Cloudflare KV TTL caching layer for tubot-sf-data360.
 *
 * Cached values are non-secret operational hints only (catalog payloads,
 * last-good snapshots, channel-map resolutions). Tokens, secrets, and PII
 * must never be cached through this module.
 *
 * Backend accounting: Cache API match/put/delete calls count against the
 * Worker 50-subrequest invocation budget and 502 cold runs, so the TTL
 * cache uses KV instead. KV operations count against the separate 1,000
 * internal-services budget.
 *
 * The binding is installed once per request entry via initCache(). The
 * layer never throws: any error, or an uninitialized binding (plain
 * Bun/Node runtimes, missing env), degrades to null (get) or no-op
 * (put/delete).
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

let kvBinding: KVNamespace | null = null;

export interface CacheStats {
  bound: boolean;
  hits: number;
  misses: number;
  puts: number;
  putErrors: number;
  lastError: string;
}

const stats = { hits: 0, misses: 0, puts: 0, putErrors: 0, lastError: "" };

export function getCacheStats(): CacheStats {
  return { bound: kvBinding !== null, ...stats };
}

export function resetCacheStats(): void {
  stats.hits = 0;
  stats.misses = 0;
  stats.puts = 0;
  stats.putErrors = 0;
  stats.lastError = "";
}

function recordError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  stats.lastError = message.slice(0, 200);
}

/**
 * Installs the KV namespace backing this module. Safe to call once per
 * request entry: the binding value is identical for every request of a
 * worker+env. Pass null/undefined to uninstall (tests, teardown).
 */
export function initCache(kv: KVNamespace | null | undefined): void {
  kvBinding = kv ?? null;
}

function isValidKey(key: string): boolean {
  return typeof key === "string" && KEY_PATTERN.test(key);
}

export async function cacheGetJSON<T>(key: string): Promise<T | null> {
  try {
    if (!isValidKey(key)) return null;
    if (!kvBinding) return null;
    const value = await kvBinding.get(key, "json");
    if (value === null || value === undefined) {
      stats.misses++;
      return null;
    }
    stats.hits++;
    return value as T;
  } catch (err: unknown) {
    stats.misses++;
    recordError(err);
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
    if (!kvBinding) return;
    await kvBinding.put(key, JSON.stringify(value), {
      expirationTtl: ttlSeconds,
    });
    stats.puts++;
  } catch (err: unknown) {
    stats.putErrors++;
    recordError(err);
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    if (!isValidKey(key)) return;
    if (!kvBinding) return;
    await kvBinding.delete(key);
  } catch {
    // Degrade to no-op.
  }
}
