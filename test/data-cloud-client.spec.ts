import { describe, it, expect, vi } from "vitest";
import { DataCloudClient, DATA_CLOUD_RETRIEVE_SUBREQUEST_BUDGET } from "../src/data-cloud-client";
import { CACHE_TTL, cacheGetJSON, cachePutJSON, lastGoodCacheKey } from "../src/cache";
import type { DataCloudObject, SalesforceConnection } from "../src/types";

function installFakeCaches(): Map<string, Response> {
  const store = new Map<string, Response>();
  (globalThis as any).caches = {
    default: {
      match: async (req: Request) => {
        const hit = store.get(req.url);
        return hit ? hit.clone() : undefined;
      },
      put: async (req: Request, res: Response) => {
        store.set(req.url, res.clone());
      },
      delete: async (req: Request) => store.delete(req.url),
    },
  };
  return store;
}

const dmoCatalogEntry = {
  apiName: "Individual__dm",
  developerName: "Individual__dm",
  name: "Individual__dm",
  dataSpaceName: "default",
  label: "Individual",
  isEnabled: true,
  isUnstructured: false,
  isLink: false,
  isUnified: false,
  category: "Profile",
  creationType: "Custom",
  definitionType: "STANDARD",
  fields: [
    { name: "Id__c", label: "Id", isPrimaryKey: true },
    { name: "Email__c", label: "Email Address", isPrimaryKey: false },
  ],
  description: "dropped junk",
  customNested: { deep: [1, 2, 3] },
};

function installCatalogFetch() {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: any) => {
    const href = String(url);
    urls.push(href);
    if (href.includes("data-spaces")) return Response.json({ dataSpaces: [{ name: "default" }] });
    if (href.includes("identity-resolutions")) return Response.json({ identityResolutions: [] });
    if (href.includes("data-lake-objects")) return Response.json({ dataLakeObjects: [] });
    if (href.includes("data-model-objects")) return Response.json({ dataModelObject: [dmoCatalogEntry] });
    if (href.includes("data-graphs/metadata")) return Response.json({ dataGraphMetadata: [] });
    if (href.includes("calculated-insights")) return Response.json({ collection: { items: [] } });
    throw new Error(`unexpected catalog url ${href}`);
  });
  return { urls, restore: () => { globalThis.fetch = originalFetch; } };
}

