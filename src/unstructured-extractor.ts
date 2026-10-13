import type { ExtractedUnstructuredFile, SalesforceConnection } from "./types";

export type FileCategory = ExtractedUnstructuredFile["category"];

export interface ExtractUnstructuredOptions {
  maxFiles?: number;
  includeContentVersion?: boolean;
  includeDocument?: boolean;
  includeStaticResource?: boolean;
  apiVersion?: string;
  concurrency?: number;
}

const EXTENSION_MAP: Record<string, string> = {
  PDF: "pdf",
  PNG: "png",
  JPG: "jpg",
  JPEG: "jpg",
  GIF: "gif",
  SVG: "svg",
  WEBP: "webp",
  DOC: "doc",
  DOCX: "docx",
  RTF: "rtf",
  PAGES: "pages",
  ODT: "odt",
  TXT: "txt",
  CSV: "csv",
  JSON: "json",
  XML: "xml",
  HTML: "html",
  HTM: "html",
  MD: "md",
  LOG: "log",
  ZIP: "zip",
  TAR: "tar",
  GZ: "gz",
  "7Z": "7z",
};

const MIME_MAP: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "application/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/x-7z-compressed": "7z",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/**
 * Categorizes a file into one of the standard unstructured categories:
 * 'pdf', 'image', 'document', 'text', 'archive', or 'other'.
 */
export function categorizeFile(params: {
  fileType?: string;
  extension?: string;
  contentType?: string;
}): FileCategory {
  const type = (params.fileType || "").trim().toUpperCase();
  const ext = (params.extension || "").trim().toLowerCase();
  const extUpper = ext.toUpperCase();
  const contentType = (params.contentType || "").trim().toLowerCase();

  // 'pdf': if FileType === 'PDF' or ext === 'pdf' or contentType === 'application/pdf'
  if (
    type === "PDF" ||
    ext === "pdf" ||
    contentType === "application/pdf" ||
    contentType.includes("pdf")
  ) {
    return "pdf";
  }

  // 'image': if ['PNG', 'JPG', 'JPEG', 'GIF', 'SVG', 'WEBP'].includes(type) or contentType startsWith 'image/'
  const imageTypes = ["PNG", "JPG", "JPEG", "GIF", "SVG", "WEBP"];
  if (
    imageTypes.includes(type) ||
    imageTypes.includes(extUpper) ||
    contentType.startsWith("image/")
  ) {
    return "image";
  }

  // 'document': if ['DOC', 'DOCX', 'RTF', 'PAGES', 'ODT'].includes(type) or contentType includes 'msword' or 'officedocument'
  const docTypes = ["DOC", "DOCX", "RTF", "PAGES", "ODT"];
  if (
    docTypes.includes(type) ||
    docTypes.includes(extUpper) ||
    contentType.includes("msword") ||
    contentType.includes("officedocument")
  ) {
    return "document";
  }

  // 'text': if ['TXT', 'CSV', 'JSON', 'XML', 'HTML', 'MD', 'LOG'].includes(type) or contentType startsWith 'text/'
  const textTypes = ["TXT", "CSV", "JSON", "XML", "HTML", "MD", "LOG"];
  if (
    textTypes.includes(type) ||
    textTypes.includes(extUpper) ||
    contentType.startsWith("text/")
  ) {
    return "text";
  }

  // 'archive': if ['ZIP', 'TAR', 'GZ', '7Z'].includes(type) or contentType includes 'zip'
  const archiveTypes = ["ZIP", "TAR", "GZ", "7Z"];
  if (
    archiveTypes.includes(type) ||
    archiveTypes.includes(extUpper) ||
    contentType.includes("zip") ||
    contentType.includes("tar") ||
    contentType.includes("gzip")
  ) {
    return "archive";
  }

  // 'other': fallback
  return "other";
}

/**
 * Resolves the file extension without a leading dot based on raw extension,
 * file name, file type, MIME content-type, and category.
 */
export function resolveExtension(params: {
  rawExtension?: string;
  fileType?: string;
  contentType?: string;
  name?: string;
  category?: FileCategory;
}): string {
  // 1. Explicit rawExtension
  if (params.rawExtension && params.rawExtension.trim()) {
    return params.rawExtension.trim().replace(/^\.+/, "").toLowerCase();
  }

  // 2. Check if name already has an extension
  if (params.name) {
    const match = params.name.match(/\.([a-zA-Z0-9]+)$/);
    if (match) {
      return match[1].toLowerCase();
    }
  }

  // 3. Map from fileType
  const typeKey = (params.fileType || "").trim().toUpperCase();
  if (typeKey && EXTENSION_MAP[typeKey]) {
    return EXTENSION_MAP[typeKey];
  }

  // 4. Map from contentType
  const mimeKey = (params.contentType || "").trim().toLowerCase().split(";")[0];
  if (mimeKey && MIME_MAP[mimeKey]) {
    return MIME_MAP[mimeKey];
  }

  // 5. Fallback based on category
  if (params.category) {
    switch (params.category) {
      case "pdf":
        return "pdf";
      case "archive":
        return "zip";
      case "text":
        return "txt";
      case "document":
        return "docx";
      case "image":
        return "png";
    }
  }

  return "";
}

