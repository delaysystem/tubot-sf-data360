import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import {
  CACHE_TABLES,
  __resetRetentionGuardForTests,
  dryRunRetention,
  maybeRunRetention,
  purgeRetention,
  retentionCutoffMs,
  dryRunSql,
  purgeSql,
  type CacheTableDef,
  type RetentionDb,
} from "../src/retention";
import { D1Data360Cache } from "../src/cache-helper";

/** bun:sqlite-backed RetentionDb (same engine family as D1/workerd). */
function sqliteRetentionDb(sqlite: Database): RetentionDb {
  const wrap = (sql: string, args: unknown[]) => ({
    async first<T>() {
      return (sqlite.query(sql).get(...(args as any[])) as T | null) ?? null;
    },
    async all<T>() {
      return { results: sqlite.query(sql).all(...(args as any[])) as T[] };
    },
    async run() {
      const res = sqlite.query(sql).run(...(args as any[]));
      return { meta: { changes: Number((res as any).changes ?? 0) } };
    },
  });
  return {
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => wrap(sql, args), run: () => wrap(sql, []).run() };
    },
  } as unknown as RetentionDb;
}

const NOW = Date.now();
const HOUR_MS = 3600 * 1000;
const CUTOFF = retentionCutoffMs(NOW);

const PK_COL: Record<CacheTableDef["key"], string> = {
  user: "user_id",
  session: "session_id",
  conversation: "user_id",
  global: "target_id",
  agentCode: "agent_key",
  toolUrls: "channel_id",
};
const PAYLOAD_COL: Record<CacheTableDef["key"], string> = {
  user: "data",
  session: "data",
  conversation: "data",
  global: "data",
  agentCode: "data",
  toolUrls: "urls",
};

async function seedDb(): Promise<{ sqlite: Database; db: RetentionDb }> {
  const sqlite = new Database(":memory:");
  const db = sqliteRetentionDb(sqlite);
  // Real ensureSchema path: creates the cache tables AND the F15 indexes.
  await new D1Data360Cache(db as unknown as D1Database).ensureSchema();
  for (const def of CACHE_TABLES) {
    const pk = PK_COL[def.key];
    const payload = PAYLOAD_COL[def.key];
    const extra = def.key === "conversation" ? ", session_count, total_messages" : "";
    const extraVals = def.key === "conversation" ? ", 0, 0" : "";
    const put = (id: string, expiresAt: number) =>
      sqlite
        .query(
          `INSERT INTO ${def.table} (${pk}, org_id, ${payload}, etag, updated_at, expires_at${extra}) VALUES (?, ?, ?, ?, ?, ?${extraVals})`,
        )
        .run(`${def.key}-${id}`, "org", JSON.stringify({ k: `${def.key}-${id}` }), `etag-${id}`, 1, expiresAt);
    put("stale", CUTOFF - 24 * HOUR_MS); // expired 2d ago: purged
    put("grace", CUTOFF + 12 * HOUR_MS); // expired 12h ago: within grace, kept
    put("live", NOW + HOUR_MS); // live: kept
    put("edge", CUTOFF); // boundary: expires_at == cutoff is purged
    put("never", 0); // never-expire sentinel: kept
  }
  return { sqlite, db };
}

function remainingIds(sqlite: Database, def: CacheTableDef): string[] {
  return (
    sqlite.query(`SELECT ${PK_COL[def.key]} AS id FROM ${def.table} ORDER BY id`).all() as Array<{ id: string }>
  ).map((r) => r.id);
}

