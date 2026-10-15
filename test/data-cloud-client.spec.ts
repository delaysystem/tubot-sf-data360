import { describe, it, expect, vi } from "vitest";
import { DataCloudClient, DATA_CLOUD_RETRIEVE_SUBREQUEST_BUDGET } from "../src/data-cloud-client";
import type { DataCloudObject, SalesforceConnection } from "../src/types";

describe("DataCloudClient", () => {
  const conn: SalesforceConnection = {
    accessToken: "mock-data-cloud-token",
    instanceUrl: "https://test.my.salesforce.com",
  };
  const objects: DataCloudObject[] = [
    { name: "Lake1", dataSpace: "default", family: "dlo", storageKey: "Lake1", metadata: {} },
    { name: "Model1", dataSpace: "default", family: "dmo", storageKey: "Model1", metadata: {} },
  ];

  it("pages small DMO catalogs at 200 and follows offset continuation", async () => {
    const client = new DataCloudClient(conn, "v68.0");
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: any) => {
      const href = String(url);
      urls.push(href);
      const offset = Number(new URL(href).searchParams.get("offset") ?? "0");
      const page = offset === 0
        ? Array.from({ length: 200 }, (_, i) => ({ apiName: `Item${i}` }))
        : [];
      return Response.json({ dataModelObject: page });
    });

    try {
      const rows = await client.list("data-model-objects", "dataModelObject", "default");
      expect(rows).toHaveLength(200);
      expect(urls).toHaveLength(2);
      expect(urls[0]).toContain("limit=200");
      expect(urls[1]).toContain("offset=200");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("requests wide pages unless the endpoint caps its page size", async () => {
    const client = new DataCloudClient(conn, "v68.0");
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: any) => {
      const href = String(url);
      urls.push(href);
      if (href.includes("calculated-insights")) {
        return Response.json({ collection: { items: [{ developerName: "Insight1" }] } });
      }
      return Response.json({ dataLakeObjects: [{ apiName: "Lake1" }] });
    });

    try {
      await client.list("data-lake-objects", "dataLakeObjects", "default");
      await client.list("calculated-insights", "collection", "default");
      expect(urls[0]).toContain("limit=1000");
      expect(urls[1]).toContain("batchSize=200");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retrieves every family when no budget is set", async () => {
    const client = new DataCloudClient(conn, "v68.0");
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      return Response.json({ data: [{ id: "r1" }] });
    });

    try {
      const result = await client.retrieve(objects, [], 1);
      expect(calls).toBe(2);
      expect(Object.keys(result.dataCloud).sort()).toEqual(["Lake1", "Model1"]);
      expect(result.warnings).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("stops retrieve gracefully with partial coverage when the budget is exhausted", async () => {
    const client = new DataCloudClient(conn, "v68.0");
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      calls++;
      return Response.json({ data: [{ id: "r1" }] });
    });

    try {
      const result = await client.retrieve(objects, [], 1, { subrequestBudget: 1 });
      expect(calls).toBe(1);
      expect(Object.keys(result.dataCloud)).toEqual(["Lake1"]);
      expect(result.warnings).toEqual([
        "Data 360 family coverage is partial: subrequest budget exhausted",
      ]);
      // Budget is scoped to the call: later requests are unlimited again.
      const followUp = await client.retrieve(objects, [], 1);
      expect(calls).toBe(3);
      expect(Object.keys(followUp.dataCloud).sort()).toEqual(["Lake1", "Model1"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sizes the worker retrieve budget below the invocation subrequest limit", () => {
    expect(DATA_CLOUD_RETRIEVE_SUBREQUEST_BUDGET).toBeLessThan(50);
    expect(DATA_CLOUD_RETRIEVE_SUBREQUEST_BUDGET).toBeGreaterThan(0);
  });
});
