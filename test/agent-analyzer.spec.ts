import { describe, it, expect, vi, afterEach } from "vitest";
import { AgentAnalyzer } from "../src/agent-analyzer";
import { CACHE_TTL, channelMapCacheKey, initCache } from "../src/cache";
import type { SalesforceConnection } from "../src/types";

describe("AgentAnalyzer", () => {
  const conn: SalesforceConnection = {
    accessToken: "mock-analyzer-token",
    instanceUrl: "https://test.my.salesforce.com",
  };

  it("extracts DMOs, segment IDs, actions, and prompt templates from agent script DSL", () => {
    const analyzer = new AgentAnalyzer();
    const sampleScript = `
system:
    instructions: "You are the Marketer Agent"
variables:
    segment_on_entity: mutable string = "ssot__Individual__dlm"
    segmentId: mutable string = "1sgg50000001kX3AAI"
actions:
    CdpSegmentOverlapAction:
        target: "standardInvocableAction://cdpSegmentOverlapAction"
    CustomDmoQuery:
        target: "custom_dmo__dlm"
    RunPrompt:
        target: "@promptTemplates.Personalized_Schedule"
`;

    const discovered = analyzer.analyzeAgentScript(sampleScript, {
      ExtraTemplate: "<template/>",
    });

    // Core DMOs + explicitly referenced
    expect(discovered.dmoNames).toContain("ssot__Individual__dlm");
    expect(discovered.dmoNames).toContain("custom_dmo__dlm");
    expect(discovered.referencedSegmentIds).toContain("1sgg50000001kX3AAI");
    expect(discovered.actions).toContain("standardInvocableAction://cdpSegmentOverlapAction");
    expect(discovered.promptTemplateNames).toContain("Personalized_Schedule");
    expect(discovered.promptTemplateNames).toContain("ExtraTemplate");
  });

  it("resolves channel to agent name when SessionHandlerId is a BotDefinition", async () => {
    const analyzer = new AgentAnalyzer();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/composite/batch")) {
        return Response.json({
          hasErrors: false,
          results: [
            {
              statusCode: 200,
              result: {
                records: [
                  {
                    Id: "0Mjg5000000VtMnCAK",
                    DeveloperName: "Data360_Channel",
                    MasterLabel: "Data360 Channel",
                    SessionHandlerId: "0Xxg5000001fWMjCAM",
                  },
                ],
              },
            },
            { statusCode: 200, result: { records: [] } },
            { statusCode: 200, result: { records: [] } },
            { statusCode: 200, result: { records: [] } },
          ],
        });
      }

      const decodedUrl = decodeURIComponent(url);
      if (decodedUrl.includes("FROM BotDefinition")) {
        return Response.json({
          records: [
            {
              Id: "0Xxg5000001fWMjCAM",
              DeveloperName: "DATA360TEST",
            },
          ],
        });
      }

      return Response.json({ records: [] });
    });

    try {
      const resolved = await analyzer.resolveChannelAndAgent(conn, "0Mjg5000000VtMnCAK");
      expect(resolved.agentName).toBe("DATA360TEST");
      expect(resolved.channelDeveloperName).toBe("Data360_Channel");
      expect(resolved.channelRecord?.Id).toBe("0Mjg5000000VtMnCAK");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("AgentAnalyzer channel-map caching", () => {
  const orgId = "00D000000000001AAA";
  const connWithOrg: SalesforceConnection = {
    accessToken: "mock-analyzer-token",
    instanceUrl: "https://test.my.salesforce.com",
    orgId,
  };
  const channelId = "0Mjg5000000VtMnCAK";

  afterEach(() => {
    initCache(null);
  });

  function installFakeKV() {
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
    return { store, get, put };
  }

  function installSalesforceFetch() {
    return vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/composite/batch")) {
        return Response.json({
          hasErrors: false,
          results: [
            {
              statusCode: 200,
              result: {
                records: [
                  {
                    Id: channelId,
                    DeveloperName: "Data360_Channel",
                    MasterLabel: "Data360 Channel",
                    SessionHandlerId: "0Xxg5000001fWMjCAM",
                  },
                ],
              },
            },
            { statusCode: 200, result: { records: [] } },
            { statusCode: 200, result: { records: [] } },
            { statusCode: 200, result: { records: [] } },
          ],
        });
      }
      const decodedUrl = decodeURIComponent(url);
      if (decodedUrl.includes("FROM BotDefinition")) {
        return Response.json({
          records: [{ Id: "0Xxg5000001fWMjCAM", DeveloperName: "DATA360TEST" }],
        });
      }
      return Response.json({ records: [] });
    });
  }

  it("returns the cached resolution on a channel-map hit without querying Salesforce", async () => {
    const analyzer = new AgentAnalyzer();
    const originalFetch = globalThis.fetch;
    const fake = installFakeKV();
    const fetchMock = installSalesforceFetch();
    globalThis.fetch = fetchMock;
    try {
      const key = channelMapCacheKey(orgId, channelId);
      fake.store.set(
        key,
        JSON.stringify({
          agentName: "CACHED_AGENT",
          channelRecord: { Id: channelId, DeveloperName: "Cached_Channel" },
          channelDeveloperName: "Cached_Channel",
        })
      );

      const resolved = await analyzer.resolveChannelAndAgent(connWithOrg, channelId);
      expect(resolved.agentName).toBe("CACHED_AGENT");
      expect(resolved.channelDeveloperName).toBe("Cached_Channel");
      expect(resolved.channelRecord?.Id).toBe(channelId);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      initCache(null);
    }
  });

  it("stores the resolution on a miss and serves the second call from cache", async () => {
    const analyzer = new AgentAnalyzer();
    const originalFetch = globalThis.fetch;
    const fake = installFakeKV();
    const fetchMock = installSalesforceFetch();
    globalThis.fetch = fetchMock;
    try {
      const first = await analyzer.resolveChannelAndAgent(connWithOrg, channelId);
      expect(first.agentName).toBe("DATA360TEST");
      expect(first.channelDeveloperName).toBe("Data360_Channel");
      expect(fetchMock).toHaveBeenCalled();

      const key = channelMapCacheKey(orgId, channelId);
      const stored = fake.store.get(key);
      expect(stored).toBeDefined();
      expect(fake.put).toHaveBeenCalledWith(key, expect.any(String), {
        expirationTtl: CACHE_TTL.channelMap,
      });
      expect(JSON.parse(stored!)).toEqual({
        agentName: "DATA360TEST",
        channelRecord: expect.objectContaining({ Id: channelId }),
        channelDeveloperName: "Data360_Channel",
      });

      fetchMock.mockClear();
      const second = await analyzer.resolveChannelAndAgent(connWithOrg, channelId);
      expect(second).toEqual(first);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      initCache(null);
    }
  });

  it("skips caching entirely when conn.orgId is missing", async () => {
    const analyzer = new AgentAnalyzer();
    const originalFetch = globalThis.fetch;
    const fake = installFakeKV();
    const fetchMock = installSalesforceFetch();
    globalThis.fetch = fetchMock;
    try {
      const connNoOrg: SalesforceConnection = {
        accessToken: "mock-analyzer-token",
        instanceUrl: "https://test.my.salesforce.com",
      };
      const resolved = await analyzer.resolveChannelAndAgent(connNoOrg, channelId);
      expect(resolved.agentName).toBe("DATA360TEST");
      expect(fetchMock).toHaveBeenCalled();
      expect(fake.get).not.toHaveBeenCalled();
      expect(fake.put).not.toHaveBeenCalled();
      expect(fake.store.size).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      initCache(null);
    }
  });
});
