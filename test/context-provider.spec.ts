import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, {
  TubotSfData360Entrypoint,
  D1Data360Cache,
  assembleContext,
  computeETag,
} from "../src/index";
import type { Data360Env, GetContextOptions, Context } from "../src/types";

function createMockD1(): { db: D1Database; tables: Map<string, Map<string, any>> } {
  const tables = new Map<string, Map<string, any>>();
  tables.set("data360_user_cache", new Map());
  tables.set("data360_session_cache", new Map());
  tables.set("data360_conversation_cache", new Map());
  tables.set("data360_global_cache", new Map());
  tables.set("data360_agent_code_cache", new Map());
  tables.set("data360_tool_urls_cache", new Map());
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
          for (const [tableName, tableMap] of tables.entries()) {
            if (lower.includes(`from ${tableName}`)) {
              return (tableMap.get(boundArgs[0]) as T) || null;
            }
          }
          return null;
        },
        async run() {
          const lower = sql.toLowerCase();
          if (lower.includes("create table")) {
            return { success: true, meta: { changes: 0 } };
          }
          for (const [tableName, tableMap] of tables.entries()) {
            if (lower.includes(`insert or ignore into ${tableName}`)) {
              if (tableMap.has(boundArgs[0])) return { success: true, meta: { changes: 0 } };
              tableMap.set(boundArgs[0], { hash: boundArgs[0], expires_at: boundArgs[1] });
              return { success: true, meta: { changes: 1 } };
            }
            if (lower.includes(`delete from ${tableName}`) && tableName.includes("nonce")) {
              for (const [k, v] of tableMap.entries()) {
                if ((v as any).expires_at <= boundArgs[0]) tableMap.delete(k);
              }
              return { success: true, meta: { changes: 0 } };
            }
            if (lower.includes(`insert into ${tableName}`)) {
              const key = boundArgs[0];
              tableMap.set(key, {
                key,
                org_id: boundArgs[1],
                data: boundArgs[2],
                urls: boundArgs[2], // for tool_urls
                etag: boundArgs[3],
                updated_at: boundArgs[4],
                expires_at: boundArgs[5],
              });
              return { success: true, meta: { changes: 1 } };
            }
            if (lower.includes(`delete from ${tableName}`)) {
              const existed = tableMap.delete(boundArgs[0]);
              return { success: true, meta: { changes: existed ? 1 : 0 } };
            }
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  } as unknown as D1Database;

  return { db, tables };
}

