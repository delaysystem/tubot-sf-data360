import { describe, it, expect, vi } from "vitest";
import { AgentAnalyzer } from "../src/agent-analyzer";
import { CACHE_TTL, channelMapCacheKey } from "../src/cache";
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

  function installFakeCaches() {
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
    return { store, match, put };
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
    const originalCaches = (globalThis as any).caches;
    const fake = installFakeCaches();
    const fetchMock = installSalesforceFetch();
    globalThis.fetch = fetchMock;
    try {
      const key = channelMapCacheKey(orgId, channelId);
      fake.store.set(
        `https://cache.internal/v1/${key}`,
        Response.json(
          {
            agentName: "CACHED_AGENT",
            channelRecord: { Id: channelId, DeveloperName: "Cached_Channel" },
            channelDeveloperName: "Cached_Channel",
          },
          { headers: { "Cache-Control": `max-age=${CACHE_TTL.channelMap}` } }
        )
      );

      const resolved = await analyzer.resolveChannelAndAgent(connWithOrg, channelId);
      expect(resolved.agentName).toBe("CACHED_AGENT");
      expect(resolved.channelDeveloperName).toBe("Cached_Channel");
      expect(resolved.channelRecord?.Id).toBe(channelId);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).caches = originalCaches;
    }
  });

  it("stores the resolution on a miss and serves the second call from cache", async () => {
    const analyzer = new AgentAnalyzer();
    const originalFetch = globalThis.fetch;
    const originalCaches = (globalThis as any).caches;
    const fake = installFakeCaches();
    const fetchMock = installSalesforceFetch();
    globalThis.fetch = fetchMock;
    try {
      const first = await analyzer.resolveChannelAndAgent(connWithOrg, channelId);
      expect(first.agentName).toBe("DATA360TEST");
      expect(first.channelDeveloperName).toBe("Data360_Channel");
      expect(fetchMock).toHaveBeenCalled();

      const key = channelMapCacheKey(orgId, channelId);
      const stored = fake.store.get(`https://cache.internal/v1/${key}`);
      expect(stored).toBeDefined();
      expect(stored?.headers.get("Cache-Control")).toBe(`max-age=${CACHE_TTL.channelMap}`);
      expect(await stored?.clone().json()).toEqual({
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
      (globalThis as any).caches = originalCaches;
    }
  });

  it("skips caching entirely when conn.orgId is missing", async () => {
    const analyzer = new AgentAnalyzer();
    const originalFetch = globalThis.fetch;
    const originalCaches = (globalThis as any).caches;
    const fake = installFakeCaches();
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
      expect(fake.match).not.toHaveBeenCalled();
      expect(fake.put).not.toHaveBeenCalled();
      expect(fake.store.size).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).caches = originalCaches;
    }
  });
});
