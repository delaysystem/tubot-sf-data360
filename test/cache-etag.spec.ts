import { describe, it, expect } from "vitest";
import { D1Data360Cache, clearAllMemoryCaches } from "../src/cache-helper";

type Row = Record<string, any>;

/** Minimal in-memory D1 double for the cache tables: records SELECTs. */
function fakeCacheDb() {
  const tables = new Map<string, Map<string, Row>>();
  const selects: string[] = [];
  const tableFor = (sql: string): Map<string, Row> => {
    const m = sql.match(/data360_\w+_cache/);
    const name = m ? m[0] : "unknown";
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const db = {
    selects,
    seed(table: string, key: string, row: Row) {
      if (!tables.has(table)) tables.set(table, new Map());
      tables.get(table)!.set(key, row);
    },
    prepare(sql: string) {
      const q = sql.replace(/\s+/g, " ").trim();
      const bound =
        (...args: unknown[]) =>
        ({
          async first() {
            if (q.startsWith("SELECT")) {
              selects.push(q);
              return tableFor(q).get(String(args[0])) ?? null;
            }
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            if (q.startsWith("DELETE")) {
              tableFor(q).delete(String(args[0]));
              return { success: true, meta: { changes: 1 } };
            }
            if (q.startsWith("INSERT INTO")) {
              const table = tableFor(q);
              const cols = q.slice(q.indexOf("(") + 1, q.indexOf(")")).split(",").map((c) => c.trim());
              const row: Row = {};
              cols.forEach((c, i) => (row[c] = args[i]));
              const keyCol = cols[0];
              table.set(String(row[keyCol]), row);
              return { success: true, meta: { changes: 1 } };
            }
            return { success: true, meta: { changes: 0 } };
          },
        }) as any;
      return { bind: bound, ...bound() } as any;
    },
  };
  return db;
}

describe("F16 single-read data+etag", () => {
  it("getUserWithETag returns data + stored etag with one SELECT", async () => {
    const db = fakeCacheDb();
    db.seed("data360_user_cache", "u1", {
      data: JSON.stringify({ userId: "u1" }), etag: "etag-u1", expires_at: Date.now() + 60_000,
    });
    const cache = new D1Data360Cache(db as any);
    const hit = await cache.getUserWithETag("u1");
    expect(hit).toEqual({ data: { userId: "u1" }, etag: "etag-u1" });
    expect(db.selects).toHaveLength(1);
    // Mem hit: no further SELECT.
    expect(await cache.getUserWithETag("u1")).toEqual({ data: { userId: "u1" }, etag: "etag-u1" });
    expect(db.selects).toHaveLength(1);
    clearAllMemoryCaches(db as any);
  });

  it("plain getters delegate with identical values and one SELECT", async () => {
    const db = fakeCacheDb();
    db.seed("data360_user_cache", "u2", {
      data: JSON.stringify({ n: 1 }), etag: "e2", expires_at: Date.now() + 60_000,
    });
    db.seed("data360_tool_urls_cache", "ch1", {
      urls: JSON.stringify(["https://x/y"]), etag: "e3", expires_at: Date.now() + 60_000,
    });
    db.seed("data360_conversation_cache", "u2", {
      data: "not-json{{{", etag: null, expires_at: Date.now() + 60_000,
    });
    const cache = new D1Data360Cache(db as any);
    expect(await cache.getUser("u2")).toEqual({ n: 1 });
    expect(await cache.getToolUrls("ch1")).toEqual(["https://x/y"]);
    // Raw-string fallback and null-etag rows preserved.
    expect(await cache.getConversationHistory("u2")).toBe("not-json{{{");
    expect(await cache.getConversationHistoryWithETag("u2")).toEqual({ data: "not-json{{{", etag: null });
    expect((await cache.getToolUrlsWithETag("ch1"))?.etag).toBe("e3");
    expect(db.selects).toHaveLength(3);
    clearAllMemoryCaches(db as any);
  });

  it("expired rows read as miss and are purged", async () => {
    const db = fakeCacheDb();
    db.seed("data360_global_cache", "g1", {
      data: JSON.stringify({}), etag: "old", expires_at: Date.now() - 1000,
    });
    const cache = new D1Data360Cache(db as any);
    expect(await cache.getGlobalData360WithETag("g1")).toBeNull();
    expect(await cache.getGlobalData360("g1")).toBeNull();
    clearAllMemoryCaches(db as any);
  });

  it("put then WithETag round-trips the stored etag without recompute", async () => {
    const db = fakeCacheDb();
    const cache = new D1Data360Cache(db as any);
    await cache.putSession("s1", { a: 1 }, { etag: "pinned-etag", ttlSeconds: 300 });
    clearAllMemoryCaches(db as any);
    const hit = await cache.getSessionWithETag("s1");
    expect(hit?.data).toEqual({ a: 1 });
    expect(hit?.etag).toBe("pinned-etag");
    clearAllMemoryCaches(db as any);
  });

  it("non-array tool urls parse to [] exactly like the old getter", async () => {
    const db = fakeCacheDb();
    db.seed("data360_tool_urls_cache", "ch2", {
      urls: JSON.stringify({ not: "array" }), etag: "e4", expires_at: Date.now() + 60_000,
    });
    const cache = new D1Data360Cache(db as any);
    expect(await cache.getToolUrls("ch2")).toEqual([]);
    expect((await cache.getToolUrlsWithETag("ch2"))?.etag).toBe("e4");
    clearAllMemoryCaches(db as any);
  });
});
