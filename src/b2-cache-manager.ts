import type {
  DataCloudFamily,
  B2CacheMetadata,
  B2Config,
  B2SnapshotSummary,
  ExportManifest,
  ExtractedData360Package,
  ExtractedUnstructuredFile,
} from "./types";
import { DATA_CLOUD_FAMILIES } from "./types";

export interface B2FileEntry {
  fileId?: string;
  fileName: string;
  contentLength?: number;
  size?: number;
  uploadTimestamp?: number;
  contentType?: string;
}

export interface B2ListFilesResponse {
  files: B2FileEntry[];
  nextFileName?: string | null;
}

export interface B2ClientInterface {
  bucketId?: string;
  bucketName?: string;
  uploadFile(
    fileNameOrParams: string | any,
    data?: Uint8Array | string,
    contentType?: string
  ): Promise<{ fileId?: string; fileName?: string; contentLength?: number; [key: string]: any }>;
  downloadFile(fileNameOrParams: string | any): Promise<Uint8Array | Response | null>;
  listFileNames(
    prefixOrOptions?:
      | string
      | { prefix?: string; startFileName?: string; maxFileCount?: number; delimiter?: string }
  ): Promise<B2ListFilesResponse | B2FileEntry[] | string[] | any>;
  upload?(
    fileNameOrParams: string | any,
    data?: Uint8Array | string,
    contentType?: string
  ): Promise<{ fileId?: string; fileName?: string; contentLength?: number; [key: string]: any }>;
  download?(fileNameOrParams: string | any): Promise<Uint8Array | Response | null>;
  downloadFileByName?(fileName: string): Promise<Uint8Array | Response | null>;
  authorize?(): Promise<{ apiUrl: string; authorizationToken: string; downloadUrl: string }>;
}

/**
 * Standard client for Backblaze B2 Cloud Storage.
 * Supports B2 Native REST API and works seamlessly across Cloudflare Workers, Node, and Bun runtimes.
 */
export class B2Client implements B2ClientInterface {
  public keyId: string;
  public applicationKey: string;
  public bucketId: string;
  public bucketName: string;
  public endpoint: string;

  private authToken?: string;
  private apiUrl?: string;
  private downloadUrl?: string;
  private uploadUrl?: string;
  private uploadToken?: string;

  constructor(config?: B2Config) {
    this.keyId =
      config?.keyId ||
      (typeof process !== "undefined" ? process.env?.BACKBLAZE_KEY_ID : undefined) ||
      "";
    this.applicationKey =
      config?.applicationKey ||
      (typeof process !== "undefined" ? process.env?.BACKBLAZE_APPLICATION_KEY : undefined) ||
      "";
    this.bucketId =
      config?.bucketId ||
      (typeof process !== "undefined" ? process.env?.BACKBLAZE_BUCKET_ID : undefined) ||
      "";
    this.bucketName =
      config?.bucketName ||
      this.bucketId ||
      "tubot-encrypted";
    this.endpoint =
      config?.endpoint ||
      (typeof process !== "undefined" ? process.env?.BACKBLAZE_ENDPOINT : undefined) ||
      "s3.us-west-004.backblazeb2.com";
  }

