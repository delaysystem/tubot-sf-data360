import { DATA_CLOUD_FAMILIES, type DataCloudFamily, type DataCloudObject, type SalesforceConnection } from "./types";

type Row = Record<string, any>;
export const sqlIdentifier = (value: string): string => {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw new Error("Invalid Data 360 SQL identifier");
  return `"${value}"`;
};

/** Live Data 360 Connect API transport. Never substitutes CRM files for UDMOs. */
export class DataCloudClient {
  private readonly root: string;
  constructor(private readonly connection: SalesforceConnection, apiVersion: string) {
    if (!/^v\d+\.\d+$/.test(apiVersion)) throw new Error("Invalid Salesforce API version");
    this.root = `/services/data/${apiVersion}/`;
  }

  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    const relative = path.startsWith("/") ? path : `${this.root}ssot/${path}`;
    if (!relative.startsWith(this.root) || relative.includes("..")) throw new Error("Invalid Data 360 API page URL");
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
    let next: string | undefined = `${path}?${new URLSearchParams({ ...(dataSpace ? { dataspace: dataSpace } : {}), ...(key === "collection" ? { batchSize: "200" } : { limit: "200" }), offset: "0" })}`;
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
      if (!next && key === "dataModelObject" && page.length === 200) {
        next = `${path}?${new URLSearchParams({ ...(dataSpace ? { dataspace: dataSpace } : {}), limit: "200", offset: String(offset) })}`;
      }
    }
    return rows;
  }

  async discover(onCatalog?: (family: string, count: number) => void): Promise<{ dataSpaces: Row[]; objects: DataCloudObject[]; identityResolutions: Row[]; warnings: string[] }> {
    const dataSpaces = await this.list("data-spaces", "dataSpaces");
    const objects: DataCloudObject[] = [];
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
            if (!objects.some(o => o.name === objectName && o.dataSpace === dataSpace && o.family === family)) {
              objects.push({ name: objectName, dataSpace, family, storageKey: `${dataSpace}/${objectName}`, metadata });
            }
          }
          onCatalog?.(kind, objects.filter(o => o.dataSpace === name && o.family === kind).length);
        } catch (error) {
          if (/HTTP (401|403)/.test(String(error))) throw error;
          warnings.push(error instanceof Error ? error.message : `Data 360 ${path} discovery failed`);
        }
      }
    }
    for (const object of objects) {
      if (objects.filter(o => o.name === object.name).length === 1) object.storageKey = object.name;
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

  async read(object: DataCloudObject, limit: number): Promise<Row[]> {
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
      const descriptor = await this.request(route);
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

  async retrieve(objects: DataCloudObject[], referenced: string[], maxRecords: number) {
    const dataCloud: Record<string, Row[]> = {};
    const dataGraphs: Record<string, Row[]> = {};
    const warnings: string[] = [];
    const tried = new Set<string>();
    const read = async (object: DataCloudObject) => {
      tried.add(object.storageKey);
      try {
        const rows = await this.read(object, maxRecords);
        (object.family === "data-graph" ? dataGraphs : dataCloud)[object.storageKey] = rows;
        return rows.length > 0;
      } catch (error) {
        if (/HTTP (401|403)/.test(String(error))) throw error;
        warnings.push(`${object.family} ${object.storageKey}: ${error instanceof Error ? error.message : "retrieval failed"}`);
        return false;
      }
    };
    for (const object of objects.filter(o => referenced.includes(o.name))) await read(object);
    for (const family of DATA_CLOUD_FAMILIES) {
      const candidates = objects.filter(o => o.family === family && o.metadata.isEnabled !== false &&
        (family !== "dmo" || !["Adg", "Semantic"].includes(o.metadata.creationType)));
      if (candidates.some(o => (family === "data-graph" ? dataGraphs : dataCloud)[o.storageKey]?.length)) continue;
      for (const object of candidates) {
        if (!tried.has(object.storageKey) && await read(object)) break;
      }
    }
    return { dataCloud, dataGraphs, warnings };
  }
}
