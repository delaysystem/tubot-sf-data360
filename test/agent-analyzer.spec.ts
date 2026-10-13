import { describe, it, expect, vi } from "vitest";
import { AgentAnalyzer } from "../src/agent-analyzer";
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
