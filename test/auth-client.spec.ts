import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SalesforceAuthBridge } from "../src/auth-client";
import { RPC_SIGNER_CALLER_ID, signRpcEnvelope, stableJson } from "../src/rpc-sign";
import type { Data360Env } from "../src/types";

const TEST_KEY = "test-data360-caller-key-0123456789abcdef";
const NONCE_RE = /^[A-Za-z0-9_-]{24}$/;
const TS_RE = /^\d{10}$/;

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
    globalThis.fetch = vi.fn().mockResolvedValue(Response.json({ organization_id: "00D000000000001AAA" }));
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
    ).rejects.toThrow("failed authorization");
  });

  it("resolves token via TUBOT_SF_AUTH RPC with tenant scope", async () => {
    const mockRpc = vi.fn().mockResolvedValue({
      accessToken: "rpc-token-123",
      instanceUrl: "https://rpc.my.salesforce.com/",
      orgId: "00D000000000001AAA",
      teamId: "team-1",
    });

    const env: Data360Env = {
      SF_AUTH_CALLER_KEY: TEST_KEY,
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

    expect(mockRpc).toHaveBeenCalledTimes(1);
    const rpcArgs = mockRpc.mock.calls[0];
    expect(rpcArgs.slice(0, 2)).toEqual(["0Mjg00000000001AAA", {
      teamId: "team-1",
      orgId: "00D000000000001AAA",
    }]);
    const signed = rpcArgs[2] as Record<string, string>;
    expect(signed.caller).toBe("data360");
    expect(signed.org).toBe("00D000000000001AAA");
    expect(signed.timestamp).toMatch(TS_RE);
    expect(signed.nonce).toMatch(NONCE_RE);
    expect(typeof signed.signature).toBe("string");
    expect(res.connection.accessToken).toBe("rpc-token-123");
    expect(res.connection.instanceUrl).toBe("https://rpc.my.salesforce.com");
    expect(res.orgId).toBe("00D000000000001AAA");
    expect(res.teamId).toBe("team-1");
  });

  it("rejects a token whose tenant scope does not match the request", async () => {
    const env: Data360Env = {
      SF_AUTH_CALLER_KEY: TEST_KEY,
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

  it("signs getUserConversationHistory with a valid trailing envelope", async () => {
    const mockRpc = vi.fn().mockResolvedValue({ userId: "u1", sessions: [] });
    const env: Data360Env = { SF_AUTH_CALLER_KEY: TEST_KEY, TUBOT_SF_AUTH: { getUserConversationHistory: mockRpc } };
    const bridge = new SalesforceAuthBridge(env);
    const options = { teamId: "team-1", orgId: "00D000000000001AAA", limit: 5 };
    await bridge.getUserConversationHistory("u1", options);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const rpcArgs = mockRpc.mock.calls[0];
    expect(rpcArgs.slice(0, 2)).toEqual(["u1", options]);
    const signed = rpcArgs[2] as Record<string, string>;
    expect(signed.caller).toBe("data360");
    expect(signed.org).toBe("00D000000000001AAA");
    expect(signed.timestamp).toMatch(TS_RE);
    expect(signed.nonce).toMatch(NONCE_RE);
    expect(typeof signed.signature).toBe("string");
  });

  it("signs getCallableToolUrls with a valid trailing envelope", async () => {
    const mockRpc = vi.fn().mockResolvedValue(["https://tools.internal/a"]);
    const env: Data360Env = { SF_AUTH_CALLER_KEY: TEST_KEY, TUBOT_SF_AUTH: { getCallableToolUrlsForChannel: mockRpc } };
    const bridge = new SalesforceAuthBridge(env);
    const options = { teamId: "team-1", orgId: "00D000000000001AAA" };
    await bridge.getCallableToolUrls("0Mjg00000000001AAA", options);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const rpcArgs = mockRpc.mock.calls[0];
    expect(rpcArgs.slice(0, 2)).toEqual(["0Mjg00000000001AAA", options]);
    const signed = rpcArgs[2] as Record<string, string>;
    expect(signed.caller).toBe("data360");
    expect(signed.org).toBe("00D000000000001AAA");
    expect(signed.timestamp).toMatch(TS_RE);
    expect(signed.nonce).toMatch(NONCE_RE);
  });

  it("fails fast without calling the RPC when the caller key is missing or short", async () => {
    const mockRpc = vi.fn();
    const scope = { teamId: "team-1", orgId: "00D000000000001AAA" };
    for (const key of [undefined, "short"]) {
      const env: Data360Env = { ...(key === undefined ? {} : { SF_AUTH_CALLER_KEY: key }),
        TUBOT_SF_AUTH: { getTokenForChannel: mockRpc } };
      const bridge = new SalesforceAuthBridge(env);
      await expect(bridge.resolveToken({ channelId: "0Mjg00000000001AAA", ...scope }))
        .rejects.toThrow("SF_AUTH_CALLER_KEY");
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("rpc-sign fixed vector", () => {
  it("matches an independent inline WebCrypto recomputation", async () => {
    expect(RPC_SIGNER_CALLER_ID).toBe("data360");
    const method = "getTokenForChannel";
    const businessArgs: unknown[] = ["0Mjg00000000001AAA", { teamId: "team-1", orgId: "00D000000000001AAA" }];
    const timestamp = "1760400000";
    const nonce = "ABCDEFGHIJKLMNOPQRSTUVWX".slice(0, 24);
    const org = "00D000000000001AAA";
    const env = await signRpcEnvelope({ caller: "data360", callerKey: TEST_KEY, org, method, businessArgs, timestamp, nonce });
    expect(env.caller).toBe("data360");
    expect(env.org).toBe(org);
    expect(stableJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');

    // Independent recomputation: local stable-stringify + raw WebCrypto only.
    const sj = (v: any): string => {
      if (v === null || typeof v !== "object") return JSON.stringify(v);
      if (v instanceof Uint8Array) return JSON.stringify(Array.from(v));
      if (Array.isArray(v)) return "[" + v.map(sj).join(",") + "]";
      return "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + sj(v[k])).join(",") + "}";
    };
    const enc = new TextEncoder();
    const toB64u = (bytes: Uint8Array): string => {
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(sj(businessArgs))));
    const argsDigest = Array.from(digest).map(b => b.toString(16).padStart(2, "0")).join("");
    const canonical = `data360\n${org}\n${method}\n${timestamp}\n${nonce}\n${argsDigest}`;
    const ikm = await crypto.subtle.importKey("raw", enc.encode(TEST_KEY), "HKDF", false, ["deriveBits"]);
    const ok = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: enc.encode("tubot-rpc-org-v1"),
        info: enc.encode("data360\n" + org) }, ikm, 256));
    const key = await crypto.subtle.importKey("raw", ok,
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const expected = toB64u(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(canonical))));
    expect(env.signature).toBe(expected);
    await expect(signRpcEnvelope({ caller: "data360", callerKey: TEST_KEY, org: "bad", method, businessArgs }))
      .rejects.toThrow("org is missing or malformed");
  });
});
