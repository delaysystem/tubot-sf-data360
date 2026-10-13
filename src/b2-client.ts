import { createHash } from "node:crypto";
import type { B2Config } from "./types";

export interface B2AuthResponse {
  authorizationToken: string;
  apiUrl: string;
  downloadUrl: string;
  accountId: string;
  bucketName?: string;
}

export interface B2UploadUrlResponse {
  uploadUrl: string;
  authorizationToken: string;
}

export interface B2UploadFileParams {
  bucketId?: string;
  fileName: string;
  data: Uint8Array | string;
  contentType?: string;
}

export interface B2UploadFileResponse {
  fileId: string;
  fileName: string;
  contentLength: number;
  contentSha1: string;
}

export interface B2DownloadAuthParams {
  bucketId?: string;
  fileNamePrefix: string;
  validDurationInSeconds?: number;
}

export interface B2DownloadAuthResponse {
  authorizationToken: string;
}

export interface B2DownloadFileParams {
  bucketName?: string;
  fileName: string;
}

export interface B2FileInfo {
  fileId: string;
  fileName: string;
  contentLength: number;
  uploadTimestamp: number;
}

export interface B2ListFilesParams {
  bucketId?: string;
  prefix?: string;
  delimiter?: string;
  maxFileCount?: number;
  startFileName?: string;
}

export interface B2ListFilesResponse {
  files: B2FileInfo[];
  nextFileName: string | null;
}

export interface B2DeleteFileVersionParams {
  fileName: string;
  fileId: string;
}

export interface B2DeleteFileVersionResponse {
  fileId: string;
  fileName: string;
}

export class B2Client {
  public readonly config: B2Config;
  private customFetch?: typeof fetch;

  public authorizationToken: string | null = null;
  public apiUrl: string | null = null;
  public downloadUrl: string | null = null;
  public accountId: string | null = null;
  public bucketName: string | null = null;
  public bucketId: string | null = null;

  constructor(config: B2Config, fetchFn?: typeof fetch) {
    this.config = config;
    this.customFetch = fetchFn;
  }