describe("tubot-sf-data360 Context Provider & Smart Caching", () => {
  let mockEnv: Data360Env;
  let mockD1: { db: D1Database; tables: Map<string, Map<string, any>> };
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("b2_authorize_account")) {
        return new Response("{}", { status: 401 });
      }
      if (urlStr.includes("/composite/batch")) {
        return Response.json({ hasErrors: false, results: [] });
      }
      return Response.json({ records: [] });
    });
    mockD1 = createMockD1();
    mockEnv = {
      DB: mockD1.db,
      DATA360_INTERNAL_KEY: "mesh-key-0123456789abcdef0123456789abcd",
      SF_AUTH_CALLER_KEY: "test-data360-caller-key-0123456789abcdef",
      TUBOT_SF_AUTH: {
        async getTokenForChannel(channelId: string) {
          return {
            accessToken: "mock-token-xyz",
            instanceUrl: "https://testorg.my.salesforce.com",
            orgId: "00D800000000001AAA",
            teamId: "team-1",
          };
        },
        async getCallableToolUrlsForChannel(channelId: string) {
          return [
            "https://retrieve64.internal/tools/verify_customer",
            "https://retrieve64.internal/tools/lookup_cases",
          ];
        },
        async getUserConversationHistory(userId: string) {
          return {
            userId,
            sessions: [
              {
                sessionId: "sess-001",
                messages: [
                  { senderType: "user", message: "Hi, I need help with my account." },
                  { senderType: "agent", message: "Hello! How can I assist you today?" },
                ],
              },
            ],
            totalSessions: 1,
            totalMessages: 2,
            extractedAt: new Date().toISOString(),
          };
        },
      },
      TUBOT_SF_PARSER: {
        async translateToCel(content: string) {
          return {
            agentName: "ServiceAgent",
            format: "agent_script",
            variables: {
              isVerified: { name: "isVerified", type: "boolean", defaultValue: false },
            },
            topics: [
              {
                name: "agent_router",
                description: "Root router topic",
                actions: [],
                transitionGates: [
                  { targetTopic: "ServiceCustomerVerification", condition: "!variables.isVerified" },
                ],
              },
              {
                name: "ServiceCustomerVerification",
                description: "Customer verification subagent",
                actions: [
                  { name: "verify_customer", target: "Flow.VerifyCustomer", condition: "true" },
                ],
                transitionGates: [],
              },
            ],
          };
        },
      },
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("assembleContext returns all 5 non-negotiable requirements for tubot-agentcode", async () => {
    const options: GetContextOptions = {
      userId: "user-123",
      channelId: "channel-abc",
      agentName: "ServiceAgent",
      teamId: "team-1",
      orgId: "00D800000000001AAA",
      agentScript: `system_prompt: "Service agent"\ntopic agent_router {}`,
    };

    const result = await assembleContext(mockEnv, {}, options);

    expect(result.ok).toBe(true);
    expect(result.compositeETag).toBeTruthy();

    const context: Context = result.context;
    // 1. precompiledAgent
    expect(context.precompiledAgent).toBeDefined();
    expect(context.precompiledAgent.agentName).toBe("ServiceAgent");
    expect(context.precompiledAgent.topics.length).toBeGreaterThan(0);

    // 2. customerData
    expect(context.customerData).toBeDefined();
    expect(context.customerData.userId).toBe("user-123");

    // 3. conversationHistory
    expect(Array.isArray(context.conversationHistory)).toBe(true);
    expect(context.conversationHistory.length).toBe(2);
    expect(context.conversationHistory[0].role).toBe("user");
    expect(context.conversationHistory[0].content).toBe("Hi, I need help with my account.");

    // 4. globalData
    expect(context.globalData).toBeDefined();

    // 5. toolCallUrls
    expect(Array.isArray(context.toolCallUrls)).toBe(true);
    expect(context.toolCallUrls).toContain("https://retrieve64.internal/tools/verify_customer");
  });

  it("smartly caches precompiledAgent and toolCallUrls in D1 on subsequent turns", async () => {
    const options: GetContextOptions = {
      userId: "user-123",
      channelId: "channel-abc",
      teamId: "team-1",
      orgId: "00D800000000001AAA",
    };

    // First call: Cache MISS for both
    const turn1 = await assembleContext(mockEnv, {}, options);
    expect(turn1.cacheBreakdown.precompiledAgent.cached).toBe(false);
    expect(turn1.cacheBreakdown.toolCallUrls.cached).toBe(false);

    // Verify written to D1 tables
    expect(mockD1.tables.get("data360_agent_code_cache")?.size).toBe(1);
    expect(mockD1.tables.get("data360_tool_urls_cache")?.size).toBe(1);

    // Second call: Cache HIT for all components
    const turn2 = await assembleContext(mockEnv, {}, options);
    expect(turn2.cacheBreakdown.precompiledAgent.cached).toBe(true);
    expect(turn2.cacheBreakdown.precompiledAgent.source).toBe("d1");
    expect(turn2.cacheBreakdown.toolCallUrls.cached).toBe(true);
    expect(turn2.cacheBreakdown.toolCallUrls.source).toBe("d1");
    expect(turn2.context.precompiledAgent.agentName).toBe("ServiceAgent");
    expect(turn2.context.toolCallUrls.length).toBe(2);
  });

  it("TubotSfData360Entrypoint RPC getContext returns pure Context", async () => {
    const { signRpcEnvelope } = await import("../../tubot-new-panel/worker/service-signer");
    const entrypoint = new TubotSfData360Entrypoint({} as any, mockEnv);
    const args = [{ userId: "user-999", channelId: "channel-xyz" }];
    const headers = await signRpcEnvelope(mockEnv.DATA360_INTERNAL_KEY!, "getContext", args);
    const context = await entrypoint.getContext(args[0], {
      timestamp: headers["x-tubot-sig-timestamp"],
      nonce: headers["x-tubot-sig-nonce"],
      signature: headers["x-tubot-sig-signature"],
    });

    expect(context.precompiledAgent).toBeDefined();
    expect(context.customerData).toBeDefined();
    expect(Array.isArray(context.conversationHistory)).toBe(true);
    expect(context.globalData).toBeDefined();
    expect(Array.isArray(context.toolCallUrls)).toBe(true);
  });

  it("RPC methods reject missing, replayed, and wrong-key envelopes", async () => {
    const { signRpcEnvelope } = await import("../../tubot-new-panel/worker/service-signer");
    const entrypoint = new TubotSfData360Entrypoint({} as any, mockEnv);
    await expect(entrypoint.getToolUrls("channel-xyz")).rejects.toThrow("data360_rpc_unauthorized");
    const key = mockEnv.DATA360_INTERNAL_KEY!;
    const headers = await signRpcEnvelope(key, "getToolUrls", ["channel-xyz"]);
    const envelope = {
      timestamp: headers["x-tubot-sig-timestamp"],
      nonce: headers["x-tubot-sig-nonce"],
      signature: headers["x-tubot-sig-signature"],
    };
    await expect(entrypoint.getToolUrls("channel-xyz", envelope)).resolves.toEqual([]);
    await expect(entrypoint.getToolUrls("channel-xyz", envelope)).rejects.toThrow("data360_rpc_unauthorized");
    const forged = await signRpcEnvelope("wrong-key-0123456789abcdef0123456789ab", "getToolUrls", ["channel-xyz"]);
    await expect(entrypoint.getToolUrls("channel-xyz", {
      timestamp: forged["x-tubot-sig-timestamp"],
      nonce: forged["x-tubot-sig-nonce"],
      signature: forged["x-tubot-sig-signature"],
    })).rejects.toThrow("data360_rpc_unauthorized");
  });

  it("serves REST API POST /api/v1/context with cache headers and composite ETag", async () => {
    const req = new Request("https://tubot-sf-data360.internal/api/v1/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        userId: "user-456",
        channelId: "channel-rest",
      }),
    });

    const res = await worker.fetch(req, mockEnv);
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.context.precompiledAgent).toBeDefined();
    expect(json.context.toolCallUrls).toBeDefined();
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(res.headers.get("Cache-Tag")).toContain("data360-tools-channel-rest");
  });

  it("validates required parameters and returns 400 when missing userId or channelId", async () => {
    const req = new Request("https://tubot-sf-data360.internal/api/v1/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-only" }),
    });

    const res = await worker.fetch(req, mockEnv);
    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error).toBe("invalid_request");
  });
});
