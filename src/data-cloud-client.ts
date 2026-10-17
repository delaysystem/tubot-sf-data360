import { DATA_CLOUD_FAMILIES, type DataCloudFamily, type DataCloudObject, type SalesforceConnection } from "./types";
import { CACHE_TTL, cacheGetJSON, cachePutJSON, catalogCacheKey, lastGoodCacheKey } from "./cache";

type Row = Record<string, any>;
export const sqlIdentifier = (value: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw new Error("Invalid Data 360 SQL identifier");
  return `"${value}"`;
};

/** Live Data 360 Connect API transport. Never substitutes CRM files for UDMOs. */
const CATALOG_PAGE_SIZE = 1000;
/** Catalog keys whose pages must stay small: API maximums and multi-MB payloads. */
const SMALL_CATALOG_PAGES: Record<string, number> = { collection: 200, dataModelObject: 200 };

export class DataCloudBudgetExhaustedError extends Error {
  constructor() { super("Data 360 retrieval stopped: subrequest budget exhausted"); }
}

/** Caps Data 360 row retrieval so a full export fits the Workers 50-subrequest invocation limit. */
export const DATA_CLOUD_RETRIEVE_SUBREQUEST_BUDGET = 16;

/**
 * Catalog metadata keys retained after discovery. Per-object `fields` arrays
 * and every other key are dropped: full metadata is megabytes and is
 * re-serialized on every export, while the worker only reads these keys
 * (classification markers plus Data Graph lookup inputs). `dgObject` is kept
 * whole because its nested fields carry the Data Graph primary lookup keys.
 */
const SLIM_METADATA_KEYS = [
  "apiName", "developerName", "name", "dataSpaceName", "dataspaceName", "dataSpace",
  "label", "isEnabled", "isUnstructured", "isLink", "isUnified", "category",
  "creationType", "definitionType", "dgObject", "primaryObjectName", "valuesDmoName",
] as const;

const slimMetadata = (metadata: Row): Row => {
  const slim: Row = {};
  for (const key of SLIM_METADATA_KEYS) {
    if (metadata[key] !== undefined) slim[key] = metadata[key];
  }
  return slim;
};

export interface DataCloudDiscoverOptions {
  includeObjectSchemas?: boolean;
}

export class DataCloudClient {
  private readonly root: string;
  private subrequestBudget: number | null = null;
  constructor(private readonly connection: SalesforceConnection, apiVersion: string) {
    if (!/^v\d+\.\d+$/.test(apiVersion)) throw new Error("Invalid Salesforce API version");
    this.root = `/services/data/${apiVersion}/`;
  }

  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    const relative = path.startsWith("/") ? path : `${this.root}ssot/${path}`;
    if (!relative.startsWith(this.root) || relative.includes("..")) throw new Error("Invalid Data 360 API page URL");
    if (this.subrequestBudget !== null) {
      if (this.subrequestBudget <= 0) throw new DataCloudBudgetExhaustedError();
      this.subrequestBudget--;
    }
    const response = await fetch(new URL(relative, this.connection.instanceUrl), {
      method, signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${this.connection.accessToken}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      // Upstream error bodies can contain lookup keys or customer values.
      throw new Error(`Data 360 ${method} ${relative.split("?")[0]} returned HTTP ${response.status}`);
    }
    return response.json();
  }