/**
 * Sanitizes a filename:
 * - Replaces invalid chars (< > : " / \ | ? * and control chars) with '_'
 * - Trims trailing dots and spaces
 * - Ensures appropriate extension is attached if missing
 */
export function sanitizeFilename(
  rawName: string,
  extension?: string,
  fallbackId?: string
): string {
  // Replace invalid chars (< > : " / \ | ? * and control chars 0x00-0x1F) with '_'
  let sanitized = (rawName || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim();
  sanitized = sanitized.replace(/[\s.]+$/, "");

  if (!sanitized) {
    sanitized = fallbackId ? `file_${fallbackId}` : "file";
  }

  if (extension) {
    const ext = extension.replace(/^\.+/, "").toLowerCase();
    if (ext && !sanitized.toLowerCase().endsWith(`.${ext}`)) {
      sanitized = `${sanitized}.${ext}`;
    }
  }

  return sanitized;
}

/**
 * Manages concurrent asynchronous tasks with an upper bound on active tasks.
 */
async function runWithConcurrency<T, R>(
  items: T[],
  concurrencyLimit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  const workerCount = Math.min(Math.max(1, concurrencyLimit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await task(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

interface RawFileRecord {
  id: string;
  sourceObject: "ContentVersion" | "Document" | "StaticResource";
  title: string;
  rawType?: string;
  rawExtension?: string;
  contentType?: string;
  contentSize: number;
  description?: string;
  downloadUrl: string;
}

export class UnstructuredExtractor {
  private customFetch?: typeof fetch;

  constructor(fetchFn?: typeof fetch) {
    this.customFetch = fetchFn;
  }

  private get fetch(): typeof fetch {
    if (this.customFetch) {
      return (input: any, init?: any) => this.customFetch!(input, init);
    }
    return (input: any, init?: any) => globalThis.fetch(input, init);
  }

  /**
   * Extracts unstructured files (ContentVersion, Document, StaticResource)
   * from Salesforce using SOQL queries and binary downloads with concurrency control.
   */
  async extractAllFiles(
    connection: SalesforceConnection,
    options?: ExtractUnstructuredOptions
  ): Promise<ExtractedUnstructuredFile[]> {
    const apiVersion = options?.apiVersion || "v65.0";
    const normApiVersion = apiVersion.startsWith("v") ? apiVersion : `v${apiVersion}`;
    const instanceUrl = connection.instanceUrl.replace(/\/+$/, "");
    const maxFiles = options?.maxFiles;
    const concurrency = options?.concurrency ?? 5;

    const includeContentVersion = options?.includeContentVersion ?? true;
    const includeDocument = options?.includeDocument ?? true;
    const includeStaticResource = options?.includeStaticResource ?? true;

    const recordsToDownload: RawFileRecord[] = [];

    // Helper to query SOQL
    const runSoql = async <T = any>(soql: string): Promise<T[]> => {
      const url = `${instanceUrl}/services/data/${normApiVersion}/query?q=${encodeURIComponent(soql)}`;
      const res = await this.fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${connection.accessToken}`,
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        let errBody = `HTTP ${res.status}`;
        try {
          errBody = await res.text();
        } catch {}
        throw new Error(`SOQL query failed: ${errBody}`);
      }

      const json = (await res.json()) as { records?: T[] };
      return Array.isArray(json?.records) ? json.records : [];
    };

    // 1. ContentVersion (Prioritizes PDF files first in memory)
    if (includeContentVersion) {
      if (maxFiles === undefined || recordsToDownload.length < maxFiles) {
        const cvSoql =
          "SELECT Id, Title, FileType, FileExtension, ContentSize, ContentDocumentId, Description FROM ContentVersion WHERE IsLatest = true ORDER BY CreatedDate DESC LIMIT 50";
        const cvRecords = await runSoql<{
          Id: string;
          Title?: string;
          FileType?: string;
          FileExtension?: string;
          ContentSize?: number;
          ContentDocumentId?: string;
          Description?: string;
        }>(cvSoql);

        // Sort so PDFs are processed first
        cvRecords.sort((a, b) => {
          const isAPdf = (a.FileType || "").toUpperCase() === "PDF" || (a.FileExtension || "").toLowerCase() === "pdf";
          const isBPdf = (b.FileType || "").toUpperCase() === "PDF" || (b.FileExtension || "").toLowerCase() === "pdf";
          if (isAPdf && !isBPdf) return -1;
          if (!isAPdf && isBPdf) return 1;
          return 0;
        });

        for (const r of cvRecords) {
          if (maxFiles !== undefined && recordsToDownload.length >= maxFiles) break;
          recordsToDownload.push({
            id: r.Id,
            sourceObject: "ContentVersion",
            title: r.Title || r.Id,
            rawType: r.FileType,
            rawExtension: r.FileExtension,
            contentType: undefined,
            contentSize: typeof r.ContentSize === "number" ? r.ContentSize : 0,
            description: r.Description || undefined,
            downloadUrl: `${instanceUrl}/services/data/${normApiVersion}/sobjects/ContentVersion/${r.Id}/VersionData`,
          });
        }
      }
    }

    // 2. Document
    if (includeDocument) {
      if (maxFiles === undefined || recordsToDownload.length < maxFiles) {
        const docSoql =
          "SELECT Id, Name, Type, ContentType, BodyLength, Description FROM Document ORDER BY CreatedDate DESC";
        const docRecords = await runSoql<{
          Id: string;
          Name?: string;
          Type?: string;
          ContentType?: string;
          BodyLength?: number;
          Description?: string;
        }>(docSoql);

        for (const r of docRecords) {
          if (maxFiles !== undefined && recordsToDownload.length >= maxFiles) break;
          recordsToDownload.push({
            id: r.Id,
            sourceObject: "Document",
            title: r.Name || r.Id,
            rawType: r.Type,
            rawExtension: undefined,
            contentType: r.ContentType,
            contentSize: typeof r.BodyLength === "number" ? r.BodyLength : 0,
            description: r.Description || undefined,
            downloadUrl: `${instanceUrl}/services/data/${normApiVersion}/sobjects/Document/${r.Id}/Body`,
          });
        }
      }
    }

    // 3. StaticResource
    if (includeStaticResource) {
      if (maxFiles === undefined || recordsToDownload.length < maxFiles) {
        const srSoql =
          "SELECT Id, Name, ContentType, BodyLength, Description FROM StaticResource ORDER BY CreatedDate DESC";
        const srRecords = await runSoql<{
          Id: string;
          Name?: string;
          ContentType?: string;
          BodyLength?: number;
          Description?: string;
        }>(srSoql);

        for (const r of srRecords) {
          if (maxFiles !== undefined && recordsToDownload.length >= maxFiles) break;
          recordsToDownload.push({
            id: r.Id,
            sourceObject: "StaticResource",
            title: r.Name || r.Id,
            rawType: undefined,
            rawExtension: undefined,
            contentType: r.ContentType,
            contentSize: typeof r.BodyLength === "number" ? r.BodyLength : 0,
            description: r.Description || undefined,
            downloadUrl: `${instanceUrl}/services/data/${normApiVersion}/sobjects/StaticResource/${r.Id}/Body`,
          });
        }
      }
    }

    // Download binaries using concurrency pool (default 5 concurrent fetches)
    const extractedFiles = await runWithConcurrency(
      recordsToDownload,
      concurrency,
      async (rec): Promise<ExtractedUnstructuredFile> => {
        const res = await this.fetch(rec.downloadUrl, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${connection.accessToken}`,
            Accept: "*/*",
          },
        });

        if (!res.ok) {
          let errText = `HTTP ${res.status}`;
          try {
            errText = await res.text();
          } catch {}
          throw new Error(
            `Failed to download binary for ${rec.sourceObject} ${rec.id}: ${errText}`
          );
        }

        const buffer = await res.arrayBuffer();
        const data = new Uint8Array(buffer);

        // Inspect response Content-Type header if record didn't supply one
        let contentType = rec.contentType;
        const resContentType = res.headers.get("content-type")?.split(";")[0]?.trim();
        if (
          resContentType &&
          (!contentType || contentType === "application/octet-stream")
        ) {
          contentType = resContentType;
        }

        // Determine effective extension
        let ext = (rec.rawExtension || "").trim().toLowerCase();
        if (!ext && rec.title) {
          const match = rec.title.match(/\.([a-zA-Z0-9]+)$/);
          if (match) {
            ext = match[1].toLowerCase();
          }
        }

        // Categorize file
        const category = categorizeFile({
          fileType: rec.rawType,
          extension: ext,
          contentType,
        });

        // Resolve final extension
        const resolvedExt = resolveExtension({
          rawExtension: ext,
          fileType: rec.rawType,
          contentType,
          name: rec.title,
          category,
        });

        // Sanitize filename and attach extension if missing
        const filename = sanitizeFilename(rec.title, resolvedExt, rec.id);

        const fileType =
          rec.rawType?.toUpperCase() ||
          resolvedExt?.toUpperCase() ||
          (category !== "other" ? category.toUpperCase() : "UNKNOWN");

        return {
          id: rec.id,
          sourceObject: rec.sourceObject,
          title: rec.title,
          filename,
          category,
          fileType,
          fileExtension: resolvedExt || undefined,
          contentType: contentType || undefined,
          contentSize: data.byteLength || rec.contentSize,
          description: rec.description,
          data,
        };
      }
    );

    return extractedFiles;
  }
}
