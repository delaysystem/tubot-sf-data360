/** F15 retention purges for the tubot-sf-data360 D1 caches (user, session,
 * conversation, global, agent-code, tool-urls). Expired rows are treated as a
 * miss by every reader (and even self-delete on exact-key re-read), but rows
 * that are never re-read accumulate forever, so a daily cron calls
 * purgeRetention(); dryRunRetention() reports the exact backlog first using
 * the same predicates without LIMIT.
 *
 * Trigger choice: hot-path piggyback with a daily-run guard, NOT a cron. A
 * cron was the first design (own budget, off-peak), but the account is at the
 * Workers Free limit of 5 cron triggers, so new crons fail to register and
 * break deploys. The piggyback keeps user calls safe instead: an isolate-local
 * throttle (one D1 guard read per hour max), an atomic cross-isolate daily
 * claim, and the purge itself always in ctx.waitUntil — zero added latency,
 * and the purge is idempotent + batch-capped so a duplicate run is harmless.
 * The scheduled() handler stays in the worker as dormant-ready code: re-adding
 * the 3-line triggers block if cron capacity ever frees up just works.
 *
 * Window (conservative): rows expired for over 1d grace. expires_at is
 * MILLISECONDS here (Date.now()); expires_at = 0 means never-expire and is
 * always kept. Expired rows are invisible to every reader, so deletion
 * reclaims storage only; the grace covers skew/debug. Boundary (pinned by
 * tests): `expires_at <= cutoff` purges, mirroring the readers' own expiry
 * checks with the grace applied.
 */

export const DATA360_CACHE_PURGE_GRACE_MS = 24 * 3600 * 1000;
export const RETENTION_BATCH_SIZE = 500;
export const RETENTION_MAX_BATCHES = 50;

/** Minimal D1 surface the purge needs; real D1Database is assignable. */
export interface RetentionDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      first<T>(column?: string): Promise<T | null>;
      run(): Promise<{ meta?: { changes?: number } }>;
    };
    run(): Promise<{ meta?: { changes?: number } }>;
  };
}

export interface CacheTableDef {
  key: "user" | "session" | "conversation" | "global" | "agentCode" | "toolUrls";
  table: string;
  index: string;
}

export const CACHE_TABLES: CacheTableDef[] = [
  { key: "user", table: "data360_user_cache", index: "data360_user_cache_expires_idx" },
  { key: "session", table: "data360_session_cache", index: "data360_session_cache_expires_idx" },
  { key: "conversation", table: "data360_conversation_cache", index: "data360_conversation_cache_expires_idx" },
  { key: "global", table: "data360_global_cache", index: "data360_global_cache_expires_idx" },
  { key: "agentCode", table: "data360_agent_code_cache", index: "data360_agent_code_cache_expires_idx" },
  { key: "toolUrls", table: "data360_tool_urls_cache", index: "data360_tool_urls_cache_expires_idx" },
];

const EXPIRED_PREDICATE = "expires_at > 0 AND expires_at <= ?";

/** Defensive index DDL (idempotent no-op once ensureSchema has applied; it
 * guarantees the purge seeks even on a DB the cache never initialized). */
export const retentionIndexSql = (def: CacheTableDef): string =>
  `CREATE INDEX IF NOT EXISTS ${def.index} ON ${def.table} (expires_at)`;

/** Dry-run counts: the exact purge predicate, no LIMIT (full backlog). */
export const dryRunSql = (def: CacheTableDef): string =>
  `SELECT COUNT(*) AS n FROM ${def.table} WHERE ${EXPIRED_PREDICATE}`;

/** Batched delete. D1 has no DELETE..LIMIT, hence the rowid/IN-subselect
 * form; the LIMIT is baked from our own constant (no injection surface). */
export const purgeSql = (def: CacheTableDef): string =>
  `DELETE FROM ${def.table} WHERE rowid IN (SELECT rowid FROM ${def.table} WHERE ${EXPIRED_PREDICATE} LIMIT ${RETENTION_BATCH_SIZE})`;

export interface Data360RetentionCounts {
  user: number;
  session: number;
  conversation: number;
  global: number;
  agentCode: number;
  toolUrls: number;
}

export interface Data360PurgeSummary extends Data360RetentionCounts {
  batches: number;
  capped: boolean;
}

const isMissingTable = (error: unknown): boolean =>
  error instanceof Error && /no such table/i.test(error.message);