  private get fetch(): typeof fetch {
    return this.customFetch
      ? ((input, init) => this.customFetch!(input, init))
      : ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Alias for authorizeAccount() for compatibility.
   */
  async authorize(force = false): Promise<B2AuthResponse> {
    return this.authorizeAccount(force);
  }

  /**
   * Authorize B2 account and cache tokens and URLs.
   */
  async authorizeAccount(force = false): Promise<B2AuthResponse> {
    if (
      !force &&
      this.authorizationToken &&
      this.apiUrl &&
      this.downloadUrl &&
      this.accountId
    ) {
      return {
        authorizationToken: this.authorizationToken,
        apiUrl: this.apiUrl,
        downloadUrl: this.downloadUrl,
        accountId: this.accountId,
        bucketName: this.bucketName ?? undefined,
      };
    }

    const authEndpoint =
      this.config.endpoint &&
      !this.config.endpoint.includes("s3.") &&
      (this.config.endpoint.includes("b2_authorize_account") || this.config.endpoint.includes("api."))
        ? (this.config.endpoint.includes("/b2_authorize_account")
            ? (this.config.endpoint.startsWith("http") ? this.config.endpoint : `https://${this.config.endpoint}`)
            : `${(this.config.endpoint.startsWith("http") ? this.config.endpoint : `https://${this.config.endpoint}`).replace(/\/+$/, "")}/b2api/v3/b2_authorize_account`)
        : "https://api.backblazeb2.com/b2api/v3/b2_authorize_account";

    const credentials = Buffer.from(
      `${this.config.keyId}:${this.config.applicationKey}`
    ).toString("base64");

    const res = await this.fetch(authEndpoint, {
      method: "GET",
      headers: {
        Authorization: `Basic ${credentials}`,
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`B2 authorizeAccount failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as any;

    const apiUrl = data.apiInfo?.storageApi?.apiUrl || data.apiUrl;
    const downloadUrl = data.apiInfo?.storageApi?.downloadUrl || data.downloadUrl;
    const accountId = data.accountId;
    const authToken = data.authorizationToken;

    if (!authToken || !apiUrl || !downloadUrl || !accountId) {
      throw new Error("B2 authorizeAccount response missing required credentials");
    }

    this.authorizationToken = authToken;
    this.apiUrl = apiUrl;
    this.downloadUrl = downloadUrl;
    this.accountId = accountId;
    this.bucketName =
      data.apiInfo?.storageApi?.bucketName || this.config.bucketName || (this.config.bucketId && !this.config.bucketId.match(/^[0-9a-f]{24}$/) ? this.config.bucketId : null);
    if (data.apiInfo?.storageApi?.bucketId) {
      this.bucketId = data.apiInfo.storageApi.bucketId;
    }

    return {
      authorizationToken: this.authorizationToken!,
      apiUrl: this.apiUrl!,
      downloadUrl: this.downloadUrl!,
      accountId: this.accountId!,
      bucketName: this.bucketName ?? undefined,
    };
  }

  private async ensureAuthorized(): Promise<void> {
    if (!this.authorizationToken || !this.apiUrl || !this.downloadUrl) {
      await this.authorizeAccount();
    }
  }

  /**
   * Get an upload URL and token for the specified or default bucket.
   */
  async getUploadUrl(bucketId?: string): Promise<B2UploadUrlResponse> {
    await this.ensureAuthorized();

    const targetBucketId =
      bucketId && /^[0-9a-f]{24}$/i.test(bucketId)
        ? bucketId
        : this.bucketId || bucketId || this.config.bucketId;
    if (!targetBucketId) {
      throw new Error("bucketId is required for getUploadUrl");
    }

    const res = await this.fetch(`${this.apiUrl}/b2api/v3/b2_get_upload_url`, {
      method: "POST",
      headers: {
        Authorization: this.authorizationToken!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bucketId: targetBucketId }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`B2 getUploadUrl failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as any;
    return {
      uploadUrl: data.uploadUrl,
      authorizationToken: data.authorizationToken,
    };
  }

  /**
   * Upload a file to B2 using single upload URL flow.
   * Supports both object params and positional params (fileName, data, contentType).
   */
  async uploadFile(
    paramsOrFileName: B2UploadFileParams | string,
    rawFileData?: Uint8Array | string,
    contentType?: string
  ): Promise<B2UploadFileResponse> {
    const params: B2UploadFileParams =
      typeof paramsOrFileName === "string"
        ? {
            fileName: paramsOrFileName,
            data: rawFileData!,
            contentType,
            bucketId: this.bucketId || this.config.bucketId,
          }
        : paramsOrFileName;

    const dataBytes =
      typeof params.data === "string"
        ? new TextEncoder().encode(params.data)
        : params.data;

    const sha1Hex = createHash("sha1").update(dataBytes).digest("hex");
    const { uploadUrl, authorizationToken: uploadAuthToken } =
      await this.getUploadUrl(params.bucketId);

    const cleanFileName = encodeURIComponent(params.fileName).replace(
      /%2F/g,
      "/"
    );
    const resolvedContentType = params.contentType || "application/octet-stream";

    const res = await this.fetch(uploadUrl, {
      method: "POST",
      headers: {
        Authorization: uploadAuthToken,
        "X-Bz-File-Name": cleanFileName,
        "Content-Type": resolvedContentType,
        "Content-Length": String(dataBytes.length),
        "X-Bz-Content-Sha1": sha1Hex,
        "X-Bz-Info-Bandwidth-Alliance": "true",
      },
      body: dataBytes,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`B2 uploadFile failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as any;
    return {
      fileId: data.fileId,
      fileName: data.fileName,
      contentLength: Number(data.contentLength ?? dataBytes.length),
      contentSha1: data.contentSha1 ?? sha1Hex,
    };
  }

  /**
   * Generate a download authorization token for a file prefix.
   */
  async getDownloadAuthorization(
    params: B2DownloadAuthParams
  ): Promise<B2DownloadAuthResponse> {
    await this.ensureAuthorized();

    const targetBucketId = params.bucketId || this.bucketId || this.config.bucketId;
    if (!targetBucketId) {
      throw new Error("bucketId is required for getDownloadAuthorization");
    }

    const res = await this.fetch(
      `${this.apiUrl}/b2api/v3/b2_get_download_authorization`,
      {
        method: "POST",
        headers: {
          Authorization: this.authorizationToken!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          bucketId: targetBucketId,
          fileNamePrefix: params.fileNamePrefix,
          validDurationInSeconds: params.validDurationInSeconds || 3600,
        }),
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(
        `B2 getDownloadAuthorization failed (${res.status}): ${errorText}`
      );
    }

    const data = (await res.json()) as any;
    return {
      authorizationToken: data.authorizationToken,
    };
  }

  /**
   * Download a file from B2 using authorization token.
   */
  async downloadFile(params: B2DownloadFileParams): Promise<Response> {
    await this.ensureAuthorized();

    const targetBucketName =
      params.bucketName || this.bucketName || this.config.bucketName || (this.config.bucketId && !this.config.bucketId.match(/^[0-9a-f]{24}$/) ? this.config.bucketId : undefined);
    if (!targetBucketName) {
      throw new Error("bucketName is required for downloadFile");
    }

    const { authorizationToken: token } =
      await this.getDownloadAuthorization({
        bucketId: this.bucketId || this.config.bucketId,
        fileNamePrefix: params.fileName,
      });

    const cleanFileName = encodeURIComponent(
      params.fileName.replace(/^\/+/, "")
    ).replace(/%2F/g, "/");

    const downloadUrl = `${this.downloadUrl}/file/${targetBucketName}/${cleanFileName}?Authorization=${encodeURIComponent(token)}`;

    const res = await this.fetch(downloadUrl, {
      method: "GET",
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`B2 downloadFile failed (${res.status}): ${errorText}`);
    }

    return res;
  }

  /**
   * List files in a bucket with optional prefix, delimiter, and pagination.
   */
  async listFileNames(
    params?: B2ListFilesParams
  ): Promise<B2ListFilesResponse> {
    await this.ensureAuthorized();

    const targetBucketId = params?.bucketId || this.bucketId || this.config.bucketId;
    if (!targetBucketId) {
      throw new Error("bucketId is required for listFileNames");
    }

    const requestBody: Record<string, any> = {
      bucketId: targetBucketId,
      maxFileCount: params?.maxFileCount || 100,
    };
    if (params?.prefix !== undefined) requestBody.prefix = params.prefix;
    if (params?.delimiter !== undefined) requestBody.delimiter = params.delimiter;
    if (params?.startFileName !== undefined) {
      requestBody.startFileName = params.startFileName;
    }

    const res = await this.fetch(`${this.apiUrl}/b2api/v3/b2_list_file_names`, {
      method: "POST",
      headers: {
        Authorization: this.authorizationToken!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`B2 listFileNames failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as any;
    const files: B2FileInfo[] = (data.files || []).map((file: any) => ({
      fileId: file.fileId,
      fileName: file.fileName,
      contentLength: Number(file.contentLength ?? 0),
      uploadTimestamp: Number(file.uploadTimestamp ?? 0),
    }));

    return {
      files,
      nextFileName: data.nextFileName ?? null,
    };
  }

  /**
   * Delete a specific version of a file.
   */
  async deleteFileVersion(
    params: B2DeleteFileVersionParams
  ): Promise<B2DeleteFileVersionResponse> {
    if (!params?.fileName || !params?.fileId) {
      throw new Error("fileName and fileId are required for deleteFileVersion");
    }

    await this.ensureAuthorized();

    const res = await this.fetch(
      `${this.apiUrl}/b2api/v3/b2_delete_file_version`,
      {
        method: "POST",
        headers: {
          Authorization: this.authorizationToken!,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fileName: params.fileName,
          fileId: params.fileId,
        }),
      }
    );

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`B2 deleteFileVersion failed (${res.status}): ${errorText}`);
    }

    const data = (await res.json()) as any;
    return {
      fileId: data.fileId,
      fileName: data.fileName,
    };
  }
}
