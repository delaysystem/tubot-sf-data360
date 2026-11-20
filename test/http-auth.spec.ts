import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signedRequest } from "./helpers/http-gate";
import worker, { D1Data360Cache, clearAllMemoryCaches } from "../src/index";
import type { Data360Env } from "../src/types";

/**
 * HTTP-layer authentication gate (security audit D2/D1): every data route
 * requires an HMAC service signature or a live-validated Salesforce token.
 * Scope-only requests (ids without a credential) are rejected, token-mode
 * cache reads bind to the validated org, and failure fallbacks cache with a
 * short negative TTL instead of shadowing real rows at full TTL.
 */

const KEY = "mesh-key-0123456789abcdef0123456789abcd";
const ORG_A = "00D000000000001AAA";
const ORG_B = "00D000000000002BBB";
const USER = "005000000000001AAA";

function createMockD1(): { db: D1Database; tables: Map<string, Map<string, any>> } {
  const tables = new Map<string, Map<string, any>>([
    ["data360_user_cache", new Map()],
    ["salesforce_self_oauth_internal_nonce", new Map()],
  ]);
  const db = {
    async exec(_sql: string) {
      return { count: 0, duration: 0 };
    },
    prepare(sql: string) {
      const stmt: any = {
        bind(...args: any[]) {
          return {
            async first() {
              const lower = sql.toLowerCase();
              for (const [name, table] of tables.entries()) {
                if (!lower.includes(`from ${name}`)) continue;
                const row = table.get(args[0]);
                if (!row) return null;
                // Enforce the org predicate exactly like D1 would.
                if (lower.includes("org_id = ?") && row.org_id !== args[1]) return null;
                return row;
              }
              return null;
            },
            async run() {
              const lower = sql.toLowerCase();
              if (lower.includes("salesforce_self_oauth_internal_nonce")) {
                const table = tables.get("salesforce_self_oauth_internal_nonce")!;
                if (lower.startsWith("delete ")) {
                  for (const [k, v] of table.entries()) {
                    if (v.expires_at <= args[0]) table.delete(k);
                  }
                  return { success: true, meta: { changes: 0 } };
                }
                if (table.has(args[0])) return { success: true, meta: { changes: 0 } };
                table.set(args[0], { hash: args[0], expires_at: args[1] });
                return { success: true, meta: { changes: 1 } };
              }
              if (lower.includes("insert into data360_user_cache")) {
                const [userId, orgId, data, etag, updatedAt, expiresAt] = args;
                tables.get("data360_user_cache")!.set(userId, {
                  user_id: userId, org_id: orgId, data, etag, updated_at: updatedAt, expires_at: expiresAt,
                });
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            },
          };
        },
        async run() {
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;
  return { db, tables };
}

describe("HTTP auth gate", () => {
  let mockD1: ReturnType<typeof createMockD1>;
  let env: Data360Env;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockD1 = createMockD1();
    clearAllMemoryCaches(mockD1.db);
    env = {
      DB: mockD1.db,
      DATA360_INTERNAL_KEY: KEY,
      SF_AUTH_CALLER_KEY: "test-data360-caller-key-0123456789abcdef",
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const tokenHeaders = (org: string) => ({
    Authorization: "Bearer live-user-token",
    "x-salesforce-instance-url": "https://test.my.salesforce.com",
    "x-org-id": org,
  });

  function mockUserinfo(org: string | null) {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).endsWith("/services/oauth2/userinfo")) {
        if (!org) return new Response("{}", { status: 401 });
        return Response.json({ organization_id: org });
      }
      return new Response("{}", { status: 401 });
    });
  }

  it("returns 401 on every gated path without credentials", async () => {
    const cases: Array<[string, string, unknown?]> = [
      ["POST", "https://x.internal/api/data360/cache/purge", { tags: ["t"] }],
      ["POST", "https://x.internal/data360/cache/purge", { tags: ["t"] }],
      ["GET", `https://x.internal/api/v1/context?userId=${USER}&channelId=c`],
      ["POST", "https://x.internal/api/v1/context", { userId: USER, channelId: "c" }],
      ["GET", `https://x.internal/api/data360/context?userId=${USER}&channelId=c`],
      ["GET", `https://x.internal/data360/context?userId=${USER}&channelId=c`],
      ["GET", `https://x.internal/context?userId=${USER}&channelId=c`],
      ["GET", `https://x.internal/api/data360/corresponding-data?userId=${USER}&channelId=c`],
      ["GET", `https://x.internal/data360/corresponding-data?userId=${USER}&channelId=c`],
      ["GET", `https://x.internal/api/data360/users/${USER}`],
      ["GET", `https://x.internal/users/${USER}/data360`],
      ["POST", `https://x.internal/api/data360/users/${USER}`, { data: { a: 1 } }],
      ["GET", "https://x.internal/api/data360/messagingsessions/0Mw000000000001AAA"],
      ["POST", "https://x.internal/api/data360/messagingsessions/0Mw000000000001AAA", { data: { a: 1 } }],
      ["POST", "https://x.internal/export", { channelId: "c" }],
      ["POST", "https://x.internal/api/export", { channelId: "c" }],
    ];
    for (const [method, url, body] of cases) {
      const req = new Request(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(401);
    }
  });

  it("rejects scope-only requests (ids without a credential)", async () => {
    const req = new Request(
      `https://x.internal/api/v1/context?userId=${USER}&channelId=0Mj000000000001AAA&teamId=team-1&orgId=${ORG_A}`,
      { method: "GET", headers: { "x-team-id": "team-1", "x-org-id": ORG_A } },
    );
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("rejects tokens that fail live userinfo validation", async () => {
    mockUserinfo(null);
    const req = new Request(`https://x.internal/api/data360/users/${USER}`, {
      method: "GET",
      headers: tokenHeaders(ORG_A),
    });
    expect((await worker.fetch(req, env)).status).toBe(401);
  });

  it("rejects asserted orgs that mismatch the validated token org", async () => {
    mockUserinfo(ORG_A);
    const req = new Request(`https://x.internal/api/data360/users/${USER}`, {
      method: "GET",
      headers: tokenHeaders(ORG_B),
    });
    expect((await worker.fetch(req, env)).status).toBe(403);
  });

  it("keeps purge service-only: a valid user token still gets 401", async () => {
    mockUserinfo(ORG_A);
    const req = new Request("https://x.internal/api/data360/cache/purge", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...tokenHeaders(ORG_A) },
      body: JSON.stringify({ tags: ["t"] }),
    });
    expect((await worker.fetch(req, env)).status).toBe(401);
  });

  it("replays of an HMAC signature fail the second claim", async () => {
    const body = { tags: ["t"] };
    const first = await signedRequest(env, "POST", "https://x.internal/api/data360/cache/purge", { body });
    expect((await worker.fetch(first, env, {} as any)).status).toBe(200);
    // Identical bytes + identical signature headers: the nonce is spent.
    const replay = new Request("https://x.internal/api/data360/cache/purge", {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify(body),
    });
    expect((await worker.fetch(replay, env, {} as any)).status).toBe(401);
  });

  it("serves a same-org cached row to a validated token", async () => {
    mockUserinfo(ORG_A);
    const cache = new D1Data360Cache(mockD1.db);
    await cache.putUser(USER, { userId: USER, secret: "org-a-data" }, { orgId: ORG_A });
    const req = new Request(`https://x.internal/api/data360/users/${USER}`, {
      method: "GET",
      headers: tokenHeaders(ORG_A),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.secret).toBe("org-a-data");
  });

  it("never serves another org's cached row, even when the id matches", async () => {
    mockUserinfo(ORG_A);
    const cache = new D1Data360Cache(mockD1.db);
    await cache.putUser(USER, { userId: USER, secret: "org-b-data" }, { orgId: ORG_B });
    const req = new Request(`https://x.internal/api/data360/users/${USER}`, {
      method: "GET",
      headers: tokenHeaders(ORG_A),
    });
    const res = await worker.fetch(req, env);
    // Miss on the org-bound read, then extraction fails (no SF): 502, and
    // crucially the org-B row is never served.
    expect(res.status).toBe(502);
  });

  it("writes failure fallbacks with a short negative TTL, not the full default", async () => {
    mockUserinfo(ORG_A);
    const req = await signedRequest(env, "POST", "https://x.internal/api/v1/context", {
      body: { userId: "missing-user-1", channelId: "missing-channel-1", teamId: "team-1", orgId: ORG_A },
    });
    // Service mode trusts scope; the channel lookup fails (no auth binding),
    // so every component falls back — and must cache briefly, not 300s+.
    const noAuthEnv = { ...env };
    delete (noAuthEnv as any).TUBOT_SF_AUTH;
    const res = await worker.fetch(req, noAuthEnv);
    expect(res.status).toBe(200);
    const row = mockD1.tables.get("data360_user_cache")!.get("missing-user-1");
    expect(row).toBeDefined();
    expect(row.expires_at - row.updated_at).toBeLessThanOrEqual(60_000);
  });
});
