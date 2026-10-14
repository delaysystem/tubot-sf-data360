import { describe, it, expect, beforeEach } from "vitest";
import { B2CacheManager, B2Client, type B2ClientInterface } from "../src/b2-cache-manager";
import type {
  ExportManifest,
  ExtractedData360Package,
  ExtractedUnstructuredFile,
} from "../src/types";

class MockB2Client implements B2ClientInterface {
  public bucketId = "test-bucket-id";
  public bucketName = "test-bucket-name";
  public files = new Map<string, { data: Uint8Array; contentType?: string }>();
  public uploadCalls: Array<{ fileName: string; size: number; contentType?: string }> = [];

  async uploadFile(fileName: string, data: Uint8Array | string, contentType?: string) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.files.set(fileName, { data: bytes, contentType });
    this.uploadCalls.push({ fileName, size: bytes.length, contentType });
    return {
      fileId: `file-${this.uploadCalls.length}`,
      fileName,
      contentLength: bytes.length,
    };
  }

  async downloadFile(fileName: string): Promise<Uint8Array | null> {
    const file = this.files.get(fileName);
    return file ? file.data : null;
  }

  async listFileNames(
    prefixOrOptions?:
      | string
      | { prefix?: string; startFileName?: string; maxFileCount?: number; delimiter?: string }
  ) {
    const prefix =
      typeof prefixOrOptions === "string" ? prefixOrOptions : prefixOrOptions?.prefix || "";
    const matching: Array<{ fileId: string; fileName: string; contentLength: number }> = [];

    for (const [name, file] of this.files.entries()) {
      if (name.startsWith(prefix)) {
        matching.push({
          fileId: `id-${name}`,
          fileName: name,
          contentLength: file.data.length,
        });
      }
    }
    return { files: matching };
  }
}