  async authorize(): Promise<{ apiUrl: string; authorizationToken: string; downloadUrl: string }> {
    const creds = btoa(`${this.keyId}:${this.applicationKey}`);
    const res = await fetch("https://api.backblazeb2.com/b2api/v2/b2_authorize_account", {
      headers: {
        Authorization: `Basic ${creds}`,
      },
    });

    if (!res.ok) {
      throw new Error(`B2 authorization failed (${res.status}): ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    this.authToken = data.authorizationToken;
    this.apiUrl = data.apiUrl;
    this.downloadUrl = data.downloadUrl;
    // Downloads address the bucket by NAME (/file/<name>/...), so an id-shaped
    // configured name breaks every read. Adopt the authoritative name from the
    // authorize response unless an explicit (non-id) name was configured.
    const derivedName = data?.allowed?.bucketName || data?.apiInfo?.storageApi?.bucketName;
    if (
      typeof derivedName === "string" &&
      derivedName &&
      (!this.bucketName || /^[0-9a-f]{24}$/i.test(this.bucketName))
    ) {
      this.bucketName = derivedName;
    }

    return {
      apiUrl: data.apiUrl,
      authorizationToken: data.authorizationToken,
      downloadUrl: data.downloadUrl,
    };
  }

  async uploadFile(
    fileName: string,
    data: Uint8Array | string,
    contentType = "application/octet-stream"
  ): Promise<{ fileId: string; fileName: string; contentLength: number }> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (!this.authToken || !this.apiUrl) {
      await this.authorize();
    }

    if (!this.uploadUrl || !this.uploadToken) {
      const getUrlRes = await fetch(`${this.apiUrl}/b2api/v2/b2_get_upload_url`, {
        method: "POST",
        headers: {
          Authorization: this.authToken!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bucketId: this.bucketId }),
      });

      if (!getUrlRes.ok) {
        throw new Error(`Failed to acquire upload URL: ${getUrlRes.statusText}`);
      }

      const uploadUrlData = (await getUrlRes.json()) as any;
      this.uploadUrl = uploadUrlData.uploadUrl;
      this.uploadToken = uploadUrlData.authorizationToken;
    }

    const uploadRes = await fetch(this.uploadUrl!, {
      method: "POST",
      headers: {
        Authorization: this.uploadToken!,
        "X-Bz-File-Name": encodeURIComponent(fileName),
        "Content-Type": contentType,
        "Content-Length": String(bytes.length),
        "X-Bz-Content-Sha1": "do_not_verify",
      },
      body: bytes as any,
    });

    if (!uploadRes.ok) {
      throw new Error(`Failed to upload file "${fileName}": ${uploadRes.statusText}`);
    }

    const resData = (await uploadRes.json()) as any;
    return {
      fileId: resData.fileId,
      fileName: resData.fileName,
      contentLength: resData.contentLength ?? bytes.length,
    };
  }

  async upload(
    fileName: string,
    data: Uint8Array | string,
    contentType?: string
  ): Promise<{ fileId: string; fileName: string; contentLength: number }> {
    return this.uploadFile(fileName, data, contentType);
  }

  async downloadFile(fileName: string): Promise<Uint8Array | null> {
    if (!this.authToken || !this.downloadUrl) {
      await this.authorize();
    }

    const url = `${this.downloadUrl}/file/${this.bucketName}/${fileName.split("/").map(encodeURIComponent).join("/")}`;
    const res = await fetch(url, {
      headers: {
        Authorization: this.authToken!,
      },
    });

    if (res.status === 404) {
      return null;
    }
    if (!res.ok) {
      throw new Error(`Failed to download file "${fileName}": ${res.statusText}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  async downloadFileByName(fileName: string): Promise<Uint8Array | null> {
    return this.downloadFile(fileName);
  }

  async download(fileName: string): Promise<Uint8Array | null> {
    return this.downloadFile(fileName);
  }

  async listFileNames(
    prefixOrOptions?:
      | string
      | { prefix?: string; startFileName?: string; maxFileCount?: number; delimiter?: string }
  ): Promise<B2ListFilesResponse> {
    if (!this.authToken || !this.apiUrl) {
      await this.authorize();
    }

    const prefix = typeof prefixOrOptions === "string" ? prefixOrOptions : prefixOrOptions?.prefix;
    const body: Record<string, any> = {
      bucketId: this.bucketId,
      maxFileCount: 1000,
    };
    if (prefix) body.prefix = prefix;
    if (typeof prefixOrOptions === "object") {
      if (prefixOrOptions.startFileName) body.startFileName = prefixOrOptions.startFileName;
      if (prefixOrOptions.maxFileCount) body.maxFileCount = prefixOrOptions.maxFileCount;
      if (prefixOrOptions.delimiter) body.delimiter = prefixOrOptions.delimiter;
    }

    const res = await fetch(`${this.apiUrl}/b2api/v2/b2_list_file_names`, {
      method: "POST",
      headers: {
        Authorization: this.authToken!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`Failed to list file names: ${res.statusText}`);
    }

    const data = (await res.json()) as any;
    return {
      files: data.files || [],
      nextFileName: data.nextFileName,
    };
  }
}

const CRM_ENTITY_MAP: Record<string, string> = {
  individuals: "Individual",
  contactPointEmails: "ContactPointEmail",
  contactPointPhones: "ContactPointPhone",
  orders: "Order",
  orderItems: "OrderItem",
  leads: "Lead",
  accounts: "Account",
  messagingSessions: "MessagingSession",
};

/** Version tag for the data-bundle.json snapshot layout (see savePackage). */
const DATA_BUNDLE_VERSION = 1;

/** Portable base64 encode/decode (Workers have no Buffer). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Extracts target identifier (channelId, agentName, or fallback)
 */
function extractTargetIdentifier(pkg: ExtractedData360Package): string {
  const target =
    pkg.manifest?.target?.channelId ||
    pkg.manifest?.target?.agentName ||
    pkg.manifest?.target?.channelDeveloperName ||
    pkg.agent?.channelName ||
    pkg.agent?.agentName ||
    "default-target";

  return target.trim().replace(/[/\\]/g, "_");
}

/**
 * Extracts Salesforce Org ID from package manifest, target info, or instance URL.
 */
function extractOrgId(pkg: ExtractedData360Package): string {
  if ((pkg as any).orgId) return String((pkg as any).orgId);
  if ((pkg.manifest as any)?.orgId) return String((pkg.manifest as any).orgId);
  if (pkg.manifest?.salesforce?.orgId) return String(pkg.manifest.salesforce.orgId);
  if ((pkg.manifest?.target as any)?.orgId) return String((pkg.manifest.target as any).orgId);

  const instanceUrl = pkg.manifest?.salesforce?.instanceUrl;
  if (instanceUrl) {
    try {
      const url = new URL(instanceUrl.startsWith("http") ? instanceUrl : `https://${instanceUrl}`);
      const hostname = url.hostname;
      const parts = hostname.split(".");
      if (parts[0] && parts[0] !== "www") {
        return parts[0];
      }
    } catch {
      const cleaned = instanceUrl.replace(/^https?:\/\//, "").split("/")[0].split(".")[0];
      if (cleaned) return cleaned;
    }
  }

  throw new Error("Tenant isolation error: Unable to resolve orgId from package manifest or instanceUrl.");
}

/**
 * B2 Cache Manager for tubot-sf-data360.
 * Organizes snapshots, data archives, manifest metadata, CRM entities, Data Cloud DMOs,
 * and unstructured files in Backblaze B2 storage with bandwidth alliance support.
 */
export class B2CacheManager {
  private b2Client: B2ClientInterface;
  private config?: B2Config;

  constructor(b2ClientOrConfig?: B2ClientInterface | B2Config, config?: B2Config) {
    if (
      b2ClientOrConfig &&
      ("uploadFile" in b2ClientOrConfig ||
        "listFileNames" in b2ClientOrConfig ||
        "downloadFile" in b2ClientOrConfig)
    ) {
      this.b2Client = b2ClientOrConfig as B2ClientInterface;
      this.config = config;
    } else {
      const resolvedConfig: B2Config = (b2ClientOrConfig as B2Config) || config || {
        keyId: (typeof process !== "undefined" ? process.env?.BACKBLAZE_KEY_ID : undefined) || "",
        applicationKey:
          (typeof process !== "undefined" ? process.env?.BACKBLAZE_APPLICATION_KEY : undefined) ||
          "",
        bucketId:
          (typeof process !== "undefined" ? process.env?.BACKBLAZE_BUCKET_ID : undefined) || "",
        bucketName:
          (typeof process !== "undefined" ? process.env?.BACKBLAZE_BUCKET_ID : undefined) ||
          "tubot-encrypted",
        endpoint:
          (typeof process !== "undefined" ? process.env?.BACKBLAZE_ENDPOINT : undefined) ||
          "s3.us-west-004.backblazeb2.com",
      };
      this.config = resolvedConfig;
      this.b2Client = new B2Client(resolvedConfig);
    }
  }

  get client(): B2ClientInterface {
    return this.b2Client;
  }

  /** B2 key root for this manager (sanitized; default "data360"). */
  rootPrefix(): string {
    const raw = this.config?.pathPrefix || "data360";
    return /^[A-Za-z0-9_-]{1,64}$/.test(raw) ? raw : "data360";
  }

  private async doUpload(
    fileName: string,
    data: Uint8Array | string,
    contentType = "application/octet-stream"
  ): Promise<{ fileId?: string; fileName: string; contentLength: number }> {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (typeof this.b2Client.uploadFile === "function") {
      const hexBucketId =
        this.config?.bucketId && /^[0-9a-f]{24}$/i.test(this.config.bucketId)
          ? this.config.bucketId
          : ((this.b2Client as any).bucketId || this.config?.bucketId);

      if (this.b2Client.uploadFile.length > 1) {
        return (this.b2Client as any).uploadFile(fileName, bytes, contentType);
      }

      return await (this.b2Client as any).uploadFile({
        bucketId: hexBucketId,
        fileName,
        data: bytes,
        contentType,
      });
    }
    if (typeof this.b2Client.upload === "function") {
      return (this.b2Client.upload(fileName, bytes, contentType) as any);
    }
    throw new Error("b2Client does not implement uploadFile or upload method.");
  }

  private async doDownload(fileName: string): Promise<Uint8Array | null> {
    const downloadFn =
      (this.b2Client as any).downloadFile ||
      (this.b2Client as any).downloadFileByName ||
      (this.b2Client as any).download;

    if (typeof downloadFn !== "function") {
      throw new Error(
        "b2Client does not implement downloadFile, downloadFileByName, or download."
      );
    }

    let result: any;
    try {
      result = await downloadFn.call(this.b2Client, fileName);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      result = null;
    }

    // The native client already translates a real 404 to null. Do not retry
    // that response with the compatibility adapter's object arguments.
    if (result === null && this.b2Client instanceof B2Client) return null;

    if (!result || (typeof result.status === "number" && result.status === 404)) {
      try {
        result = await downloadFn.call(this.b2Client, {
          bucketName:
            this.config?.bucketName || this.b2Client.bucketName || this.config?.bucketId,
          fileName,
        });
      } catch (err: any) {
        const msg = (err?.message || String(err)).toLowerCase();
        if (msg.includes("404") || msg.includes("not found")) {
          return null;
        }
        throw err;
      }
    }

    if (!result) return null;

    if (typeof (result as any).arrayBuffer === "function") {
      if (result.status === 404) return null;
      if (!result.ok && result.status !== 200) {
        throw new Error(`B2 download returned HTTP ${result.status}`);
      }
      const buf = await result.arrayBuffer();
      return new Uint8Array(buf);
    }

    if (typeof result === "string") {
      return new TextEncoder().encode(result);
    }
    if (result instanceof Uint8Array) {
      return result;
    }
    if (result instanceof ArrayBuffer) {
      return new Uint8Array(result);
    }
    return result;
  }

  private async doListFiles(prefix: string): Promise<any> {
    if (typeof this.b2Client.listFileNames === "function") {
      try {
        return await (this.b2Client as any).listFileNames(prefix);
      } catch {
        return await (this.b2Client as any).listFileNames({
          bucketId: this.config?.bucketId || this.b2Client.bucketId,
          prefix,
          maxFileCount: 1000,
        });
      }
    }
    throw new Error("b2Client does not implement listFileNames method.");
  }

  /** Publish a tenant-scoped snapshot only after every family object is stored. */
  async savePackage(
    pkg: ExtractedData360Package,
    options?: { ttlSeconds?: number; snapshotId?: string; orgId?: string; targetId?: string }
  ): Promise<B2CacheMetadata> {
    const orgId = options?.orgId || extractOrgId(pkg);
    const targetIdentifier = options?.targetId || extractTargetIdentifier(pkg);
    const snapshotId = options?.snapshotId || `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
    for (const value of [orgId, targetIdentifier, snapshotId]) {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid B2 snapshot scope");
    }
    const basePath = `${this.rootPrefix()}/${orgId}/${targetIdentifier}/snapshots/${snapshotId}`;
    let totalBytes = 0;
    let fileCount = 0;
    const files: NonNullable<ExportManifest["storage"]>["files"] = [];
    const upload = async (path: string, value: Uint8Array | string, contentType: string) => {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const sha256 = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
      await this.doUpload(`${basePath}/${path}`, bytes, contentType);
      files.push({ path, bytes: bytes.length, sha256 });
      totalBytes += bytes.length;
      fileCount++;
    };
    const json = (path: string, value: unknown) => upload(path, JSON.stringify(value), "application/json");
    const descriptors = pkg.metadata.dataCloudObjects ?? [];
    const objectFamilies: Record<string, DataCloudFamily> = Object.fromEntries(descriptors.map(o => [o.storageKey, o.family]));
    const metadataFallback: Partial<Record<DataCloudFamily, unknown>> = {
      dlo: pkg.metadata.dataLakeObjects, dmo: pkg.metadata.dataModelObjects ?? pkg.metadata.dmoDescribes,
      "data-graph": pkg.metadata.dataGraphs, "calculated-insight": pkg.metadata.calculatedInsights,
    };
    // Packages from older callers still contain valid rows without the new catalog.
    for (const name of Object.keys(pkg.records.dataCloud)) objectFamilies[name] ??= "dmo";
    for (const name of Object.keys(pkg.records.dataGraphs ?? {})) objectFamilies[name] = "data-graph";
    for (const family of DATA_CLOUD_FAMILIES) {
      const objects = descriptors.filter(o => o.family === family);
      const source = family === "data-graph" ? pkg.records.dataGraphs ?? {} : pkg.records.dataCloud;
      const rows = Object.fromEntries(Object.entries(source).filter(([name]) => objectFamilies[name] === family));
      const metadata = objects.length ? objects.map(o => ({ ...o.metadata, dataSpace: o.dataSpace, storageKey: o.storageKey }))
        : metadataFallback[family] ?? [];
      await json(`data/${family}.json`, { metadata, rows });
    }
    const { dataCloudObjects, dataLakeObjects, dataModelObjects, dataGraphs,
      calculatedInsights, dmoDescribes, ...context } = pkg.metadata;
    await json("metadata/context.json", { metadata: context, agent: pkg.agent });
    await json("data/crm.json", pkg.records.crm);
    const fileIndex = [];
    for (const file of pkg.unstructuredFiles ?? []) {
      const path = `files/${encodeURIComponent(file.category)}/${encodeURIComponent(file.id)}/${encodeURIComponent(file.filename)}`;
      const { data, ...metadata } = file;
      await upload(path, data instanceof Uint8Array ? data : new Uint8Array(data), file.contentType || "application/octet-stream");
      fileIndex.push({ ...metadata, path });
    }
    await json("metadata/files.json", fileIndex);
    pkg.manifest.storage = { layoutVersion: 3, objectFamilies,
      objectDataSpaces: Object.fromEntries(descriptors.map(o => [o.storageKey, o.dataSpace])), files };
    const metadata: B2CacheMetadata = {
      stored: true,
      bucketName: this.b2Client.bucketName || this.config?.bucketName || "",
      bucketId: this.b2Client.bucketId || this.config?.bucketId || "",
      snapshotId, basePath, cachedAt: new Date().toISOString(),
      ...(options?.ttlSeconds ? { expiresAt: new Date(Date.now() + options.ttlSeconds * 1000).toISOString() } : {}),
      bandwidthAlliance: true, totalBytes, fileCount: fileCount + 1,
    };
    pkg.manifest.b2Cache = metadata;
    pkg.b2Cache = metadata;
    // Resolve the self-referential manifest byte count before writing it.
    let manifestText = "";
    for (let i = 0; i < 10; i++) {
      manifestText = JSON.stringify(pkg.manifest);
      const measured = totalBytes + new TextEncoder().encode(manifestText).length;
      if (metadata.totalBytes === measured) break;
      metadata.totalBytes = measured;
    }
    await this.doUpload(`${basePath}/manifest.json`, manifestText, "application/json");
    const summary: B2SnapshotSummary = {
      snapshotId, timestamp: pkg.manifest.exportTimestamp, orgId,
      targetId: targetIdentifier, manifest: pkg.manifest,
      totalBytes: metadata.totalBytes, fileCount: metadata.fileCount,
    };
    await this.doUpload(`${this.rootPrefix()}/${orgId}/${targetIdentifier}/latest.json`, JSON.stringify(summary), "application/json");
    return metadata;
  }

  /**
   * Retrieves the latest snapshot summary for an orgId and targetId.
   */
  async getLatestSnapshot(orgId: string, targetId: string): Promise<B2SnapshotSummary | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(orgId) || !/^[A-Za-z0-9_-]+$/.test(targetId)) throw new Error("Invalid B2 snapshot scope");
    const cleanTargetId = targetId.trim().replace(/[/\\]/g, "_");
    const key = `${this.rootPrefix()}/${orgId}/${cleanTargetId}/latest.json`;
    const data = await this.doDownload(key);
    if (!data) return null;

    try {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      return JSON.parse(text) as B2SnapshotSummary;
    } catch {
      return null;
    }
  }

  /**
   * Reads the data-bundle.json snapshot layout (see savePackage). Returns null
   * when the snapshot predates bundles so callers fall back to exploded paths.
   */
  private async readDataBundle(snapshotPrefix: string): Promise<any | null> {
    const bytes = await this.doDownload(`${snapshotPrefix}/data-bundle.json`);
    if (!bytes) return null;
    try {
      const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
      const bundle = JSON.parse(text);
      return bundle && bundle.version === DATA_BUNDLE_VERSION ? bundle : null;
    } catch {
      return null;
    }
  }

  /**
   * Queries a cached entity from a snapshot.
   * Bundle-first (data-bundle.json), with fallback to the legacy exploded layout:
   * If query.dmo: data/data-cloud/${query.dmo}.json
   * If query.crmEntity: data/crm/${query.crmEntity}.json
   * If query.file: files/${query.file} (returns binary bytes or text)
   * If no entity specified: returns full snapshot manifest.
   */
  async queryCachedEntity(
    orgId: string,
    targetId: string,
    query: { dmo?: string; objectType?: DataCloudFamily; objectName?: string; dataSpace?: string; crmEntity?: string; file?: string; snapshotId?: string }
  ): Promise<any> {
    if (!/^[A-Za-z0-9_-]+$/.test(orgId) || !/^[A-Za-z0-9_-]+$/.test(targetId) ||
      (query.snapshotId && !/^[A-Za-z0-9_-]+$/.test(query.snapshotId))) throw new Error("Invalid B2 snapshot scope");
    if (query.file?.split(/[\\/]/).some(part => part === ".." || part === ".")) throw new Error("Invalid cached file path");
    const cleanTargetId = targetId.trim().replace(/[/\\]/g, "_");
    let snapshotId = query.snapshotId;

    if (!snapshotId) {
      const latest = await this.getLatestSnapshot(orgId, cleanTargetId);
      if (!latest) {
        return null;
      }
      snapshotId = latest.snapshotId;
    }

    if (!snapshotId || !/^[A-Za-z0-9_-]+$/.test(snapshotId)) throw new Error("Invalid B2 snapshot scope");

    const snapshotPrefix = `${this.rootPrefix()}/${orgId}/${cleanTargetId}/snapshots/${snapshotId}`;
    const storedManifestBytes = await this.doDownload(`${snapshotPrefix}/manifest.json`);
    const manifest = storedManifestBytes ? JSON.parse(new TextDecoder().decode(storedManifestBytes)) as ExportManifest : null;
    if (manifest?.storage?.layoutVersion === 2 || manifest?.storage?.layoutVersion === 3) {
      const enveloped = manifest.storage.layoutVersion === 3;
      const readJson = async (path: string) => {
        const bytes = await this.doDownload(`${snapshotPrefix}/${path}`);
        if (!bytes) throw new Error(`B2 snapshot is incomplete: ${path}`);
        return JSON.parse(new TextDecoder().decode(bytes));
      };
      const readFamilyRows = async (family: DataCloudFamily) => {
        const doc = await readJson(`data/${family}.json`);
        return enveloped ? doc.rows : doc;
      };
      if (query.objectType && !DATA_CLOUD_FAMILIES.includes(query.objectType)) throw new Error("Unknown Data 360 object type");
      const objectName = query.objectName ?? query.dmo;
      if (objectName) {
        const name = objectName.replace(/\.json$/, "");
        const matches = Object.keys(manifest.storage.objectFamilies).filter(key =>
          (key === name || key.endsWith(`/${name}`)) &&
          (!query.dataSpace || key === `${query.dataSpace}/${name}` || manifest.storage!.objectDataSpaces?.[key] === query.dataSpace) &&
          (!query.objectType || manifest.storage!.objectFamilies[key] === query.objectType));
        if (!matches.length) return null;
        if (matches.length > 1) throw new Error("Object name is ambiguous; specify its data space-qualified name");
        const key = matches[0];
        const family = manifest.storage.objectFamilies[key];
        return (await readFamilyRows(family))[key] ?? null;
      }
      if (query.objectType) return readFamilyRows(query.objectType);
      if (query.crmEntity) {
        const entity = query.crmEntity.replace(/\.json$/, "");
        const key = Object.entries(CRM_ENTITY_MAP).find(([, name]) => name === entity)?.[0] ?? entity;
        return (await readJson("data/crm.json"))[key] ?? null;
      }
      if (query.file) {
        const index = await readJson("metadata/files.json");
        const matches = index.filter((f: any) => f.path === query.file || f.filename === query.file);
        if (matches.length > 1) throw new Error("File name is ambiguous; specify its full snapshot path");
        if (!matches.length) return null;
        const file = matches[0];
        const bytes = await this.doDownload(`${snapshotPrefix}/${file.path}`);
        if (!bytes) throw new Error("B2 snapshot file is missing");
        const text = new TextDecoder().decode(bytes);
        if (/\.json$/i.test(file.filename) || /application\/json/i.test(file.contentType ?? "")) {
          try { return JSON.parse(text); } catch { return text; }
        }
        if (/\.(txt|csv|md|xml|html|log)$/i.test(file.filename) || /^text\//i.test(file.contentType ?? "")) return text;
        return bytes;
      }
      return manifest;
    }
    const bundle = await this.readDataBundle(snapshotPrefix);

    if (query.objectName) {
      if (query.objectType === "data-graph") return bundle?.records?.dataGraphs?.[query.objectName] ?? null;
      query = { ...query, dmo: query.objectName };
    }

    // 1. Data Cloud DMO query
    if (query.dmo) {
      const dmoName = query.dmo.endsWith(".json") ? query.dmo.slice(0, -5) : query.dmo;
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(dmoName)) throw new Error("Invalid cached object name");
      const bundled = bundle?.records?.dataCloud?.[dmoName];
      if (bundled !== undefined) return bundled;
      const dmoFile = `${dmoName}.json`;
      const key = `${snapshotPrefix}/data/data-cloud/${dmoFile}`;
      const bytes = await this.doDownload(key);
      if (!bytes) return null;
      const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
      return JSON.parse(text);
    }

    // 2. CRM Entity query
    if (query.crmEntity) {
      if (!/^[A-Za-z][A-Za-z0-9_]*(\.json)?$/.test(query.crmEntity)) throw new Error("Invalid cached CRM entity");
      const entityName = query.crmEntity.endsWith(".json")
        ? query.crmEntity.slice(0, -5)
        : query.crmEntity;
      const bundleKey =
        Object.entries(CRM_ENTITY_MAP).find(([, mapped]) => mapped === entityName)?.[0] ||
        entityName;
      const bundled = bundle?.records?.crm?.[bundleKey];
      if (bundled !== undefined) return bundled;
      const mapped = CRM_ENTITY_MAP[query.crmEntity] || query.crmEntity;
      const crmFile = mapped.endsWith(".json") ? mapped : `${mapped}.json`;
      let bytes = await this.doDownload(`${snapshotPrefix}/data/crm/${crmFile}`);

      if (!bytes && query.crmEntity !== mapped) {
        const fallbackFile = query.crmEntity.endsWith(".json")
          ? query.crmEntity
          : `${query.crmEntity}.json`;
        bytes = await this.doDownload(`${snapshotPrefix}/data/crm/${fallbackFile}`);
      }

      if (!bytes) return null;
      const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
      return JSON.parse(text);
    }

    // 3. Unstructured file query
    if (query.file) {
      const cleanFile = query.file.replace(/^files\//, "");
      const bundledFile = (bundle?.files || []).find(
        (f: any) =>
          f?.filename === cleanFile ||
          (cleanFile.includes("/") && f?.filename === cleanFile.split("/").pop())
      );
      let bytes: Uint8Array | string | null = bundledFile?.dataBase64
        ? base64ToBytes(bundledFile.dataBase64)
        : null;
      if (!bytes) {
        let key = `${snapshotPrefix}/files/${cleanFile}`;
        bytes = await this.doDownload(key);

        if (!bytes && cleanFile.includes("/")) {
          const basename = cleanFile.split("/").pop();
          if (basename) {
            key = `${snapshotPrefix}/files/${basename}`;
            bytes = await this.doDownload(key);
          }
        }
      }

      if (!bytes) return null;

      const lower = cleanFile.toLowerCase();
      const isText =
        lower.endsWith(".txt") ||
        lower.endsWith(".csv") ||
        lower.endsWith(".md") ||
        lower.endsWith(".xml") ||
        lower.endsWith(".html") ||
        lower.endsWith(".log");
      const isJson = lower.endsWith(".json");

      if (isJson) {
        try {
          const text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
          return JSON.parse(text);
        } catch {
          return typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
        }
      }

      if (isText) {
        return typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
      }

      return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    }

    // 4. Default: return snapshot manifest
    const manifestKey = `${snapshotPrefix}/manifest.json`;
    const manifestBytes = await this.doDownload(manifestKey);
    if (!manifestBytes) return null;
    const text =
      typeof manifestBytes === "string"
        ? manifestBytes
        : new TextDecoder().decode(manifestBytes);
    return JSON.parse(text);
  }

  /**
   * Downloads the data360-export.zip archive for the specified snapshot or latest snapshot.
   */
  async downloadCachedZip(
    orgId: string,
    targetId: string,
    snapshotId?: string
  ): Promise<Uint8Array | null> {
    if (!/^[A-Za-z0-9_-]+$/.test(orgId) || !/^[A-Za-z0-9_-]+$/.test(targetId)) throw new Error("Invalid B2 snapshot scope");
    const cleanTargetId = targetId.trim().replace(/[/\\]/g, "_");
    let resolvedSnapshotId = snapshotId;

    if (!resolvedSnapshotId) {
      const latest = await this.getLatestSnapshot(orgId, cleanTargetId);
      if (!latest) {
        return null;
      }
      resolvedSnapshotId = latest.snapshotId;
    }

    if (!resolvedSnapshotId || !/^[A-Za-z0-9_-]+$/.test(resolvedSnapshotId)) throw new Error("Invalid B2 snapshot scope");
    const key = `${this.rootPrefix()}/${orgId}/${cleanTargetId}/snapshots/${resolvedSnapshotId}/data360-export.zip`;
    const data = await this.doDownload(key);
    if (!data) return null;

    if (typeof data === "string") {
      return new TextEncoder().encode(data);
    }
    return data;
  }

  /**
   * Lists all snapshot summaries for an orgId and targetId by inspecting Backblaze B2 keys.
   */
  async listSnapshots(orgId: string, targetId: string): Promise<B2SnapshotSummary[]> {
    if (!/^[A-Za-z0-9_-]+$/.test(orgId) || !/^[A-Za-z0-9_-]+$/.test(targetId)) throw new Error("Invalid B2 snapshot scope");
    const cleanTargetId = targetId.trim().replace(/[/\\]/g, "_");
    const prefix = `${this.rootPrefix()}/${orgId}/${cleanTargetId}/snapshots/`;
    const result = await this.doListFiles(prefix);

    const rawFiles: any[] = Array.isArray(result)
      ? result
      : result && Array.isArray(result.files)
        ? result.files
        : [];

    const snapshotMap = new Map<
      string,
      { files: Array<{ fileName: string; contentLength: number }>; totalBytes: number }
    >();

    for (const item of rawFiles) {
      const fileName =
        typeof item === "string" ? item : item?.fileName || item?.name;
      if (!fileName || !fileName.startsWith(prefix)) continue;

      const rest = fileName.slice(prefix.length);
      const snapshotId = rest.split("/")[0];
      if (!snapshotId) continue;

      const size =
        typeof item === "object" ? item.contentLength ?? item.size ?? 0 : 0;

      if (!snapshotMap.has(snapshotId)) {
        snapshotMap.set(snapshotId, { files: [], totalBytes: 0 });
      }
      const entry = snapshotMap.get(snapshotId)!;
      entry.files.push({ fileName, contentLength: size });
      entry.totalBytes += size;
    }

    const summaries: B2SnapshotSummary[] = [];

    for (const [snapshotId, entry] of snapshotMap.entries()) {
      if (!entry.files.some(file => file.fileName === `${prefix}${snapshotId}/manifest.json`)) continue;
      let manifest: ExportManifest | null = null;
      const manifestKey = `${prefix}${snapshotId}/manifest.json`;
      const manifestBytes = await this.doDownload(manifestKey);
      if (manifestBytes) {
        const text = new TextDecoder().decode(manifestBytes);
        manifest = JSON.parse(text);
      }
      if (!manifest) continue;

      const zipFile = entry.files.find((f) => f.fileName.endsWith("data360-export.zip"));
      const zipSizeBytes = zipFile?.contentLength ?? (manifest?.summary ? (manifest as any).zipSizeBytes : undefined);

      summaries.push({
        snapshotId,
        timestamp: manifest?.exportTimestamp || snapshotId,
        orgId,
        targetId: cleanTargetId,
        manifest,
        ...(zipFile ? { zipFileName: "data360-export.zip" } : {}),
        totalBytes: entry.totalBytes || manifest?.b2Cache?.totalBytes || 0,
        fileCount: entry.files.length || manifest?.b2Cache?.fileCount || 0,
        ...(zipSizeBytes !== undefined ? { zipSizeBytes } : {}),
      } as any);
    }

    // Sort descending (newest snapshot first)
    summaries.sort((a, b) => b.snapshotId.localeCompare(a.snapshotId));
    return summaries;
  }

  /**
   * Saves individual user Data 360 data to B2 storage.
   */
  async saveUserData(orgId: string, userId: string, data: any): Promise<string> {
    const cleanUserId = userId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = `${this.rootPrefix()}/${orgId}/users/${cleanUserId}/data360.json`;
    const jsonStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    await this.doUpload(filePath, jsonStr, "application/json");
    return filePath;
  }

  /**
   * Saves individual messaging session Data 360 data to B2 storage.
   */
  async saveSessionData(orgId: string, sessionId: string, data: any): Promise<string> {
    const cleanSessionId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = `${this.rootPrefix()}/${orgId}/sessions/${cleanSessionId}/data360.json`;
    const jsonStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    await this.doUpload(filePath, jsonStr, "application/json");
    return filePath;
  }
}
