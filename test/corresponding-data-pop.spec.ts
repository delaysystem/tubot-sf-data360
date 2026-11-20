import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { signedRequest } from "./helpers/http-gate";
import worker, {
  TubotSfData360Entrypoint,
  D1Data360Cache,
  computeETag,
  isNotModified,
  normalizeCanonicalUrl,
  clearAllMemoryCaches,
  DEFAULT_CACHE_CONTROL,
} from "../src/index";
import type {
  Data360Env,
  CorrespondingDataResult,
  UserConversationHistory,
  UserData360Result,
} from "../src/types";

function createMockD1(): { db: D1Database; tables: Map<string, Map<string, any>> } {
  const tables = new Map<string, Map<string, any>>();
  tables.set("data360_user_cache", new Map());
  tables.set("data360_session_cache", new Map());
  tables.set("data360_conversation_cache", new Map());
  tables.set("data360_global_cache", new Map());
  tables.set("salesforce_self_oauth_internal_nonce", new Map());

  const db = {
    async exec(_sql: string) {
      return { count: 0, duration: 0 };
    },
    prepare(sql: string) {
      let boundArgs: any[] = [];
      const stmt = {
        bind(...args: any[]) {
          boundArgs = args;
          return stmt;
        },
        async first<T = any>() {
          const lower = sql.toLowerCase();
          if (lower.includes("from data360_user_cache")) {
            const table = tables.get("data360_user_cache")!;
            return (table.get(boundArgs[0]) as T) || null;
          }
          if (lower.includes("from data360_session_cache")) {
            const table = tables.get("data360_session_cache")!;
            return (table.get(boundArgs[0]) as T) || null;
          }
          if (lower.includes("from data360_conversation_cache")) {
            const table = tables.get("data360_conversation_cache")!;
            return (table.get(boundArgs[0]) as T) || null;
          }
          if (lower.includes("from data360_global_cache")) {
            const table = tables.get("data360_global_cache")!;
            return (table.get(boundArgs[0]) as T) || null;
          }
          return null;
        },
        async run() {
          const lower = sql.toLowerCase();
          if (lower.includes("create table")) {
            return { success: true, meta: { changes: 0 } };
          }
          if (lower.includes("salesforce_self_oauth_internal_nonce")) {
            const table = tables.get("salesforce_self_oauth_internal_nonce")!;
            if (lower.startsWith("delete ")) {
              for (const [k, v] of table.entries()) {
                if ((v as any).expires_at <= boundArgs[0]) table.delete(k);
              }
              return { success: true, meta: { changes: 0 } };
            }
            if (table.has(boundArgs[0])) return { success: true, meta: { changes: 0 } };
            table.set(boundArgs[0], { hash: boundArgs[0], expires_at: boundArgs[1] });
            return { success: true, meta: { changes: 1 } };
          }
          if (lower.includes("insert into data360_user_cache")) {
            const table = tables.get("data360_user_cache")!;
            const [userId, orgId, data, etag, updatedAt, expiresAt] = boundArgs;
            table.set(userId, {
              user_id: userId,
              org_id: orgId,
              data,
              etag,
              updated_at: updatedAt,
              expires_at: expiresAt,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (lower.includes("delete from data360_user_cache")) {
            const table = tables.get("data360_user_cache")!;
            const existed = table.delete(boundArgs[0]);
            return { success: true, meta: { changes: existed ? 1 : 0 } };
          }
          if (lower.includes("insert into data360_conversation_cache")) {
            const table = tables.get("data360_conversation_cache")!;
            const [userId, orgId, data, etag, sessionCount, totalMessages, updatedAt, expiresAt] = boundArgs;
            table.set(userId, {
              user_id: userId,
              org_id: orgId,
              data,
              etag,
              session_count: sessionCount,
              total_messages: totalMessages,
              updated_at: updatedAt,
              expires_at: expiresAt,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (lower.includes("delete from data360_conversation_cache")) {
            const table = tables.get("data360_conversation_cache")!;
            const existed = table.delete(boundArgs[0]);
            return { success: true, meta: { changes: existed ? 1 : 0 } };
          }
          if (lower.includes("insert into data360_global_cache")) {
            const table = tables.get("data360_global_cache")!;
            const [targetId, orgId, data, etag, updatedAt, expiresAt] = boundArgs;
            table.set(targetId, {
              target_id: targetId,
              org_id: orgId,
              data,
              etag,
              updated_at: updatedAt,
              expires_at: expiresAt,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (lower.includes("delete from data360_global_cache")) {
            const table = tables.get("data360_global_cache")!;
            const existed = table.delete(boundArgs[0]);
            return { success: true, meta: { changes: existed ? 1 : 0 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  return { db, tables };
}

describe("Corresponding Data: Real Conversation Simulation & Pop Testing", () => {
  const channelId = "0Mjg00000000001AAA";
  const userId = "003000000000001AAA";
  const session1Id = "0Mw000000000001AAA";
  const session2Id = "0Mw000000000002AAA";
  const orgId = "00D000000000001AAA";

  let mockD1: { db: D1Database; tables: Map<string, Map<string, any>> };
  let env: Data360Env;
  let conversationState: UserConversationHistory;
  let originalFetch: typeof fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    // Explicit-token userinfo validation and B2 lookups fail fast and
    // deterministically, exercising the same fallback paths as live failures.
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    mockD1 = createMockD1();

    // Initial conversation state for Session 1 with 1 message
    conversationState = {
      userId,
      totalSessions: 1,
      totalMessages: 1,
      lastActiveAt: "2026-09-26T10:00:00.000Z",
      extractedAt: "2026-09-26T10:00:00.000Z",
      sessions: [
        {
          sessionId: session1Id,
          channelId,
          startTime: "2026-09-26T10:00:00.000Z",
          status: "Active",
          messages: [
            {
              id: "0Me000000000001AAA",
              senderType: "user",
              message: "Hi, I need help with my account status.",
              timestamp: "2026-09-26T10:00:00.000Z",
              actorName: "Alice Customer",
            },
          ],
        },
      ],
    };

    env = {
      DB: mockD1.db,
      DATA360_INTERNAL_KEY: "mesh-key-0123456789abcdef0123456789abcd",
      SF_CREDENTIAL_ENCRYPTION_KEY: "test-key",
      SF_AUTH_CALLER_KEY: "test-data360-caller-key-0123456789abcdef",
      TUBOT_SF_AUTH: {
        async getTokenForChannel(_chId: string) {
          return {
            accessToken: "test-access-token",
            instanceUrl: "https://test.my.salesforce.com",
            orgId,
            teamId: "team-123",
          };
        },
        async getUserConversationHistory(_uId: string) {
          return JSON.parse(JSON.stringify(conversationState));
        },
      },
    };

    clearAllMemoryCaches(mockD1.db);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("Phase 1: Multi-Turn Conversation Simulation", () => {
    it("Turn 1 (Initial contact): fetches all 3 components on cache MISS and saves them to D1", async () => {
      const req = await signedRequest(env, "GET",
        `https://tubot-sf-data360.internal/api/data360/corresponding-data?userId=${userId}&channelId=${channelId}&sessionId=${session1Id}&orgId=${orgId}`,
        {
          headers: {
            "x-salesforce-access-token": "test-token",
            "x-salesforce-instance-url": "https://test.my.salesforce.com",
            "x-team-id": "team-123",
          },
        },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const compositeEtag = res.headers.get("ETag");
      expect(compositeEtag).toBeTruthy();
      expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
      expect(res.headers.get("X-Cache-Global")).toBe("MISS");
      expect(res.headers.get("X-Cache-Individual")).toBe("MISS");
      expect(res.headers.get("X-Cache-Conversations")).toBe("MISS");

      const body: CorrespondingDataResult = await res.json();
      expect(body.ok).toBe(true);
      expect(body.userId).toBe(userId);
      expect(body.channelId).toBe(channelId);
      expect(body.sessionId).toBe(session1Id);
      expect(body.cacheBreakdown.globalData360.cached).toBe(false);
      expect(body.cacheBreakdown.individualData360.cached).toBe(false);
      expect(body.cacheBreakdown.conversationHistory.cached).toBe(false);
      expect(body.cacheBreakdown.conversationHistory.totalMessages).toBe(1);
      expect(body.conversationHistory?.sessions.length).toBe(1);

      // Verify all 3 components are now stored in D1 cache
      expect(mockD1.tables.get("data360_global_cache")?.has(channelId)).toBe(true);
      expect(mockD1.tables.get("data360_user_cache")?.has(userId)).toBe(true);
      expect(mockD1.tables.get("data360_conversation_cache")?.has(userId)).toBe(true);
    });

    it("Turn 2 (Instant re-check / conditional check): returns 304 Not Modified with 0 upstream calls", async () => {
      // Setup D1 with cached items
      const d1Cache = new D1Data360Cache(mockD1.db);
      const globalEtag = '"global-etag-1"';
      const userEtag = '"user-etag-1"';
      const convEtag = '"conv-etag-1"';
      await d1Cache.putGlobalData360(channelId, { channelId, status: "Active" }, { etag: globalEtag });
      await d1Cache.putUser(userId, { userId, name: "Alice" }, { etag: userEtag });
      await d1Cache.putConversationHistory(userId, conversationState, { etag: convEtag });

      const expectedComposite = await computeETag(`${globalEtag}:${userEtag}:${convEtag}`);

      const req = await signedRequest(env, "GET",
        `https://tubot-sf-data360.internal/api/data360/corresponding-data?userId=${userId}&channelId=${channelId}&sessionId=${session1Id}`,
        {
          headers: {
            "If-None-Match": expectedComposite,
          },
        },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(304);
      expect(res.headers.get("ETag")).toBe(expectedComposite);
      expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
    });

    it("Turn 3 (Conversation progression / Bot replies): Global & Individual are CACHE HITS, only Conversation updates", async () => {
      const d1Cache = new D1Data360Cache(mockD1.db);
      const globalEtag = '"global-v1"';
      const userEtag = '"user-v1"';
      await d1Cache.putGlobalData360(channelId, { channelId, name: "Support Channel" }, { etag: globalEtag });
      await d1Cache.putUser(userId, { userId, firstName: "Alice" }, { etag: userEtag });

      // Alice receives reply: conversation now has 2 messages
      conversationState.totalMessages = 2;
      conversationState.sessions[0].messages.push({
        id: "0Me000000000002AAA",
        senderType: "bot",
        message: "Hello Alice! Your account is active and in good standing.",
        timestamp: "2026-09-26T10:00:30.000Z",
        actorName: "Agentforce Bot",
      });

      // Conversation cache was not yet populated or was invalidated for new message
      const req = await signedRequest(env, "GET",
        `https://tubot-sf-data360.internal/api/data360/corresponding-data?userId=${userId}&channelId=${channelId}&sessionId=${session1Id}&orgId=${orgId}`,
        {
          headers: {
            "x-salesforce-access-token": "test-token",
            "x-salesforce-instance-url": "https://test.my.salesforce.com",
            "x-team-id": "team-123",
          },
        },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Cache-Global")).toBe("HIT");
      expect(res.headers.get("X-Cache-Individual")).toBe("HIT");
      expect(res.headers.get("X-Cache-Conversations")).toBe("MISS");

      const body: CorrespondingDataResult = await res.json();
      expect(body.cacheBreakdown.globalData360.cached).toBe(true);
      expect(body.cacheBreakdown.globalData360.source).toBe("d1");
      expect(body.cacheBreakdown.individualData360.cached).toBe(true);
      expect(body.cacheBreakdown.individualData360.source).toBe("d1");
      expect(body.cacheBreakdown.conversationHistory.cached).toBe(false);
      expect(body.cacheBreakdown.conversationHistory.totalMessages).toBe(2);

      // Now conversation is stored in D1 as well
      expect(mockD1.tables.get("data360_conversation_cache")?.has(userId)).toBe(true);
    });

    it("Turn 4 (Cross-Session Pop / Next Session Continuity): retrieves history across Session 1 and Session 2", async () => {
      // Simulate Session 1 ended and Session 2 started
      conversationState.totalSessions = 2;
      conversationState.totalMessages = 3;
      conversationState.sessions.unshift({
        sessionId: session2Id,
        channelId,
        startTime: "2026-09-27T09:00:00.000Z",
        status: "Active",
        messages: [
          {
            id: "0Me000000000003AAA",
            senderType: "user",
            message: "I am following up on my previous conversation from yesterday.",
            timestamp: "2026-09-27T09:00:00.000Z",
            actorName: "Alice Customer",
          },
        ],
      });

      const d1Cache = new D1Data360Cache(mockD1.db);
      // Pre-seed Global and User
      await d1Cache.putGlobalData360(channelId, { channelId, name: "Support Channel" });
      await d1Cache.putUser(userId, { userId, name: "Alice" });

      const req = await signedRequest(env, "POST",
        `https://tubot-sf-data360.internal/api/data360/corresponding-data`,
        {
          headers: { "x-team-id": "team-123" },
          body: {
            userId,
            channelId,
            sessionId: session2Id,
            teamId: "team-123",
            orgId,
          },
        },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);

      const body: CorrespondingDataResult = await res.json();
      expect(body.ok).toBe(true);
      expect(body.cacheBreakdown.globalData360.cached).toBe(true);
      expect(body.cacheBreakdown.individualData360.cached).toBe(true);
      expect(body.conversationHistory?.sessions.length).toBe(2);
      expect(body.conversationHistory?.sessions[0].sessionId).toBe(session2Id);
      expect(body.conversationHistory?.sessions[1].sessionId).toBe(session1Id);
      expect(body.conversationHistory?.totalMessages).toBe(3);
    });
  });

  describe("Phase 2: Component Cache Pop & Eviction Testing", () => {
    it("Evicting Individual Data360 cache re-extracts user without popping Global or Conversation cache", async () => {
      const d1Cache = new D1Data360Cache(mockD1.db);
      const globalEtag = '"global-stable"';
      const convEtag = '"conv-stable"';
      await d1Cache.putGlobalData360(channelId, { channelId, version: "1.0" }, { etag: globalEtag });
      await d1Cache.putConversationHistory(userId, conversationState, { etag: convEtag });

      // Notice: user cache is intentionally NOT in D1 (popped / evicted)
      expect(mockD1.tables.get("data360_user_cache")?.has(userId)).toBe(false);

      const req = await signedRequest(env, "GET",
        `https://tubot-sf-data360.internal/api/data360/corresponding-data?userId=${userId}&channelId=${channelId}`,
        {
          headers: {
            "x-salesforce-access-token": "test-token",
            "x-salesforce-instance-url": "https://test.my.salesforce.com",
          },
        },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Cache-Global")).toBe("HIT");
      expect(res.headers.get("X-Cache-Individual")).toBe("MISS");
      expect(res.headers.get("X-Cache-Conversations")).toBe("HIT");

      const body: CorrespondingDataResult = await res.json();
      expect(body.cacheBreakdown.globalData360.cached).toBe(true);
      expect(body.cacheBreakdown.individualData360.cached).toBe(false);
      expect(body.cacheBreakdown.conversationHistory.cached).toBe(true);

      // Now user cache is re-populated in D1
      expect(mockD1.tables.get("data360_user_cache")?.has(userId)).toBe(true);
    });

    it("Evicting Global Data360 cache re-extracts global channel without popping User or Conversation cache", async () => {
      const d1Cache = new D1Data360Cache(mockD1.db);
      const userEtag = '"user-stable"';
      const convEtag = '"conv-stable"';
      await d1Cache.putUser(userId, { userId, name: "Alice" }, { etag: userEtag });
      await d1Cache.putConversationHistory(userId, conversationState, { etag: convEtag });

      // Notice: global cache is intentionally NOT in D1 (popped / evicted)
      expect(mockD1.tables.get("data360_global_cache")?.has(channelId)).toBe(false);

      const req = await signedRequest(env, "GET",
        `https://tubot-sf-data360.internal/api/data360/corresponding-data?userId=${userId}&channelId=${channelId}`,
        {
          headers: {
            "x-salesforce-access-token": "test-token",
            "x-salesforce-instance-url": "https://test.my.salesforce.com",
          },
        },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Cache-Global")).toBe("MISS");
      expect(res.headers.get("X-Cache-Individual")).toBe("HIT");
      expect(res.headers.get("X-Cache-Conversations")).toBe("HIT");

      const body: CorrespondingDataResult = await res.json();
      expect(body.cacheBreakdown.globalData360.cached).toBe(false);
      expect(body.cacheBreakdown.individualData360.cached).toBe(true);
      expect(body.cacheBreakdown.conversationHistory.cached).toBe(true);
    });

    it("Explicit bypassCache=true bypasses all 3 caches simultaneously", async () => {
      const d1Cache = new D1Data360Cache(mockD1.db);
      await d1Cache.putGlobalData360(channelId, { channelId, version: "old" });
      await d1Cache.putUser(userId, { userId, name: "Old Alice" });
      await d1Cache.putConversationHistory(userId, conversationState);

      const req = await signedRequest(env, "GET",
        `https://tubot-sf-data360.internal/api/data360/corresponding-data?userId=${userId}&channelId=${channelId}&bypassCache=true`,
        {
          headers: {
            "x-salesforce-access-token": "test-token",
            "x-salesforce-instance-url": "https://test.my.salesforce.com",
          },
        },
      );

      const res = await worker.fetch(req, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Cache-Global")).toBe("MISS");
      expect(res.headers.get("X-Cache-Individual")).toBe("MISS");
      expect(res.headers.get("X-Cache-Conversations")).toBe("MISS");

      const body: CorrespondingDataResult = await res.json();
      expect(body.cacheBreakdown.globalData360.cached).toBe(false);
      expect(body.cacheBreakdown.individualData360.cached).toBe(false);
      expect(body.cacheBreakdown.conversationHistory.cached).toBe(false);
    });
  });

  describe("Phase 3: RPC Entrypoint Pop Testing", () => {
    it("TubotSfData360Entrypoint.getCorrespondingData retrieves and caches all 3 components via RPC", async () => {
      const { signRpcEnvelope } = await import("../../tubot-new-panel/worker/service-signer");
      const entrypoint = new TubotSfData360Entrypoint({ waitUntil: () => {} }, env);
      const sign = async (args: unknown) => {
        const h = await signRpcEnvelope(env.DATA360_INTERNAL_KEY!, "getCorrespondingData", args);
        return { timestamp: h["x-tubot-sig-timestamp"], nonce: h["x-tubot-sig-nonce"], signature: h["x-tubot-sig-signature"] };
      };

      const args1 = {
        userId,
        channelId,
        sessionId: session1Id,
        accessToken: "test-token",
        instanceUrl: "https://test.my.salesforce.com",
      };
      const result1 = await entrypoint.getCorrespondingData(args1, await sign([args1]));

      expect(result1.ok).toBe(true);
      expect(result1.userId).toBe(userId);
      expect(result1.channelId).toBe(channelId);
      expect(result1.compositeETag).toBeTruthy();
      expect(result1.cacheBreakdown.globalData360.cached).toBe(false);
      expect(result1.cacheBreakdown.individualData360.cached).toBe(false);
      expect(result1.cacheBreakdown.conversationHistory.cached).toBe(false);

      // Second invocation via RPC: all 3 should be cached (HIT)
      const args2 = {
        userId,
        channelId,
        sessionId: session1Id,
      };
      const result2 = await entrypoint.getCorrespondingData(args2, await sign([args2]));

      expect(result2.ok).toBe(true);
      expect(result2.compositeETag).toBe(result1.compositeETag);
      expect(result2.cacheBreakdown.globalData360.cached).toBe(true);
      expect(result2.cacheBreakdown.globalData360.source).toBe("d1");
      expect(result2.cacheBreakdown.individualData360.cached).toBe(true);
      expect(result2.cacheBreakdown.individualData360.source).toBe("d1");
      expect(result2.cacheBreakdown.conversationHistory.cached).toBe(true);
      expect(result2.cacheBreakdown.conversationHistory.source).toBe("d1");
    });
  });

  describe("Phase 4: Input Validation & Edge Cases", () => {
    it("returns 401 without credentials and 400 when userId is missing", async () => {
      const anon = new Request(
        `https://tubot-sf-data360.internal/api/data360/corresponding-data?channelId=${channelId}`,
        { method: "GET" }
      );
      expect((await worker.fetch(anon, env)).status).toBe(401);
      const req = await signedRequest(env, "GET",
        `https://tubot-sf-data360.internal/api/data360/corresponding-data?channelId=${channelId}`,
      );
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("invalid_request");
    });

    it("returns 401 without credentials and 400 when channelId is missing", async () => {
      const anon = new Request(
        `https://tubot-sf-data360.internal/api/data360/corresponding-data?userId=${userId}`,
        { method: "GET" }
      );
      expect((await worker.fetch(anon, env)).status).toBe(401);
      const req = await signedRequest(env, "GET",
        `https://tubot-sf-data360.internal/api/data360/corresponding-data?userId=${userId}`,
      );
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("invalid_request");
    });

    it("returns 401 without credentials and 400 for malformed POST body", async () => {
      const anon = new Request(
        `https://tubot-sf-data360.internal/api/data360/corresponding-data`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{ invalid_json ",
        }
      );
      expect((await worker.fetch(anon, env)).status).toBe(401);
      const req = await signedRequest(env, "POST",
        `https://tubot-sf-data360.internal/api/data360/corresponding-data`,
        { body: "{ invalid_json " },
      );
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("invalid_json");
    });
  });
});
