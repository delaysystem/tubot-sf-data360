import { describe, it, expect, vi } from "vitest";
import {
  UnstructuredExtractor,
  categorizeFile,
  sanitizeFilename,
  resolveExtension,
} from "../src/unstructured-extractor";
import type { SalesforceConnection } from "../src/types";

describe("UnstructuredExtractor", () => {
  const conn: SalesforceConnection = {
    accessToken: "mock-salesforce-token-xyz",
    instanceUrl: "https://test.my.salesforce.com",
  };

  const mockPdfBytes = new TextEncoder().encode("%PDF-1.4 mock pdf document content");
  const mockPngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const mockTxtBytes = new TextEncoder().encode("APP_ENV=production\nLOG_LEVEL=debug\n");
  const mockZipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

  function createMockFetch(activeTracker?: { current: number; max: number }) {
    return vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const decodedUrl = decodeURIComponent(url);

      // 1. SOQL Query for ContentVersion
      if (
        decodedUrl.includes("/query?q=") &&
        decodedUrl.includes("FROM ContentVersion")
      ) {
        return Response.json({
          totalSize: 2,
          done: true,
          records: [
            {
              Id: "068xx000001PDF",
              Title: "Quarterly Report <Q3:2026> *",
              FileType: "PDF",
              FileExtension: "pdf",
              ContentSize: mockPdfBytes.byteLength,
              ContentDocumentId: "069xx000001DOC",
              Description: "Q3 Financial Report",
            },
            {
              Id: "068xx000002PNG",
              Title: "Company Logo",
              FileType: "PNG",
              FileExtension: "png",
              ContentSize: mockPngBytes.byteLength,
              ContentDocumentId: "069xx000002DOC",
              Description: "Main Brand Logo",
            },
          ],
        });
      }

      // 2. SOQL Query for Document
      if (decodedUrl.includes("/query?q=") && decodedUrl.includes("FROM Document")) {
        return Response.json({
          totalSize: 1,
          done: true,
          records: [
            {
              Id: "015xx000003TXT",
              Name: "server/config?v=1",
              Type: "txt",
              ContentType: "text/plain",
              BodyLength: mockTxtBytes.byteLength,
              Description: "Server Environment Settings",
            },
          ],
        });
      }

      // 3. SOQL Query for StaticResource
      if (
        decodedUrl.includes("/query?q=") &&
        decodedUrl.includes("FROM StaticResource")
      ) {
        return Response.json({
          totalSize: 1,
          done: true,
          records: [
            {
              Id: "081xx000004ZIP",
              Name: "application_assets",
              ContentType: "application/zip",
              BodyLength: mockZipBytes.byteLength,
              Description: "Static Web Assets Bundle",
            },
          ],
        });
      }

      // Track active concurrent fetches if requested
      if (activeTracker) {
        activeTracker.current++;
        if (activeTracker.current > activeTracker.max) {
          activeTracker.max = activeTracker.current;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // 4. Binary download: ContentVersion VersionData
      if (url.includes("/sobjects/ContentVersion/068xx000001PDF/VersionData")) {
        if (activeTracker) activeTracker.current--;
        return new Response(mockPdfBytes, {
          status: 200,
          headers: { "Content-Type": "application/pdf" },
        });
      }
      if (url.includes("/sobjects/ContentVersion/068xx000002PNG/VersionData")) {
        if (activeTracker) activeTracker.current--;
        return new Response(mockPngBytes, {
          status: 200,
          headers: { "Content-Type": "image/png" },
        });
      }

      // 5. Binary download: Document Body
      if (url.includes("/sobjects/Document/015xx000003TXT/Body")) {
        if (activeTracker) activeTracker.current--;
        return new Response(mockTxtBytes, {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        });
      }

      // 6. Binary download: StaticResource Body
      if (url.includes("/sobjects/StaticResource/081xx000004ZIP/Body")) {
        if (activeTracker) activeTracker.current--;
        return new Response(mockZipBytes, {
          status: 200,
          headers: { "Content-Type": "application/zip" },
        });
      }

      if (activeTracker) activeTracker.current--;
      return new Response("Not Found", { status: 404 });
    });
  }

  it("extracts all unstructured files: ContentVersion (PDF, PNG), Document (TXT), StaticResource (ZIP)", async () => {
    const mockFetch = createMockFetch();
    const extractor = new UnstructuredExtractor(mockFetch as unknown as typeof fetch);

    const files = await extractor.extractAllFiles(conn);

    expect(files).toHaveLength(4);

    // 1. ContentVersion PDF
    const pdfFile = files.find((f) => f.id === "068xx000001PDF");
    expect(pdfFile).toBeDefined();
    expect(pdfFile!.sourceObject).toBe("ContentVersion");
    expect(pdfFile!.category).toBe("pdf");
    expect(pdfFile!.fileType).toBe("PDF");
    expect(pdfFile!.fileExtension).toBe("pdf");
    expect(pdfFile!.filename).toBe("Quarterly Report _Q3_2026_ _.pdf");
    expect(pdfFile!.title).toBe("Quarterly Report <Q3:2026> *");
    expect(pdfFile!.description).toBe("Q3 Financial Report");
    expect(pdfFile!.contentSize).toBe(mockPdfBytes.byteLength);
    expect(pdfFile!.data).toEqual(mockPdfBytes);

    // 2. ContentVersion PNG (missing extension in title, should attach .png)
    const pngFile = files.find((f) => f.id === "068xx000002PNG");
    expect(pngFile).toBeDefined();
    expect(pngFile!.sourceObject).toBe("ContentVersion");
    expect(pngFile!.category).toBe("image");
    expect(pngFile!.fileType).toBe("PNG");
    expect(pngFile!.fileExtension).toBe("png");
    expect(pngFile!.filename).toBe("Company Logo.png");
    expect(pngFile!.description).toBe("Main Brand Logo");
    expect(pngFile!.data).toEqual(mockPngBytes);

    // 3. Document TXT (sanitizes '/' and '?')
    const txtFile = files.find((f) => f.id === "015xx000003TXT");
    expect(txtFile).toBeDefined();
    expect(txtFile!.sourceObject).toBe("Document");
    expect(txtFile!.category).toBe("text");
    expect(txtFile!.fileType).toBe("TXT");
    expect(txtFile!.fileExtension).toBe("txt");
    expect(txtFile!.filename).toBe("server_config_v=1.txt");
    expect(txtFile!.contentType).toBe("text/plain");
    expect(txtFile!.data).toEqual(mockTxtBytes);

    // 4. StaticResource ZIP (attaches .zip from ContentType)
    const zipFile = files.find((f) => f.id === "081xx000004ZIP");
    expect(zipFile).toBeDefined();
    expect(zipFile!.sourceObject).toBe("StaticResource");
    expect(zipFile!.category).toBe("archive");
    expect(zipFile!.fileType).toBe("ZIP");
    expect(zipFile!.fileExtension).toBe("zip");
    expect(zipFile!.filename).toBe("application_assets.zip");
    expect(zipFile!.contentType).toBe("application/zip");
    expect(zipFile!.data).toEqual(mockZipBytes);
  });

  it("respects source inclusion flags (includeContentVersion, includeDocument, includeStaticResource)", async () => {
    const mockFetch = createMockFetch();
    const extractor = new UnstructuredExtractor(mockFetch as unknown as typeof fetch);

    // Exclude ContentVersion -> only Document and StaticResource
    const filesNoCv = await extractor.extractAllFiles(conn, {
      includeContentVersion: false,
    });
    expect(filesNoCv.map((f) => f.sourceObject)).toEqual(["Document", "StaticResource"]);

    // Exclude Document -> only ContentVersion and StaticResource
    const filesNoDoc = await extractor.extractAllFiles(conn, {
      includeDocument: false,
    });
    expect(filesNoDoc.map((f) => f.sourceObject)).toEqual([
      "ContentVersion",
      "ContentVersion",
      "StaticResource",
    ]);

    // Exclude StaticResource -> only ContentVersion and Document
    const filesNoSr = await extractor.extractAllFiles(conn, {
      includeStaticResource: false,
    });
    expect(filesNoSr.map((f) => f.sourceObject)).toEqual([
      "ContentVersion",
      "ContentVersion",
      "Document",
    ]);
  });

  it("respects maxFiles limit", async () => {
    const mockFetch = createMockFetch();
    const extractor = new UnstructuredExtractor(mockFetch as unknown as typeof fetch);

    const limitedFiles = await extractor.extractAllFiles(conn, {
      maxFiles: 2,
    });
    expect(limitedFiles).toHaveLength(2);
    expect(limitedFiles[0].id).toBe("068xx000001PDF");
    expect(limitedFiles[1].id).toBe("068xx000002PNG");
  });

  it("enforces concurrency control during binary downloads", async () => {
    const tracker = { current: 0, max: 0 };
    const mockFetch = createMockFetch(tracker);
    const extractor = new UnstructuredExtractor(mockFetch as unknown as typeof fetch);

    const files = await extractor.extractAllFiles(conn, { concurrency: 2 });
    expect(files).toHaveLength(4);
    // Concurrency limit is 2, so max active in-flight binary requests must be <= 2
    expect(tracker.max).toBeLessThanOrEqual(2);
  });

  it("handles SOQL query failure by throwing informative error", async () => {
    const failingFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ message: "Session expired or invalid" }]), {
        status: 401,
        statusText: "Unauthorized",
      })
    );
    const extractor = new UnstructuredExtractor(failingFetch as unknown as typeof fetch);

    await expect(extractor.extractAllFiles(conn)).rejects.toThrow("SOQL query failed");
  });

  it("handles binary download failure by throwing informative error", async () => {
    const failingFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("/query?q=")) {
        return Response.json({
          records: [{ Id: "068xxError", Title: "FaultyFile", FileType: "PDF" }],
        });
      }
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    });
    const extractor = new UnstructuredExtractor(failingFetch as unknown as typeof fetch);

    await expect(extractor.extractAllFiles(conn)).rejects.toThrow(
      "Failed to download binary for ContentVersion 068xxError"
    );
  });
});

