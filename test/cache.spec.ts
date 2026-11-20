import { describe, it, expect, vi, afterEach } from "vitest";
import {
  CACHE_TTL,
  catalogCacheKey,
  lastGoodCacheKey,
  channelMapCacheKey,
  cacheGetJSON,
  cachePutJSON,
  cacheDelete,
  initCache,
  getCacheStats,
  resetCacheStats,
} from "../src/cache";

interface FakeKVStore {
  store: Map<string, string>;
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function installFakeKV(): FakeKVStore {
  const store = new Map<string, string>();
  const get = vi.fn(async (key: string, type?: string) => {
    const hit = store.get(key);
    if (hit === undefined) return null;
    return type === "json" ? JSON.parse(hit) : hit;
  });
  const put = vi.fn(async (key: string, value: string, _options?: unknown) => {
    store.set(key, value);
  });
  const deleter = vi.fn(async (key: string) => {
    store.delete(key);
  });
  initCache({ get, put, delete: deleter } as unknown as KVNamespace);
  return { store, get, put, delete: deleter };
}

describe("cache layer", () => {
  afterEach(() => {
    initCache(null);
    resetCacheStats();
  });

  it("exposes the expected TTLs and key builders", () => {
    expect(CACHE_TTL).toEqual({ catalog: 21600, lastGood: 604800, channelMap: 86400 });
    expect(catalogCacheKey("00D1")).toBe("catalog/00D1");
    expect(lastGoodCacheKey("00D1", "dmo")).toBe("last-good/00D1/dmo");
    expect(channelMapCacheKey("00D1", "chan_A")).toBe("channel-map/00D1/chan_A");
  });

  it("roundtrips put/get through the KV binding", async () => {
    installFakeKV();
    await cachePutJSON("catalog/org1", { dmos: ["a"] }, CACHE_TTL.catalog);
    const got = await cacheGetJSON<{ dmos: string[] }>("catalog/org1");
    expect(got).toEqual({ dmos: ["a"] });
  });

  it("passes the TTL through as KV expirationTtl on put", async () => {
    const fake = installFakeKV();
    await cachePutJSON("catalog/org1", { ok: true }, 123);
    expect(fake.put).toHaveBeenCalledWith(
      "catalog/org1",
      JSON.stringify({ ok: true }),
      { expirationTtl: 123 }
    );
    expect(fake.store.get("catalog/org1")).toBe(JSON.stringify({ ok: true }));
  });

  it("returns null on a cache miss and deletes entries", async () => {
    installFakeKV();
    expect(await cacheGetJSON("catalog/missing")).toBeNull();
    await cachePutJSON("catalog/temp", { x: 1 }, 60);
    expect(await cacheGetJSON("catalog/temp")).toEqual({ x: 1 });
    await cacheDelete("catalog/temp");
    expect(await cacheGetJSON("catalog/temp")).toBeNull();
  });

  it("rejects invalid keys without throwing and without touching KV", async () => {
    const fake = installFakeKV();
    const badKey = "bad key?!with spaces";
    expect(await cacheGetJSON(badKey)).toBeNull();
    await cachePutJSON(badKey, { x: 1 }, 60);
    await cacheDelete(badKey);
    expect(fake.get).not.toHaveBeenCalled();
    expect(fake.put).not.toHaveBeenCalled();
    expect(fake.delete).not.toHaveBeenCalled();
    expect(fake.store.size).toBe(0);
  });

  it("degrades gracefully when the KV binding is uninitialized", async () => {
    initCache(null);
    expect(await cacheGetJSON("catalog/org1")).toBeNull();
    await cachePutJSON("catalog/org1", { x: 1 }, 60);
    await cacheDelete("catalog/org1");
    initCache(undefined);
    expect(await cacheGetJSON("catalog/org1")).toBeNull();
    await cachePutJSON("catalog/org1", { x: 1 }, 60);
    await cacheDelete("catalog/org1");
  });

  it("degrades gracefully when KV throws", async () => {
    initCache({
      get: vi.fn().mockRejectedValue(new Error("boom")),
      put: vi.fn().mockRejectedValue(new Error("boom")),
      delete: vi.fn().mockRejectedValue(new Error("boom")),
    } as unknown as KVNamespace);
    expect(await cacheGetJSON("catalog/org1")).toBeNull();
    await cachePutJSON("catalog/org1", { x: 1 }, 60);
    await cacheDelete("catalog/org1");
  });

  it("reports bound state, hits, misses, puts, and errors", async () => {
    resetCacheStats();
    expect(getCacheStats().bound).toBe(false);
    installFakeKV();
    expect(getCacheStats().bound).toBe(true);
    expect(await cacheGetJSON("catalog/missing")).toBeNull();
    await cachePutJSON("catalog/a", { x: 1 }, 60);
    expect(await cacheGetJSON("catalog/a")).toEqual({ x: 1 });
    const stats = getCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.puts).toBe(1);
    expect(stats.putErrors).toBe(0);
    initCache({
      get: vi.fn().mockRejectedValue(new Error("kv down")),
      put: vi.fn().mockRejectedValue(new Error("kv down")),
      delete: vi.fn().mockRejectedValue(new Error("kv down")),
    } as unknown as KVNamespace);
    await cachePutJSON("catalog/b", { x: 2 }, 60);
    const after = getCacheStats();
    expect(after.putErrors).toBe(1);
    expect(after.lastError).toContain("kv down");
  });
});
