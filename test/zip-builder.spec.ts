import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { ZipBuilder } from "../src/zip-builder";
import type { ExtractedData360Package } from "../src/types";

describe("ZipBuilder", () => {
  const pkg: ExtractedData360Package = {
    manifest: {
      version: "1.0.0",
      exportTimestamp: "2026-09-25T10:00:00Z",
      target: {
        channelId: "0Mjg5000000VtMnCAK",
        agentName: "DATA360TEST",
      },
      salesforce: {
        instanceUrl: "https://test.my.salesforce.com",
        apiVersion: "v65.0",
      },
      summary: {
        agentFormat: "agent_script",
        dmoCount: 1,
        dmos: ["ssot__Individual__dlm"],
        marketSegmentCount: 1,
        dataSpaceCount: 1,
        crmRecordCounts: { individuals: 2 },
        dataCloudRecordCounts: {},
        totalBatchRequests: 2,
        totalSubrequests: 12,
        fileCount: 8,
      },
    },
    agent: {
      agentName: "DATA360TEST",
      script: "system:\n    instructions: 'Marketer Agent'\n",
      bundleMetaXml: "<?xml version='1.0'?><AiAuthoringBundle/>",
      botXml: "<?xml version='1.0'?><Bot/>",
      promptTemplates: {
        MyTemplate: "<?xml version='1.0'?><GenAiPromptTemplate/>",
      },
      callableTools: [{ url: "https://tool.example.com" }],
    },
    metadata: {
      dataSpaces: [{ Name: "default" }],
      marketSegments: [{ Name: "VIP Customers", IncludeCriteria: "<criteria/>" }],
      calculatedInsights: [],
      identityResolutionRules: [],
      dmoDescribes: {
        ssot__Individual__dlm: { name: "ssot__Individual__dlm", fields: [] },
      },
      dmoCatalog: [],
    },
    records: {
      crm: {
        individuals: [{ Id: "0PK1", LastName: "D360 Rostova" }, { Id: "0PK2", LastName: "D360 Vance" }],
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

  it("by default excludes agent script and agent XML files from ZIP archive", () => {
    const zipBytes = ZipBuilder.buildZip(pkg);
    expect(zipBytes).toBeInstanceOf(Uint8Array);

    const unzipped = unzipSync(zipBytes);

    // Verify manifest and Data 360 data are present
    expect(unzipped["manifest.json"]).toBeDefined();
    expect(unzipped["metadata/segments.json"]).toBeDefined();
    expect(unzipped["metadata/dmos/ssot__Individual__dlm.json"]).toBeDefined();
    expect(unzipped["data/crm/Individual.json"]).toBeDefined();

    // Verify agent script and XML files are EXCLUDED by default
    expect(unzipped["agent/agent-script.agent"]).toBeUndefined();
    expect(unzipped["agent/bundle-meta.xml"]).toBeUndefined();
    expect(unzipped["agent/bot.xml"]).toBeUndefined();
    expect(unzipped["agent/prompt-templates/MyTemplate.genAiPromptTemplate"]).toBeUndefined();
  });

  it("includes agent script and agent XML when explicitly opted-in", () => {
    const zipBytes = ZipBuilder.buildZip(pkg, {
      includeAgentScript: true,
      includeAgentXml: true,
    });

    const unzipped = unzipSync(zipBytes);
    expect(unzipped["agent/agent-script.agent"]).toBeDefined();
    expect(strFromU8(unzipped["agent/agent-script.agent"])).toContain("Marketer Agent");
    expect(unzipped["agent/bundle-meta.xml"]).toBeDefined();
    expect(unzipped["agent/bot.xml"]).toBeDefined();
  });

  it("packages unstructured files under data/files/... and creates metadata/files-manifest.json", () => {
    const packageWithFiles: ExtractedData360Package = {
      ...pkg,
      unstructuredFiles: [
        {
          id: "068xx000001",
          sourceObject: "ContentVersion",
          title: "Product Architecture",
          filename: "architecture.pdf",
          category: "pdf",
          fileType: "PDF",
          fileExtension: "pdf",
          contentType: "application/pdf",
          contentSize: 1024,
          description: "Technical architecture diagram",
          data: new TextEncoder().encode("%PDF-1.4 mock pdf content"),
        },
        {
          id: "068xx000002",
          sourceObject: "Attachment",
          title: "Brand Logo",
          filename: "logo.png",
          category: "image",
          fileType: "PNG",
          fileExtension: "png",
          contentType: "image/png",
          contentSize: 2048,
          description: "Company brand logo",
          data: new TextEncoder().encode("mock png bytes"),
        },
        {
          id: "068xx000003",
          sourceObject: "Document",
          title: "Setup Guide",
          filename: "guide.docx",
          category: "document",
          fileType: "DOCX",
          fileExtension: "docx",
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          contentSize: 4096,
          description: "Customer onboarding setup guide",
          data: new TextEncoder().encode("mock docx bytes"),
        },
        {
          id: "068xx000004",
          sourceObject: "StaticResource",
          title: "Config Notes",
          filename: "notes.txt",
          category: "text",
          fileType: "TEXT",
          fileExtension: "txt",
          contentType: "text/plain",
          contentSize: 512,
          description: "Plain text configuration notes",
          data: new TextEncoder().encode("mock text notes"),
        },
        {
          id: "068xx000005",
          sourceObject: "Attachment",
          title: "Archive Package",
          filename: "package.tar",
          category: "other",
          fileType: "TAR",
          fileExtension: "tar",
          contentType: "application/x-tar",
          contentSize: 8192,
          description: "Other category binary archive",
          data: new TextEncoder().encode("mock archive bytes"),
        },
      ],
    };

    const zipBytes = ZipBuilder.buildZip(packageWithFiles);
    const unzipped = unzipSync(zipBytes);

    // Verify unstructured files are saved under the correct data/files/ subpaths
    expect(unzipped["data/files/pdf/architecture.pdf"]).toBeDefined();
    expect(strFromU8(unzipped["data/files/pdf/architecture.pdf"])).toBe("%PDF-1.4 mock pdf content");

    expect(unzipped["data/files/images/logo.png"]).toBeDefined();
    expect(strFromU8(unzipped["data/files/images/logo.png"])).toBe("mock png bytes");

    expect(unzipped["data/files/documents/guide.docx"]).toBeDefined();
    expect(strFromU8(unzipped["data/files/documents/guide.docx"])).toBe("mock docx bytes");

    expect(unzipped["data/files/text/notes.txt"]).toBeDefined();
    expect(strFromU8(unzipped["data/files/text/notes.txt"])).toBe("mock text notes");

    expect(unzipped["data/files/other/package.tar"]).toBeDefined();
    expect(strFromU8(unzipped["data/files/other/package.tar"])).toBe("mock archive bytes");

    // Verify metadata/files-manifest.json is present and structured properly
    expect(unzipped["metadata/files-manifest.json"]).toBeDefined();
    const manifestJson = JSON.parse(strFromU8(unzipped["metadata/files-manifest.json"]));
    expect(Array.isArray(manifestJson)).toBe(true);
    expect(manifestJson).toHaveLength(5);

    // Check first manifest entry details
    const pdfManifest = manifestJson.find((f: any) => f.id === "068xx000001");
    expect(pdfManifest).toEqual({
      id: "068xx000001",
      sourceObject: "ContentVersion",
      title: "Product Architecture",
      filename: "architecture.pdf",
      category: "pdf",
      fileType: "PDF",
      fileExtension: "pdf",
      contentType: "application/pdf",
      contentSize: 1024,
      description: "Technical architecture diagram",
      pathInZip: "data/files/pdf/architecture.pdf",
    });

    // Check images and documents paths
    const imageManifest = manifestJson.find((f: any) => f.id === "068xx000002");
    expect(imageManifest.pathInZip).toBe("data/files/images/logo.png");

    const docManifest = manifestJson.find((f: any) => f.id === "068xx000003");
    expect(docManifest.pathInZip).toBe("data/files/documents/guide.docx");

    const textManifest = manifestJson.find((f: any) => f.id === "068xx000004");
    expect(textManifest.pathInZip).toBe("data/files/text/notes.txt");

    const otherManifest = manifestJson.find((f: any) => f.id === "068xx000005");
    expect(otherManifest.pathInZip).toBe("data/files/other/package.tar");

    // Ensure raw 'data' bytes are strictly omitted from the manifest JSON
    for (const entry of manifestJson) {
      expect(entry.data).toBeUndefined();
    }

    // Verify agent script and xml are still strictly omitted by default
    expect(unzipped["agent/agent-script.agent"]).toBeUndefined();
    expect(unzipped["agent/bundle-meta.xml"]).toBeUndefined();
    expect(unzipped["agent/bot.xml"]).toBeUndefined();
  });

  it("packages dataStreams, dataLakeMappings, unstructuredSearchIndexes, and dataCloud records", () => {
    const packageWithDataCloudMetadata: ExtractedData360Package = {
      ...pkg,
      metadata: {
        ...pkg.metadata,
        dataStreams: [
          { Id: "ds001", Name: "Web_Clickstream", SourceType: "Engagement" },
        ],
        dataLakeMappings: [
          { Id: "dlm001", SourceDlo: "Web_Clickstream", TargetDmo: "ssot__Individual__dlm" },
        ],
        unstructuredSearchIndexes: [
          { Id: "usi001", DeveloperName: "PDF_Search_Index", Status: "Active" },
        ],
      },
      records: {
        ...pkg.records,
        dataCloud: {
          ssot__Individual__dlm: [
            { id__c: "dmo-ind-1", ssot__FirstName__c: "Alice", ssot__LastName__c: "Smith" },
          ],
          ssot__Device__dlm: [
            { id__c: "dmo-dev-1", ssot__DeviceType__c: "Mobile" },
          ],
        },
      },
    };

    const zipBytes = ZipBuilder.buildZip(packageWithDataCloudMetadata);
    const unzipped = unzipSync(zipBytes);

    // Verify metadata files
    expect(unzipped["metadata/data-streams.json"]).toBeDefined();
    const dataStreams = JSON.parse(strFromU8(unzipped["metadata/data-streams.json"]));
    expect(dataStreams).toEqual([
      { Id: "ds001", Name: "Web_Clickstream", SourceType: "Engagement" },
    ]);

    expect(unzipped["metadata/data-lake-mappings.json"]).toBeDefined();
    const mappings = JSON.parse(strFromU8(unzipped["metadata/data-lake-mappings.json"]));
    expect(mappings).toEqual([
      { Id: "dlm001", SourceDlo: "Web_Clickstream", TargetDmo: "ssot__Individual__dlm" },
    ]);

    expect(unzipped["metadata/search-indexes.json"]).toBeDefined();
    const searchIndexes = JSON.parse(strFromU8(unzipped["metadata/search-indexes.json"]));
    expect(searchIndexes).toEqual([
      { Id: "usi001", DeveloperName: "PDF_Search_Index", Status: "Active" },
    ]);

    // Verify dataCloud DMO records
    expect(unzipped["data/data-cloud/ssot__Individual__dlm.json"]).toBeDefined();
    const indRecords = JSON.parse(strFromU8(unzipped["data/data-cloud/ssot__Individual__dlm.json"]));
    expect(indRecords).toHaveLength(1);
    expect(indRecords[0].ssot__FirstName__c).toBe("Alice");

    expect(unzipped["data/data-cloud/ssot__Device__dlm.json"]).toBeDefined();
    const devRecords = JSON.parse(strFromU8(unzipped["data/data-cloud/ssot__Device__dlm.json"]));
    expect(devRecords).toHaveLength(1);
    expect(devRecords[0].ssot__DeviceType__c).toBe("Mobile");

    // Verify agent script and xml are still strictly omitted by default
    expect(unzipped["agent/agent-script.agent"]).toBeUndefined();
    expect(unzipped["agent/bundle-meta.xml"]).toBeUndefined();
    expect(unzipped["agent/bot.xml"]).toBeUndefined();
  });

  it("omits data-streams, data-lake-mappings, and search-indexes when empty", () => {
    const packageWithEmptyMetadata: ExtractedData360Package = {
      ...pkg,
      metadata: {
        ...pkg.metadata,
        dataStreams: [],
        dataLakeMappings: [],
        unstructuredSearchIndexes: [],
      },
    };

    const zipBytes = ZipBuilder.buildZip(packageWithEmptyMetadata);
    const unzipped = unzipSync(zipBytes);

    expect(unzipped["metadata/data-streams.json"]).toBeUndefined();
    expect(unzipped["metadata/data-lake-mappings.json"]).toBeUndefined();
    expect(unzipped["metadata/search-indexes.json"]).toBeUndefined();
  });
});
