import type {
  BatchSubrequest,
  BatchSubresponse,
  CompositeBatchResponse,
  SalesforceConnection,
} from "./types";

export class SalesforceBatchClient {
  static readonly MAX_BATCH_SIZE = 25;
  static readonly DEFAULT_API_VERSION = "v65.0";

  /**
   * Executes a collection of Salesforce REST subrequests using the Composite Batch API.
   * Automatically partitions subrequests into chunks of up to 25 and executes them.
   */
  async executeBatch(
    conn: SalesforceConnection,
    subrequests: BatchSubrequest[],
    apiVersion: string = SalesforceBatchClient.DEFAULT_API_VERSION
  ): Promise<BatchSubresponse[]> {
    if (subrequests.length === 0) return [];

    const normApiVersion = apiVersion.startsWith("v") ? apiVersion : `v${apiVersion}`;
    const chunks: BatchSubrequest[][] = [];

    for (let i = 0; i < subrequests.length; i += SalesforceBatchClient.MAX_BATCH_SIZE) {
      chunks.push(subrequests.slice(i, i + SalesforceBatchClient.MAX_BATCH_SIZE));
    }

    const allResults: BatchSubresponse[] = [];

    for (const chunk of chunks) {
      const normalizedRequests = chunk.map((req) => {
        let url = req.url;
        // Normalize url: remove leading slash or /services/data/ prefix
        if (url.startsWith("/services/data/")) {
          url = url.slice("/services/data/".length);
        } else if (url.startsWith("/")) {
          url = url.slice(1);
        }
        if (!url.startsWith("v") && !url.includes("/")) {
          url = `${normApiVersion}/${url}`;
        }
        return {
          method: req.method,
          url,
          ...(req.richInput !== undefined ? { richInput: req.richInput } : {}),
        };
      });

      const endpoint = `${conn.instanceUrl}/services/data/${normApiVersion}/composite/batch`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${conn.accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          batchRequests: normalizedRequests,
          haltOnError: false,
        }),
      });

      if (!response.ok) {
        let errBody = `HTTP ${response.status} ${response.statusText}`;
        try {
          errBody = await response.text();
        } catch {}
        throw new Error(`Salesforce composite/batch API failed: ${errBody}`);
      }

      const batchData = (await response.json()) as CompositeBatchResponse;
      if (Array.isArray(batchData?.results)) {
        allResults.push(...batchData.results);
      } else {
        throw new Error("Invalid response format received from Salesforce composite/batch API.");
      }
    }

    return allResults;
  }

  /**
   * Executes multiple SOQL queries in a single batched network round-trip.
   */
  async batchQueries<T = any>(
    conn: SalesforceConnection,
    queries: string[],
    apiVersion: string = SalesforceBatchClient.DEFAULT_API_VERSION
  ): Promise<Array<{ query: string; records: T[]; error?: string }>> {
    const normApiVersion = apiVersion.startsWith("v") ? apiVersion : `v${apiVersion}`;
    const subrequests: BatchSubrequest[] = queries.map((q) => ({
      method: "GET",
      url: `${normApiVersion}/query?q=${encodeURIComponent(q)}`,
    }));

    const results = await this.executeBatch(conn, subrequests, normApiVersion);

    return results.map((res, index) => {
      const query = queries[index];
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const records = Array.isArray(res.result?.records) ? res.result.records : [];
        return { query, records };
      }
      const errMsg =
        Array.isArray(res.result) && res.result[0]?.message
          ? res.result[0].message
          : res.result?.message || `HTTP ${res.statusCode}`;
      return { query, records: [], error: errMsg };
    });
  }

  /**
   * Retrieves object describes for multiple sObjects/DMOs in batched requests.
   */
  async batchDescribes(
    conn: SalesforceConnection,
    sobjectNames: string[],
    apiVersion: string = SalesforceBatchClient.DEFAULT_API_VERSION
  ): Promise<Record<string, any>> {
    const normApiVersion = apiVersion.startsWith("v") ? apiVersion : `v${apiVersion}`;
    const uniqueNames = Array.from(new Set(sobjectNames.filter(Boolean)));
    const subrequests: BatchSubrequest[] = uniqueNames.map((name) => ({
      method: "GET",
      url: `${normApiVersion}/sobjects/${name}/describe`,
    }));

    const results = await this.executeBatch(conn, subrequests, normApiVersion);
    const describes: Record<string, any> = {};

    results.forEach((res, index) => {
      const name = uniqueNames[index];
      if (res.statusCode >= 200 && res.statusCode < 300 && res.result) {
        describes[name] = res.result;
      }
    });

    return describes;
  }

  /**
   * Convenience single query for quick lookups.
   */
  async querySingle<T = any>(
    conn: SalesforceConnection,
    soql: string,
    apiVersion: string = SalesforceBatchClient.DEFAULT_API_VERSION
  ): Promise<T[]> {
    const normApiVersion = apiVersion.startsWith("v") ? apiVersion : `v${apiVersion}`;
    const url = `${conn.instanceUrl}/services/data/${normApiVersion}/query?q=${encodeURIComponent(soql)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${conn.accessToken}`,
        Accept: "application/json",
      },
    });

    if (!res.ok) {
      let errText = `HTTP ${res.status}`;
      try {
        errText = await res.text();
      } catch {}
      throw new Error(`SOQL query failed: ${errText}`);
    }

    const data = (await res.json()) as { records?: T[] };
    return data.records || [];
  }
}
