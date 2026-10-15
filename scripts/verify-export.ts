#!/usr/bin/env bun
import { execSync } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import worker, { Data360Extractor } from "../src/index";

async function main() {
  const args = process.argv.slice(2);
  let targetOrg = "test1empty";
  let channel = "Data360_Channel";
  let agentName = "DATA360TEST";
  let outPath = "./data360-export.zip";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--org" && args[i + 1]) targetOrg = args[++i];
    if (args[i] === "--channel" && args[i + 1]) channel = args[++i];
    if (args[i] === "--agent" && args[i + 1]) agentName = args[++i];
    if (args[i] === "--out" && args[i + 1]) outPath = args[++i];
  }

  console.log("================================================================================");
  console.log("   LIVE DATA 360 EXPORT VERIFICATION (BATChed REQUESTS & REAL ORG)              ");
  console.log("================================================================================");
  console.log(` Target Org:       ${targetOrg}`);
  console.log(` Target Channel:   ${channel}`);
  console.log(` Target Agent:     ${agentName}`);
  console.log(` Output Archive:   ${outPath}`);
  console.log("--------------------------------------------------------------------------------");

  // Step 1: Get live credentials from sf CLI
  console.log("\n[1/4] Retrieving live Salesforce connection from target org...");
  const orgDisplayRaw = execSync(`SF_USE_GENERIC_UNIX_KEYCHAIN=true sf org display -o "${targetOrg}" --json`, { encoding: "utf8" });
  const orgDisplay = JSON.parse(orgDisplayRaw).result;

  const tokenRaw = execSync(`SF_USE_GENERIC_UNIX_KEYCHAIN=true sf org auth show-access-token -o "${targetOrg}" --json`, { encoding: "utf8" });
  const tokenData = JSON.parse(tokenRaw).result;

  const instanceUrl = orgDisplay.instanceUrl;
  const accessToken = tokenData.accessToken;
  const orgId = orgDisplay.id;

  console.log(`  Connected Org:    ${orgDisplay.username} (${orgId})`);
  console.log(`  Instance URL:     ${instanceUrl}`);
  console.log("  Salesforce credentials loaded securely.");

  // Step 2: Test worker fetch endpoint
  console.log("\n[2/4] Executing extraction through Worker export endpoint...");
  const startTime = Date.now();
  const exportReq = new Request("https://tubot-sf-data360.internal/export", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "x-salesforce-instance-url": instanceUrl,
    },
    body: JSON.stringify({
      channelId: channel,
      agentName: agentName,
      maxRecords: 200,
    }),
  });

  const response = await worker.fetch(exportReq, {});
  const elapsed = Date.now() - startTime;

  if (!response.ok) {
    let errBody = `HTTP ${response.status}`;
    try {
      errBody = await response.text();
    } catch {}
    throw new Error(`Worker export failed: ${errBody}`);
  }

  console.log(`  Status:           ${response.status} ${response.statusText}`);
  console.log(`  Content-Type:     ${response.headers.get("content-type")}`);
  console.log(`  Content-Disp:     ${response.headers.get("content-disposition")}`);
  console.log(`  Time Elapsed:     ${elapsed}ms`);

  const zipBytes = new Uint8Array(await response.arrayBuffer());
  console.log(`  ZIP Archive Size: ${(zipBytes.length / 1024).toFixed(2)} KB`);

  // Save to file
  const fullOut = resolve(process.cwd(), outPath);
  writeFileSync(fullOut, zipBytes);
  console.log(`  Saved to:         ${fullOut}`);

  // Step 3: Unzip and inspect package structure
  console.log("\n[3/4] Inspecting and verifying ZIP contents...");
  const unzipped = unzipSync(zipBytes);
  const fileKeys = Object.keys(unzipped).sort();

  console.log(`  Files in archive (${fileKeys.length} items):`);
  fileKeys.forEach((k) => console.log(`    • ${k}`));

  if (!unzipped["manifest.json"]) {
    throw new Error("Missing manifest.json in exported archive!");
  }

  const agentFiles = Object.keys(unzipped).filter((k) => k.startsWith("agent/"));
  if (agentFiles.length > 0) {
    throw new Error(`Violation: agent script/xml files found in archive: ${agentFiles.join(", ")}`);
  }
  console.log("  Verified: Agent script and agent XML correctly excluded from archive.");

  const manifest = JSON.parse(strFromU8(unzipped["manifest.json"]));
  console.log("\n[4/4] Export Manifest Audit Summary:");
  console.log(`  Version:          ${manifest.version}`);
  console.log(`  Export Timestamp: ${manifest.exportTimestamp}`);
  console.log(`  Target Agent:     ${manifest.target.agentName}`);
  console.log(`  Target Channel:   ${manifest.target.channelDeveloperName || manifest.target.channelId}`);
  console.log(`  Discovered DMOs:  ${manifest.summary.dmos.join(", ")}`);
  console.log(`  Market Segments:  ${manifest.summary.marketSegmentCount}`);
  console.log(`  CRM Records:`);
  for (const [entity, count] of Object.entries(manifest.summary.crmRecordCounts)) {
    console.log(`    - ${entity}: ${count}`);
  }
  console.log(`  Batch Requests:   ${manifest.summary.totalBatchRequests}`);
  console.log(`  Subrequests:      ${manifest.summary.totalSubrequests}`);

  if (unzipped["metadata/files-manifest.json"]) {
    const filesManifest = JSON.parse(strFromU8(unzipped["metadata/files-manifest.json"]));
    console.log(`\n  Verified ${filesManifest.length} Unstructured Files in files-manifest.json:`);
    filesManifest.forEach((f: any) => {
      console.log(`    • [${f.category.toUpperCase()}] ${f.filename} (${(f.contentSize / 1024).toFixed(1)} KB, Source: ${f.sourceObject}) -> ${f.pathInZip}`);
    });

    const pdfFiles = filesManifest.filter((f: any) => f.category === "pdf");
    if (pdfFiles.length > 0) {
      console.log(`  ✔ Verified ${pdfFiles.length} PDF file(s) successfully downloaded and packaged.`);
    }

    const imageFiles = filesManifest.filter((f: any) => f.category === "image");
    if (imageFiles.length > 0) {
      console.log(`  ✔ Verified ${imageFiles.length} Image file(s) successfully downloaded and packaged.`);
    }
  }

  if (unzipped["metadata/data-streams.json"]) {
    const streams = JSON.parse(strFromU8(unzipped["metadata/data-streams.json"]));
    console.log(`  ✔ Verified ${streams.length} DataStream records in metadata/data-streams.json`);
  }

  if (unzipped["metadata/segments.json"]) {
    const segs = JSON.parse(strFromU8(unzipped["metadata/segments.json"]));
    if (segs.length > 0) {
      console.log(`\n  Verified MarketSegment in org: "${segs[0].Name}" (Status: ${segs[0].SegmentStatus})`);
    }
  }

  if (unzipped["data/crm/Individual.json"]) {
    const indivs = JSON.parse(strFromU8(unzipped["data/crm/Individual.json"]));
    console.log(`  Verified ${indivs.length} CRM Individual records (e.g. "${indivs[0]?.LastName}")`);
  }

  console.log("\n================================================================================");
  console.log("   ALL LIVE DATA 360 EXPORT VERIFICATIONS SUCCEEDED!                           ");
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("\n[ERROR] Verification failed:", err);
  process.exit(1);
});