const graphObject = (name: string): DataCloudObject => ({
  name,
  dataSpace: "default",
  family: "data-graph",
  storageKey: name,
  metadata: {
    apiName: name,
    dgObject: { developerName: "Primary__dlm", fields: [{ developerName: "Id__c", keyCol: true }] },
    primaryObjectName: "Primary__dlm",
    valuesDmoName: "Vals__dm",
  },
});

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

  it("slims catalog metadata at discovery, dropping fields but keeping classification markers", async () => {
    const client = new DataCloudClient(conn, "v68.0");
    const fetchState = installCatalogFetch();
    try {
      const catalog = await client.discover();
      expect(catalog.objects).toHaveLength(1);
      expect(catalog.objects[0].family).toBe("dmo");
      const metadata = catalog.objects[0].metadata;
      expect(metadata.fields).toBeUndefined();
      expect(metadata.description).toBeUndefined();
      expect(metadata.customNested).toBeUndefined();
      expect(Object.keys(metadata).sort()).toEqual([
        "apiName", "category", "creationType", "dataSpaceName", "definitionType",
        "developerName", "isEnabled", "isLink", "isUnified", "isUnstructured", "label", "name",
      ]);
      expect(metadata.label).toBe("Individual");
      expect(metadata.isEnabled).toBe(true);
    } finally {
      fetchState.restore();
    }
  });

  it("keeps full object schemas when includeObjectSchemas is set", async () => {
    const client = new DataCloudClient(conn, "v68.0");
    const fetchState = installCatalogFetch();
    try {
      const catalog = await client.discover({ includeObjectSchemas: true });
      expect(catalog.objects).toHaveLength(1);
      expect(catalog.objects[0].metadata).toEqual(dmoCatalogEntry);
    } finally {
      fetchState.restore();
    }
  });

  it("serves discovery from the catalog cache without fetching", async () => {
    const originalCaches = (globalThis as any).caches;
    installFakeCaches();
    const client = new DataCloudClient({ ...conn, orgId: "00Dcatalog1" }, "v68.0");
    const fetchState = installCatalogFetch();
    try {
      const first = await client.discover();
      expect(first.objects).toHaveLength(1);
      expect(fetchState.urls.length).toBeGreaterThan(0);
      let calls = 0;
      const liveFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        calls++;
        throw new Error("must not fetch on catalog cache hit");
      });
      try {
        const second = await client.discover();
        expect(calls).toBe(0);
        expect(second.objects).toEqual(first.objects);
        expect(second.dataSpaces).toEqual(first.dataSpaces);
        expect(second.identityResolutions).toEqual(first.identityResolutions);
        expect(second.warnings).toEqual([]);
      } finally {
        globalThis.fetch = liveFetch;
      }
    } finally {
      fetchState.restore();
      (globalThis as any).caches = originalCaches;
    }
  });

  it("fetches the Data Graph action descriptor once for two graph objects", async () => {
    const client = new DataCloudClient(conn, "v68.0");
    const originalFetch = globalThis.fetch;
    let descriptorGets = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: any, init: any) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      if (href.includes("cdpGetDataGraphByLookup") && method === "GET") {
        descriptorGets++;
        return Response.json({ inputs: [{ name: "DataGraphApiName" }, { name: "DataspaceApiName" }, { name: "LookupKey" }] });
      }
      if (href.includes("cdpGetDataGraphByLookup") && method === "POST") {
        return Response.json([{ isSuccess: true, outputValues: { data: [{ id: "g1" }] } }]);
      }
      if (href.includes("query-sql")) {
        return Response.json({ data: [{ Id__c: "1" }], metadata: { columns: [{ name: "Id__c" }] } });
      }
      throw new Error(`unexpected url ${href}`);
    });
    try {
      const result = await client.retrieve([graphObject("Graph1"), graphObject("Graph2")], ["Graph1", "Graph2"], 5);
      expect(descriptorGets).toBe(1);
      expect(Object.keys(result.dataGraphs).sort()).toEqual(["Graph1", "Graph2"]);
      expect(result.warnings).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("queries the hinted last-good object first", async () => {
    const originalCaches = (globalThis as any).caches;
    installFakeCaches();
    const orgId = "00DhintFirst";
    await cachePutJSON(lastGoodCacheKey(orgId, "dmo"), { storageKey: "Model2" }, CACHE_TTL.lastGood);
    const client = new DataCloudClient({ ...conn, orgId }, "v68.0");
    const dmoPair: DataCloudObject[] = [
      { name: "Model1", dataSpace: "default", family: "dmo", storageKey: "Model1", metadata: {} },
      { name: "Model2", dataSpace: "default", family: "dmo", storageKey: "Model2", metadata: {} },
    ];
    const originalFetch = globalThis.fetch;
    const queriedSql: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_url: any, init: any) => {
      queriedSql.push(String(init?.body ?? ""));
      return Response.json({ data: [{ id: "r1" }], metadata: { columns: [{ name: "id" }] } });
    });
    try {
      const result = await client.retrieve(dmoPair, [], 1);
      expect(queriedSql).toHaveLength(1);
      expect(JSON.parse(queriedSql[0]).sql).toContain('"Model2"');
      expect(Object.keys(result.dataCloud)).toEqual(["Model2"]);
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).caches = originalCaches;
    }
  });

  it("falls through to a normal scan when the hint is stale", async () => {
    const originalCaches = (globalThis as any).caches;
    installFakeCaches();
    const orgId = "00DhintStale";
    await cachePutJSON(lastGoodCacheKey(orgId, "dmo"), { storageKey: "GhostObject" }, CACHE_TTL.lastGood);
    const client = new DataCloudClient({ ...conn, orgId }, "v68.0");
    const dmoPair: DataCloudObject[] = [
      { name: "Model1", dataSpace: "default", family: "dmo", storageKey: "Model1", metadata: {} },
      { name: "Model2", dataSpace: "default", family: "dmo", storageKey: "Model2", metadata: {} },
    ];
    const originalFetch = globalThis.fetch;
    const queriedSql: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_url: any, init: any) => {
      queriedSql.push(String(init?.body ?? ""));
      return Response.json({ data: [{ id: "r1" }], metadata: { columns: [{ name: "id" }] } });
    });
    try {
      const result = await client.retrieve(dmoPair, [], 1);
      expect(queriedSql).toHaveLength(1);
      expect(JSON.parse(queriedSql[0]).sql).toContain('"Model1"');
      expect(Object.keys(result.dataCloud)).toEqual(["Model1"]);
      // The successful read replaces the stale hint.
      expect(await cacheGetJSON<{ storageKey: string }>(lastGoodCacheKey(orgId, "dmo"))).toEqual({ storageKey: "Model1" });
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).caches = originalCaches;
    }
  });

  it("stores a last-good hint after a successful read", async () => {
    const originalCaches = (globalThis as any).caches;
    installFakeCaches();
    const orgId = "00DhintStore";
    const client = new DataCloudClient({ ...conn, orgId }, "v68.0");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return Response.json({ data: [{ id: "r1" }], metadata: { columns: [{ name: "id" }] } });
    });
    try {
      await client.retrieve(objects, [], 1);
      expect(await cacheGetJSON<{ storageKey: string }>(lastGoodCacheKey(orgId, "dlo"))).toEqual({ storageKey: "Lake1" });
      expect(await cacheGetJSON<{ storageKey: string }>(lastGoodCacheKey(orgId, "dmo"))).toEqual({ storageKey: "Model1" });
    } finally {
      globalThis.fetch = originalFetch;
      (globalThis as any).caches = originalCaches;
    }
  });
});