describe("categorizeFile", () => {
  it("categorizes PDF files properly", () => {
    expect(categorizeFile({ fileType: "PDF" })).toBe("pdf");
    expect(categorizeFile({ extension: "pdf" })).toBe("pdf");
    expect(categorizeFile({ contentType: "application/pdf" })).toBe("pdf");
  });

  it("categorizes image files properly", () => {
    for (const type of ["PNG", "JPG", "JPEG", "GIF", "SVG", "WEBP"]) {
      expect(categorizeFile({ fileType: type })).toBe("image");
      expect(categorizeFile({ extension: type.toLowerCase() })).toBe("image");
    }
    expect(categorizeFile({ contentType: "image/png" })).toBe("image");
    expect(categorizeFile({ contentType: "image/webp" })).toBe("image");
  });

  it("categorizes document files properly", () => {
    for (const type of ["DOC", "DOCX", "RTF", "PAGES", "ODT"]) {
      expect(categorizeFile({ fileType: type })).toBe("document");
      expect(categorizeFile({ extension: type.toLowerCase() })).toBe("document");
    }
    expect(categorizeFile({ contentType: "application/msword" })).toBe("document");
    expect(
      categorizeFile({
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })
    ).toBe("document");
  });

  it("categorizes text files properly", () => {
    for (const type of ["TXT", "CSV", "JSON", "XML", "HTML", "MD", "LOG"]) {
      expect(categorizeFile({ fileType: type })).toBe("text");
      expect(categorizeFile({ extension: type.toLowerCase() })).toBe("text");
    }
    expect(categorizeFile({ contentType: "text/plain" })).toBe("text");
    expect(categorizeFile({ contentType: "text/csv" })).toBe("text");
  });

  it("categorizes archive files properly", () => {
    for (const type of ["ZIP", "TAR", "GZ", "7Z"]) {
      expect(categorizeFile({ fileType: type })).toBe("archive");
      expect(categorizeFile({ extension: type.toLowerCase() })).toBe("archive");
    }
    expect(categorizeFile({ contentType: "application/zip" })).toBe("archive");
    expect(categorizeFile({ contentType: "application/x-zip-compressed" })).toBe("archive");
  });

  it("falls back to 'other' for unrecognized formats", () => {
    expect(categorizeFile({ fileType: "BIN" })).toBe("other");
    expect(categorizeFile({ extension: "xyz" })).toBe("other");
    expect(categorizeFile({ contentType: "application/octet-stream" })).toBe("other");
  });
});

