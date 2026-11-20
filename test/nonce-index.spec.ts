import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import {
  claimServiceNonce,
  ensureNonceSchema,
  SIG_NONCE_TTL_SEC,
  type NonceDb,
} from "../src/service-verify";

/** bun:sqlite-backed NonceDb (same engine family as D1/workerd). */
function sqliteNonceDb(sqlite: Database): NonceDb {
  return {
    prepare(sql: string) {
      const bound =
        (...args: unknown[]) =>
        ({
          async run() {
            const res = sqlite.query(sql).run(...(args as any[]));
            return { meta: { changes: Number((res as any).changes ?? 0) } };
          },
        }) as any;
      return {
        bind: bound,
        async run() {
          sqlite.exec(sql);
          return { meta: { changes: 0 } };
        },
      } as any;
    },
  };
}

const DELETE_SQL = "DELETE FROM salesforce_self_oauth_internal_nonce WHERE expires_at <= ?";

describe("F10 nonce expiry index", () => {
  it("creates the table + expires_at index once per DB handle", async () => {
    const sqlite = new Database(":memory:");
    const db = sqliteNonceDb(sqlite);
    const seen: string[] = [];
    const outer = db.prepare.bind(db);
    const recording = {
      prepare(sql: string) {
        seen.push(sql);
        return outer(sql);
      },
    } as NonceDb;
    await ensureNonceSchema(recording);
    await ensureNonceSchema(recording);
    expect(seen.filter((s) => s.startsWith("CREATE"))).toHaveLength(2);
    expect(
      sqlite
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
        .get("salesforce_self_oauth_internal_nonce_expiry_idx"),
    ).not.toBeNull();
  });

  it("turns the per-RPC expired-nonce DELETE into an index SEARCH", async () => {
    const sqlite = new Database(":memory:");
    const db = sqliteNonceDb(sqlite);
    sqlite.exec(
      "CREATE TABLE salesforce_self_oauth_internal_nonce (nonce_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
    );
    const before = (
      sqlite.query(`EXPLAIN QUERY PLAN ${DELETE_SQL}`).all() as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join(" | ");
    expect(before).toContain("SCAN");
    await ensureNonceSchema(db);
    const after = (
      sqlite.query(`EXPLAIN QUERY PLAN ${DELETE_SQL}`).all() as Array<{ detail: string }>
    )
      .map((r) => r.detail)
      .join(" | ");
    expect(after).toContain("USING INDEX salesforce_self_oauth_internal_nonce_expiry_idx");
    expect(after).not.toContain("SCAN");
  });

  it("preserves single-use + expiry-purge nonce semantics", async () => {
    const sqlite = new Database(":memory:");
    const db = sqliteNonceDb(sqlite);
    const t = 1_700_000_000;
    expect(await claimServiceNonce(db, "nonce-A-0123456789abcdef", t)).toBe(true);
    // Replay of the same nonce fails.
    expect(await claimServiceNonce(db, "nonce-A-0123456789abcdef", t + 1)).toBe(false);
    // A distinct nonce still claims.
    expect(await claimServiceNonce(db, "nonce-B-0123456789abcdef", t + 1)).toBe(true);
    // Expired rows are purged by the per-claim DELETE.
    sqlite
      .query("INSERT INTO salesforce_self_oauth_internal_nonce VALUES (?, ?)")
      .run("expired-row", t - 1);
    expect(await claimServiceNonce(db, "nonce-C-0123456789abcdef", t + 2)).toBe(true);
    expect(
      sqlite
        .query("SELECT COUNT(*) AS c FROM salesforce_self_oauth_internal_nonce WHERE nonce_hash='expired-row'")
        .get() as { c: number },
    ).toEqual({ c: 0 });
    // Fresh claims carry the TTL past the claim second.
    expect(
      (sqlite
        .query("SELECT COUNT(*) AS c FROM salesforce_self_oauth_internal_nonce WHERE expires_at = ?")
        .get(t + 2 + SIG_NONCE_TTL_SEC) as { c: number }).c,
    ).toBe(1);
  });
});
