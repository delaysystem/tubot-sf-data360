import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, {
  TubotSfData360Entrypoint,
  D1Data360Cache,
  Data360Extractor,
  buildDeclarativeCacheHeaders,
  computeETag,
  isNotModified,
  normalizeCanonicalUrl,
  purgeEdgeCache,
  sanitizeVaryHeader,
  sanitizeHeaders,
  DEFAULT_CACHE_CONTROL,
} from "../src/index";
import type { Data360Env, SalesforceConnection } from "../src/types";

function createMockD1(): D1Database {
  const tables = new Map<string, Map<string, any>>();
  tables.set("data360_user_cache", new Map());
  tables.set("data360_session_cache", new Map());

  return {
    async exec(_sql: string) {
      return { count: 0, duration: 0 };
    },
    prepare(sql: string) {
      return {
        bind(...args: any[]) {
          return {
            async first<T = any>() {
              const lower = sql.toLowerCase();
              if (lower.includes("from data360_user_cache")) {
                const userTable = tables.get("data360_user_cache")!;
                const userId = args[0];
                const row = userTable.get(userId);
                return (row as T) || null;
              }
              if (lower.includes("from data360_session_cache")) {
                const sessionTable = tables.get("data360_session_cache")!;
                const sessionId = args[0];
                const row = sessionTable.get(sessionId);
                return (row as T) || null;
              }
              return null;
            },
            async run() {
              const lower = sql.toLowerCase();
              if (lower.includes("insert into data360_user_cache")) {
                const userTable = tables.get("data360_user_cache")!;
                let userId: string;
                let orgId: string | null;
                let data: string;
                let etag: string | null = null;
                let updatedAt: number;
                let expiresAt: number;
                if (args.length >= 6) {
                  [userId, orgId, data, etag, updatedAt, expiresAt] = args;
                } else {
                  [userId, orgId, data, updatedAt, expiresAt] = args;
                }
                userTable.set(userId, {
                  user_id: userId,
                  org_id: orgId,
                  data,
                  etag,
                  updated_at: updatedAt,
                  expires_at: expiresAt,
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (lower.includes("insert into data360_session_cache")) {
                const sessionTable = tables.get("data360_session_cache")!;
                let sessionId: string;
                let orgId: string | null;
                let data: string;
                let etag: string | null = null;
                let updatedAt: number;
                let expiresAt: number;
                if (args.length >= 6) {
                  [sessionId, orgId, data, etag, updatedAt, expiresAt] = args;
                } else {
                  [sessionId, orgId, data, updatedAt, expiresAt] = args;
                }
                sessionTable.set(sessionId, {
                  session_id: sessionId,
                  org_id: orgId,
                  data,
                  etag,
                  updated_at: updatedAt,
                  expires_at: expiresAt,
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (lower.includes("delete from data360_user_cache")) {
                const userTable = tables.get("data360_user_cache")!;
                const userId = args[0];
                userTable.delete(userId);
                return { success: true, meta: { changes: 1 } };
              }
              if (lower.includes("delete from data360_session_cache")) {
                const sessionTable = tables.get("data360_session_cache")!;
                const sessionId = args[0];
                sessionTable.delete(sessionId);
                return { success: true, meta: { changes: 1 } };
              }
              return { success: true, meta: { changes: 0 } };
            },
            async all() {
              return { results: [], success: true, meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("Cloudflare Declarative Workers Cache & Data360 System", () => {
  let originalFetch: typeof fetch;

  const mockConnection: SalesforceConnection = {
    instanceUrl: "https://test.my.salesforce.com",
    accessToken: "mock-sf-token-123",
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("Cache Helper & Signature Immunity", () => {
    it("provides standard Declarative Workers Cache response headers", () => {
      const headers = buildDeclarativeCacheHeaders({
        tags: ["data360-user", "data360-user-003XX"],
        etag: '"test-etag-123"',
      });

      expect(headers["Cache-Control"]).toBe("public, max-age=0, must-revalidate, s-maxage=300");
      expect(headers["Cache-Control"]).toBe(DEFAULT_CACHE_CONTROL);
      expect(headers["Cache-Control"]).not.toContain("stale-while-revalidate");
      expect(headers["Cache-Tag"]).toBe("data360-user,data360-user-003XX");
      expect(headers["ETag"]).toBe('"test-etag-123"');
      expect(headers["Vary"]).toBeUndefined();
    });

    it("verifies DEFAULT_CACHE_CONTROL enforces 0-cost, 0-stale cache hits and eliminates stale-while-revalidate", () => {
      expect(DEFAULT_CACHE_CONTROL).toBe("public, max-age=0, must-revalidate, s-maxage=300");
      expect(DEFAULT_CACHE_CONTROL).not.toContain("stale-while-revalidate");
      const defaultHeaders = buildDeclarativeCacheHeaders();
      expect(defaultHeaders["Cache-Control"]).toBe("public, max-age=0, must-revalidate, s-maxage=300");
      expect(defaultHeaders["Cache-Control"]).not.toContain("stale-while-revalidate");
    });

    it("enforces signature immunity: never returns Vary: Authorization or signature headers", () => {
      const sanitized1 = sanitizeVaryHeader("Authorization, Accept-Encoding");
      expect(sanitized1).toBe("Accept-Encoding");

      const sanitized2 = sanitizeVaryHeader("x-channel-signature, x-channel-timestamp, User-Agent");
      expect(sanitized2).toBe("User-Agent");

      const sanitizedForbiddenOnly = sanitizeVaryHeader("Authorization, x-channel-signature");
      expect(sanitizedForbiddenOnly).toBeUndefined();

      const headers = new Headers();
      headers.set("Vary", "Authorization, x-channel-timestamp");
      sanitizeHeaders(headers);
      expect(headers.get("Vary")).toBeNull();
    });

    it("normalizes canonical URLs by stripping nonces and signatures", () => {
      const rawUrl =
        "https://api.example.com/api/data360/users/003XX?t=1727280000&sig=abc12345&timestamp=1727280000&nonce=nonce123&orgId=00DXX&userId=003XX";
      const cleanUrl = normalizeCanonicalUrl(rawUrl);

      expect(cleanUrl).toContain("orgId=00DXX");
      expect(cleanUrl).toContain("userId=003XX");
      expect(cleanUrl).not.toContain("t=1727280000");
      expect(cleanUrl).not.toContain("sig=abc12345");
      expect(cleanUrl).not.toContain("timestamp=1727280000");
      expect(cleanUrl).not.toContain("nonce=nonce123");
    });

    it("computes safe strong ETags and checks If-None-Match", async () => {
      const data = { user: "test", count: 42 };
      const etag = await computeETag(data);
      expect(etag).toMatch(/^"[a-f0-9]{32}"$/);

      const reqMatching = new Request("https://example.com", {
        headers: { "if-none-match": etag },
      });
      expect(isNotModified(reqMatching, etag)).toBe(true);

      const reqMismatch = new Request("https://example.com", {
        headers: { "if-none-match": '"other-etag"' },
      });
      expect(isNotModified(reqMismatch, etag)).toBe(false);
    });

    it("purges edge cache programmatically using ctx.cache.purge and fallback", async () => {
      const mockCtxPurge = {
        cache: {
          purge: vi.fn().mockResolvedValue(true),
        },
      };

      const purged = await purgeEdgeCache(mockCtxPurge, ["data360-user-003XX"]);
      expect(purged).toBe(true);
      expect(mockCtxPurge.cache.purge).toHaveBeenCalledWith({ tags: ["data360-user-003XX"] });

      // Fallback behavior when ctx.cache.purge is absent
      const fallbackPurged = await purgeEdgeCache({}, ["data360-user-003XX"]);
      // Returns boolean without throwing
      expect(typeof fallbackPurged).toBe("boolean");
    });

    it("stores, retrieves, and expires items in D1 cache", async () => {
      const mockDb = createMockD1();
      const d1Cache = new D1Data360Cache(mockDb);

      await d1Cache.putUser("user-1", { name: "Alice" }, { orgId: "org-1", ttlSeconds: 100 });
      const cached = await d1Cache.getUser("user-1");
      expect(cached).toEqual({ name: "Alice" });

      await d1Cache.deleteUser("user-1");
      const afterDelete = await d1Cache.getUser("user-1");
      expect(afterDelete).toBeNull();

      // Session cache
      await d1Cache.putSession("session-1", { status: "Active" }, { orgId: "org-1", ttlSeconds: 100 });
      const cachedSession = await d1Cache.getSession("session-1");
      expect(cachedSession).toEqual({ status: "Active" });

      await d1Cache.deleteSession("session-1");
      expect(await d1Cache.getSession("session-1")).toBeNull();
    });

    it("supports fast lightweight ETag lookups via getUserETag and getSessionETag", async () => {
      const mockDb = createMockD1();
      const d1Cache = new D1Data360Cache(mockDb);

      const userEtag = await computeETag({ name: "Bob" });
      await d1Cache.putUser("user-bob", { name: "Bob" }, { orgId: "org-1", ttlSeconds: 100, etag: userEtag });

      const retrievedUserEtag = await d1Cache.getUserETag("user-bob");
      expect(retrievedUserEtag).toBe(userEtag);

      const nonExistentEtag = await d1Cache.getUserETag("non-existent");
      expect(nonExistentEtag).toBeNull();

      const sessionEtag = await computeETag({ status: "Pending" });
      await d1Cache.putSession("sess-bob", { status: "Pending" }, { orgId: "org-1", ttlSeconds: 100, etag: sessionEtag });

      const retrievedSessionEtag = await d1Cache.getSessionETag("sess-bob");
      expect(retrievedSessionEtag).toBe(sessionEtag);

      const nonExistentSessionEtag = await d1Cache.getSessionETag("non-existent-session");
      expect(nonExistentSessionEtag).toBeNull();
    });
  });

  describe("Data360Extractor: extractUserData360 & extractMessagingSessionData360", () => {
    it("extracts complete UserData360 across Individual, Contact, Lead, ContactPoints, and Unified Individual", async () => {
      const mockBatchClient = {
        batchQueries: vi.fn().mockResolvedValue([
          // Individual
          { query: "Individual", records: [{ Id: "0PK001", FirstName: "Jane", LastName: "Doe" }] },
          // Contact
          { query: "Contact", records: [{ Id: "003001", FirstName: "Jane", LastName: "Doe", Email: "jane@example.com" }] },
          // Lead
          { query: "Lead", records: [] },
          // ContactPointEmail
          { query: "ContactPointEmail", records: [{ Id: "0CPE1", EmailAddress: "jane@example.com", IsPrimary: true }] },
          // ContactPointPhone
          { query: "ContactPointPhone", records: [{ Id: "0CPP1", TelephoneNumber: "+15551234567", IsPrimary: true }] },
        ]),
      };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes("/ssot/queryv2")) {
          return Response.json({
            data: [{ ssot__Id__c: "003001", ssot__FirstName__c: "Jane", ssot__LastName__c: "Doe" }],
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const extractor = new Data360Extractor(mockBatchClient as any);
      const result = await extractor.extractUserData360(mockConnection, "003001");

      expect(result.userId).toBe("003001");
      expect(result.individual?.FirstName).toBe("Jane");
      expect(result.contact?.Email).toBe("jane@example.com");
      expect(result.contactPointEmails.length).toBe(1);
      expect(result.contactPointPhones.length).toBe(1);
      expect(result.unifiedIndividual.length).toBeGreaterThan(0);
      expect(result.extractedAt).toBeDefined();
    });

    it("extracts MessagingSessionData360 with transcripts and links Customer 360", async () => {
      const mockBatchClient = {
        batchQueries: vi.fn().mockImplementation(async (_conn: any, queries: string[]) => {
          if (queries[0]?.includes("MessagingSession")) {
            return [
              {
                query: "MessagingSession",
                records: [
                  {
                    Id: "0Mw00000001",
                    ChannelName: "InAppWeb",
                    ChannelType: "EmbeddedMessaging",
                    Status: "Active",
                    ContactId: "003000000001",
                  },
                ],
              },
              {
                query: "ConversationEntry",
                records: [
                  { Id: "0CE1", MessageText: "Hello agent!", ActorType: "User" },
                  { Id: "0CE2", MessageText: "Hi there!", ActorType: "Bot" },
                ],
              },
            ];
          }
          // Fallback for user queries in extractUserData360
          return [
            { query: "Individual", records: [{ Id: "0PK1", FirstName: "John" }] },
            { query: "Contact", records: [{ Id: "003000000001", FirstName: "John", LastName: "Smith" }] },
            { query: "Lead", records: [] },
            { query: "ContactPointEmail", records: [] },
            { query: "ContactPointPhone", records: [] },
          ];
        }),
      };

      const extractor = new Data360Extractor(mockBatchClient as any);
      const result = await extractor.extractMessagingSessionData360(mockConnection, "0Mw00000001");

      expect(result.sessionId).toBe("0Mw00000001");
      expect(result.session?.Status).toBe("Active");
      expect(result.transcripts.length).toBe(2);
      expect(result.customer360?.contact?.FirstName).toBe("John");
    });
  });

  describe("Worker Endpoints & Declarative Edge Caching", () => {
    let mockEnv: Data360Env;

    beforeEach(() => {
      const mockDb = createMockD1();
      mockEnv = {
        DB: mockDb,
        BACKBLAZE_KEY_ID: "test-key-id",
        BACKBLAZE_APPLICATION_KEY: "test-app-key",
        BACKBLAZE_BUCKET_ID: "tubot-encrypted",
        SF_AUTH_CALLER_KEY: "test-data360-caller-key-0123456789abcdef",
        TUBOT_SF_AUTH: {
          getTokenForChannel: vi.fn().mockResolvedValue({
            accessToken: "mock-test-token",
            instanceUrl: "https://test.my.salesforce.com",
            orgId: "00D000000000001AAA",
          }),
        },
      };
    });

    it("GET /api/data360/users/:userId checks D1 cache first and returns Declarative Cache headers", async () => {
      const d1Cache = new D1Data360Cache(mockEnv.DB);
      await d1Cache.putUser("003USER01", { Id: "003USER01", name: "Cached User" });

      const request = new Request("https://example.com/api/data360/users/003USER01?sig=stripme&t=12345");
      const response = await worker.fetch(request, mockEnv);

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
      expect(response.headers.get("Cache-Tag")).toBe("data360-user,data360-user-003USER01");
      expect(response.headers.get("ETag")).toBeDefined();
      expect(response.headers.get("X-Cache-Source")).toBe("d1");

      const body = (await response.json()) as any;
      expect(body.name).toBe("Cached User");
    });

    it("GET /data360/user supports query parameter userId and returns 304 on ETag match", async () => {
      const d1Cache = new D1Data360Cache(mockEnv.DB);
      const userData = { Id: "003USER02", name: "ETag User" };
      await d1Cache.putUser("003USER02", userData);
      const expectedEtag = await computeETag(userData);

      const request = new Request("https://example.com/data360/user?userId=003USER02", {
        headers: { "if-none-match": expectedEtag },
      });
      const response = await worker.fetch(request, mockEnv);

      expect(response.status).toBe(304);
      expect(response.headers.get("Cache-Tag")).toBe("data360-user,data360-user-003USER02");
    });

    it("POST /api/data360/users/:userId saves to D1 and B2, and purges edge cache tag", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        if (String(url).includes("b2api/v2")) {
          return Response.json({
            authorizationToken: "auth-b2",
            apiUrl: "https://api.backblazeb2.com",
            downloadUrl: "https://f004.backblazeb2.com",
          });
        }
        return new Response("ok", { status: 200 });
      });

      const mockCtx = {
        cache: {
          purge: vi.fn().mockResolvedValue(true),
        },
      };

      const request = new Request("https://example.com/api/data360/users/003USER03", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated User", email: "user@example.com" }),
      });

      const response = await worker.fetch(request, mockEnv, mockCtx);
      expect(response.status).toBe(200);

      const resJson = (await response.json()) as any;
      expect(resJson.ok).toBe(true);
      expect(resJson.userId).toBe("003USER03");
      expect(resJson.purgedTag).toBe("data360-user-003USER03");

      // Verify stored in D1
      const d1Cache = new D1Data360Cache(mockEnv.DB);
      const cached = await d1Cache.getUser("003USER03");
      expect(cached.name).toBe("Updated User");
      expect(mockCtx.cache.purge).toHaveBeenCalledWith({ tags: ["data360-user-003USER03"] });
    });

    it("GET & POST /api/data360/messagingsessions/:sessionId manages session cache", async () => {
      const d1Cache = new D1Data360Cache(mockEnv.DB);
      await d1Cache.putSession("0MwSESSION01", { Id: "0MwSESSION01", Status: "Active" });

      // GET
      const getReq = new Request("https://example.com/api/data360/messagingsessions/0MwSESSION01");
      const getRes = await worker.fetch(getReq, mockEnv);
      expect(getRes.status).toBe(200);
      expect(getRes.headers.get("Cache-Tag")).toBe("data360-session,data360-session-0MwSESSION01");
      expect(getRes.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);

      // POST
      const mockCtx = { cache: { purge: vi.fn().mockResolvedValue(true) } };
      const postReq = new Request("https://example.com/api/data360/messagingsessions/0MwSESSION01", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Status: "Ended", EndTimeReason: "AgentResolved" }),
      });

      const postRes = await worker.fetch(postReq, mockEnv, mockCtx);
      expect(postRes.status).toBe(200);
      const postJson = (await postRes.json()) as any;
      expect(postJson.purgedTag).toBe("data360-session-0MwSESSION01");
      expect(mockCtx.cache.purge).toHaveBeenCalledWith({ tags: ["data360-session-0MwSESSION01"] });

      const updated = await d1Cache.getSession("0MwSESSION01");
      expect(updated.Status).toBe("Ended");
    });

    it("POST /api/data360/cache/purge purges cache by tags", async () => {
      const mockCtx = {
        cache: {
          purge: vi.fn().mockResolvedValue(true),
        },
      };

      const purgeReq = new Request("https://example.com/api/data360/cache/purge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: ["data360-user-123", "data360-session-456"] }),
      });

      const purgeRes = await worker.fetch(purgeReq, mockEnv, mockCtx);
      expect(purgeRes.status).toBe(200);
      const purgeJson = (await purgeRes.json()) as any;
      expect(purgeJson.ok).toBe(true);
      expect(purgeJson.purgedTags).toEqual(["data360-user-123", "data360-session-456"]);
      expect(mockCtx.cache.purge).toHaveBeenCalledWith({
        tags: ["data360-user-123", "data360-session-456"],
      });
    });

    it("TubotSfData360Entrypoint RPC methods execute cache and extraction flows cleanly", async () => {
      const mockCtx = { cache: { purge: vi.fn().mockResolvedValue(true) } };
      const entrypoint = new TubotSfData360Entrypoint(mockCtx, mockEnv);

      // 1. saveUserData360 RPC
      const saveUserRes = await entrypoint.saveUserData360("RPC_USER_01", { name: "RPC User" });
      expect(saveUserRes.ok).toBe(true);
      expect(saveUserRes.userId).toBe("RPC_USER_01");
      expect(saveUserRes.purgedTag).toBe("data360-user-RPC_USER_01");

      // 2. getUserData360 RPC (hits D1 cache)
      const fetchedUser = await entrypoint.getUserData360("RPC_USER_01");
      expect(fetchedUser).toEqual({ name: "RPC User" });

      // 3. saveMessagingSessionData360 RPC
      const saveSessionRes = await entrypoint.saveMessagingSessionData360("RPC_SESS_01", {
        status: "Active",
      });
      expect(saveSessionRes.ok).toBe(true);
      expect(saveSessionRes.sessionId).toBe("RPC_SESS_01");
      expect(saveSessionRes.purgedTag).toBe("data360-session-RPC_SESS_01");

      // 4. getMessagingSessionData360 RPC (hits D1 cache)
      const fetchedSession = await entrypoint.getMessagingSessionData360("RPC_SESS_01");
      expect(fetchedSession).toEqual({ status: "Active" });

      // 5. purgeCache RPC
      const purgeResult = await entrypoint.purgeCache(["data360-user", "custom-tag"]);
      expect(purgeResult.ok).toBe(true);
      expect(purgeResult.tags).toEqual(["data360-user", "custom-tag"]);

      // 6. getUserETag & getSessionETag RPC
      const userEtag = await entrypoint.getUserETag("RPC_USER_01");
      expect(userEtag).toBeDefined();
      expect(typeof userEtag).toBe("string");

      const sessionEtag = await entrypoint.getSessionETag("RPC_SESS_01");
      expect(sessionEtag).toBeDefined();
      expect(typeof sessionEtag).toBe("string");
    });

    it("ensures fast-path ETag checks return 304 Not Modified when request has If-None-Match matching stored ETag", async () => {
      const d1Cache = new D1Data360Cache(mockEnv.DB);
      const userData = { Id: "FAST_USER_01", name: "Fast User", score: 99 };
      const userEtag = await computeETag(userData);
      await d1Cache.putUser("FAST_USER_01", userData, { orgId: "org-1", etag: userEtag });

      // Matching ETag on User endpoint -> 304 Not Modified
      const userReq = new Request("https://example.com/api/data360/users/FAST_USER_01", {
        headers: { "if-none-match": userEtag },
      });
      const userRes = await worker.fetch(userReq, mockEnv);
      expect(userRes.status).toBe(304);
      expect(userRes.headers.get("ETag")).toBe(userEtag);
      expect(userRes.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
      expect(userRes.headers.get("Cache-Tag")).toBe("data360-user,data360-user-FAST_USER_01");

      // Matching ETag on Session endpoint -> 304 Not Modified
      const sessionData = { Id: "FAST_SESS_01", status: "Active" };
      const sessEtag = await computeETag(sessionData);
      await d1Cache.putSession("FAST_SESS_01", sessionData, { orgId: "org-1", etag: sessEtag });

      const sessReq = new Request("https://example.com/api/data360/messagingsessions/FAST_SESS_01", {
        headers: { "if-none-match": sessEtag },
      });
      const sessRes = await worker.fetch(sessReq, mockEnv);
      expect(sessRes.status).toBe(304);
      expect(sessRes.headers.get("ETag")).toBe(sessEtag);
      expect(sessRes.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
      expect(sessRes.headers.get("Cache-Tag")).toBe("data360-session,data360-session-FAST_SESS_01");
    });

    it("ensures 0-stale guarantee: If-None-Match mismatch never serves stale cache", async () => {
      const d1Cache = new D1Data360Cache(mockEnv.DB);
      const userData = { Id: "USER_FRESH", name: "Fresh Version" };
      const freshEtag = await computeETag(userData);
      await d1Cache.putUser("USER_FRESH", userData, { orgId: "org-1", etag: freshEtag });

      // Client has stale/old ETag
      const staleEtag = '"stale-etag-99999"';
      const req = new Request("https://example.com/api/data360/users/USER_FRESH", {
        headers: { "if-none-match": staleEtag },
      });
      const res = await worker.fetch(req, mockEnv);

      // Must NOT be 304, must be 200 with fresh body
      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toBe(freshEtag);
      expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
      expect(res.headers.get("Cache-Control")).not.toContain("stale-while-revalidate");
      const body = await res.json() as any;
      expect(body.name).toBe("Fresh Version");
    });

    it("POST user and POST session compute new ETag, save it, invoke purgeEdgeCache, and return ETag", async () => {
      const mockCtx = { cache: { purge: vi.fn().mockResolvedValue(true) } };

      // POST User
      const postUserReq = new Request("https://example.com/api/data360/users/USER_POST_01", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new@example.com", name: "New Name" }),
      });
      const postUserRes = await worker.fetch(postUserReq, mockEnv, mockCtx);
      expect(postUserRes.status).toBe(200);
      expect(postUserRes.headers.get("ETag")).toBeDefined();
      const userJson = await postUserRes.json() as any;
      expect(userJson.ok).toBe(true);
      expect(userJson.etag).toBeDefined();
      expect(userJson.purgedTag).toBe("data360-user-USER_POST_01");
      expect(mockCtx.cache.purge).toHaveBeenCalledWith({ tags: ["data360-user-USER_POST_01"] });

      // Verify ETag stored in D1
      const d1Cache = new D1Data360Cache(mockEnv.DB);
      const storedUserEtag = await d1Cache.getUserETag("USER_POST_01");
      expect(storedUserEtag).toBe(userJson.etag);

      // POST Session
      const postSessReq = new Request("https://example.com/api/data360/messagingsessions/SESS_POST_01", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Status: "Ended", Channel: "Web" }),
      });
      const postSessRes = await worker.fetch(postSessReq, mockEnv, mockCtx);
      expect(postSessRes.status).toBe(200);
      expect(postSessRes.headers.get("ETag")).toBeDefined();
      const sessJson = await postSessRes.json() as any;
      expect(sessJson.ok).toBe(true);
      expect(sessJson.etag).toBeDefined();
      expect(sessJson.purgedTag).toBe("data360-session-SESS_POST_01");
      expect(mockCtx.cache.purge).toHaveBeenCalledWith({ tags: ["data360-session-SESS_POST_01"] });

      // Verify ETag stored in D1
      const storedSessEtag = await d1Cache.getSessionETag("SESS_POST_01");
      expect(storedSessEtag).toBe(sessJson.etag);
    });
  });
});
