import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SalesforceAuthBridge } from "../src/auth-client";
import type { Data360Env } from "../src/types";

describe("SalesforceAuthBridge", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves direct access token and instance URL after userinfo validation", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const bridge = new SalesforceAuthBridge({});
    const res = await bridge.resolveToken({
      accessToken: "Bearer direct-token-abc",
      instanceUrl: "https://myorg.my.salesforce.com/",
    });

    expect(res.connection.accessToken).toBe("direct-token-abc");
    expect(res.connection.instanceUrl).toBe("https://myorg.my.salesforce.com");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://myorg.my.salesforce.com/services/oauth2/userinfo",
      expect.objectContaining({ headers: { Authorization: "Bearer direct-token-abc" } })
    );
  });

  it("rejects a direct token that fails userinfo validation", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 401 }));
    const bridge = new SalesforceAuthBridge({});
    await expect(
      bridge.resolveToken({
        accessToken: "bad-token",
        instanceUrl: "https://myorg.my.salesforce.com",
      })
    ).rejects.toThrow("failed authorization (401)");
  });

  it("resolves token via TUBOT_SF_AUTH RPC with tenant scope", async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      accessToken: "rpc-token-123",
      instanceUrl: "https://rpc.my.salesforce.com/",
      orgId: "00D000000000001AAA",
      teamId: "team-1",
    });

    const env: Data360Env = {
      TUBOT_SF_AUTH: {
        getTokenForChannel: mockRpc,
      },
    };

    const bridge = new SalesforceAuthBridge(env);
    const res = await bridge.resolveToken({
      channelId: "0Mjg00000000001AAA",
      teamId: "team-1",
      orgId: "00D000000000001AAA",
    });

    expect(mockRpc).toHaveBeenCalledWith("0Mjg00000000001AAA", {
      teamId: "team-1",
      orgId: "00D000000000001AAA",
    });
    expect(res.connection.accessToken).toBe("rpc-token-123");
    expect(res.connection.instanceUrl).toBe("https://rpc.my.salesforce.com");
    expect(res.orgId).toBe("00D000000000001AAA");
    expect(res.teamId).toBe("team-1");
  });

  it("rejects a token whose tenant scope does not match the request", async () => {
    const env: Data360Env = {
      TUBOT_SF_AUTH: {
        getTokenForChannel: vi.fn().mockResolvedValue({
          accessToken: "rpc-token-123",
          instanceUrl: "https://rpc.my.salesforce.com",
          orgId: "00D000000000009AAA",
          teamId: "team-9",
        }),
      },
    };

    const bridge = new SalesforceAuthBridge(env);
    await expect(
      bridge.resolveToken({
        channelId: "0Mjg00000000001AAA",
        teamId: "team-1",
        orgId: "00D000000000001AAA",
      })
    ).rejects.toThrow("did not return a token for the requested tenant scope");
  });

  it("requires teamId and orgId to resolve a channel", async () => {
    const env: Data360Env = {
      TUBOT_SF_AUTH: {
        getTokenForChannel: vi.fn(),
      },
    };
    const bridge = new SalesforceAuthBridge(env);
    await expect(bridge.resolveToken({ channelId: "0Mjg00000000001AAA" })).rejects.toThrow(
      "A teamId and orgId are required to resolve a Salesforce channel."
    );
  });

  it("throws when the tubot-sf-auth binding is unavailable", async () => {
    const bridge = new SalesforceAuthBridge({});
    await expect(
      bridge.resolveToken({ channelId: "0Mjg00000000001AAA", teamId: "team-1", orgId: "00D1" })
    ).rejects.toThrow("service binding is unavailable");
  });

  it("throws error when neither token nor channelId is provided", async () => {
    const bridge = new SalesforceAuthBridge({});
    await expect(bridge.resolveToken({})).rejects.toThrow("A Salesforce channelId is required.");
  });
});
