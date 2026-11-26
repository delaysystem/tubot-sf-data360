import { connectApiCoverageResponse } from "./helpers/connect-api";
import { signedRequest, createGateMockD1 } from "./helpers/http-gate";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index";
import { B2CacheManager } from "../src/b2-cache-manager";
import type { Data360Env } from "../src/types";

const SECRET = "test-internal-secret-0123456789abcdef";

function baseEnv(overrides?: Partial<Data360Env>): Data360Env {
  return {
    SF_AUTH_CALLER_KEY: "test-data360-caller-key-0123456789abcdef",
    DATA360_INTERNAL_KEY: SECRET,
    BACKBLAZE_KEY_ID: "test-key-id",
    BACKBLAZE_APPLICATION_KEY: "test-app-key",
    BACKBLAZE_BUCKET_ID: "tubot-encrypted",
    BACKBLAZE_ENDPOINT: "s3.us-west-004.backblazeb2.com",
    ...overrides,
  };
}

function refreshRequest(path: string, secret?: string, body?: Record<string, unknown>): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret !== undefined) headers["x-data360-secret"] = secret;
  return new Request(`https://data360.internal${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? { channelId: "0Mj000000000001AAA", teamId: "team-1", orgId: "00D000000000001AAA" }),
  });
}

describe("POST /cache/refresh internal gate", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns 401 {error:\"unauthorized\"} when HMAC headers are missing", async () => {
    const res = await worker.fetch(refreshRequest("/cache/refresh"), baseEnv({ DB: createGateMockD1() }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 {error:\"unauthorized\"} when the secret/signature is wrong", async () => {
    const res = await worker.fetch(refreshRequest("/cache/refresh", "wrong-secret"), baseEnv({ DB: createGateMockD1() }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 on the /api/cache/refresh alias without valid HMAC auth", async () => {
    const res = await worker.fetch(refreshRequest("/api/cache/refresh", "wrong-secret"), baseEnv({ DB: createGateMockD1() }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 503 {error:\"data360_unconfigured\"} when the server secret is unset", async () => {
    const env = baseEnv({ DATA360_INTERNAL_KEY: undefined, DB: createGateMockD1() });
    const req = await signedRequest(baseEnv(), "POST", "https://data360.internal/cache/refresh", {
      body: { channelId: "0Mj000000000001AAA", teamId: "team-1", orgId: "00D000000000001AAA" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "data360_unconfigured" });
  });

  it("gates before validation: missing secret beats missing channelId", async () => {
    const req = new Request("https://data360.internal/cache/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await worker.fetch(req, baseEnv({ DB: createGateMockD1() }));
    expect(res.status).toBe(401);
  });

  it("returns 405 {error:\"method_not_allowed\"} for GET on /cache/refresh", async () => {
    const env = baseEnv({ DB: createGateMockD1() });
    const req = await signedRequest(env, "GET", "https://data360.internal/cache/refresh");
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "method_not_allowed" });
  });

  it("gates /export (401 without credentials, 400 when signed but invalid)", async () => {
    const anon = new Request("https://data360.internal/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect((await worker.fetch(anon, baseEnv())).status).toBe(401);

    const gatedEnv = { ...baseEnv(), DB: createGateMockD1() };
    const req = await signedRequest(gatedEnv, "POST", "https://data360.internal/export", { body: {} });
    const res = await worker.fetch(req, gatedEnv);
    expect(res.status).toBe(400);
    const data = (await res.json()) as any;
    expect(data.error).toBe("invalid_request");
  });
});

describe("POST /cache/refresh recency short-circuit", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns {ok:true,deduped:true,cache} for a fresh snapshot without calling tubot-sf-auth", async () => {
    const freshTs = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    vi.spyOn(B2CacheManager.prototype, "getLatestSnapshot").mockResolvedValue({
      snapshotId: "fresh-snap-1",
      timestamp: freshTs,
      orgId: "00D000000000001AAA",
      targetId: "0Mj000000000001AAA",
      manifest: {
        b2Cache: {
          stored: true,
          bucketName: "tubot-encrypted",
          bucketId: "tubot-encrypted",
          snapshotId: "fresh-snap-1",
          basePath: "data360/00D000000000001AAA/0Mj000000000001AAA/snapshots/fresh-snap-1",
          cachedAt: freshTs,
          bandwidthAlliance: true,
          totalBytes: 10,
          fileCount: 2,
        },
      } as any,
      zipFileName: "data360-export.zip",
      totalBytes: 10,
      fileCount: 2,
    });

    const getTokenForChannel = vi.fn();
    const env = baseEnv({
      DB: createGateMockD1(),
      TUBOT_SF_AUTH: { getTokenForChannel },
    });

    const req = await signedRequest(env, "POST", "https://data360.internal/api/cache/refresh", {
      body: { channelId: "0Mj000000000001AAA", teamId: "team-1", orgId: "00D000000000001AAA" },
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.deduped).toBe(true);
    expect(data.cache.snapshotId).toBe("fresh-snap-1");
    expect(data.cache.basePath).toContain("fresh-snap-1");
    expect(res.headers.get("X-B2-Snapshot-Id")).toBe("fresh-snap-1");
    expect(getTokenForChannel).not.toHaveBeenCalled();
  });

  it("falls through to extraction when the latest snapshot is stale (>6h)", async () => {
    const staleTs = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    vi.spyOn(B2CacheManager.prototype, "getLatestSnapshot").mockResolvedValue({
      snapshotId: "stale-snap-1",
      timestamp: staleTs,
      orgId: "00D000000000001AAA",
      targetId: "0Mj000000000001AAA",
      manifest: {} as any,
      zipFileName: "data360-export.zip",
      totalBytes: 0,
      fileCount: 0,
    });

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      const catalogResponse = connectApiCoverageResponse(urlStr);
      if (catalogResponse) return catalogResponse;
      if (urlStr.includes("b2_authorize_account")) {
        return Response.json({
          authorizationToken: "auth-123",
          apiUrl: "https://api004.backblazeb2.com",
          downloadUrl: "https://f004.backblazeb2.com",
        });
      }
      if (urlStr.includes("b2_get_upload_url")) {
        return Response.json({
          uploadUrl: "https://upload.backblazeb2.com/file",
          authorizationToken: "upload-auth-123",
        });
      }
      if (urlStr.includes("upload.backblazeb2.com")) {
        return Response.json({ fileId: "fid", fileName: "f", contentLength: 1 });
      }
      if (urlStr.includes("/composite/batch")) {
        return Response.json({ hasErrors: false, results: [] });
      }
      return Response.json({ records: [] });
    });

    const getTokenForChannel = vi.fn().mockResolvedValue({
      accessToken: "mock-test-token",
      instanceUrl: "https://test.my.salesforce.com",
      orgId: "00D000000000001AAA",
      teamId: "team-1",
    });
    const env = baseEnv({ DB: createGateMockD1(), TUBOT_SF_AUTH: { getTokenForChannel } });

    const req = await signedRequest(env, "POST", "https://data360.internal/cache/refresh", {
      body: { channelId: "0Mj000000000001AAA", teamId: "team-1", orgId: "00D000000000001AAA" },
    });
    const res = await worker.fetch(req, env);
    const data = (await res.json()) as any;
    expect(data.deduped).toBeUndefined();
    expect(getTokenForChannel).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
  });

  it("falls through to extraction when no snapshot exists", async () => {
    vi.spyOn(B2CacheManager.prototype, "getLatestSnapshot").mockResolvedValue(null);

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      const catalogResponse = connectApiCoverageResponse(urlStr);
      if (catalogResponse) return catalogResponse;
      if (urlStr.includes("b2_authorize_account")) {
        return Response.json({
          authorizationToken: "auth-123",
          apiUrl: "https://api004.backblazeb2.com",
          downloadUrl: "https://f004.backblazeb2.com",
        });
      }
      if (urlStr.includes("b2_get_upload_url")) {
        return Response.json({
          uploadUrl: "https://upload.backblazeb2.com/file",
          authorizationToken: "upload-auth-123",
        });
      }
      if (urlStr.includes("upload.backblazeb2.com")) {
        return Response.json({ fileId: "fid", fileName: "f", contentLength: 1 });
      }
      if (urlStr.includes("/composite/batch")) {
        return Response.json({ hasErrors: false, results: [] });
      }
      return Response.json({ records: [] });
    });

    const getTokenForChannel = vi.fn().mockResolvedValue({
      accessToken: "mock-test-token",
      instanceUrl: "https://test.my.salesforce.com",
      orgId: "00D000000000001AAA",
      teamId: "team-1",
    });
    const env = baseEnv({ DB: createGateMockD1(), TUBOT_SF_AUTH: { getTokenForChannel } });

    const req = await signedRequest(env, "POST", "https://data360.internal/cache/refresh", {
      body: { channelId: "0Mj000000000001AAA", teamId: "team-1", orgId: "00D000000000001AAA" },
    });
    const res = await worker.fetch(req, env);
    const data = (await res.json()) as any;
    expect(data.deduped).toBeUndefined();
    expect(getTokenForChannel).toHaveBeenCalled();
  });

  it("skips unstructured bytes and stores the seven family files without an archive", async () => {
    vi.spyOn(B2CacheManager.prototype, "getLatestSnapshot").mockResolvedValue(null);

    const fetchedUrls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      const catalogResponse = connectApiCoverageResponse(urlStr);
      if (catalogResponse) return catalogResponse;
      fetchedUrls.push(urlStr);
      if (urlStr.includes("b2_authorize_account")) {
        return Response.json({
          authorizationToken: "auth-123",
          apiUrl: "https://api004.backblazeb2.com",
          downloadUrl: "https://f004.backblazeb2.com",
        });
      }
      if (urlStr.includes("b2_get_upload_url")) {
        return Response.json({
          uploadUrl: "https://upload.backblazeb2.com/file",
          authorizationToken: "upload-auth-123",
        });
      }
      if (urlStr.includes("upload.backblazeb2.com")) {
        return Response.json({ fileId: "fid", fileName: "f", contentLength: 1 });
      }
      if (urlStr.includes("/composite/batch")) {
        return Response.json({ hasErrors: false, results: [] });
      }
      return Response.json({ records: [] });
    });

    const getTokenForChannel = vi.fn().mockResolvedValue({
      accessToken: "mock-test-token",
      instanceUrl: "https://test.my.salesforce.com",
      orgId: "00D000000000001AAA",
      teamId: "team-1",
    });
    const env = baseEnv({ DB: createGateMockD1(), TUBOT_SF_AUTH: { getTokenForChannel } });

    const req = await signedRequest(env, "POST", "https://data360.internal/cache/refresh", {
      body: { channelId: "0Mj000000000001AAA", teamId: "team-1", orgId: "00D000000000001AAA" },
    });
    const res = await worker.fetch(req, env);
    const data = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.cache?.snapshotId).toBeTruthy();

    // No unstructured list queries or binary downloads (per-file downloads plus
    // redirect hops exhaust the per-invocation subrequest budget before the save).
    for (const u of fetchedUrls) {
      expect(u).not.toMatch(/ContentVersion|ContentDocument|StaticResource|\/sfc\//);
    }
    // Seven family envelopes, context (with agent), CRM, file index, manifest, latest.
    expect(fetchedUrls.filter((u) => u.includes("upload.backblazeb2.com"))).toHaveLength(12);
  });
});
