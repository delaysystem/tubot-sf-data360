import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { unzipSync } from "fflate";
import { signedRequest, createGateMockD1 } from "./helpers/http-gate";
import worker from "../src/index";
import {
  Data360Extractor,
  assertSoqlId,
  escapeSoqlString,
} from "../src/data360-extractor";
import {
  DataCloudClient,
  DATA_CLOUD_QUERY_DEADLINE_MS,
  DATA_CLOUD_QUERY_POLL_BASE_MS,
  DATA_CLOUD_QUERY_POLL_MAX_MS,
} from "../src/data-cloud-client";
import {
  UnstructuredExtractor,
  UNSTRUCTURED_LISTING_QUERIES,
  UNSTRUCTURED_LISTING_LIMIT,
  UNSTRUCTURED_MAX_FILE_BYTES,
} from "../src/unstructured-extractor";
import { ZipBuilder } from "../src/zip-builder";
import { D1Data360Cache } from "../src/cache-helper";
import { resolveCacheOrgId, resolveCacheReadOrg } from "../src/index";
import type { SalesforceConnection } from "../src/types";

const conn: SalesforceConnection = {
  accessToken: "mock-token",
  instanceUrl: "https://test.my.salesforce.com",
};

describe("SEC-11 SOQL injection hardening", () => {
  it("rejects injection payloads in userId before any query is issued", async () => {
    const mockBatchClient = { batchQueries: vi.fn() };
    const extractor = new Data360Extractor(mockBatchClient as any);
    await expect(
      extractor.extractUserData360(conn, "003' OR '1'='1")
    ).rejects.toThrow("Invalid userId");
    expect(mockBatchClient.batchQueries).not.toHaveBeenCalled();
  });

  it("rejects empty, overlong, and metacharacter-bearing sessionIds", async () => {
    const mockBatchClient = { batchQueries: vi.fn() };
    const extractor = new Data360Extractor(mockBatchClient as any);
    await expect(extractor.extractMessagingSessionData360(conn, "   ")).rejects.toThrow("Invalid sessionId");
    await expect(
      extractor.extractMessagingSessionData360(conn, "0Mw0001; DROP TABLE x")
    ).rejects.toThrow("Invalid sessionId");
    await expect(
      extractor.extractMessagingSessionData360(conn, "a".repeat(19))
    ).rejects.toThrow("Invalid sessionId");
    expect(mockBatchClient.batchQueries).not.toHaveBeenCalled();
  });

  it("accepts Salesforce IDs and dash-bearing external keys", () => {
    expect(assertSoqlId("003000000000001AAA", "userId")).toBe("003000000000001AAA");
    expect(assertSoqlId("  user-123  ", "userId")).toBe("user-123");
    expect(assertSoqlId("0Mw000000000001AAA", "sessionId")).toBe("0Mw000000000001AAA");
  });

  it("escapes SOQL string literals", () => {
    expect(escapeSoqlString("a'b\\c")).toBe("a\\'b\\\\c");
  });

  it("skips the linked-Individual follow-up when the record-sourced ID is malformed", async () => {
    const mockBatchClient = {
      batchQueries: vi.fn().mockResolvedValue([
        { records: [] }, // Individual: no direct match
        { records: [{ Id: "003001", IndividualId: "0PK' OR '1'='1" }] }, // Contact with hostile IndividualId
        { records: [] },
        { records: [] },
        { records: [] },
      ]),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("no", { status: 404 }));
    try {
      const extractor = new Data360Extractor(mockBatchClient as any);
      await extractor.extractUserData360(conn, "003001");
      // Initial 5-query batch only: the hostile linked ID must not be interpolated.
      expect(mockBatchClient.batchQueries).toHaveBeenCalledTimes(1);
      for (const q of mockBatchClient.batchQueries.mock.calls[0][1] as string[]) {
        expect(q).not.toContain("OR '1'");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to the unfiltered MessagingSession query for a malformed channelId", async () => {
    const executeBatch = vi.fn().mockResolvedValue([]);
    const extractor = new Data360Extractor(
      { executeBatch } as any,
      {
        resolveChannelAndAgent: vi.fn().mockResolvedValue({
          agentName: "A", channelRecord: null, channelDeveloperName: undefined,
        }),
        analyzeAgentScript: vi.fn().mockReturnValue({ dmoNames: [] }),
      } as any,
      { extractAllFiles: vi.fn().mockResolvedValue([]) } as any,
    );
    await extractor.extractData360(conn, {
      channelId: "0Mj' OR '1'='1",
      format: "json",
      includeTools: false,
      includeMetadata: false,
      includeDataCloudRecords: false,
      includeUnstructuredFiles: false,
    });
    const subrequests = executeBatch.mock.calls[0][1] as Array<{ url: string }>;
    const sessionReq = subrequests.find((r) => decodeURIComponent(r.url).includes("FROM MessagingSession"));
    expect(sessionReq).toBeDefined();
    expect(decodeURIComponent(sessionReq!.url)).not.toContain("WHERE");
    expect(decodeURIComponent(sessionReq!.url)).not.toContain("OR '1'");
  });

  it("rejects malformed userId/sessionId path params with 400 at the HTTP gate", async () => {
    const env: any = {
      DB: createGateMockD1(),
      DATA360_INTERNAL_KEY: "mesh-key-0123456789abcdef0123456789abcd",
    };
    const badUser = await signedRequest(env, "GET", "https://x.internal/api/data360/users/003'%20OR%20'1'%3D'1");
    expect((await worker.fetch(badUser, env)).status).toBe(400);
    const badSession = await signedRequest(env, "GET", "https://x.internal/api/data360/messagingsessions/0Mw0001;DROP");
    expect((await worker.fetch(badSession, env)).status).toBe(400);
  });

  it("keeps the channel filter for a well-formed MessagingChannel ID", async () => {
    const executeBatch = vi.fn().mockResolvedValue([]);
    const extractor = new Data360Extractor(
      { executeBatch } as any,
      {
        resolveChannelAndAgent: vi.fn().mockResolvedValue({
          agentName: "A", channelRecord: null, channelDeveloperName: undefined,
        }),
        analyzeAgentScript: vi.fn().mockReturnValue({ dmoNames: [] }),
      } as any,
      { extractAllFiles: vi.fn().mockResolvedValue([]) } as any,
    );
    await extractor.extractData360(conn, {
      channelId: "0Mjg5000000VtMnCAK",
      format: "json",
      includeTools: false,
      includeMetadata: false,
      includeDataCloudRecords: false,
      includeUnstructuredFiles: false,
    });
    const subrequests = executeBatch.mock.calls[0][1] as Array<{ url: string }>;
    const sessionReq = subrequests.find((r) => decodeURIComponent(r.url).includes("FROM MessagingSession"));
    expect(decodeURIComponent(sessionReq!.url)).toContain("MessagingChannelId = '0Mjg5000000VtMnCAK'");
  });
});

describe("SEC-23 authenticated cache org", () => {
  it("prefers the authenticated org over a caller-asserted orgId", () => {
    expect(
      resolveCacheOrgId(
        { orgId: "00D000000000001AAA", authedOrgId: "00D000000000001AAA" },
        { connection: { orgId: "00D000000000001AAA" } },
      ),
    ).toBe("00D000000000001AAA");
    // Connection org wins even when listed last in the old fallback chain.
    expect(
      resolveCacheOrgId({ orgId: "00D000000000001AAA" }, { connection: { orgId: "00D000000000001AAA" } }),
    ).toBe("00D000000000001AAA");
  });

  it("fails closed with 403 when asserted and authenticated orgs disagree", () => {
    const err = (() => {
      try {
        resolveCacheOrgId(
          { orgId: "00D000000000009AAA" },
          { connection: { orgId: "00D000000000001AAA" } },
        );
      } catch (e: any) {
        return e;
      }
      return null;
    })();
    expect(err).not.toBeNull();
    expect(err.status).toBe(403);
  });

  it("tolerates 15-char vs 18-char forms of the same org", () => {
    expect(
      resolveCacheOrgId({ orgId: "00D000000000001" }, { connection: { orgId: "00D000000000001AAA" } }),
    ).toBe("00D000000000001AAA");
  });

  it("falls back to asserted scope only when nothing is authenticated", () => {
    expect(resolveCacheOrgId({ orgId: "00D1" }, null)).toBe("00D1");
    expect(resolveCacheOrgId({}, null)).toBeUndefined();
  });

  it("binds reads to the authenticated org first, asserted scope second", () => {
    expect(resolveCacheReadOrg({ orgId: "A", authedOrgId: "B" })).toBe("B");
    expect(resolveCacheReadOrg({ orgId: "A" })).toBe("A");
    expect(resolveCacheReadOrg({})).toBeUndefined();
  });
});

describe("FLK-06 Data Cloud poll retry", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("exposes the poll deadline and backoff as named constants", () => {
    expect(DATA_CLOUD_QUERY_DEADLINE_MS).toBe(60_000);
    expect(DATA_CLOUD_QUERY_POLL_BASE_MS).toBe(500);
    expect(DATA_CLOUD_QUERY_POLL_MAX_MS).toBe(5_000);
  });

  it("retries a transient poll failure instead of aborting the query", async () => {
    const client = new DataCloudClient(conn, "v68.0");
    let polls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: any, init: any) => {
      const href = String(url);
      if (init?.method === "POST" && href.includes("query-sql?dataspace")) {
        return Response.json({ status: { queryId: "q1", completionStatus: "Running" } });
      }
      if (href.includes("query-sql/q1")) {
        polls++;
        if (polls === 1) return new Response("boom", { status: 500 });
        return Response.json({
          status: { completionStatus: "ResultsProduced", rowCount: 1 },
          data: [{ id: "r1" }],
          metadata: { columns: [{ name: "id" }] },
        });
      }
      throw new Error(`unexpected url ${href}`);
    });
    const rows = await client.query('SELECT * FROM "M" LIMIT 5', "default", 5);
    expect(rows).toEqual([{ id: "r1" }]);
    // 1 failed status poll (retried) + 1 successful status poll + 1 rows page.
    expect(polls).toBe(3);
  });

  it("rethrows auth failures immediately without retrying", async () => {
    const client = new DataCloudClient(conn, "v68.0");
    let polls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: any, init: any) => {
      const href = String(url);
      if (init?.method === "POST") {
        return Response.json({ status: { queryId: "q9", completionStatus: "Running" } });
      }
      polls++;
      return new Response("expired", { status: 401 });
    });
    await expect(client.query('SELECT * FROM "M" LIMIT 1', "default", 1)).rejects.toThrow("HTTP 401");
    expect(polls).toBe(1);
  });
});