describe("B2CacheManager", () => {
  let mockClient: MockB2Client;
  let cacheManager: B2CacheManager;
  let samplePkg: ExtractedData360Package;

  beforeEach(() => {
    mockClient = new MockB2Client();
    cacheManager = new B2CacheManager(mockClient);

    const manifest: ExportManifest = {
      version: "1.0.0",
      exportTimestamp: "2026-09-25T12:00:00.000Z",
      target: {
        channelId: "0Mj000000000001",
        agentName: "SupportAgent",
      },
      salesforce: {
        instanceUrl: "https://acme-corp.my.salesforce.com",
        apiVersion: "v60.0",
      },
      summary: {
        dmoCount: 1,
        dmos: ["UnifiedIndividual__dlm"],
        marketSegmentCount: 1,
        dataSpaceCount: 1,
        crmRecordCounts: { Individual: 1 },
        dataCloudRecordCounts: { UnifiedIndividual__dlm: 1 },
        totalBatchRequests: 2,
        totalSubrequests: 4,
        fileCount: 4,
      },
    };

    const unstructuredFiles: ExtractedUnstructuredFile[] = [
      {
        id: "file-doc-1",
        sourceObject: "ContentVersion",
        title: "Policy Handbook",
        filename: "policy.txt",
        category: "text",
        fileType: "TEXT",
        contentType: "text/plain",
        contentSize: 19,
        data: new TextEncoder().encode("Refunds within 30d."),
      },
      {
        id: "file-bin-1",
        sourceObject: "StaticResource",
        title: "Firmware Binary",
        filename: "firmware.bin",
        category: "other",
        fileType: "BIN",
        contentType: "application/octet-stream",
        contentSize: 4,
        data: new Uint8Array([0xca, 0xfe, 0xba, 0xbe]),
      },
    ];

    samplePkg = {
      manifest,
      agent: {
        agentName: "SupportAgent",
        channelName: "0Mj000000000001",
        script: "system: Help users",
        callableTools: [{ id: "tool-1", url: "https://api.acme.com/search" }],
        localActions: { checkStatus: { type: "flow" } },
      },
      metadata: {
        channel: { Id: "0Mj000000000001", Name: "Support Channel" },
        dataSpaces: [{ Id: "ds-01", Name: "DefaultDataSpace" }],
        marketSegments: [{ Id: "seg-01", Name: "VIPCustomers" }],
        calculatedInsights: [{ Id: "ci-01", Name: "LTVInsight" }],
        identityResolutionRules: [{ Id: "ir-01", Name: "EmailMatch" }],
        dmoDescribes: {
          UnifiedIndividual__dlm: { name: "UnifiedIndividual__dlm", fields: [] },
        },
        dmoCatalog: [{ name: "UnifiedIndividual__dlm" }],
      },
      records: {
        crm: {
          individuals: [{ Id: "003001", FirstName: "John", LastName: "Doe" }],
          contactPointEmails: [{ Id: "0CP001", EmailAddress: "john@example.com" }],
          contactPointPhones: [],
          orders: [{ Id: "801001", OrderNumber: "SO-101" }],
          orderItems: [],
          leads: [],
          accounts: [{ Id: "001001", Name: "Acme LLC" }],
          messagingSessions: [],
        },
        dataCloud: {
          UnifiedIndividual__dlm: [
            { id__c: "UI-100", firstName__c: "John", lastName__c: "Doe" },
          ],
        },
      },
      unstructuredFiles,
      zipBytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00]), // ZIP header
    };
  });

  describe("Initialization & Environment Configuration", () => {
    it("uses injected B2Client instance", () => {
      const mgr = new B2CacheManager(mockClient);
      expect(mgr.client).toBe(mockClient);
    });

    it("constructs default B2Client with config or process.env variables", () => {
      const prevKeyId = process.env.BACKBLAZE_KEY_ID;
      const prevAppKey = process.env.BACKBLAZE_APPLICATION_KEY;
      const prevBucket = process.env.BACKBLAZE_BUCKET_ID;

      process.env.BACKBLAZE_KEY_ID = "env-key-id";
      process.env.BACKBLAZE_APPLICATION_KEY = "env-app-key";
      process.env.BACKBLAZE_BUCKET_ID = "env-bucket-id";

      try {
        const mgr = new B2CacheManager();
        expect(mgr.client).toBeInstanceOf(B2Client);
        const defaultClient = mgr.client as B2Client;
        expect(defaultClient.keyId).toBe("env-key-id");
        expect(defaultClient.applicationKey).toBe("env-app-key");
        expect(defaultClient.bucketId).toBe("env-bucket-id");
      } finally {
        process.env.BACKBLAZE_KEY_ID = prevKeyId;
        process.env.BACKBLAZE_APPLICATION_KEY = prevAppKey;
        process.env.BACKBLAZE_BUCKET_ID = prevBucket;
      }
    });

    it("constructs default B2Client using explicit B2Config object", () => {
      const mgr = new B2CacheManager({
        keyId: "custom-key",
        applicationKey: "custom-app-key",
        bucketId: "custom-bucket",
        endpoint: "s3.custom.backblazeb2.com",
      });
      const client = mgr.client as B2Client;
      expect(client.keyId).toBe("custom-key");
      expect(client.bucketId).toBe("custom-bucket");
    });
  });

  describe("savePackage", () => {
    it("saves all package components into Backblaze B2 storage structure", async () => {
      const b2Meta = await cacheManager.savePackage(samplePkg, {
        snapshotId: "snap-2026-09-25",
        ttlSeconds: 3600,
      });

      // Target extracted from channelId (0Mj000000000001), orgId extracted from acme-corp.my.salesforce.com -> acme-corp
      expect(b2Meta.stored).toBe(true);
      expect(b2Meta.snapshotId).toBe("snap-2026-09-25");
      expect(b2Meta.basePath).toBe("data360/acme-corp/0Mj000000000001/snapshots/snap-2026-09-25");
      expect(b2Meta.bandwidthAlliance).toBe(true);
      expect(b2Meta.expiresAt).toBeDefined();
      expect(b2Meta.totalBytes).toBeGreaterThan(0);
      expect(b2Meta.fileCount).toBeGreaterThan(0);
      expect(b2Meta.zipUrl).toBe(
        "data360/acme-corp/0Mj000000000001/snapshots/snap-2026-09-25/data360-export.zip"
      );

      // Verify files uploaded into mock storage
      const uploadedKeys = Array.from(mockClient.files.keys());

      // 1. latest.json pointer
      expect(uploadedKeys).toContain("data360/acme-corp/0Mj000000000001/latest.json");

      // 2. manifest.json
      expect(uploadedKeys).toContain(
        "data360/acme-corp/0Mj000000000001/snapshots/snap-2026-09-25/manifest.json"
      );

      // 3. data360-export.zip
      expect(uploadedKeys).toContain(
        "data360/acme-corp/0Mj000000000001/snapshots/snap-2026-09-25/data360-export.zip"
      );

      // 4. Single data-bundle.json replaces the exploded per-entity layout
      // (one exploded file per entity costs 2 B2 subrequests each and exceeds
      // the per-invocation subrequest budget on small plans).
      expect(uploadedKeys).toContain(
        "data360/acme-corp/0Mj000000000001/snapshots/snap-2026-09-25/data-bundle.json"
      );
      const bundleRaw = mockClient.files.get(
        "data360/acme-corp/0Mj000000000001/snapshots/snap-2026-09-25/data-bundle.json"
      );
      const bundle = JSON.parse(new TextDecoder().decode(bundleRaw!.data));
      expect(bundle.version).toBe(1);
      expect(bundle.records.crm.individuals[0].FirstName).toBe("John");
      expect(bundle.records.dataCloud["UnifiedIndividual__dlm"][0].firstName__c).toBe("John");
      expect(bundle.metadata.marketSegments).toBeDefined();
      expect(bundle.files.map((f: any) => f.filename).sort()).toEqual([
        "firmware.bin",
        "policy.txt",
      ]);

      // 5. No exploded per-entity uploads (subrequest budget)
      for (const key of uploadedKeys) {
        expect(key).not.toMatch(/\/metadata\/(segments|data-spaces|dmos|files-manifest)/);
        expect(key).not.toMatch(/\/data\/(crm|data-cloud)\//);
        expect(key).not.toMatch(/\/files\//);
      }
      expect(uploadedKeys).toHaveLength(4); // zip, bundle, manifest, latest
    });

    it("handles package without zipBytes or unstructured files", async () => {
      const minimalPkg: ExtractedData360Package = {
        manifest: {
          version: "1.0.0",
          exportTimestamp: "2026-09-25T14:00:00.000Z",
          target: { agentName: "BillingAgent" },
          salesforce: { instanceUrl: "https://simple.salesforce.com", apiVersion: "v60.0" },
          summary: {
            dmoCount: 0,
            dmos: [],
            marketSegmentCount: 0,
            dataSpaceCount: 0,
            crmRecordCounts: {},
            dataCloudRecordCounts: {},
            totalBatchRequests: 1,
            totalSubrequests: 1,
            fileCount: 1,
          },
        },
        agent: { agentName: "BillingAgent" },
        metadata: {
          dataSpaces: [],
          marketSegments: [],
          calculatedInsights: [],
          identityResolutionRules: [],
          dmoDescribes: {},
          dmoCatalog: [],
        },
        records: {
          crm: {
            individuals: [],
            contactPointEmails: [],
            contactPointPhones: [],
            orders: [],
            orderItems: [],
            leads: [],
            accounts: [],
            messagingSessions: [],
          },
          dataCloud: {},
        },
      };

      const meta = await cacheManager.savePackage(minimalPkg, {
        orgId: "org-custom",
        targetId: "BillingAgent",
        snapshotId: "snap-billing-1",
      });

      expect(meta.stored).toBe(true);
      expect(meta.basePath).toBe("data360/org-custom/BillingAgent/snapshots/snap-billing-1");
      expect(meta.zipUrl).toBeUndefined();

      const uploadedKeys = Array.from(mockClient.files.keys());
      expect(uploadedKeys).toContain("data360/org-custom/BillingAgent/latest.json");
      expect(uploadedKeys).toContain(
        "data360/org-custom/BillingAgent/snapshots/snap-billing-1/manifest.json"
      );
      expect(uploadedKeys).not.toContain(
        "data360/org-custom/BillingAgent/snapshots/snap-billing-1/data360-export.zip"
      );
    });
  });

  describe("B2Client bucket name resolution", () => {
    it("adopts the authorize-derived bucket name when configured with an id", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        Response.json({
          authorizationToken: "tok",
          apiUrl: "https://api.backblazeb2.com",
          downloadUrl: "https://f.backblazeb2.com",
          allowed: { bucketId: "f00df00df00df00df00df00d", bucketName: "tubot-encrypted" },
        })) as any;
      try {
        const client = new B2Client({
          keyId: "k",
          applicationKey: "a",
          bucketId: "f00df00df00df00df00df00d",
        });
        expect(client.bucketName).toBe("f00df00df00df00df00df00d");
        await client.authorize();
        expect(client.bucketName).toBe("tubot-encrypted");
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it("keeps an explicitly configured bucket name", async () => {
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        Response.json({
          authorizationToken: "tok",
          apiUrl: "https://api.backblazeb2.com",
          downloadUrl: "https://f.backblazeb2.com",
          allowed: { bucketId: "f00df00df00df00df00df00d", bucketName: "other-name" },
        })) as any;
      try {
        const client = new B2Client({
          keyId: "k",
          applicationKey: "a",
          bucketId: "f00df00df00df00df00df00d",
          bucketName: "explicit-name",
        });
        await client.authorize();
        expect(client.bucketName).toBe("explicit-name");
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe("pathPrefix environment isolation", () => {
    it("scopes every key under the configured prefix and rejects hostile values", async () => {
      const prefixed = new B2CacheManager(mockClient, {
        keyId: "k",
        applicationKey: "a",
        bucketId: "b",
        pathPrefix: "data360-prod",
      });
      expect(prefixed.rootPrefix()).toBe("data360-prod");
      const meta = await prefixed.savePackage(samplePkg, { snapshotId: "snap-1" });
      expect(meta.basePath).toBe("data360-prod/acme-corp/0Mj000000000001/snapshots/snap-1");
      const keys = Array.from(mockClient.files.keys());
      expect(keys).toContain("data360-prod/acme-corp/0Mj000000000001/latest.json");
      expect(keys.every((k) => k.startsWith("data360-prod/"))).toBe(true);
      const latest = await prefixed.getLatestSnapshot("acme-corp", "0Mj000000000001");
      expect(latest?.snapshotId).toBe("snap-1");
      const dmo = await prefixed.queryCachedEntity("acme-corp", "0Mj000000000001", {
        dmo: "UnifiedIndividual__dlm",
      });
      expect(dmo[0].firstName__c).toBe("John");

      const hostile = new B2CacheManager(mockClient, {
        keyId: "k",
        applicationKey: "a",
        bucketId: "b",
        pathPrefix: "../../evil",
      });
      expect(hostile.rootPrefix()).toBe("data360");
    });
  });

  describe("getLatestSnapshot", () => {
    it("returns parsed B2SnapshotSummary when latest.json exists", async () => {
      await cacheManager.savePackage(samplePkg, {
        snapshotId: "snap-latest-123",
      });

      const summary = await cacheManager.getLatestSnapshot("acme-corp", "0Mj000000000001");
      expect(summary).not.toBeNull();
      expect(summary?.snapshotId).toBe("snap-latest-123");
      expect(summary?.orgId).toBe("acme-corp");
      expect(summary?.targetId).toBe("0Mj000000000001");
      expect(summary?.manifest.target.agentName).toBe("SupportAgent");
      expect(summary?.zipFileName).toBe("data360-export.zip");
      expect(summary?.totalBytes).toBeGreaterThan(0);
      expect(summary?.fileCount).toBeGreaterThan(0);
    });

    it("returns null when latest.json does not exist", async () => {
      const summary = await cacheManager.getLatestSnapshot("nonexistent-org", "nonexistent-target");
      expect(summary).toBeNull();
    });
  });

  describe("queryCachedEntity", () => {
    beforeEach(async () => {
      await cacheManager.savePackage(samplePkg, {
        snapshotId: "snap-query-test",
      });
    });

    it("queries Data Cloud DMO records", async () => {
      const dmoRecords = await cacheManager.queryCachedEntity("acme-corp", "0Mj000000000001", {
        dmo: "UnifiedIndividual__dlm",
      });

      expect(Array.isArray(dmoRecords)).toBe(true);
      expect(dmoRecords).toHaveLength(1);
      expect(dmoRecords[0].firstName__c).toBe("John");
    });

    it("queries CRM entity records by canonical object name", async () => {
      const individualRecords = await cacheManager.queryCachedEntity(
        "acme-corp",
        "0Mj000000000001",
        {
          crmEntity: "Individual",
        }
      );

      expect(Array.isArray(individualRecords)).toBe(true);
      expect(individualRecords[0].FirstName).toBe("John");
    });

    it("queries CRM entity records by plural/property key", async () => {
      const individualRecords = await cacheManager.queryCachedEntity(
        "acme-corp",
        "0Mj000000000001",
        {
          crmEntity: "individuals",
        }
      );

      expect(Array.isArray(individualRecords)).toBe(true);
      expect(individualRecords[0].FirstName).toBe("John");
    });

    it("queries text unstructured file as string text", async () => {
      const textContent = await cacheManager.queryCachedEntity("acme-corp", "0Mj000000000001", {
        file: "policy.txt",
      });

      expect(typeof textContent).toBe("string");
      expect(textContent).toBe("Refunds within 30d.");
    });

    it("queries binary unstructured file as Uint8Array", async () => {
      const binContent = await cacheManager.queryCachedEntity("acme-corp", "0Mj000000000001", {
        file: "firmware.bin",
      });

      expect(binContent).toBeInstanceOf(Uint8Array);
      expect(binContent[0]).toBe(0xca);
      expect(binContent[1]).toBe(0xfe);
    });

    it("queries full snapshot manifest when no specific entity is provided", async () => {
      const manifest = await cacheManager.queryCachedEntity("acme-corp", "0Mj000000000001", {});

      expect(manifest).toBeDefined();
      expect(manifest.version).toBe("1.0.0");
      expect(manifest.target.agentName).toBe("SupportAgent");
    });

    it("supports querying against an explicit snapshotId", async () => {
      // Save another snapshot with different data
      const modifiedPkg = structuredClone(samplePkg);
      modifiedPkg.records.crm.individuals = [{ Id: "003002", FirstName: "Bob", LastName: "Ross" }];

      await cacheManager.savePackage(modifiedPkg, {
        snapshotId: "snap-query-explicit",
      });

      const recordsFromOlderSnapshot = await cacheManager.queryCachedEntity(
        "acme-corp",
        "0Mj000000000001",
        {
          crmEntity: "Individual",
          snapshotId: "snap-query-test",
        }
      );

      const recordsFromNewerSnapshot = await cacheManager.queryCachedEntity(
        "acme-corp",
        "0Mj000000000001",
        {
          crmEntity: "Individual",
          snapshotId: "snap-query-explicit",
        }
      );

      expect(recordsFromOlderSnapshot[0].FirstName).toBe("John");
      expect(recordsFromNewerSnapshot[0].FirstName).toBe("Bob");
    });

    it("falls back to the legacy exploded layout when no bundle exists", async () => {
      const prefix = "data360/acme-corp/0Mj000000000001/snapshots/snap-legacy";
      const enc = new TextEncoder();
      mockClient.files.set(`${prefix}/data/data-cloud/UnifiedIndividual__dlm.json`, {
        data: enc.encode(JSON.stringify([{ firstName__c: "Legacy" }])),
      });
      mockClient.files.set(`${prefix}/data/crm/Individual.json`, {
        data: enc.encode(JSON.stringify([{ FirstName: "Legacy" }])),
      });
      mockClient.files.set(`${prefix}/files/note.txt`, {
        data: enc.encode("legacy bytes"),
      });

      const dmo = await cacheManager.queryCachedEntity("acme-corp", "0Mj000000000001", {
        dmo: "UnifiedIndividual__dlm",
        snapshotId: "snap-legacy",
      });
      expect(dmo[0].firstName__c).toBe("Legacy");

      const crm = await cacheManager.queryCachedEntity("acme-corp", "0Mj000000000001", {
        crmEntity: "Individual",
        snapshotId: "snap-legacy",
      });
      expect(crm[0].FirstName).toBe("Legacy");

      const file = await cacheManager.queryCachedEntity("acme-corp", "0Mj000000000001", {
        file: "note.txt",
        snapshotId: "snap-legacy",
      });
      expect(file).toBe("legacy bytes");
    });

    it("returns null for non-existent entities", async () => {
      const notFoundDmo = await cacheManager.queryCachedEntity("acme-corp", "0Mj000000000001", {
        dmo: "NonExistent__dlm",
      });
      expect(notFoundDmo).toBeNull();

      const notFoundFile = await cacheManager.queryCachedEntity("acme-corp", "0Mj000000000001", {
        file: "missing.pdf",
      });
      expect(notFoundFile).toBeNull();
    });
  });

  describe("downloadCachedZip", () => {
    beforeEach(async () => {
      await cacheManager.savePackage(samplePkg, {
        snapshotId: "snap-zip-test",
      });
    });

    it("downloads cached zip bytes from latest snapshot when snapshotId is omitted", async () => {
      const zipBytes = await cacheManager.downloadCachedZip("acme-corp", "0Mj000000000001");
      expect(zipBytes).not.toBeNull();
      expect(zipBytes).toBeInstanceOf(Uint8Array);
      expect(zipBytes![0]).toBe(0x50);
      expect(zipBytes![1]).toBe(0x4b);
    });

    it("downloads cached zip bytes for explicit snapshotId", async () => {
      const zipBytes = await cacheManager.downloadCachedZip(
        "acme-corp",
        "0Mj000000000001",
        "snap-zip-test"
      );
      expect(zipBytes).not.toBeNull();
      expect(zipBytes![0]).toBe(0x50);
    });

    it("returns null when zip archive does not exist", async () => {
      const zipBytes = await cacheManager.downloadCachedZip(
        "acme-corp",
        "0Mj000000000001",
        "nonexistent-snap"
      );
      expect(zipBytes).toBeNull();
    });
  });

  describe("listSnapshots", () => {
    it("calls listFileNames and extracts unique snapshot summaries", async () => {
      await cacheManager.savePackage(samplePkg, {
        snapshotId: "2026-09-24T10-00-00",
      });
      await cacheManager.savePackage(samplePkg, {
        snapshotId: "2026-09-25T15-30-00",
      });

      const snapshots = await cacheManager.listSnapshots("acme-corp", "0Mj000000000001");

      expect(snapshots).toHaveLength(2);
      // Verify sorted descending by snapshotId
      expect(snapshots[0].snapshotId).toBe("2026-09-25T15-30-00");
      expect(snapshots[1].snapshotId).toBe("2026-09-24T10-00-00");

      expect(snapshots[0].orgId).toBe("acme-corp");
      expect(snapshots[0].targetId).toBe("0Mj000000000001");
      expect(snapshots[0].zipFileName).toBe("data360-export.zip");
      expect(snapshots[0].totalBytes).toBeGreaterThan(0);
      expect(snapshots[0].fileCount).toBeGreaterThan(0);
      expect(snapshots[0].manifest.target.agentName).toBe("SupportAgent");
    });

    it("returns empty array when no snapshots exist for target", async () => {
      const snapshots = await cacheManager.listSnapshots("empty-org", "empty-target");
      expect(snapshots).toEqual([]);
    });
  });

  describe("Object-Parameter B2Client Compatibility", () => {
    it("works with B2Client implementing object params and Response downloads", async () => {
      const storage = new Map<string, Uint8Array>();
      const objectClient: B2ClientInterface = {
        bucketId: "obj-bucket-id",
        bucketName: "obj-bucket",
        async uploadFile(params: any, dataArg?: any) {
          const fileName = typeof params === "string" ? params : params.fileName;
          const rawData = typeof params === "string" ? dataArg : params.data;
          const bytes =
            typeof rawData === "string"
              ? new TextEncoder().encode(rawData)
              : rawData;
          storage.set(fileName, bytes);
          return { fileId: "f-1", fileName, contentLength: bytes.length };
        },
        async downloadFile(params: any) {
          const fileName = typeof params === "string" ? params : params?.fileName;
          const bytes = storage.get(fileName);
          if (!bytes) {
            return new Response("Not Found", { status: 404 });
          }
          return new Response(bytes, { status: 200 });
        },
        async listFileNames(params?: any) {
          const prefix = typeof params === "string" ? params : params?.prefix || "";
          const files = [];
          for (const [name, bytes] of storage.entries()) {
            if (name.startsWith(prefix)) {
              files.push({
                fileId: `id-${name}`,
                fileName: name,
                contentLength: bytes.length,
                uploadTimestamp: Date.now(),
              });
            }
          }
          return { files, nextFileName: null };
        },
      };

      const mgr = new B2CacheManager(objectClient);
      const meta = await mgr.savePackage(samplePkg, { snapshotId: "snap-obj-1" });
      expect(meta.stored).toBe(true);

      const latest = await mgr.getLatestSnapshot("acme-corp", "0Mj000000000001");
      expect(latest?.snapshotId).toBe("snap-obj-1");

      const zip = await mgr.downloadCachedZip("acme-corp", "0Mj000000000001");
      expect(zip).not.toBeNull();
      expect(zip![0]).toBe(0x50);

      const dmo = await mgr.queryCachedEntity("acme-corp", "0Mj000000000001", {
        dmo: "UnifiedIndividual__dlm",
      });
      expect(dmo[0].firstName__c).toBe("John");
    });
  });
});