  async list(path: string, key: string, dataSpace?: string): Promise<Row[]> {
    const rows: Row[] = [];
    const seen = new Set<string>();
    const pageSignatures = new Set<string>();
    let offset = 0;
    const pageSize = SMALL_CATALOG_PAGES[key] ?? CATALOG_PAGE_SIZE;
    let next: string | undefined = `${path}?${new URLSearchParams({ ...(dataSpace ? { dataspace: dataSpace } : {}), ...(key === "collection" ? { batchSize: String(pageSize) } : { limit: String(pageSize) }), offset: "0" })}`;
    while (next) {
      if (seen.has(next)) throw new Error(`Data 360 ${path} repeated a catalog page`);
      seen.add(next);
      const body = await this.request(next);
      const collection = key === "collection" ? body.collection : body;
      const page = key === "collection" ? collection?.items : body[key];
      if (!Array.isArray(page)) throw new Error(`Data 360 ${path} returned an invalid catalog`);
      const signature = JSON.stringify(page.map((item: Row) => item.apiName ?? item.developerName ?? item.name));
      if (page.length && pageSignatures.has(signature)) throw new Error(`Data 360 ${path} ignored catalog pagination`);
      pageSignatures.add(signature);
      rows.push(...page);
      offset += page.length;
      next = collection.nextPageUrl || undefined;
      // DMO catalog has no pagination envelope: continue until its short page.
      if (!next && key === "dataModelObject" && page.length === pageSize) {
        next = `${path}?${new URLSearchParams({ ...(dataSpace ? { dataspace: dataSpace } : {}), limit: String(pageSize), offset: String(offset) })}`;
      }
    }
    return rows;
  }

  async discover(
    onCatalog?: ((family: string, count: number) => void) | DataCloudDiscoverOptions,
    opts?: DataCloudDiscoverOptions,
  ): Promise<{ dataSpaces: Row[]; objects: DataCloudObject[]; identityResolutions: Row[]; warnings: string[]; dataCloudAvailable?: boolean }> {
    const callback = typeof onCatalog === "function" ? onCatalog : undefined;
    const includeObjectSchemas =
      (typeof onCatalog === "object" && onCatalog !== null ? onCatalog.includeObjectSchemas : undefined)
      ?? opts?.includeObjectSchemas ?? false;
    const orgId = this.connection.orgId;
    // Full-schema discovery bypasses the slim catalog cache so the cached
    // payload stays small and opt-in callers always see complete schemas.
    if (orgId && !includeObjectSchemas) {
      const cached = await cacheGetJSON<{ dataSpaces: Row[]; objects: DataCloudObject[]; identityResolutions: Row[] }>(catalogCacheKey(orgId));
      if (cached && Array.isArray(cached.dataSpaces) && Array.isArray(cached.objects) && Array.isArray(cached.identityResolutions)) {
        return { dataSpaces: cached.dataSpaces, objects: cached.objects, identityResolutions: cached.identityResolutions, warnings: [] };
      }
    }
    const result = await this.discoverLive(callback, includeObjectSchemas);
    // A degraded (Data Cloud unavailable) catalog is never cached: caching an
    // empty catalog would mask a later-enabled Data Cloud until TTL expiry.
    if (orgId && !includeObjectSchemas && result.dataCloudAvailable !== false) {
      await cachePutJSON(catalogCacheKey(orgId), {
        dataSpaces: result.dataSpaces, objects: result.objects, identityResolutions: result.identityResolutions,
      }, CACHE_TTL.catalog);
    }
    return result;
  }

