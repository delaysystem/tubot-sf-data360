/** Independent B2 REST checker. Does not import the worker or its B2 client. */
import type { B2CacheMetadata, ExportManifest } from "../../src/types";

async function main() {
  const path = process.argv[2];
  if (!path) throw Error("Pass a live snapshot verification descriptor");
  const { cache, manifest } = await Bun.file(path).json() as { cache: B2CacheMetadata; manifest: ExportManifest };
  const keyId = process.env.BACKBLAZE_KEY_ID, applicationKey = process.env.BACKBLAZE_APPLICATION_KEY;
  if (!keyId || !applicationKey) throw Error("Missing live B2 checker credentials");
  const authResponse = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
    headers: { Authorization: `Basic ${btoa(`${keyId}:${applicationKey}`)}` },
  });
  if (!authResponse.ok) throw Error(`B2 checker authentication HTTP ${authResponse.status}`);
  const auth = await authResponse.json() as any;
  const storage = auth.apiInfo?.storageApi ?? auth;
  const prefix = `${cache.basePath}/`;
  const files: Array<{ fileName: string }> = [];
  let startFileName: string | undefined;
  do {
    const response = await fetch(`${storage.apiUrl}/b2api/v3/b2_list_file_names`, {
      method: "POST", headers: { Authorization: auth.authorizationToken, "Content-Type": "application/json" },
      body: JSON.stringify({ bucketId: cache.bucketId, prefix, maxFileCount: 1000, ...(startFileName ? { startFileName } : {}) }),
    });
    if (!response.ok) throw Error(`B2 checker list HTTP ${response.status}`);
    const page = await response.json() as any;
    files.push(...page.files);
    if (startFileName && page.nextFileName === startFileName) throw Error("B2 checker pagination repeated a page");
    startFileName = page.nextFileName;
  } while (startFileName);
  if (files.length !== cache.fileCount) throw Error("B2 snapshot object count mismatch");
  if (files.some(f => f.fileName.endsWith(".zip") || f.fileName.endsWith("data-bundle.json"))) throw Error("B2 snapshot contains a forbidden archive or monolithic bundle");
  let bytes = 0;
  for (const file of files) {
    const response = await fetch(`${storage.downloadUrl}/file/${cache.bucketName}/${file.fileName.split("/").map(encodeURIComponent).join("/")}`, { headers: { Authorization: auth.authorizationToken } });
    if (!response.ok) throw Error(`B2 checker download HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    bytes += data.length;
    const relative = file.fileName.slice(prefix.length);
    if (relative === "manifest.json") {
      const actual = JSON.parse(new TextDecoder().decode(data)) as ExportManifest;
      if (actual.b2Cache?.snapshotId !== cache.snapshotId || actual.storage?.layoutVersion !== 2) throw Error("B2 manifest does not identify the written snapshot");
      continue;
    }
    const expected = manifest.storage?.files.find(f => f.path === relative);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), b => b.toString(16).padStart(2, "0")).join("");
    if (!expected || expected.sha256 !== digest || expected.bytes !== data.length) throw Error(`B2 checksum mismatch for ${relative}`);
  }
  if (bytes !== cache.totalBytes) throw Error("B2 total stored bytes mismatch");
  console.log(JSON.stringify({ blindB2Readback: true, objects: files.length, bytes, checksums: "all matched", zip: false }));
}
main().catch(error => { console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "B2 checker failed" })); process.exitCode = 1; });
