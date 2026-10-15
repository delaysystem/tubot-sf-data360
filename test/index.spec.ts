import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, { TubotSfData360Entrypoint } from "../src/index";
import type { Data360Env } from "../src/types";

describe("tubot-sf-data360 worker endpoints", () => {
  let originalFetch: typeof fetch;

  const cacheHeaders = { Authorization: "Bearer package-coverage-token", "x-salesforce-instance-url": "https://test.my.salesforce.com" };

  const mockEnv: Data360Env = {
    BACKBLAZE_KEY_ID: "test-key-id",
    BACKBLAZE_APPLICATION_KEY: "test-app-key",
    BACKBLAZE_BUCKET_ID: "tubot-encrypted",
    BACKBLAZE_ENDPOINT: "s3.us-west-004.backblazeb2.com",
    SF_AUTH_CALLER_KEY: "test-data360-caller-key-0123456789abcdef",
    TUBOT_SF_AUTH: {
      getTokenForChannel: vi.fn().mockResolvedValue({
        accessToken: "mock-test-token",
        instanceUrl: "https://test.my.salesforce.com",
        orgId: "00D000000000001AAA",
      }),
    },
  };

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => Response.json({ organization_id: "00D000000000001AAA" }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("responds with health check on /health", async () => {
    const request = new Request("http://example.com/health");
    const response = await worker.fetch(request, mockEnv);
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.service).toBe("tubot-sf-data360");
    expect(data.version).toBe("1.0.0");
  });

  it("responds with health check on root /", async () => {
    const response = await worker.fetch(new Request("https://example.com/"), mockEnv);
    expect(response.status).toBe(200);
    const data = (await response.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.service).toBe("tubot-sf-data360");
  });

  it("requires channelId or agentName on /export", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      mockEnv
    );
    expect(response.status).toBe(400);
    const data = (await response.json()) as any;
    expect(data.error).toBe("invalid_request");
  });

  it("returns 400 for malformed JSON body on /export", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "invalid-json{",
      }),
      mockEnv
    );
    expect(response.status).toBe(400);
    const data = (await response.json()) as any;
    expect(data.error).toBe("invalid_json");
  });

  describe("GET /cache/latest", () => {
    it("returns 400 if neither channelId nor agentName is provided", async () => {
      const response = await worker.fetch(new Request("https://example.com/cache/latest", { headers: cacheHeaders }), mockEnv);
      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data.error).toBe("invalid_request");
    });

    it("returns 404 when no snapshot exists", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/services/oauth2/userinfo")) return Response.json({ organization_id: "00D000000000001AAA" });
        if (urlStr.includes("b2_authorize_account")) {
          return Response.json({
            authorizationToken: "auth-123",
            apiUrl: "https://api004.backblazeb2.com",
            downloadUrl: "https://f004.backblazeb2.com",
            accountId: "acc-123",
            apiInfo: { storageApi: { bucketName: "tubot-encrypted" } },
          });
        }
        if (urlStr.includes("b2_get_download_authorization")) {
          return Response.json({ authorizationToken: "dl-token-123" });
        }
        if (urlStr.includes("/file/")) {
          return new Response("Not found", { status: 404 });
        }
        return new Response("{}", { status: 200 });
      });

      const response = await worker.fetch(
        new Request("https://example.com/cache/latest?channelId=chan123&orgId=00D000000000001AAA", { headers: cacheHeaders }),
        mockEnv
      );
      expect(response.status).toBe(404);
      const data = (await response.json()) as any;
      expect(data.error).toBe("not_found");
    });

    it("returns 200 and snapshot summary when latest.json exists", async () => {
      const mockSummary = {
        snapshotId: "2026-09-25T16-00-00",
        targetIdentifier: "chan123",
        orgId: "00D000000000001AAA",
        createdTimestamp: "2026-09-25T16:00:00Z",
        recordCounts: { dmoRecords: 10, crmRecords: 5 },
        unstructuredFileCount: 2,
        zipSizeBytes: 1234,
      };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/services/oauth2/userinfo")) return Response.json({ organization_id: "00D000000000001AAA" });
        if (urlStr.includes("b2_authorize_account")) {
          return Response.json({
            authorizationToken: "auth-123",
            apiUrl: "https://api004.backblazeb2.com",
            downloadUrl: "https://f004.backblazeb2.com",
            accountId: "acc-123",
            apiInfo: { storageApi: { bucketName: "tubot-encrypted" } },
          });
        }
        if (urlStr.includes("b2_get_download_authorization")) {
          return Response.json({ authorizationToken: "dl-token-123" });
        }
        if (urlStr.includes("/file/")) {
          return Response.json(mockSummary);
        }
        return new Response("{}", { status: 200 });
      });

      const response = await worker.fetch(
        new Request("https://example.com/cache/latest?channelId=chan123&orgId=00D000000000001AAA", { headers: cacheHeaders }),
        mockEnv
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Bz-Info-Bandwidth-Alliance")).toBe("true");
      expect(response.headers.get("X-B2-Snapshot-Id")).toBe("2026-09-25T16-00-00");
      const data = (await response.json()) as any;
      expect(data.snapshotId).toBe("2026-09-25T16-00-00");
      expect(data.recordCounts.dmoRecords).toBe(10);
    });
  });

  describe("GET /cache/query", () => {
    it("returns 400 when channelId or agentName is omitted", async () => {
      const response = await worker.fetch(new Request("https://example.com/cache/query?dmo=Account__dlm", { headers: cacheHeaders }), mockEnv);
      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data.error).toBe("invalid_request");
    });

    it("queries DMO records and returns 200 JSON", async () => {
      const mockDmoData = [{ Id: "001", Name: "Acme Corp" }];
      const mockSummary = { snapshotId: "snap-001" };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/services/oauth2/userinfo")) return Response.json({ organization_id: "00D000000000001AAA" });
        if (urlStr.includes("b2_authorize_account")) {
          return Response.json({
            authorizationToken: "auth-123",
            apiUrl: "https://api004.backblazeb2.com",
            downloadUrl: "https://f004.backblazeb2.com",
            accountId: "acc-123",
            apiInfo: { storageApi: { bucketName: "tubot-encrypted" } },
          });
        }
        if (urlStr.includes("b2_get_download_authorization")) {
          return Response.json({ authorizationToken: "dl-token-123" });
        }
        if (urlStr.includes("latest.json")) {
          return Response.json(mockSummary);
        }
        if (urlStr.includes("Account__dlm.json")) {
          return Response.json(mockDmoData);
        }
        return new Response("Not found", { status: 404 });
      });

      const response = await worker.fetch(
        new Request("https://example.com/cache/query?agentName=TestAgent&dmo=Account__dlm", { headers: cacheHeaders }),
        mockEnv
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Bz-Info-Bandwidth-Alliance")).toBe("true");
      const data = (await response.json()) as any;
      expect(data).toEqual(mockDmoData);
    });

    it("queries binary file and returns proper Content-Type", async () => {
      const mockPdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
      const mockSummary = { snapshotId: "snap-001" };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/services/oauth2/userinfo")) return Response.json({ organization_id: "00D000000000001AAA" });
        if (urlStr.includes("b2_authorize_account")) {
          return Response.json({
            authorizationToken: "auth-123",
            apiUrl: "https://api004.backblazeb2.com",
            downloadUrl: "https://f004.backblazeb2.com",
            accountId: "acc-123",
            apiInfo: { storageApi: { bucketName: "tubot-encrypted" } },
          });
        }
        if (urlStr.includes("b2_get_download_authorization")) {
          return Response.json({ authorizationToken: "dl-token-123" });
        }
        if (urlStr.includes("latest.json")) {
          return Response.json(mockSummary);
        }
        if (urlStr.includes("document.pdf")) {
          return new Response(mockPdfBytes, { headers: { "Content-Type": "application/pdf" } });
        }
        return new Response("Not found", { status: 404 });
      });

      const response = await worker.fetch(
        new Request("https://example.com/cache/query?agentName=TestAgent&file=document.pdf", { headers: cacheHeaders }),
        mockEnv
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/pdf");
      expect(response.headers.get("X-Bz-Info-Bandwidth-Alliance")).toBe("true");
      const bodyBytes = new Uint8Array(await response.arrayBuffer());
      expect(bodyBytes).toEqual(mockPdfBytes);
    });
  });

  describe("GET /cache/download", () => {
    it("returns 400 when channelId or agentName is omitted", async () => {
      const response = await worker.fetch(new Request("https://example.com/cache/download", { headers: cacheHeaders }), mockEnv);
      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data.error).toBe("invalid_request");
    });

    it("returns 200 with ZIP binary stream when archive exists", async () => {
      const mockZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // PK..
      const mockSummary = { snapshotId: "snap-999" };

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/services/oauth2/userinfo")) return Response.json({ organization_id: "00D000000000001AAA" });
        if (urlStr.includes("b2_authorize_account")) {
          return Response.json({
            authorizationToken: "auth-123",
            apiUrl: "https://api004.backblazeb2.com",
            downloadUrl: "https://f004.backblazeb2.com",
            accountId: "acc-123",
            apiInfo: { storageApi: { bucketName: "tubot-encrypted" } },
          });
        }
        if (urlStr.includes("b2_get_download_authorization")) {
          return Response.json({ authorizationToken: "dl-token-123" });
        }
        if (urlStr.includes("latest.json")) {
          return Response.json(mockSummary);
        }
        if (urlStr.includes("data360-export.zip")) {
          return new Response(mockZip, { headers: { "Content-Type": "application/zip" } });
        }
        return new Response("Not found", { status: 404 });
      });

      const response = await worker.fetch(
        new Request("https://example.com/cache/download?agentName=TestAgent", { headers: cacheHeaders }),
        mockEnv
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/zip");
      expect(response.headers.get("X-Bz-Info-Bandwidth-Alliance")).toBe("true");
      expect(response.headers.get("Cache-Control")).toBe("private, max-age=3600");
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes).toEqual(mockZip);
    });

    it("returns 404 when cached zip does not exist", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/services/oauth2/userinfo")) return Response.json({ organization_id: "00D000000000001AAA" });
        if (urlStr.includes("b2_authorize_account")) {
          return Response.json({
            authorizationToken: "auth-123",
            apiUrl: "https://api004.backblazeb2.com",
            downloadUrl: "https://f004.backblazeb2.com",
            accountId: "acc-123",
            apiInfo: { storageApi: { bucketName: "tubot-encrypted" } },
          });
        }
        if (urlStr.includes("b2_get_download_authorization")) {
          return Response.json({ authorizationToken: "dl-token-123" });
        }
        return new Response("Not found", { status: 404 });
      });

      const response = await worker.fetch(
        new Request("https://example.com/cache/download?agentName=NonExistent", { headers: cacheHeaders }),
        mockEnv
      );
      expect(response.status).toBe(404);
      const data = (await response.json()) as any;
      expect(data.error).toBe("not_found");
    });
  });

  describe("GET /cache/snapshots", () => {
    it("returns 400 when channelId or agentName is missing", async () => {
      const response = await worker.fetch(new Request("https://example.com/cache/snapshots", { headers: cacheHeaders }), mockEnv);
      expect(response.status).toBe(400);
      const data = (await response.json()) as any;
      expect(data.error).toBe("invalid_request");
    });

    it("lists snapshots successfully", async () => {
      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/services/oauth2/userinfo")) return Response.json({ organization_id: "00D000000000001AAA" });
        if (urlStr.includes("b2_authorize_account")) {
          return Response.json({
            authorizationToken: "auth-123",
            apiUrl: "https://api004.backblazeb2.com",
            downloadUrl: "https://f004.backblazeb2.com",
            accountId: "acc-123",
            apiInfo: { storageApi: { bucketName: "tubot-encrypted" } },
          });
        }
        if (urlStr.includes("b2_list_file_names")) {
          return Response.json({
            files: [
              {
                fileId: "f1",
                fileName: "data360/00D000000000001AAA/agent1/snapshots/snap-1/manifest.json",
                contentLength: 500,
                uploadTimestamp: 1600000000000,
              },
              {
                fileId: "f2",
                fileName: "data360/00D000000000001AAA/agent1/snapshots/snap-2/manifest.json",
                contentLength: 600,
                uploadTimestamp: 1700000000000,
              },
            ],
            nextFileName: null,
          });
        }
        if (urlStr.includes("b2_get_download_authorization")) {
          return Response.json({ authorizationToken: "dl-token-123" });
        }
        if (urlStr.includes("manifest.json")) {
          return Response.json({
            exportTimestamp: "2026-09-25T16:00:00Z",
            recordCounts: { dmoRecords: 2 },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const response = await worker.fetch(
        new Request("https://example.com/cache/snapshots?agentName=agent1&orgId=00D000000000001AAA", { headers: cacheHeaders }),
        mockEnv
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Bz-Info-Bandwidth-Alliance")).toBe("true");
      const data = (await response.json()) as any;
      expect(data.count).toBe(2);
      expect(data.snapshots.length).toBe(2);
      expect(data.snapshots[0].snapshotId).toBe("snap-2");
      expect(data.snapshots[1].snapshotId).toBe("snap-1");
    });
  });

  describe("TubotSfData360Entrypoint RPC methods", () => {
    it("calls getLatestCache, queryCache, downloadCachedZip, and listSnapshots", async () => {
      const entrypoint = new TubotSfData360Entrypoint({}, mockEnv);

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        const urlStr = String(url);
        if (urlStr.endsWith("/services/oauth2/userinfo")) return Response.json({ organization_id: "00D000000000001AAA" });
        if (urlStr.includes("b2_authorize_account")) {
          return Response.json({
            authorizationToken: "auth-123",
            apiUrl: "https://api004.backblazeb2.com",
            downloadUrl: "https://f004.backblazeb2.com",
            accountId: "acc-123",
            apiInfo: { storageApi: { bucketName: "tubot-encrypted" } },
          });
        }
        if (urlStr.includes("b2_get_download_authorization")) {
          return Response.json({ authorizationToken: "dl-token-123" });
        }
        if (urlStr.includes("latest.json")) {
          return Response.json({ snapshotId: "rpc-snap" });
        }
        if (urlStr.includes("data360-export.zip")) {
          return new Response(new Uint8Array([1, 2, 3]));
        }
        if (urlStr.includes("b2_list_file_names")) {
          return Response.json({ files: [], nextFileName: null });
        }
        return new Response("Not found", { status: 404 });
      });

      const latest = await entrypoint.getLatestCache({ agentName: "RPCAgent", accessToken: "package-coverage-token", instanceUrl: "https://test.my.salesforce.com" });
      expect(latest?.snapshotId).toBe("rpc-snap");

      const zip = await entrypoint.downloadCachedZip({ agentName: "RPCAgent", accessToken: "package-coverage-token", instanceUrl: "https://test.my.salesforce.com" });
      expect(zip).toEqual(new Uint8Array([1, 2, 3]));

      const snapshots = await entrypoint.listSnapshots({ agentName: "RPCAgent", accessToken: "package-coverage-token", instanceUrl: "https://test.my.salesforce.com" });
      expect(snapshots).toEqual([]);
    });
  });

  it("returns 404 for unknown endpoint", async () => {
    const response = await worker.fetch(new Request("https://example.com/unknown"), mockEnv);
    expect(response.status).toBe(404);
  });
});
