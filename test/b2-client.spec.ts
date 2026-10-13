import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { B2Client } from "../src/b2-client";
import type { B2Config } from "../src/types";

describe("B2Client", () => {
  const sampleConfig: B2Config = {
    keyId: "test-key-id",
    applicationKey: "test-app-key",
    bucketId: "test-bucket-id",
    bucketName: "default-bucket",
  };

  const mockAuthData = {
    accountId: "account-123",
    authorizationToken: "auth-token-xyz",
    apiUrl: "https://api001.backblazeb2.com",
    downloadUrl: "https://f001.backblazeb2.com",
    apiInfo: {
      storageApi: {
        bucketName: "storage-bucket",
      },
    },
  };

  const mockUploadUrlData = {
    bucketId: "test-bucket-id",
    uploadUrl: "https://upload001.backblazeb2.com/upload/data",
    authorizationToken: "upload-auth-token-456",
  };

  it("safely invokes fetch without illegal invocation in Cloudflare Workers", async () => {
    const mockCustomFetch = vi.fn().mockResolvedValue(
      Response.json(mockAuthData)
    );

    const client = new B2Client(sampleConfig, mockCustomFetch);
    const auth = await client.authorizeAccount();

    expect(mockCustomFetch).toHaveBeenCalledTimes(1);
    expect(auth.authorizationToken).toBe("auth-token-xyz");
    expect(client.authorizationToken).toBe("auth-token-xyz");
  });

  it("falls back to globalThis.fetch safely when no custom fetch is provided", async () => {
    const originalFetch = globalThis.fetch;
    const globalMock = vi.fn().mockResolvedValue(Response.json(mockAuthData));
    globalThis.fetch = globalMock;

    try {
      const client = new B2Client(sampleConfig);
      const auth = await client.authorizeAccount();

      expect(globalMock).toHaveBeenCalledTimes(1);
      expect(auth.authorizationToken).toBe("auth-token-xyz");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  describe("authorizeAccount", () => {
    it("sends correct Basic Auth credentials to B2 authorize endpoint", async () => {
      let capturedUrl = "";
      let capturedHeaders: Record<string, string> = {};

      const mockFetch = vi.fn(async (input: any, init?: any) => {
        capturedUrl = String(input);
        capturedHeaders = init?.headers || {};
        return Response.json(mockAuthData);
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      const res = await client.authorizeAccount();

      expect(capturedUrl).toBe("https://api.backblazeb2.com/b2api/v3/b2_authorize_account");
      const expectedBasic = Buffer.from("test-key-id:test-app-key").toString("base64");
      expect(capturedHeaders.Authorization).toBe(`Basic ${expectedBasic}`);

      expect(res.authorizationToken).toBe("auth-token-xyz");
      expect(res.apiUrl).toBe("https://api001.backblazeb2.com");
      expect(res.downloadUrl).toBe("https://f001.backblazeb2.com");
      expect(res.accountId).toBe("account-123");
      expect(res.bucketName).toBe("storage-bucket");

      expect(client.authorizationToken).toBe("auth-token-xyz");
      expect(client.apiUrl).toBe("https://api001.backblazeb2.com");
      expect(client.downloadUrl).toBe("https://f001.backblazeb2.com");
      expect(client.accountId).toBe("account-123");
      expect(client.bucketName).toBe("storage-bucket");
    });

    it("caches authorization and does not call fetch multiple times", async () => {
      const mockFetch = vi.fn().mockImplementation(() => Response.json(mockAuthData));
      const client = new B2Client(sampleConfig, mockFetch as any);

      const firstAuth = await client.authorizeAccount();
      const secondAuth = await client.authorizeAccount();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(firstAuth).toEqual(secondAuth);

      // Force authorize re-fetches
      await client.authorizeAccount(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("falls back to config.bucketName when apiInfo.storageApi.bucketName is omitted", async () => {
      const authWithoutApiInfo = {
        accountId: "account-123",
        authorizationToken: "auth-token-xyz",
        apiUrl: "https://api001.backblazeb2.com",
        downloadUrl: "https://f001.backblazeb2.com",
      };

      const mockFetch = vi.fn().mockResolvedValue(Response.json(authWithoutApiInfo));
      const client = new B2Client(sampleConfig, mockFetch as any);

      const res = await client.authorizeAccount();
      expect(res.bucketName).toBe("default-bucket");
      expect(client.bucketName).toBe("default-bucket");
    });

    it("throws descriptive error when authorization fails", async () => {
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: "unauthorized", message: "Invalid key" }), {
          status: 401,
          statusText: "Unauthorized",
        })
      );

      const client = new B2Client(sampleConfig, mockFetch as any);
      await expect(client.authorizeAccount()).rejects.toThrow(
        "B2 authorizeAccount failed (401)"
      );
    });
  });

  describe("getUploadUrl", () => {
    it("requests an upload URL with target bucketId and cached auth token", async () => {
      const calls: Array<{ url: string; body: any; headers: any }> = [];

      const mockFetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, body, headers: init?.headers });

        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_get_upload_url")) {
          return Response.json(mockUploadUrlData);
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      const res = await client.getUploadUrl("custom-bucket-999");

      expect(calls.length).toBe(2);
      expect(calls[0].url).toContain("b2_authorize_account");
      expect(calls[1].url).toBe("https://api001.backblazeb2.com/b2api/v3/b2_get_upload_url");
      expect(calls[1].headers.Authorization).toBe("auth-token-xyz");
      expect(calls[1].body).toEqual({ bucketId: "custom-bucket-999" });

      expect(res.uploadUrl).toBe("https://upload001.backblazeb2.com/upload/data");
      expect(res.authorizationToken).toBe("upload-auth-token-456");
    });

    it("defaults to config.bucketId when bucketId parameter is not provided", async () => {
      const calls: Array<{ url: string; body: any }> = [];

      const mockFetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, body });

        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_get_upload_url")) {
          return Response.json(mockUploadUrlData);
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      await client.getUploadUrl();

      expect(calls[1].body).toEqual({ bucketId: "test-bucket-id" });
    });

    it("throws error when getUploadUrl API returns error status", async () => {
      const mockFetch = vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        return new Response("Service unavailable", { status: 503 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      await expect(client.getUploadUrl()).rejects.toThrow("B2 getUploadUrl failed (503)");
    });
  });

  describe("uploadFile", () => {
    it("computes SHA-1 hash, sets required B2 headers, and posts string data", async () => {
      const testContent = "Hello Backblaze B2 Data360!";
      const expectedSha1 = createHash("sha1").update(testContent).digest("hex");
      const expectedBytes = new TextEncoder().encode(testContent);

      let uploadCallHeaders: Record<string, string> = {};
      let uploadCallBody: any = null;

      const mockFetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_get_upload_url")) {
          return Response.json(mockUploadUrlData);
        }
        if (url === "https://upload001.backblazeb2.com/upload/data") {
          uploadCallHeaders = init?.headers || {};
          uploadCallBody = init?.body;
          return Response.json({
            fileId: "file-id-987",
            fileName: "snapshots/2026/my data.txt",
            contentLength: expectedBytes.length,
            contentSha1: expectedSha1,
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      const res = await client.uploadFile({
        fileName: "snapshots/2026/my data.txt",
        data: testContent,
        contentType: "text/plain",
      });

      expect(uploadCallHeaders.Authorization).toBe("upload-auth-token-456");
      expect(uploadCallHeaders["X-Bz-File-Name"]).toBe("snapshots/2026/my%20data.txt");
      expect(uploadCallHeaders["Content-Type"]).toBe("text/plain");
      expect(uploadCallHeaders["Content-Length"]).toBe(String(expectedBytes.length));
      expect(uploadCallHeaders["X-Bz-Content-Sha1"]).toBe(expectedSha1);
      expect(uploadCallHeaders["X-Bz-Info-Bandwidth-Alliance"]).toBe("true");

      expect(uploadCallBody).toEqual(expectedBytes);
      expect(res.fileId).toBe("file-id-987");
      expect(res.fileName).toBe("snapshots/2026/my data.txt");
      expect(res.contentLength).toBe(expectedBytes.length);
      expect(res.contentSha1).toBe(expectedSha1);
    });

    it("handles Uint8Array binary data and default content-type", async () => {
      const binaryData = new Uint8Array([0x00, 0xff, 0x42, 0x13, 0x37]);
      const expectedSha1 = createHash("sha1").update(binaryData).digest("hex");

      let uploadCallHeaders: Record<string, string> = {};

      const mockFetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_get_upload_url")) {
          return Response.json(mockUploadUrlData);
        }
        if (url.includes("upload/data")) {
          uploadCallHeaders = init?.headers || {};
          return Response.json({
            fileId: "file-bin-111",
            fileName: "archive.zip",
            contentLength: binaryData.length,
            contentSha1: expectedSha1,
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      const res = await client.uploadFile({
        fileName: "archive.zip",
        data: binaryData,
      });

      expect(uploadCallHeaders["Content-Type"]).toBe("application/octet-stream");
      expect(uploadCallHeaders["X-Bz-Content-Sha1"]).toBe(expectedSha1);
      expect(res.fileId).toBe("file-bin-111");
      expect(res.contentLength).toBe(5);
    });

    it("throws error when upload call fails", async () => {
      const mockFetch = vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_get_upload_url")) {
          return Response.json(mockUploadUrlData);
        }
        return new Response("Sha1 mismatch", { status: 400 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      await expect(
        client.uploadFile({
          fileName: "corrupt.dat",
          data: "bad data",
        })
      ).rejects.toThrow("B2 uploadFile failed (400)");
    });
  });

  describe("getDownloadAuthorization", () => {
    it("requests download authorization with duration and prefix", async () => {
      let capturedBody: any = null;

      const mockFetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_get_download_authorization")) {
          capturedBody = JSON.parse(init.body);
          return Response.json({
            bucketId: "test-bucket-id",
            fileNamePrefix: "exports/2026/",
            authorizationToken: "download-auth-token-789",
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      const res = await client.getDownloadAuthorization({
        fileNamePrefix: "exports/2026/",
        validDurationInSeconds: 7200,
      });

      expect(capturedBody).toEqual({
        bucketId: "test-bucket-id",
        fileNamePrefix: "exports/2026/",
        validDurationInSeconds: 7200,
      });
      expect(res.authorizationToken).toBe("download-auth-token-789");
    });

    it("defaults validDurationInSeconds to 3600", async () => {
      let capturedBody: any = null;

      const mockFetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_get_download_authorization")) {
          capturedBody = JSON.parse(init.body);
          return Response.json({
            authorizationToken: "download-auth-token-default",
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      await client.getDownloadAuthorization({
        fileNamePrefix: "manifest.json",
      });

      expect(capturedBody.validDurationInSeconds).toBe(3600);
    });

    it("throws error when getDownloadAuthorization fails", async () => {
      const mockFetch = vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        return new Response("Forbidden", { status: 403 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      await expect(
        client.getDownloadAuthorization({ fileNamePrefix: "forbidden" })
      ).rejects.toThrow("B2 getDownloadAuthorization failed (403)");
    });
  });

  describe("downloadFile", () => {
    it("obtains download auth and fetches file from downloadUrl with clean filename", async () => {
      let downloadFetchUrl = "";

      const sampleBinary = new Uint8Array([1, 2, 3, 4, 5]);

      const mockFetch = vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_get_download_authorization")) {
          return Response.json({
            authorizationToken: "dl-token-abc 123",
          });
        }
        if (url.startsWith("https://f001.backblazeb2.com/file/")) {
          downloadFetchUrl = url;
          return new Response(sampleBinary, {
            status: 200,
            headers: { "Content-Type": "application/zip" },
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      const res = await client.downloadFile({
        bucketName: "my-bucket",
        fileName: "/exports/2026/snapshot file.zip",
      });

      expect(downloadFetchUrl).toBe(
        `https://f001.backblazeb2.com/file/my-bucket/exports/2026/snapshot%20file.zip?Authorization=${encodeURIComponent("dl-token-abc 123")}`
      );

      const buffer = await res.arrayBuffer();
      expect(new Uint8Array(buffer)).toEqual(sampleBinary);
    });

    it("throws error when download returns 404 or other non-200 status", async () => {
      const mockFetch = vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_get_download_authorization")) {
          return Response.json({
            authorizationToken: "dl-token-abc",
          });
        }
        return new Response("File not found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      await expect(
        client.downloadFile({ fileName: "nonexistent.zip" })
      ).rejects.toThrow("B2 downloadFile failed (404)");
    });
  });

  describe("listFileNames", () => {
    it("posts query parameters and returns mapped files list with nextFileName", async () => {
      let listBody: any = null;

      const mockFetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_list_file_names")) {
          listBody = JSON.parse(init.body);
          return Response.json({
            files: [
              {
                fileId: "file-1",
                fileName: "exports/file1.zip",
                contentLength: "1024",
                uploadTimestamp: "1700000000000",
              },
              {
                fileId: "file-2",
                fileName: "exports/file2.zip",
                contentLength: 2048,
                uploadTimestamp: 1700000005000,
              },
            ],
            nextFileName: "exports/file3.zip",
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      const res = await client.listFileNames({
        prefix: "exports/",
        delimiter: "/",
        maxFileCount: 50,
      });

      expect(listBody).toEqual({
        bucketId: "test-bucket-id",
        prefix: "exports/",
        delimiter: "/",
        maxFileCount: 50,
      });

      expect(res.files).toHaveLength(2);
      expect(res.files[0]).toEqual({
        fileId: "file-1",
        fileName: "exports/file1.zip",
        contentLength: 1024,
        uploadTimestamp: 1700000000000,
      });
      expect(res.files[1]).toEqual({
        fileId: "file-2",
        fileName: "exports/file2.zip",
        contentLength: 2048,
        uploadTimestamp: 1700000005000,
      });
      expect(res.nextFileName).toBe("exports/file3.zip");
    });

    it("defaults maxFileCount to 100 and returns null when nextFileName is missing", async () => {
      let listBody: any = null;

      const mockFetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_list_file_names")) {
          listBody = JSON.parse(init.body);
          return Response.json({ files: [] });
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      const res = await client.listFileNames();

      expect(listBody.maxFileCount).toBe(100);
      expect(res.nextFileName).toBeNull();
      expect(res.files).toEqual([]);
    });

    it("throws error when listFileNames fails", async () => {
      const mockFetch = vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        return new Response("Bad request", { status: 400 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      await expect(client.listFileNames()).rejects.toThrow("B2 listFileNames failed (400)");
    });
  });

  describe("deleteFileVersion", () => {
    it("deletes a file version by fileName and fileId", async () => {
      let deleteBody: any = null;
      let deleteHeaders: Record<string, string> = {};

      const mockFetch = vi.fn(async (input: any, init?: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        if (url.includes("b2_delete_file_version")) {
          deleteBody = JSON.parse(init.body);
          deleteHeaders = init?.headers || {};
          return Response.json({
            fileId: "file-to-delete-123",
            fileName: "snapshots/old.zip",
          });
        }
        return new Response("Not found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      const res = await client.deleteFileVersion({
        fileName: "snapshots/old.zip",
        fileId: "file-to-delete-123",
      });

      expect(deleteBody).toEqual({
        fileName: "snapshots/old.zip",
        fileId: "file-to-delete-123",
      });
      expect(deleteHeaders.Authorization).toBe("auth-token-xyz");
      expect(res).toEqual({
        fileId: "file-to-delete-123",
        fileName: "snapshots/old.zip",
      });
    });

    it("throws error if deleteFileVersion fails or params are missing", async () => {
      const mockFetch = vi.fn(async (input: any) => {
        const url = String(input);
        if (url.includes("b2_authorize_account")) {
          return Response.json(mockAuthData);
        }
        return new Response("Not Found", { status: 404 });
      });

      const client = new B2Client(sampleConfig, mockFetch as any);
      await expect(
        client.deleteFileVersion({ fileName: "", fileId: "123" })
      ).rejects.toThrow("fileName and fileId are required");

      await expect(
        client.deleteFileVersion({ fileName: "valid.zip", fileId: "missing-id" })
      ).rejects.toThrow("B2 deleteFileVersion failed (404)");
    });
  });
});
