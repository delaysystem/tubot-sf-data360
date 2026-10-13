import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import worker from "../src/index";
import type { Data360Env } from "../src/types";

describe("tubot-sf-data360 export pipeline", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("GET /health returns status 200 and service metadata", async () => {
    const req = new Request("https://data360.internal/health");
    const res = await worker.fetch(req, {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("tubot-sf-data360");
  });

  it("POST /export returns a valid ZIP file with manifest, agent, and data records", async () => {
    // Setup Mock Salesforce Responses
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: any) => {
      const urlStr = String(url);

      // SOAP Metadata Retrieve (initiate & poll)
      if (urlStr.includes("/services/Soap/m/")) {
        const bodyStr = String(init?.body || "");
        if (bodyStr.includes("<met:retrieve>")) {
          return new Response(
            `<soapenv:Envelope><soapenv:Body><retrieveResponse><result><id>04s000000000001AAA</id></result></retrieveResponse></soapenv:Body></soapenv:Envelope>`,
            { status: 200, headers: { "Content-Type": "text/xml" } }
          );
        }
        if (bodyStr.includes("<met:checkRetrieveStatus>")) {
          // Return base64 of an empty zip or minimal zip
          // Let's create an in-memory zip for AiAuthoringBundle
          const { zipSync, strToU8 } = await import("fflate");
          const mockZip = zipSync({
            "aiAuthoringBundles/DATA360TEST/DATA360TEST.agent": strToU8(
              "system:\n    instructions: 'Marketer Agent'\nvariables:\n    segment_on_entity: 'ssot__Individual__dlm'\n"
            ),
          });
          const zipB64 = btoa(String.fromCharCode(...mockZip));

          return new Response(
            `<soapenv:Envelope><soapenv:Body><checkRetrieveStatusResponse><result><done>true</done><zipFile>${zipB64}</zipFile></result></checkRetrieveStatusResponse></soapenv:Body></soapenv:Envelope>`,
            { status: 200, headers: { "Content-Type": "text/xml" } }
          );
        }
      }

      // Composite Batch API Calls
      if (urlStr.includes("/composite/batch")) {
        const batchReq = JSON.parse(init?.body || "{}");
        const subrequests = batchReq.batchRequests || [];

        const results = subrequests.map((r: any) => {
          const decoded = decodeURIComponent(r.url);
          if (decoded.includes("FROM MessagingChannel")) {
            return {
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
            };
          }
          if (decoded.includes("FROM MarketSegment")) {
            return {
              statusCode: 200,
              result: {
                records: [
                  {
                    Id: "1sgg50000001kX3AAI",
                    Name: "VIP Customers",
                    IncludeCriteria: "<DbtPipeline/>",
                  },
                ],
              },
            };
          }
          if (decoded.includes("FROM Individual")) {
            return {
              statusCode: 200,
              result: {
                records: [
                  { Id: "0PK001", LastName: "D360 Rostova" },
                  { Id: "0PK002", LastName: "D360 Vance" },
                ],
              },
            };
          }
          if (decoded.includes("/sobjects/") && decoded.includes("/describe")) {
            return {
              statusCode: 200,
              result: {
                name: "ssot__Individual__dlm",
                fields: [{ name: "Id", type: "string" }],
              },
            };
          }
          return { statusCode: 200, result: { records: [] } };
        });

        return Response.json({ hasErrors: false, results });
      }

      if (decodeURIComponent(urlStr).includes("FROM BotDefinition")) {
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

    const env: Data360Env = {
      TUBOT_SF_AUTH: {
        getTokenForChannel: vi.fn().mockResolvedValue({
          accessToken: "mock-test-token",
          instanceUrl: "https://test.my.salesforce.com",
          orgId: "00D000000000001AAA",
        }),
      },
    };

    const req = new Request("https://data360.internal/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: "0Mjg5000000VtMnCAK",
        agentName: "DATA360TEST",
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
    expect(res.headers.get("Content-Disposition")).toContain("data360-");

    const zipBuffer = new Uint8Array(await res.arrayBuffer());
    expect(zipBuffer.length).toBeGreaterThan(100);

    // Unzip and assert
    const unzipped = unzipSync(zipBuffer);
    expect(unzipped["manifest.json"]).toBeDefined();

    const manifest = JSON.parse(strFromU8(unzipped["manifest.json"]));
    expect(manifest.target.agentName).toBe("DATA360TEST");
    expect(manifest.summary.marketSegmentCount).toBe(1);
    expect(manifest.summary.crmRecordCounts.individuals).toBe(2);

    expect(unzipped["agent/agent-script.agent"]).toBeUndefined();
    expect(unzipped["agent/bundle-meta.xml"]).toBeUndefined();
    expect(unzipped["metadata/segments.json"]).toBeDefined();
    expect(unzipped["data/crm/Individual.json"]).toBeDefined();
  });

  it("POST /export with format=json returns raw JSON payload", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/composite/batch")) {
        return Response.json({
          hasErrors: false,
          results: [{ statusCode: 200, result: { records: [] } }],
        });
      }
      return Response.json({ records: [] });
    });

    const env: Data360Env = {
      TUBOT_SF_AUTH: {
        getTokenForChannel: vi.fn().mockResolvedValue({
          accessToken: "mock-test-token",
          instanceUrl: "https://test.my.salesforce.com",
        }),
      },
    };

    const req = new Request("https://data360.internal/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentName: "DATA360TEST",
        format: "json",
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json");

    const data = (await res.json()) as any;
    expect(data.manifest).toBeDefined();
    expect(data.manifest.target.agentName).toBe("DATA360TEST");
  });

  it("returns 400 when neither channelId nor agentName is provided", async () => {
    const req = new Request("https://data360.internal/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await worker.fetch(req, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toBe("invalid_request");
  });

  it("POST /export with cacheToB2=true persists package to B2 and includes headers", async () => {
    const uploadedFiles: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: any) => {
      const urlStr = String(url);

      if (urlStr.includes("b2_authorize_account")) {
        return Response.json({
          authorizationToken: "auth-123",
          apiUrl: "https://api004.backblazeb2.com",
          downloadUrl: "https://f004.backblazeb2.com",
          accountId: "acc-123",
          apiInfo: { storageApi: { bucketName: "tubot-encrypted" } },
        });
      }
      if (urlStr.includes("b2_get_upload_url")) {
        return Response.json({
          uploadUrl: "https://upload.backblazeb2.com/file",
          authorizationToken: "upload-auth-123",
        });
      }
      if (urlStr.includes("/upload/file") || urlStr.includes("upload.backblazeb2.com")) {
        const fileNameHeader = init?.headers?.["X-Bz-File-Name"] || "unknown";
        uploadedFiles.push(fileNameHeader);
        return Response.json({
          fileId: `b2-fid-${uploadedFiles.length}`,
          fileName: fileNameHeader,
          contentLength: 100,
          contentSha1: "hash-123",
        });
      }
      if (decodeURIComponent(urlStr).includes("FROM BotDefinition")) {
        return Response.json({
          records: [{ Id: "0Xxg5000001fWMjCAM", DeveloperName: "DATA360TEST" }],
        });
      }
      if (urlStr.includes("/composite/batch")) {
        return Response.json({ hasErrors: false, results: [] });
      }
      return Response.json({ records: [] });
    });

    const env: Data360Env = {
      BACKBLAZE_KEY_ID: "test-key-id",
      BACKBLAZE_APPLICATION_KEY: "test-app-key",
      BACKBLAZE_BUCKET_ID: "tubot-encrypted",
      BACKBLAZE_ENDPOINT: "s3.us-west-004.backblazeb2.com",
      TUBOT_SF_AUTH: {
        getTokenForChannel: vi.fn().mockResolvedValue({
          accessToken: "mock-test-token",
          instanceUrl: "https://test.my.salesforce.com",
          orgId: "00D000000000001AAA",
        }),
      },
    };

    const req = new Request("https://data360.internal/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentName: "DATA360TEST",
        format: "json",
        cacheToB2: true,
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Bz-Info-Bandwidth-Alliance")).toBe("true");
    expect(res.headers.get("X-B2-Snapshot-Id")).toBeDefined();
    expect(res.headers.get("X-B2-Cache-Path")).toContain("data360/00D000000000001AAA/DATA360TEST/snapshots/");

    const data = (await res.json()) as any;
    expect(data.b2Cache).toBeDefined();
    expect(data.b2Cache.bucketName).toBe("tubot-encrypted");
    expect(uploadedFiles.length).toBeGreaterThan(0);
  });

  it("POST /cache/refresh triggers extraction with enforced cacheToB2 and returns summary", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("b2_authorize_account")) {
        return Response.json({
          authorizationToken: "auth-123",
          apiUrl: "https://api004.backblazeb2.com",
          downloadUrl: "https://f004.backblazeb2.com",
          accountId: "acc-123",
          apiInfo: { storageApi: { bucketName: "tubot-encrypted" } },
        });
      }
      if (urlStr.includes("b2_get_upload_url")) {
        return Response.json({
          uploadUrl: "https://upload.backblazeb2.com/file",
          authorizationToken: "upload-auth-123",
        });
      }
      if (urlStr.includes("/upload/file") || urlStr.includes("upload.backblazeb2.com")) {
        return Response.json({
          fileId: "b2-fid-1",
          fileName: "data360/latest.json",
          contentLength: 100,
          contentSha1: "hash-123",
        });
      }
      if (decodeURIComponent(urlStr).includes("FROM BotDefinition")) {
        return Response.json({
          records: [{ Id: "0Xxg5000001fWMjCAM", DeveloperName: "DATA360TEST" }],
        });
      }
      if (urlStr.includes("/composite/batch")) {
        return Response.json({ hasErrors: false, results: [] });
      }
      return Response.json({ records: [] });
    });

    const env: Data360Env = {
      BACKBLAZE_KEY_ID: "test-key-id",
      BACKBLAZE_APPLICATION_KEY: "test-app-key",
      BACKBLAZE_BUCKET_ID: "tubot-encrypted",
      BACKBLAZE_ENDPOINT: "s3.us-west-004.backblazeb2.com",
      TUBOT_SF_AUTH: {
        getTokenForChannel: vi.fn().mockResolvedValue({
          accessToken: "mock-test-token",
          instanceUrl: "https://test.my.salesforce.com",
          orgId: "00D000000000001AAA",
        }),
      },
    };

    const req = new Request("https://data360.internal/cache/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentName: "DATA360TEST",
      }),
    });

    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.message).toContain("Cache refreshed successfully");
    expect(data.cache).toBeDefined();
  });
});