  private async discoverLive(
    onCatalog: ((family: string, count: number) => void) | undefined,
    includeObjectSchemas: boolean,
  ): Promise<{ dataSpaces: Row[]; objects: DataCloudObject[]; identityResolutions: Row[]; warnings: string[]; dataCloudAvailable?: boolean }> {
    let dataSpaces: Row[];
    try {
      dataSpaces = await this.list("data-spaces", "dataSpaces");
    } catch (error) {
      // Orgs without Data Cloud answer the catalog root with 403/404: degrade
      // to an empty catalog (warning) instead of failing the whole export.
      // 401 stays fatal: an expired token must surface, not masquerade as
      // a missing feature.
      if (/HTTP (403|404)/.test(String(error))) {
        return {
          dataSpaces: [], objects: [], identityResolutions: [],
          warnings: ["Data Cloud is not available in this org; skipping the Data Cloud catalog."],
          dataCloudAvailable: false,
        };
      }
      throw error;
    }
    const objects: DataCloudObject[] = [];
    const seenObjects = new Set<string>();
    const warnings: string[] = [];
    const identityResolutions: Row[] = [];
    for (const space of dataSpaces) {
      const name = space.name;
      if (typeof name !== "string") continue;
      const resolvedFamilies = new Map<string, DataCloudFamily>();
      try {
        const rulesets = await this.list("identity-resolutions", "identityResolutions", name);
        identityResolutions.push(...rulesets);
        for (const ruleset of rulesets) for (const rule of ruleset.reconciliationRules ?? []) {
          if (rule.unifiedDmoName) resolvedFamilies.set(rule.unifiedDmoName, "unified-dmo");
          if (rule.linkDmoName) resolvedFamilies.set(rule.linkDmoName, "link-dmo");
        }
      } catch (error) {
        if (/HTTP (401|403)/.test(String(error))) throw error;
        warnings.push(error instanceof Error ? error.message : "Identity Resolution discovery failed");
      }
      for (const [path, key, kind] of [
        ["data-lake-objects", "dataLakeObjects", "dlo"],
        ["data-model-objects", "dataModelObject", "dmo"],
        ["data-graphs/metadata", "dataGraphMetadata", "data-graph"],
        ["calculated-insights", "collection", "calculated-insight"],
      ] as const) {
        try {
          for (const metadata of await this.list(path, key, name)) {
            const objectName = metadata.apiName ?? metadata.developerName ?? metadata.name;
            if (typeof objectName !== "string") continue;
            const dataSpace = metadata.dataSpaceName ?? metadata.dataspaceName ?? metadata.dataSpace ?? name;
            let family: DataCloudFamily = kind;
            const role = String(metadata.category ?? metadata.creationType ?? "").replaceAll("_", "").toLowerCase();
            if (kind === "dmo") {
              if (metadata.isUnstructured === true || role === "directorytable" || /__udmo$/i.test(objectName)) family = "udmo";
              else if (metadata.isLink === true || /^(unified)?link|identitylink/i.test(objectName) || /IdentityLink__dlm$/i.test(objectName)) family = "link-dmo";
              else if (metadata.isUnified === true || /^unified/i.test(objectName)) family = "unified-dmo";
            }
            if (kind === "calculated-insight" && metadata.definitionType === "STREAMING_METRIC") continue; // Deferred until live streaming coverage is available.
            if (kind === "dmo" && resolvedFamilies.has(objectName)) family = resolvedFamilies.get(objectName)!;
            const dedupeKey = `${dataSpace}\0${objectName}\0${family}`;
            if (!seenObjects.has(dedupeKey)) {
              seenObjects.add(dedupeKey);
              objects.push({ name: objectName, dataSpace, family, storageKey: `${dataSpace}/${objectName}`, metadata: includeObjectSchemas ? metadata : slimMetadata(metadata) });
            }
          }
          onCatalog?.(kind, objects.filter(o => o.dataSpace === name && o.family === kind).length);
        } catch (error) {
          if (/HTTP (401|403)/.test(String(error))) throw error;
          warnings.push(error instanceof Error ? error.message : `Data 360 ${path} discovery failed`);
        }
      }
    }
    const nameCounts = new Map<string, number>();
    for (const object of objects) nameCounts.set(object.name, (nameCounts.get(object.name) ?? 0) + 1);
    for (const object of objects) {
      if (nameCounts.get(object.name) === 1) object.storageKey = object.name;
    }
    return { dataSpaces, objects, identityResolutions, warnings };
  }

