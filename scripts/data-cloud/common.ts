import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataCloudClient } from "../../src/data-cloud-client";
import type { SalesforceConnection } from "../../src/types";

export const args = process.argv.slice(2);
export function argument(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw Error(`A value is required for ${name}`);
  return args[index + 1];
}
export function report(value: unknown) { console.log(JSON.stringify(value)); }
export async function sf(target: string, argv: string[]): Promise<any> {
  const child = Bun.spawn(["sf", ...argv, "--target-org", target, "--json"], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, SF_DISABLE_LOG_FILE: "true" },
  });
  const [stdout, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  let body: any;
  try { body = stdout.trim() ? JSON.parse(stdout) : {}; } catch { throw Error("Salesforce CLI returned invalid JSON"); }
  if (exitCode || body.status) throw Error(`Salesforce CLI ${argv.slice(0, 3).join(" ")} failed (exit ${exitCode || body.status}); inspect the target org authorization and permissions`);
  return body.result;
}
export async function connection() {
  const target = argument("--target-org");
  if (!target) throw Error("Pass --target-org <connected Salesforce CLI alias>");
  const token = await sf(target, ["org", "auth", "show-access-token"]);
  const info = await sf(target, ["org", "display"]);
  if (!token?.accessToken || !info?.instanceUrl || !info?.id) throw Error("Salesforce CLI returned an incomplete authenticated connection");
  const conn: SalesforceConnection = { instanceUrl: info.instanceUrl, accessToken: token.accessToken, orgId: info.id };
  const response = await fetch(`${conn.instanceUrl}/services/data`, { headers: { Authorization: `Bearer ${conn.accessToken}` } });
  if (!response.ok) throw Error(`Salesforce API version discovery returned HTTP ${response.status}`);
  const versions = await response.json() as Array<{ version: string }>;
  const version = argument("--api-version")?.replace(/^v/, "") ?? versions.map(v => v.version).filter(v => /^\d+\.\d+$/.test(v)).sort((a,b) => Number(b) - Number(a))[0];
  if (!version) throw Error("Salesforce returned no API versions");
  if (!versions.some(v => v.version === version)) throw Error("The requested API version is unavailable in the connected org");
  return { target, conn, apiVersion: `v${version}`, client: new DataCloudClient(conn, `v${version}`) };
}

/** A separate sf CLI process independently reads state after a seed mutation. */
export async function blindRest(target: string, apiVersion: string, path: string, sql?: string): Promise<any> {
  const directory = await mkdtemp(join(tmpdir(), "data360-readback-"));
  const file = join(directory, "response.json");
  try {
    const argv = ["api", "request", "rest", `/services/data/${apiVersion}/ssot/${path}`, "--method", sql ? "POST" : "GET", "--stream-to-file", file];
    if (sql) argv.push("--body", JSON.stringify({ sql }));
    await sf(target, argv);
    const body = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(body) && body.some(item => item.errorCode)) throw Error("Independent Salesforce CLI readback was refused");
    return body;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export async function blindRows(target: string, apiVersion: string, name: string, dataSpace: string) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw Error("Invalid Data 360 readback object name");
  const body = await blindRest(target, apiVersion, `query-sql?dataspace=${encodeURIComponent(dataSpace)}`, `SELECT * FROM "${name}" LIMIT 1`);
  const rows = body.data ?? [];
  if (!Array.isArray(rows) || !rows.length) throw Error(`Independent readback found no rows for ${name}`);
  return rows.length;
}
export async function blindFile(target: string, apiVersion: string, sourceObject: string, id: string): Promise<Uint8Array> {
  if (!["ContentVersion", "Document", "StaticResource", "Attachment"].includes(sourceObject) || !/^[A-Za-z0-9]{15,18}$/.test(id)) throw Error("Invalid Salesforce file readback scope");
  const directory = await mkdtemp(join(tmpdir(), "data360-file-readback-"));
  const file = join(directory, "source.bin");
  try {
    await sf(target, ["api", "request", "rest", `/services/data/${apiVersion}/sobjects/${sourceObject}/${id}/${sourceObject === "ContentVersion" ? "VersionData" : "Body"}`, "--stream-to-file", file]);
    return new Uint8Array(await readFile(file));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
export function b2Env() {
  const names = ["BACKBLAZE_KEY_ID", "BACKBLAZE_APPLICATION_KEY", "BACKBLAZE_BUCKET_ID"];
  for (const name of names) if (!process.env[name]) throw Error(`Missing ${name} for live B2 verification`);
  return Object.fromEntries(Object.entries(process.env).filter(([name,value]) => value && (name.startsWith("BACKBLAZE_") || name === "DATA360_PATH_PREFIX")));
}
export async function waitUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean, seconds: number): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const result = await read();
    if (ready(result)) return result;
    if (Date.now() >= deadline) throw Error("Live Data 360 processing deadline exceeded; rerun after the target job completes");
    report({ waiting: "Data 360 materialization", remainingSeconds: Math.ceil((deadline - Date.now()) / 1000) });
    await Bun.sleep(15_000);
  }
}
