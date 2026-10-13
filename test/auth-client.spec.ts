import { describe, it, expect, vi } from "vitest";
import { SalesforceAuthBridge } from "../src/auth-client";
import type { Data360Env } from "../src/types";

describe("SalesforceAuthBridge", () => {
  it("resolves direct access token and instance URL without remote calls", async () => {
    const bridge = new SalesforceAuthBridge({});
    const res = await bridge.resolveToken({
      accessToken: "direct-token-abc",
      instanceUrl: "https://myorg.my.salesforce.com/",
    });

    expect(res.connection.accessToken).toBe("direct-token-abc");
    expect(res.connection.instanceUrl).toBe("https://myorg.my.salesforce.com");
  });

  it("resolves token via TUBOT_SF_AUTH RPC method", async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      accessToken: "rpc-token-123",
      instanceUrl: "https://rpc.my.salesforce.com",
      orgId: "00D000000000001AAA",
    });

    const env: Data360Env = {
      TUBOT_SF_AUTH: {
        getTokenForChannel: mockRpc,
      },
    };

    const bridge = new SalesforceAuthBridge(env);
    const res = await bridge.resolveToken({ channelId: "0Mjg00000000001AAA" });

    expect(mockRpc).toHaveBeenCalledWith("0Mjg00000000001AAA", {
      teamId: undefined,
      orgId: undefined,
      channelSecret: undefined,
    });
    expect(res.connection.accessToken).toBe("rpc-token-123");
    expect(res.connection.instanceUrl).toBe("https://rpc.my.salesforce.com");
    expect(res.orgId).toBe("00D000000000001AAA");
  });

  it("resolves token via service binding fetch when RPC is not available", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        ok: true,
        accessToken: "fetch-token-456",
        instanceUrl: "https://fetch.my.salesforce.com",
        orgId: "00D000000000002AAA",
      })
    );

    const env: Data360Env = {
      TUBOT_SF_AUTH: {
        fetch: mockFetch,
      },
    };

    const bridge = new SalesforceAuthBridge(env);
    const res = await bridge.resolveToken({ channelId: "0Mjg00000000002AAA" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(res.connection.accessToken).toBe("fetch-token-456");
    expect(res.connection.instanceUrl).toBe("https://fetch.my.salesforce.com");
  });

  it("throws error when neither token nor channelId is provided", async () => {
    const bridge = new SalesforceAuthBridge({});
    await expect(bridge.resolveToken({})).rejects.toThrow(
      "Either a valid Salesforce channelId/agentName or both accessToken and instanceUrl must be provided."
    );
  });
});