  async query(sql: string, dataSpace: string, rowLimit = 5000): Promise<Row[]> {
    let result = await this.request(`query-sql?dataspace=${encodeURIComponent(dataSpace)}`, "POST", { sql });
    let status = result.status ?? {};
    const queryId = status.queryId ?? result.queryId;
    const deadline = Date.now() + 60_000;
    while (queryId && status.completionStatus !== "ResultsProduced" && !Array.isArray(result.data) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const polled = await this.request(`query-sql/${encodeURIComponent(queryId)}?dataspace=${encodeURIComponent(dataSpace)}`);
      status = polled.status ?? polled;
    }
    if (status.completionStatus === "ResultsProduced" && status.rowCount === 0) return [];
    if (!Array.isArray(result.data) && status.completionStatus !== "ResultsProduced") throw new Error("Data 360 SQL did not complete within its query deadline");
    const data: unknown[] = [...(result.data ?? [])];
    while (queryId && data.length < Math.min(rowLimit, status.rowCount ?? data.length)) {
      const page = await this.request(`query-sql/${encodeURIComponent(queryId)}/rows?${new URLSearchParams({ dataspace: dataSpace, offset: String(data.length), rowLimit: String(rowLimit - data.length) })}`);
      if (!Array.isArray(page.data) || !page.data.length) throw new Error("Data 360 SQL pagination ended before all requested rows were returned");
      data.push(...page.data);
      if (!result.metadata) result = { ...result, metadata: page.metadata };
    }
    const columns = result.metadata?.columns ?? result.metadata ?? [];
    const names = Array.isArray(columns) ? columns.map((c: Row) => c.name ?? c.columnName) : Object.keys(columns).sort((a,b) => (columns[a].placeInOrder ?? 0) - (columns[b].placeInOrder ?? 0));
    return data.slice(0, rowLimit).map((row: unknown) => {
      if (Array.isArray(row)) return Object.fromEntries(row.map((value, i) => [names[i] ?? String(i), value]));
      if (row && typeof row === "object") return row as Row;
      throw new Error("Data 360 SQL returned an invalid row");
    });
  }

  async read(object: DataCloudObject, limit: number, descriptorCache?: Map<string, Promise<any>>): Promise<Row[]> {
    const max = Math.min(5000, Math.max(1, Math.trunc(limit)));
    if (object.family !== "data-graph") return this.query(`SELECT * FROM ${sqlIdentifier(object.name)} LIMIT ${max}`, object.dataSpace, max);
    const graph = object.metadata;
    const root = graph.dgObject;
    const primary = root?.developerName ?? graph.primaryObjectName;
    const keys = (root?.fields ?? []).filter((f: Row) => f.keyCol === true || f.keyCol === "true");
    if (!primary || !keys.length) throw new Error("Data Graph metadata contains no primary lookup key");
    const fields = [...new Set<string>(keys.flatMap((f: Row) => [f.developerName, f.keyQualifierName].filter(Boolean)))];
    const sampleTable = graph.valuesDmoName ?? primary;
    const samples = await this.query(`SELECT ${fields.map(sqlIdentifier).join(",")} FROM ${sqlIdentifier(sampleTable)} LIMIT 1`, object.dataSpace, 1);
    const rows: Row[] = [];
    for (const sample of samples) {
      const values = fields.flatMap(field => {
        const value = sample[field];
        if (value === null || value === undefined) {
          if (keys.some((key: Row) => key.developerName === field)) throw new Error("Data Graph primary lookup key is null");
          return [];
        }
        if (/[\[\],=\r\n]/.test(String(value))) throw new Error("Data Graph key cannot be safely represented as a lookup");
        return [`${primary}.${field}=${value}`];
      });
      const route = `${this.root}actions/standard/cdpGetDataGraphByLookup`;
      let descriptor: any;
      if (!descriptorCache) {
        descriptor = await this.request(route);
      } else {
        let pending = descriptorCache.get(route);
        if (!pending) {
          pending = this.request(route);
          descriptorCache.set(route, pending);
          void pending.catch(() => {
            if (descriptorCache.get(route) === pending) descriptorCache.delete(route);
          });
        }
        descriptor = await pending;
      }
      const inputs: Row = {};
      for (const [name, value] of [["datagraphapiname", object.name], ["dataspaceapiname", object.dataSpace], ["lookupkey", `[${values.join(",")}]`]]) {
        const field = descriptor.inputs?.find((field: Row) => String(field.name).toLowerCase() === name);
        if (!field) throw new Error("Data Graph action descriptor is missing a required lookup input");
        inputs[field.name] = value;
      }
      const response = await this.request(route, "POST", { inputs: [inputs] });
      const action = response[0];
      if (action?.isSuccess !== true || action.errors?.length) throw new Error("Data Graph native lookup failed");
      const output = action.outputValues;
      const raw = output?.data ?? output?.dataGraph ?? output?.dataGraphData ?? output?.result;
      const data = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (!data) throw new Error("Data Graph lookup returned an invalid result envelope");
      rows.push(...(Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [data]));
      if (rows.length >= max) break;
    }
    return rows.slice(0, max);
  }

