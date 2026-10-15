import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import worker from "../../src/index";
import { SalesforceBatchClient } from "../../src/batch-client";
import { DATA_CLOUD_FAMILIES, type DataCloudFamily, type ExtractedData360Package } from "../../src/types";
import { argument, b2Env, blindFile, blindRows, connection, report, sf } from "./common";

async function main() {
  const { target, conn, apiVersion } = await connection();
  const env = b2Env();
  let agentName = argument("--agent");
  const channelId = argument("--channel");
  if (!agentName && !channelId) {
    const bots = await new SalesforceBatchClient().querySingle(conn, "SELECT DeveloperName FROM BotDefinition LIMIT 1", apiVersion);
    agentName = bots[0]?.DeveloperName;
    if (!agentName) throw Error("Pass --agent or --channel identifying a real target in the connected org");
  }
  const workerUrl = argument("--worker-url");
  const options = {
    agentName, channelId, orgId: conn.orgId, apiVersion, cacheToB2: true, format: "json", maxRecords: 1,
    includeTools: false, includeUnstructuredFiles: true, maxUnstructuredFiles: 1, includeCrmRecords: true,
  };
  const invoke = (path: string, init?: RequestInit) => {
    const base = workerUrl ?? "http://localhost";
    const request = new Request(new URL(path, base), init);
    return workerUrl ? fetch(request) : worker.fetch(request, env);
  };
  for (const path of ["/cache/query", "/cache/latest", "/cache/download", "/cache/snapshots"]) {
    if ((await invoke(`${path}?agentName=${encodeURIComponent(agentName ?? channelId!)}`)).status !== 401) throw Error("Anonymous B2 read was not rejected");
  }
  const wrongOrg = `${conn.orgId!.slice(0, 14)}${conn.orgId![14] === "A" ? "B" : "A"}${conn.orgId!.slice(15)}`;
  const denied = await invoke(`/cache/query?${new URLSearchParams({ agentName: agentName ?? channelId!, orgId: wrongOrg })}`, { headers: { Authorization: `Bearer ${conn.accessToken}`, "x-salesforce-instance-url": conn.instanceUrl } });
  if (denied.status !== 403) throw Error("Cross-org B2 read was not rejected");
  report({ anonymousCacheRead: "rejected", crossOrgCacheRead: "rejected" });
  report({ stage: "worker-retrieval-and-B2-write", target, runtime: workerUrl ? "HTTP Worker" : "actual Worker handler in Bun" });
  const progress = setInterval(() => report({ waiting: "Worker is retrieving live Salesforce catalogs and storing B2 family files" }), 30_000);
  let pkg: ExtractedData360Package;
  try {
    const response = await invoke("/export", {
      method: "POST", headers: { Authorization: `Bearer ${conn.accessToken}`, "x-salesforce-instance-url": conn.instanceUrl, "Content-Type": "application/json" },
      body: JSON.stringify(options), signal: AbortSignal.timeout(900_000),
    });
    if (!response.ok) throw Error(`Actual Worker export/cache request failed with HTTP ${response.status}`);
    pkg = await response.json() as ExtractedData360Package;
  } finally { clearInterval(progress); }
  if (!pkg.b2Cache?.stored || pkg.manifest.storage?.layoutVersion !== 2) throw Error("Worker did not store the new B2 snapshot layout");
  const sourceCount = await sf(target, ["data", "query", "--query", "SELECT Id FROM Lead LIMIT 1"]);
  if (pkg.records.crm.leads.length !== sourceCount.records.length) throw Error("CRM source rows differ from independent Salesforce CLI readback");
  if (pkg.zipBytes || pkg.b2Cache.zipUrl) throw Error("B2 verification flow produced a ZIP");
  const coverage = Object.fromEntries(DATA_CLOUD_FAMILIES.map(family => [family, { objects: 0, rows: 0 }])) as Record<DataCloudFamily, { objects: number; rows: number }>;
  const selected = new Set<DataCloudFamily>();
  for (const object of pkg.metadata.dataCloudObjects ?? []) {
    const rows = (object.family === "data-graph" ? pkg.records.dataGraphs?.[object.storageKey] : pkg.records.dataCloud[object.storageKey]) ?? [];
    coverage[object.family].objects++;
    coverage[object.family].rows += rows.length;
    if (!rows.length || selected.has(object.family)) continue;
    selected.add(object.family);
    await blindRows(target, apiVersion, object.family === "data-graph" ? object.metadata.valuesDmoName : object.name, object.dataSpace);
    const params = new URLSearchParams({ orgId: conn.orgId!, agentName: agentName ?? channelId!, ...(channelId ? { channelId } : {}), objectType: object.family, objectName: object.name, dataSpace: object.dataSpace, snapshotId: pkg.b2Cache.snapshotId });
    const response = await invoke(`/cache/query?${params}`, { headers: { Authorization: `Bearer ${conn.accessToken}`, "x-salesforce-instance-url": conn.instanceUrl } });
    if (!response.ok || JSON.stringify(await response.json()) !== JSON.stringify(rows)) throw Error(`Typed B2 cache read mismatch for ${object.family}`);
    report({ family: object.family, retrievedRows: rows.length, blindSalesforceReadback: true, workerB2Query: true });
  }
  if (!pkg.unstructuredFiles?.length) throw Error("Live file storage check requires a real Salesforce file");
  for (const file of pkg.unstructuredFiles) {
    const source = await blindFile(target, apiVersion, file.sourceObject, file.id);
    const params = new URLSearchParams({ orgId: conn.orgId!, agentName: agentName ?? channelId!, ...(channelId ? { channelId } : {}), file: file.filename, snapshotId: pkg.b2Cache.snapshotId });
    const response = await invoke(`/cache/query?${params}`, { headers: { Authorization: `Bearer ${conn.accessToken}`, "x-salesforce-instance-url": conn.instanceUrl } });
    if (!response.ok) throw Error("Worker cached file query failed");
    if (/application\/json/i.test(response.headers.get("content-type") ?? "")) {
      if (JSON.stringify(await response.json()) !== JSON.stringify(JSON.parse(new TextDecoder().decode(source)))) throw Error("Cached JSON differs from Salesforce CLI file readback");
    } else {
      const actual = new Uint8Array(await response.arrayBuffer());
      if (actual.length !== source.length || actual.some((value, index) => value !== source[index])) throw Error("Cached file differs from Salesforce CLI readback");
    }
    report({ realFileVerified: true, sourceObject: file.sourceObject, bytes: source.length, blindSalesforceReadback: true });
  }
  const directory = await mkdtemp(join(tmpdir(), "data360-b2-verification-"));
  try {
    const descriptor = join(directory, "snapshot.json");
    await writeFile(descriptor, JSON.stringify({ cache: pkg.b2Cache, manifest: pkg.manifest }), { mode: 0o600 });
    const checker = Bun.spawn([process.execPath, join(import.meta.dir, "b2-readback.ts"), descriptor], { stdout: "inherit", stderr: "inherit", env: process.env });
    if (await checker.exited) throw Error("Independent B2 readback process failed");
  } finally { await rm(directory, { recursive: true, force: true }); }
  const missing = DATA_CLOUD_FAMILIES.filter(family => coverage[family].rows === 0);
  report({ coverage, missing, snapshotId: pkg.b2Cache.snapshotId, storageLayout: 2 });
  if (missing.length) throw Error(`Live all-types gate failed: no real result rows for ${missing.join(", ")}. Seed the target, then rerun.`);
  report({ ok: true, liveFamiliesVerified: DATA_CLOUD_FAMILIES.length });
}
main().catch(error => { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Live verification failed" })); process.exitCode = 1; });
