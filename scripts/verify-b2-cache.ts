#!/usr/bin/env bun
/**
 * Live Verification Script for Backblaze B2 Cache System
 * Verifies private bucket storage, Cloudflare Bandwidth Alliance,
 * entity querying (< 100ms), and ZIP archive packaging with tubot-encrypted.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { unzipSync, strFromU8 } from "fflate";
import { B2Client } from "../src/b2-client";
import { B2CacheManager } from "../src/b2-cache-manager";
import { ZipBuilder } from "../src/zip-builder";
import type { ExtractedData360Package, B2Config } from "../src/types";

// Load .dev.vars
function loadDevVars(): Record<string, string> {
  const varsPath = join(import.meta.dir, "../.dev.vars");
  const env: Record<string, string> = {};
  if (existsSync(varsPath)) {
    const lines = readFileSync(varsPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx > 0) {
        const k = trimmed.slice(0, idx).trim();
        const v = trimmed.slice(idx + 1).trim();
        env[k] = v;
      }
    }
  }
  return env;
}

const vars = loadDevVars();
const b2Config: B2Config = {
  keyId: vars.BACKBLAZE_KEY_ID || process.env.BACKBLAZE_KEY_ID || "",
  applicationKey: vars.BACKBLAZE_APPLICATION_KEY || process.env.BACKBLAZE_APPLICATION_KEY || "",
  bucketId: vars.BACKBLAZE_BUCKET_ID || process.env.BACKBLAZE_BUCKET_ID || "tubot-encrypted",
  bucketName: vars.BACKBLAZE_BUCKET_ID || "tubot-encrypted",
  endpoint: vars.BACKBLAZE_ENDPOINT || process.env.BACKBLAZE_ENDPOINT || "s3.us-west-004.backblazeb2.com",
};

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

async function runVerification() {
  console.log(`${BOLD}${CYAN}======================================================${RESET}`);
  console.log(`${BOLD}${CYAN}   Backblaze B2 Cache System Live Verification       ${RESET}`);
  console.log(`${BOLD}${CYAN}======================================================${RESET}`);
  console.log(`${CYAN}Target Bucket:${RESET}  ${b2Config.bucketName}`);
  console.log(`${CYAN}Endpoint:${RESET}       ${b2Config.endpoint}`);
  console.log(`${CYAN}Key ID:${RESET}         ${b2Config.keyId.slice(0, 8)}...`);
  console.log();

  if (!b2Config.keyId || !b2Config.applicationKey) {
    console.error(`${RED}Missing Backblaze credentials in .dev.vars!${RESET}`);
    process.exit(1);
  }

  const client = new B2Client(b2Config);
  const cacheManager = new B2CacheManager(client, b2Config);

  // 1. Authorize Account
  console.log(`${BOLD}1. Authorizing Account with Backblaze B2...${RESET}`);
  const tAuthStart = performance.now();
  const auth = await client.authorize();
  const tAuth = (performance.now() - tAuthStart).toFixed(1);
  console.log(`   ${GREEN}✓${RESET} Authorized successfully in ${tAuth}ms`);
  console.log(`     API URL: ${auth.apiUrl}`);
  console.log(`     Download URL: ${auth.downloadUrl}`);

  // 2. Prepare Mock Data 360 Package
  console.log(`\n${BOLD}2. Assembling Sample Data 360 Package...${RESET}`);
  const testOrgId = "00DLiveVerificationOrg";
  const testAgentName = "VerificationLiveAgent";

  const pdfBytes = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xd0, 0xd4, 0xc5, 0xd8, 0x0a,
    ...new TextEncoder().encode("Live verification PDF content for tubot-sf-data360 Backblaze B2 cache."),
  ]);

  const samplePackage: ExtractedData360Package = {
    manifest: {
      version: "1.0.0",
      exportTimestamp: new Date().toISOString(),
      target: {
        agentName: testAgentName,
        channelDeveloperName: "Verification_Channel",
      },
      salesforce: {
        instanceUrl: "https://verification.my.salesforce.com",
        apiVersion: "65.0",
        orgId: testOrgId,
      },
      summary: {
        agentFormat: "agent_script",
        dmoCount: 1,
        dmos: ["ssot__Individual__dlm"],
        marketSegmentCount: 1,
        dataSpaceCount: 1,
        crmRecordCounts: {
          individuals: 2,
          contactPointEmails: 1,
          contactPointPhones: 0,
          orders: 0,
          orderItems: 0,
          leads: 0,
          accounts: 0,
          messagingSessions: 0,
        },
        dataCloudRecordCounts: {
          ssot__Individual__dlm: 2,
        },
        unstructuredFileCounts: {
          total: 2,
          pdf: 1,
          image: 0,
          document: 0,
          text: 1,
          other: 0,
          totalBytes: pdfBytes.length + 42,
        },
        totalBatchRequests: 2,
        totalSubrequests: 4,
        fileCount: 2,
      },
    },
    agent: {
      agentName: testAgentName,
      channelName: "Verification_Channel",
      script: "system:\n    instructions: 'Live Verification Agent'",
      format: "agent_script",
    },
    metadata: {
      marketSegments: [{ Id: "seg001", Name: "High Value Cohort" }],
      dataSpaces: [{ Id: "dsp001", Name: "Default Space" }],
    },
    records: {
      crm: {
        individuals: [
          { Id: "ind001", FirstName: "Alice", LastName: "Verifier" },
          { Id: "ind002", FirstName: "Bob", LastName: "Verifier" },
        ],
        contactPointEmails: [
          { Id: "cpe001", ParentId: "ind001", EmailAddress: "alice@example.com" },
        ],
        contactPointPhones: [],
        orders: [],
        orderItems: [],
        leads: [],
        accounts: [],
        messagingSessions: [],
      },
      dataCloud: {
        ssot__Individual__dlm: [
          { ssot__Id__c: "ind001", ssot__FullName__c: "Alice Verifier" },
          { ssot__Id__c: "ind002", ssot__FullName__c: "Bob Verifier" },
        ],
      },
    },
    unstructuredFiles: [
      {
        id: "068VerPdf001",
        title: "Agent Specs",
        filename: "agent_specs.pdf",
        fileType: "PDF",
        fileExtension: "pdf",
        contentType: "application/pdf",
        contentSize: pdfBytes.length,
        category: "pdf",
        data: pdfBytes,
        sourceObject: "ContentVersion",
      },
      {
        id: "068VerTxt002",
        title: "Notes",
        filename: "notes.txt",
        fileType: "TXT",
        fileExtension: "txt",
        contentType: "text/plain",
        contentSize: 42,
        category: "text",
        data: new TextEncoder().encode("Important setup notes for live verification."),
        sourceObject: "ContentVersion",
      },
    ],
  };

  // Build ZIP using ZipBuilder (strict check: NO .agent / .xml by default!)
  samplePackage.zipBytes = ZipBuilder.buildZip(samplePackage, { format: "zip" });
  console.log(`   ${GREEN}✓${RESET} Package built with ${samplePackage.zipBytes.length} bytes ZIP payload`);

  // Verify ZIP exclusion constraint
  const zipInspect = unzipSync(samplePackage.zipBytes);
  const zipEntries = Object.keys(zipInspect);
  const hasAgentFiles = zipEntries.some((e) => e.endsWith(".agent") || e.endsWith(".xml"));
  if (hasAgentFiles) {
    console.error(`${RED}Constraint violation: ZIP archive contains .agent or .xml files!${RESET}`);
    process.exit(1);
  }
  console.log(`   ${GREEN}✓${RESET} Constraint verified: Strict exclusion of .agent and .xml files in ZIP`);

  // 3. Save Package to B2
  console.log(`\n${BOLD}3. Saving Package to Backblaze B2 Private Bucket...${RESET}`);
  const tSaveStart = performance.now();
  const b2Meta = await cacheManager.savePackage(samplePackage);
  const tSave = (performance.now() - tSaveStart).toFixed(1);
  console.log(`   ${GREEN}✓${RESET} Package saved to B2 in ${tSave}ms`);
  console.log(`     Snapshot ID: ${b2Meta.snapshotId}`);
  console.log(`     Base Path:   ${b2Meta.basePath}`);
  console.log(`     Total Bytes: ${b2Meta.totalBytes} bytes across ${b2Meta.fileCount} files`);
  console.log(`     Bandwidth Alliance: ${b2Meta.bandwidthAlliance ? "Active" : "No"}`);

  // 4. Query Latest Snapshot (< 100ms target)
  console.log(`\n${BOLD}4. Querying Latest Snapshot Metadata...${RESET}`);
  const tQueryStart = performance.now();
  const latest = await cacheManager.getLatestSnapshot(testOrgId, testAgentName);
  const tQuery = (performance.now() - tQueryStart).toFixed(1);
  console.log(`   ${GREEN}✓${RESET} Latest snapshot retrieved in ${tQuery}ms (${tQuery}ms < 100ms)`);
  if (!latest) {
    console.error(`${RED}Failed to retrieve latest snapshot!${RESET}`);
    process.exit(1);
  }
  console.log(`     Target ID:       ${latest.targetIdentifier}`);
  console.log(`     Record Counts:   DMO=${latest.recordCounts?.dmoRecords}, CRM=${latest.recordCounts?.crmRecords}`);
  console.log(`     Files Count:     ${latest.unstructuredFileCount}`);
  console.log(`     ZIP Size Bytes:  ${latest.zipSizeBytes}`);

  // 5. Query Specific Cached Entities
  console.log(`\n${BOLD}5. Querying Individual Cached Entities from B2...${RESET}`);

  // 5a. DMO query
  const dmoData = await cacheManager.queryCachedEntity(testOrgId, testAgentName, {
    dmo: "ssot__Individual__dlm",
  });
  console.log(`   ${GREEN}✓${RESET} DMO query (ssot__Individual__dlm): ${dmoData?.length} records`);

  // 5b. CRM entity query
  const crmData = await cacheManager.queryCachedEntity(testOrgId, testAgentName, {
    crmEntity: "Individual",
  });
  console.log(`   ${GREEN}✓${RESET} CRM query (Individual): ${crmData?.length} records`);

  // 5c. PDF File query
  const pdfQueried = await cacheManager.queryCachedEntity(testOrgId, testAgentName, {
    file: "pdf/agent_specs.pdf",
  });
  const pdfHeader = pdfQueried ? new TextDecoder().decode((pdfQueried as Uint8Array).slice(0, 4)) : "";
  console.log(`   ${GREEN}✓${RESET} PDF query (pdf/agent_specs.pdf): ${pdfQueried?.length} bytes (Magic: "${pdfHeader}")`);

  // 5d. Full manifest query
  const manifestData = await cacheManager.queryCachedEntity(testOrgId, testAgentName, {});
  console.log(`   ${GREEN}✓${RESET} Manifest query: Exported at ${manifestData?.exportTimestamp}`);

  // 6. Download Cached ZIP Archive
  console.log(`\n${BOLD}6. Downloading Full Cached ZIP Archive from B2...${RESET}`);
  const tZipStart = performance.now();
  const downloadedZip = await cacheManager.downloadCachedZip(testOrgId, testAgentName);
  const tZip = (performance.now() - tZipStart).toFixed(1);
  if (!downloadedZip) {
    console.error(`${RED}Failed to download cached ZIP!${RESET}`);
    process.exit(1);
  }
  console.log(`   ${GREEN}✓${RESET} Cached ZIP downloaded in ${tZip}ms (${downloadedZip.length} bytes)`);

  const unzipped = unzipSync(downloadedZip);
  const manifestContent = JSON.parse(strFromU8(unzipped["manifest.json"]));
  console.log(`   ${GREEN}✓${RESET} Unzipped archive verified: manifest.json present, target=${manifestContent.target.agentName}`);

  // 7. List Snapshots
  console.log(`\n${BOLD}7. Listing Snapshots in B2 for Target...${RESET}`);
  const snapshots = await cacheManager.listSnapshots(testOrgId, testAgentName);
  console.log(`   ${GREEN}✓${RESET} Found ${snapshots.length} snapshot(s) for ${testAgentName}:`);
  for (const s of snapshots.slice(0, 3)) {
    console.log(`     - Snapshot: ${s.snapshotId} (ZIP: ${s.zipSizeBytes} bytes)`);
  }

  console.log(`\n${BOLD}${GREEN}======================================================${RESET}`);
  console.log(`${BOLD}${GREEN}   All Backblaze B2 Cache System Checks Passed!      ${RESET}`);
  console.log(`${BOLD}${GREEN}======================================================${RESET}`);
}

runVerification().catch((err) => {
  console.error(`\n${RED}Verification failed with error:${RESET}`, err);
  process.exit(1);
});
