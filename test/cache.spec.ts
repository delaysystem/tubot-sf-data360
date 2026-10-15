import { describe, it, expect, vi } from "vitest";
import {
  CACHE_TTL,
  catalogCacheKey,
  lastGoodCacheKey,
  channelMapCacheKey,
  cacheGetJSON,
  cachePutJSON,
  cacheDelete,
} from "../src/cache";

interface FakeCacheStore {
  store: Map<string, Response>;
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function installFakeCaches(): FakeCacheStore {
  const store = new Map<string, Response>();
  const match = vi.fn(async (req: Request) => {
    const hit = store.get(req.url);
    return hit ? hit.clone() : undefined;
  });
  const put = vi.fn(async (req: Request, res: Response) => {
    store.set(req.url, res.clone());
  });
  const deleter = vi.fn(async (req: Request) => store.delete(req.url));
  (globalThis as any).caches = {
    default: { match, put, delete: deleter },
  };
  return { store, match, put, delete: deleter };
}

describe("cache layer", () => {
  it("exposes the expected TTLs and key builders", () => {
    expect(CACHE_TTL).toEqual({ catalog: 21600, lastGood: 604800, channelMap: 86400 });
    expect(catalogCacheKey("00D1")).toBe("catalog/00D1");
    expect(lastGoodCacheKey("00D1", "dmo")).toBe("last-good/00D1/dmo");
    expect(channelMapCacheKey("00D1", "chan_A")).toBe("channel-map/00D1/chan_A");
  });

  it("roundtrips put/get through caches.default", async () => {
    const originalCaches = (globalThis as any).caches;
    installFakeCaches();
    try {
      await cachePutJSON("catalog/org1", { dmos: ["a"] }, CACHE_TTL.catalog);
      const got = await cacheGetJSON<{ dmos: string[] }>("catalog/org1");
      expect(got).toEqual({ dmos: ["a"] });
    } finally {
      (globalThis as any).caches = originalCaches;
    }
  });

  it("stores responses with a Cache-Control max-age TTL header", async () => {
    const originalCaches = (globalThis as any).caches;
    const fake = installFakeCaches();
    try {
      await cachePutJSON("catalog/org1", { ok: true }, 123);
      const stored = fake.store.get("https://cache.internal/v1/catalog/org1");
      expect(stored).toBeDefined();
      expect(stored?.headers.get("Cache-Control")).toBe("max-age=123");
    } finally {
      (globalThis as any).caches = originalCaches;
    }
  });

  it("returns null on a cache miss and deletes entries", async () => {
    const originalCaches = (globalThis as any).caches;
    installFakeCaches();
    try {
      expect(await cacheGetJSON("catalog/missing")).toBeNull();
      await cachePutJSON("catalog/temp", { x: 1 }, 60);
      expect(await cacheGetJSON("catalog/temp")).toEqual({ x: 1 });
      await cacheDelete("catalog/temp");
      expect(await cacheGetJSON("catalog/temp")).toBeNull();
    } finally {
      (globalThis as any).caches = originalCaches;
    }
  });

  it("rejects invalid keys without throwing and without touching the cache", async () => {
    const originalCaches = (globalThis as any).caches;
    const fake = installFakeCaches();
    try {
      const badKey = "bad key?!with spaces";
      expect(await cacheGetJSON(badKey)).toBeNull();
      await cachePutJSON(badKey, { x: 1 }, 60);
      await cacheDelete(badKey);
      expect(fake.match).not.toHaveBeenCalled();
      expect(fake.put).not.toHaveBeenCalled();
      expect(fake.delete).not.toHaveBeenCalled();
      expect(fake.store.size).toBe(0);
    } finally {
      (globalThis as any).caches = originalCaches;
    }
  });

  it("degrades gracefully when the Cache API is unavailable", async () => {
    const originalCaches = (globalThis as any).caches;
    (globalThis as any).caches = undefined;
    try {
      expect(await cacheGetJSON("catalog/org1")).toBeNull();
      await cachePutJSON("catalog/org1", { x: 1 }, 60);
      await cacheDelete("catalog/org1");
    } finally {
      (globalThis as any).caches = originalCaches;
    }
  });

  it("degrades gracefully when the Cache API throws", async () => {
    const originalCaches = (globalThis as any).caches;
    (globalThis as any).caches = {
      default: {
        match: vi.fn().mockRejectedValue(new Error("boom")),
        put: vi.fn().mockRejectedValue(new Error("boom")),
        delete: vi.fn().mockRejectedValue(new Error("boom")),
      },
    };
    try {
      expect(await cacheGetJSON("catalog/org1")).toBeNull();
      await cachePutJSON("catalog/org1", { x: 1 }, 60);
      await cacheDelete("catalog/org1");
    } finally {
      (globalThis as any).caches = originalCaches;
    }
  });
});