  async retrieve(objects: DataCloudObject[], referenced: string[], maxRecords: number, opts?: { subrequestBudget?: number }) {
    const dataCloud: Record<string, Row[]> = {};
    const dataGraphs: Record<string, Row[]> = {};
    const warnings: string[] = [];
    const tried = new Set<string>();
    const descriptorCache = new Map<string, Promise<any>>();
    const orgId = this.connection.orgId;
    const read = async (object: DataCloudObject) => {
      tried.add(object.storageKey);
      try {
        const rows = await this.read(object, maxRecords, descriptorCache);
        (object.family === "data-graph" ? dataGraphs : dataCloud)[object.storageKey] = rows;
        if (orgId && rows.length > 0) {
          await cachePutJSON(lastGoodCacheKey(orgId, object.family), { storageKey: object.storageKey }, CACHE_TTL.lastGood);
        }
        return rows.length > 0;
      } catch (error) {
        if (error instanceof DataCloudBudgetExhaustedError) throw error;
        if (/HTTP (401|403)/.test(String(error))) throw error;
        warnings.push(`${object.family} ${object.storageKey}: ${error instanceof Error ? error.message : "retrieval failed"}`);
        return false;
      }
    };
    // Last-known-good hints: probe each family's previously readable object
    // first. A miss or stale hint keeps normal scan order; correctness is unchanged.
    const hints = new Map<string, string>();
    if (orgId) {
      const families = [...new Set(objects.map(o => o.family))];
      const loaded = await Promise.all(families.map(family => cacheGetJSON<{ storageKey: string }>(lastGoodCacheKey(orgId, family))));
      loaded.forEach((hint, index) => {
        if (hint && typeof hint.storageKey === "string") hints.set(families[index], hint.storageKey);
      });
    }
    this.subrequestBudget = opts?.subrequestBudget ?? null;
    try {
      for (const object of objects.filter(o => referenced.includes(o.name))) await read(object);
      for (const family of DATA_CLOUD_FAMILIES) {
        const candidates = objects.filter(o => o.family === family && o.metadata.isEnabled !== false &&
          (family !== "dmo" || !["Adg", "Semantic"].includes(o.metadata.creationType)));
        const hinted = hints.get(family);
        const ordered = hinted
          ? [...candidates.filter(o => o.storageKey === hinted), ...candidates.filter(o => o.storageKey !== hinted)]
          : candidates;
        if (ordered.some(o => (family === "data-graph" ? dataGraphs : dataCloud)[o.storageKey]?.length)) continue;
        for (const object of ordered) {
          if (!tried.has(object.storageKey) && await read(object)) break;
        }
      }
    } catch (error) {
      if (!(error instanceof DataCloudBudgetExhaustedError)) throw error;
      warnings.push("Data 360 family coverage is partial: subrequest budget exhausted");
    } finally {
      this.subrequestBudget = null;
    }
    return { dataCloud, dataGraphs, warnings };
  }
}