async function count(db: RetentionDb, sql: string, cutoff: number): Promise<number> {
  try {
    const row = await db.prepare(sql).bind(cutoff).first<{ n: number }>();
    return row?.n ?? 0;
  } catch (error) {
    // Fresh DB where the table was never created: nothing to purge.
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

async function changes(db: RetentionDb, sql: string, cutoff: number): Promise<number> {
  try {
    const res = await db.prepare(sql).bind(cutoff).run();
    return res.meta?.changes ?? 0;
  } catch (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
}

export function retentionCutoffMs(nowMs: number = Date.now()): number {
  return nowMs - DATA360_CACHE_PURGE_GRACE_MS;
}

export async function dryRunRetention(db: RetentionDb, nowMs: number = Date.now()): Promise<Data360RetentionCounts> {
  const cutoff = retentionCutoffMs(nowMs);
  const out = {} as Data360RetentionCounts;
  await Promise.all(
    CACHE_TABLES.map(async (def) => {
      out[def.key] = await count(db, dryRunSql(def), cutoff);
    }),
  );
  return out;
}

/** Batched purge: one capped delete per table per iteration until an
 * iteration deletes nothing or the batch cap is hit. Idempotent: a re-run
 * deletes zero rows. */
export async function purgeRetention(db: RetentionDb, nowMs: number = Date.now()): Promise<Data360PurgeSummary> {
  const cutoff = retentionCutoffMs(nowMs);
  for (const def of CACHE_TABLES) {
    try {
      await db.prepare(retentionIndexSql(def)).run();
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
  }
  const total: Data360RetentionCounts = { user: 0, session: 0, conversation: 0, global: 0, agentCode: 0, toolUrls: 0 };
  let batches = 0;
  let capped = false;
  for (;;) {
    batches++;
    let round = 0;
    for (const def of CACHE_TABLES) {
      const n = await changes(db, purgeSql(def), cutoff);
      total[def.key] += n;
      round += n;
    }
    if (round === 0) break;
    if (batches >= RETENTION_MAX_BATCHES) {
      capped = true;
      break;
    }
  }
  return { ...total, batches, capped };
}

// ---------- daily-run guard (piggyback trigger) ----------

/** Guard-table key for THIS worker. sf-auth and data360 share the same D1
 * databases (staging and prod), so each worker claims its own key. */
export const RETENTION_GUARD_KEY = "data360_daily_v1";
export const RETENTION_GUARD_INTERVAL_MS = 24 * 3600 * 1000;
/** Per-isolate D1 check throttle: hot calls past this return false with zero I/O. */
export const RETENTION_GUARD_CHECK_THROTTLE_MS = 3600 * 1000;
export const RETENTION_GUARD_DDL =
  "CREATE TABLE IF NOT EXISTS f15_retention_guard (key TEXT PRIMARY KEY, last_run_at INTEGER NOT NULL)";
const RETENTION_GUARD_READ_SQL = "SELECT last_run_at FROM f15_retention_guard WHERE key = ?";
const RETENTION_GUARD_CLAIM_SQL = `INSERT INTO f15_retention_guard(key,last_run_at) VALUES(?,?)
  ON CONFLICT(key) DO UPDATE SET last_run_at=? WHERE f15_retention_guard.last_run_at <= ?`;

let lastGuardCheckMs = 0;
const guardDdlDone = new WeakSet<object>();
/** Test-only reset for the isolate-local throttle. */
export function __resetRetentionGuardForTests(): void {
  lastGuardCheckMs = 0;
}

/** Hot-path entry: at most one D1 guard read per isolate per hour; the purge
 * itself runs in ctx.waitUntil only after winning the atomic daily claim.
 * Never throws, never blocks the caller. Returns true when a purge started. */
export async function maybeRunRetention(
  db: RetentionDb | undefined,
  ctx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  nowMs: number = Date.now(),
): Promise<boolean> {
  try {
    if (!db || !ctx || typeof ctx.waitUntil !== "function") return false;
    if (nowMs - lastGuardCheckMs < RETENTION_GUARD_CHECK_THROTTLE_MS) return false;
    lastGuardCheckMs = nowMs;
    if (!guardDdlDone.has(db)) {
      await db.prepare(RETENTION_GUARD_DDL).run();
      guardDdlDone.add(db);
    }
    const row = await db.prepare(RETENTION_GUARD_READ_SQL).bind(RETENTION_GUARD_KEY).first<{ last_run_at: number }>();
    if (row && row.last_run_at > nowMs - RETENTION_GUARD_INTERVAL_MS) return false;
    const claim = await db
      .prepare(RETENTION_GUARD_CLAIM_SQL)
      .bind(RETENTION_GUARD_KEY, nowMs, nowMs, nowMs - RETENTION_GUARD_INTERVAL_MS)
      .run();
    if ((claim.meta?.changes ?? 0) !== 1) return false;
    ctx.waitUntil(
      purgeRetention(db, nowMs).then(
        (summary) => console.log(JSON.stringify({ msg: "f15_retention_purge", ...summary })),
        (error) => console.error(JSON.stringify({ msg: "f15_retention_purge_error", error: String(error) })),
      ),
    );
    return true;
  } catch {
    return false;
  }
}