describe("sanitizeFilename", () => {
  it("replaces invalid characters with underscores", () => {
    expect(sanitizeFilename('bad<file>:name"with/slashes\\and|pipes?and*stars', "txt")).toBe(
      "bad_file__name_with_slashes_and_pipes_and_stars.txt"
    );
  });

  it("attaches extension if missing", () => {
    expect(sanitizeFilename("my_document", "pdf")).toBe("my_document.pdf");
  });

  it("does not duplicate extension if already present", () => {
    expect(sanitizeFilename("my_document.pdf", "pdf")).toBe("my_document.pdf");
    expect(sanitizeFilename("my_document.PDF", "pdf")).toBe("my_document.PDF");
  });

  it("falls back to fallbackId when filename is empty", () => {
    expect(sanitizeFilename("", "pdf", "068abc")).toBe("file_068abc.pdf");
    expect(sanitizeFilename("   ", "png", "068xyz")).toBe("file_068xyz.png");
  });
});

describe("resolveExtension", () => {
  it("resolves from rawExtension first", () => {
    expect(resolveExtension({ rawExtension: "pdf" })).toBe("pdf");
    expect(resolveExtension({ rawExtension: ".png" })).toBe("png");
  });

  it("resolves from name if extension present", () => {
    expect(resolveExtension({ name: "my_archive.zip" })).toBe("zip");
  });

  it("resolves from fileType", () => {
    expect(resolveExtension({ fileType: "JPEG" })).toBe("jpg");
    expect(resolveExtension({ fileType: "DOCX" })).toBe("docx");
  });

  it("resolves from contentType", () => {
    expect(resolveExtension({ contentType: "application/pdf" })).toBe("pdf");
    expect(resolveExtension({ contentType: "image/png" })).toBe("png");
  });

  it("resolves from category fallback", () => {
    expect(resolveExtension({ category: "pdf" })).toBe("pdf");
    expect(resolveExtension({ category: "archive" })).toBe("zip");
  });
});