describe("FLK-31 deterministic column order", () => {
  it("breaks placeInOrder ties by column name, not upstream key order", async () => {
    const client = new DataCloudClient(conn, "v68.0");
    const originalFetch = globalThis.fetch;
    // Insertion order b-then-a: without the tiebreak, names would be [b, a].
    const columns: Record<string, any> = {};
    columns["b_col"] = { placeInOrder: 0 };
    columns["a_col"] = { placeInOrder: 0 };
    globalThis.fetch = vi.fn().mockResolvedValue(
      Response.json({ data: [["va", "vb"]], metadata: { columns } }),
    );
    try {
      const rows = await client.query('SELECT * FROM "M" LIMIT 1', "default", 1);
      expect(rows).toEqual([{ a_col: "va", b_col: "vb" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("FLK-28 invalidation failures are logged", () => {
  it("logs when the expiry sweep DELETE fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const db = {
        prepare(sql: string) {
          const stmt: any = {
            bind: (..._args: any[]) => stmt,
            first: async () => ({ etag: '"old"', expires_at: Date.now() - 1000 }),
            run: async () => {
              if (String(sql).toLowerCase().startsWith("delete from data360_user_cache")) {
                throw new Error("D1 offline");
              }
              return { success: true, meta: { changes: 0 } };
            },
          };
          return stmt;
        },
      } as unknown as D1Database;
      const cache = new D1Data360Cache(db);
      expect(await cache.getUserETag("u-expired")).toBeNull();
      expect(warn).toHaveBeenCalled();
      const [msg] = warn.mock.calls[0];
      expect(String(msg)).toContain("invalidation failed");
      expect(String(msg)).toContain("user");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("COST-08 unstructured caps", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("bounds every discovery listing with LIMIT", () => {
    expect(UNSTRUCTURED_LISTING_LIMIT).toBe(50);
    for (const q of Object.values(UNSTRUCTURED_LISTING_QUERIES)) {
      expect(q).toContain("LIMIT 50");
    }
  });

  it("skips listing-declared oversize files without fetching them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (String(url).includes("/VersionData")) {
        return new Response(new TextEncoder().encode("tiny"), {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }
      return new Response("Not Found", { status: 404 });
    });
    try {
      const extractor = new UnstructuredExtractor(fetchMock as unknown as typeof fetch);
      const files = await extractor.extractAllFiles(conn, {
        listings: {
          contentVersion: [
            { Id: "068xxBIG", Title: "huge.bin", FileType: "BIN", ContentSize: UNSTRUCTURED_MAX_FILE_BYTES + 1 },
            { Id: "068xxSMALL", Title: "tiny.txt", FileType: "TXT", FileExtension: "txt", ContentSize: 4 },
          ],
          document: [],
          staticResource: [],
        },
      });
      expect(files.map((f) => f.id)).toEqual(["068xxSMALL"]);
      const fetchedUrls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(fetchedUrls.some((u) => u.includes("068xxBIG"))).toBe(false);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("skips downloads whose Content-Length exceeds the per-file cap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("x", {
        status: 200,
        headers: { "Content-Type": "application/pdf", "Content-Length": String(UNSTRUCTURED_MAX_FILE_BYTES + 1) },
      }),
    );
    try {
      const extractor = new UnstructuredExtractor(fetchMock as unknown as typeof fetch);
      const files = await extractor.extractAllFiles(conn, {
        listings: {
          contentVersion: [{ Id: "068xxLIAR", Title: "liar.pdf", FileType: "PDF", ContentSize: 10 }],
          document: [],
          staticResource: [],
        },
      });
      expect(files).toHaveLength(0);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("COST-09 zip build off the hot path", () => {
  it("round-trips binaries byte-identical with per-entry levels", () => {
    const binary = new Uint8Array(4096).map((_, i) => (i * 31 + 7) % 251);
    const pkg: any = {
      manifest: { version: "2.0.0" },
      agent: {},
      metadata: { dataSpaces: [], marketSegments: [], calculatedInsights: [], identityResolutionRules: [], dmoDescribes: {}, dmoCatalog: [] },
      records: { crm: { individuals: [], contactPointEmails: [], contactPointPhones: [], orders: [], orderItems: [], leads: [], accounts: [], messagingSessions: [] }, dataCloud: {} },
      unstructuredFiles: [
        {
          id: "068xxBIN", sourceObject: "ContentVersion", title: "blob.pdf", filename: "blob.pdf",
          category: "pdf", fileType: "PDF", fileExtension: "pdf", contentType: "application/pdf",
          contentSize: binary.byteLength, data: binary,
        },
        {
          id: "068xxTXT", sourceObject: "ContentVersion", title: "note.txt", filename: "note.txt",
          category: "text", fileType: "TXT", fileExtension: "txt", contentType: "text/plain",
          contentSize: 11, data: new TextEncoder().encode("hello world"),
        },
      ],
    };
    const zipBytes = ZipBuilder.buildZip(pkg);
    const unzipped = unzipSync(zipBytes);
    expect(unzipped["data/files/pdf/blob.pdf"]).toEqual(binary);
    expect(new TextDecoder().decode(unzipped["data/files/text/note.txt"])).toBe("hello world");
    expect(JSON.parse(new TextDecoder().decode(unzipped["manifest.json"])).version).toBe("2.0.0");
  });
});