describe("F15 data360 cache retention", () => {
  it("dry-run reports the exact per-table purge backlog", async () => {
    const { db } = await seedDb();
    expect(await dryRunRetention(db, NOW)).toEqual({
      user: 2,
      session: 2,
      conversation: 2,
      global: 2,
      agentCode: 2,
      toolUrls: 2,
    });
  });

  it("purges stale+boundary rows and keeps grace/live/never rows with payloads intact", async () => {
    const { sqlite, db } = await seedDb();
    const summary = await purgeRetention(db, NOW);
    expect(summary).toEqual({
      user: 2,
      session: 2,
      conversation: 2,
      global: 2,
      agentCode: 2,
      toolUrls: 2,
      batches: 2,
      capped: false,
    });
    for (const def of CACHE_TABLES) {
      expect(remainingIds(sqlite, def)).toEqual([`${def.key}-grace`, `${def.key}-live`, `${def.key}-never`]);
      // Kept payload intact (hit path unaffected).
      const row = sqlite.query(`SELECT ${PAYLOAD_COL[def.key]} AS p FROM ${def.table} WHERE ${PK_COL[def.key]} = ?`).get(`${def.key}-live`) as { p: string };
      expect(JSON.parse(row.p)).toEqual({ k: `${def.key}-live` });
    }
  });

  it("is idempotent — re-run deletes zero rows", async () => {
    const { db } = await seedDb();
    await purgeRetention(db, NOW);
    expect(await purgeRetention(db, NOW)).toEqual({
      user: 0,
      session: 0,
      conversation: 0,
      global: 0,
      agentCode: 0,
      toolUrls: 0,
      batches: 1,
      capped: false,
    });
    expect(await dryRunRetention(db, NOW)).toEqual({
      user: 0,
      session: 0,
      conversation: 0,
      global: 0,
      agentCode: 0,
      toolUrls: 0,
    });
  });

  it("keeps the real read-through hit path working after the purge", async () => {
    const { db } = await seedDb();
    await purgeRetention(db, NOW);
    // Fresh cache handle (fresh mem bucket) over the same rows.
    const cache = new D1Data360Cache(db as unknown as D1Database);
    expect(await cache.getUser("user-live")).toEqual({ k: "user-live" });
    expect(await cache.getUser("user-stale")).toBeNull();
    expect(await cache.getSession("session-live")).toEqual({ k: "session-live" });
    expect(await cache.getToolUrls("toolUrls-live")).toEqual([]);
  });

  it("ensureSchema creates all six expires indexes and every purge seeks (no SCAN)", async () => {
    const { sqlite } = await seedDb();
    for (const def of CACHE_TABLES) {
      expect(
        sqlite.query("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(def.index),
      ).not.toBeNull();
      const plan = (sqlite.query(`EXPLAIN QUERY PLAN ${purgeSql(def)}`).all() as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(" | ");
      expect(plan).toContain(def.index);
      expect(plan).not.toContain("SCAN");
      const dryPlan = (sqlite.query(`EXPLAIN QUERY PLAN ${dryRunSql(def)}`).all() as Array<{ detail: string }>)
        .map((r) => r.detail)
        .join(" | ");
      expect(dryPlan).not.toContain("SCAN");
    }
    // Index need, proved on a pre-existing table (the staging backfill case):
    // unindexed -> SCAN, ensureSchema -> SEARCH.
    const def = CACHE_TABLES[0];
    const bare = new Database(":memory:");
    bare.exec(
      "CREATE TABLE data360_user_cache (user_id TEXT PRIMARY KEY, org_id TEXT, data TEXT NOT NULL, etag TEXT, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
    const before = (bare.query(`EXPLAIN QUERY PLAN ${purgeSql(def)}`).all() as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(" | ");
    expect(before).toContain("SCAN");
    await new D1Data360Cache(sqliteRetentionDb(bare) as unknown as D1Database).ensureSchema();
    const after = (bare.query(`EXPLAIN QUERY PLAN ${purgeSql(def)}`).all() as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join(" | ");
    expect(after).toContain(def.index);
    expect(after).not.toContain("SCAN");
  });

  it("guard skips without DB/ctx/waitUntil and never throws", async () => {
    __resetRetentionGuardForTests();
    const { db } = await seedDb();
    await expect(maybeRunRetention(undefined, { waitUntil() {} }, NOW)).resolves.toBe(false);
    await expect(maybeRunRetention(db, undefined, NOW)).resolves.toBe(false);
    await expect(maybeRunRetention(db, {} as any, NOW)).resolves.toBe(false);
    await expect(maybeRunRetention("nope" as any, { waitUntil() {} }, NOW)).resolves.toBe(false);
  });

  it("guard runs the purge in waitUntil on a stale claim and updates the guard", async () => {
    __resetRetentionGuardForTests();
    const { sqlite, db } = await seedDb();
    const seen: Array<Promise<unknown>> = [];
    await expect(
      maybeRunRetention(db, { waitUntil(p: Promise<unknown>) { seen.push(p); } }, NOW),
    ).resolves.toBe(true);
    expect(seen).toHaveLength(1);
    await seen[0];
    await expect(dryRunRetention(db, NOW)).resolves.toEqual({
      user: 0,
      session: 0,
      conversation: 0,
      global: 0,
      agentCode: 0,
      toolUrls: 0,
    });
    expect(
      (sqlite.query("SELECT last_run_at FROM f15_retention_guard WHERE key='data360_daily_v1'").get() as {
        last_run_at: number;
      }).last_run_at,
    ).toBe(NOW);
  });

  it("guard skips when the daily run is fresh (claim race lost)", async () => {
    __resetRetentionGuardForTests();
    const { sqlite, db } = await seedDb();
    sqlite.exec("CREATE TABLE IF NOT EXISTS f15_retention_guard (key TEXT PRIMARY KEY, last_run_at INTEGER NOT NULL)");
    sqlite.query("INSERT INTO f15_retention_guard VALUES (?, ?)").run("data360_daily_v1", NOW);
    const seen: Array<Promise<unknown>> = [];
    await expect(
      maybeRunRetention(db, { waitUntil(p: Promise<unknown>) { seen.push(p); } }, NOW),
    ).resolves.toBe(false);
    expect(seen).toHaveLength(0);
    // Nothing purged.
    await expect(dryRunRetention(db, NOW)).resolves.toEqual({
      user: 2,
      session: 2,
      conversation: 2,
      global: 2,
      agentCode: 2,
      toolUrls: 2,
    });
  });

  it("guard throttles D1 checks per isolate (second call is zero-I/O)", async () => {
    __resetRetentionGuardForTests();
    const { db } = await seedDb();
    let prepares = 0;
    const counting = { prepare(sql: string) { prepares++; return (db as any).prepare(sql); } };
    let bg: Promise<unknown> | null = null;
    await expect(
      maybeRunRetention(counting as any, { waitUntil(p: Promise<unknown>) { bg = p; } }, NOW),
    ).resolves.toBe(true);
    await bg; // settle the background purge before counting
    const afterFirst = prepares;
    expect(afterFirst).toBeGreaterThan(0);
    await expect(
      maybeRunRetention(counting as any, { waitUntil(_p: Promise<unknown>) {} }, NOW + 1000),
    ).resolves.toBe(false);
    expect(prepares).toBe(afterFirst);
  });

  it("dry-run and purge on a fresh DB (no tables) report zeros without throwing", async () => {
    const db = sqliteRetentionDb(new Database(":memory:"));
    expect(await dryRunRetention(db, NOW)).toEqual({
      user: 0,
      session: 0,
      conversation: 0,
      global: 0,
      agentCode: 0,
      toolUrls: 0,
    });
    expect(await purgeRetention(db, NOW)).toEqual({
      user: 0,
      session: 0,
      conversation: 0,
      global: 0,
      agentCode: 0,
      toolUrls: 0,
      batches: 1,
      capped: false,
    });
  });
});
