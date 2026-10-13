import { describe, it, expect, vi } from "vitest";
import { SalesforceBatchClient } from "../src/batch-client";
import type { SalesforceConnection, BatchSubrequest } from "../src/types";

describe("SalesforceBatchClient", () => {
  const conn: SalesforceConnection = {
    accessToken: "mock-batch-token",
    instanceUrl: "https://test.my.salesforce.com",
  };

  it("chunks requests larger than MAX_BATCH_SIZE (25)", async () => {
    const client = new SalesforceBatchClient();
    const calls: any[] = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ url, reqCount: body.batchRequests.length });

      return Response.json({
        hasErrors: false,
        results: body.batchRequests.map((r: any, idx: number) => ({
          statusCode: 200,
          result: { id: `item-${idx}` },
        })),
      });
    });

    try {
      // 30 subrequests -> should produce 2 batch requests: 25 and 5
      const requests: BatchSubrequest[] = Array.from({ length: 30 }, (_, i) => ({
        method: "GET",
        url: `v65.0/sobjects/Account/${i}`,
      }));

      const results = await client.executeBatch(conn, requests);

      expect(calls.length).toBe(2);
      expect(calls[0].reqCount).toBe(25);
      expect(calls[1].reqCount).toBe(5);
      expect(results.length).toBe(30);
      expect(results[0].statusCode).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("handles partial errors in batch without throwing", async () => {
    const client = new SalesforceBatchClient();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return Response.json({
        hasErrors: true,
        results: [
          { statusCode: 200, result: { records: [{ Id: "001" }] } },
          { statusCode: 404, result: [{ message: "sObject not found" }] },
        ],
      });
    });

    try {
      const results = await client.batchQueries(conn, [
        "SELECT Id FROM Account",
        "SELECT Id FROM NonExistentObject",
      ]);

      expect(results.length).toBe(2);
      expect(results[0].records).toEqual([{ Id: "001" }]);
      expect(results[0].error).toBeUndefined();
      expect(results[1].records).toEqual([]);
      expect(results[1].error).toBe("sObject not found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("batchDescribes maps object names to their describe schema", async () => {
    const client = new SalesforceBatchClient();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      return Response.json({
        hasErrors: false,
        results: [
          { statusCode: 200, result: { name: "Individual", label: "Individual" } },
          { statusCode: 200, result: { name: "Order", label: "Order" } },
        ],
      });
    });

    try {
      const describes = await client.batchDescribes(conn, ["Individual", "Order"]);
      expect(describes.Individual).toEqual({ name: "Individual", label: "Individual" });
      expect(describes.Order).toEqual({ name: "Order", label: "Order" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
