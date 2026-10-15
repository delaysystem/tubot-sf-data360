import type {
  Context,
  ContextMessage,
  ContextResult,
  Data360Env,
  ExportData360Options,
  ExtractedData360Package,
  GetContextOptions,
  UserData360Result,
  MessagingSessionData360Result,
  CorrespondingDataOptions,
  CorrespondingDataResult,
  DataCloudFamily,
} from "./types";
import { DATA_CLOUD_FAMILIES } from "./types";
import { SalesforceAuthBridge, SalesforceAuthorizationError } from "./auth-client";
import { Data360Extractor } from "./data360-extractor";
import { B2CacheManager } from "./b2-cache-manager";
import { claimServiceNonce, readSigHeaders, verifyServiceSignature } from "./service-verify";
import {
  D1Data360Cache,
  purgeEdgeCache,
  buildDeclarativeCacheHeaders,
  computeETag,
  isNotModified,
  normalizeCanonicalUrl,
  sanitizeHeaders,
} from "./cache-helper";

export * from "./types";
export * from "./auth-client";
export * from "./batch-client";
export * from "./agent-analyzer";
export * from "./zip-builder";
export * from "./unstructured-extractor";
export * from "./b2-client";
export { B2CacheManager, type B2FileEntry, type B2ClientInterface } from "./b2-cache-manager";
export * from "./data360-extractor";
export * from "./cache-helper";

let BaseWorkerEntrypoint: abstract new (ctx: any, env: any) => any = class {
  constructor(public ctx: any, public env: any) {}
};
try {
  // @ts-ignore
  const cf = await import("cloudflare:workers");
  if (cf?.WorkerEntrypoint) {
    BaseWorkerEntrypoint = cf.WorkerEntrypoint;
  }
} catch {
  // Fallback for non-workerd runtimes
}

export class TubotSfData360Entrypoint extends BaseWorkerEntrypoint {
  /**
   * RPC method: returns the exported Data 360 zip as Uint8Array bytes.
   */
  async exportData360Zip(options: ExportData360Options): Promise<Uint8Array> {
    const authBridge = new SalesforceAuthBridge(this.env);
    const authResult = await authBridge.resolveToken(options);
    const b2CacheManager = createB2CacheManager(this.env);
    const extractor = new Data360Extractor(undefined, undefined, undefined, b2CacheManager);
    const pkg = await extractor.extractData360(authResult.connection, {
      ...options,
      format: "zip",
    });
    if (!pkg.zipBytes) {
      throw new Error("Failed to generate zip payload.");
    }
    return pkg.zipBytes;
  }

  /**
   * RPC method: returns the uncompressed ExtractedData360Package object.
   */
  async extractData360(options: ExportData360Options): Promise<ExtractedData360Package> {
    const authBridge = new SalesforceAuthBridge(this.env);
    const authResult = await authBridge.resolveToken(options);
    const b2CacheManager = createB2CacheManager(this.env);
    const extractor = new Data360Extractor(undefined, undefined, undefined, b2CacheManager);
    return extractor.extractData360(authResult.connection, options);
  }

  /**
   * RPC method: returns the latest cached snapshot summary from B2.
   */
  async getLatestCache(options: ExportData360Options): Promise<any> {
    const b2CacheManager = createB2CacheManager(this.env);
    const targetId = options.channelId || options.agentName || "data360";
    const orgId = (await new SalesforceAuthBridge(this.env).resolveToken(options)).connection.orgId!;
    return b2CacheManager.getLatestSnapshot(orgId, targetId);
  }

  /**
   * RPC method: queries cached DMOs, CRM entities, or files from B2.
   */
  async queryCache(options: ExportData360Options & {
    orgId?: string;
    channelId?: string;
    agentName?: string;
    dmo?: string;
    objectType?: DataCloudFamily;
    objectName?: string;
    dataSpace?: string;
    crmEntity?: string;
    file?: string;
    snapshotId?: string;
  }): Promise<any> {
    const b2CacheManager = createB2CacheManager(this.env);
    const targetId = options.channelId || options.agentName || "data360";
    const orgId = (await new SalesforceAuthBridge(this.env).resolveToken(options)).connection.orgId!;
    return b2CacheManager.queryCachedEntity(orgId, targetId, options);
  }

  /**
   * RPC method: streams cached ZIP file bytes directly from B2.
   */
  async downloadCachedZip(options: ExportData360Options & {
    orgId?: string;
    channelId?: string;
    agentName?: string;
    snapshotId?: string;
  }): Promise<Uint8Array | null> {
    const b2CacheManager = createB2CacheManager(this.env);
    const targetId = options.channelId || options.agentName || "data360";
    const orgId = (await new SalesforceAuthBridge(this.env).resolveToken(options)).connection.orgId!;
    return b2CacheManager.downloadCachedZip(orgId, targetId, options.snapshotId);
  }

  /**
   * RPC method: lists snapshot summaries for a given target from B2.
   */
  async listSnapshots(options: ExportData360Options): Promise<any[]> {
    const b2CacheManager = createB2CacheManager(this.env);
    const targetId = options.channelId || options.agentName || "data360";
    const orgId = (await new SalesforceAuthBridge(this.env).resolveToken(options)).connection.orgId!;
    return b2CacheManager.listSnapshots(orgId, targetId);
  }

  /**
   * RPC method: retrieves user Data 360 profile (D1 cache -> Salesforce extraction -> store in D1).
   */
  async getUserData360(
    userId: string,
    options?: ExportData360Options & { bypassCache?: boolean }
  ): Promise<UserData360Result> {
    const d1Cache = new D1Data360Cache(this.env?.DB);
    if (!options?.bypassCache) {
      const cached = await d1Cache.getUser(userId);
      if (cached) return cached;
    }

    const authBridge = new SalesforceAuthBridge(this.env);
    const authResult = await authBridge.resolveToken(options || {});
    const b2CacheManager = createB2CacheManager(this.env);
    const extractor = new Data360Extractor(undefined, undefined, undefined, b2CacheManager);
    const userData = await extractor.extractUserData360(authResult.connection, userId, options);

    const computedEtag = await computeETag(userData);
    await d1Cache.putUser(userId, userData, {
      orgId: options?.orgId || authResult.connection.orgId,
      ttlSeconds: options?.cacheTtlSeconds,
      etag: computedEtag,
    });

    return userData;
  }

  /**
   * RPC method: saves user Data 360 data to D1 and B2, and purges edge cache tag.
   */
  async saveUserData360(
    userId: string,
    data: any,
    options?: { orgId?: string; ttlSeconds?: number }
  ): Promise<{ ok: boolean; userId: string; purgedTag: string }> {
    const orgId = options?.orgId || `user-${userId}`;
    const d1Cache = new D1Data360Cache(this.env?.DB);
    const etag = await computeETag(data);
    await d1Cache.putUser(userId, data, { orgId, ttlSeconds: options?.ttlSeconds, etag });

    const b2Cache = createB2CacheManager(this.env);
    try {
      await b2Cache.saveUserData(orgId, userId, data);
    } catch (err: unknown) {
      console.warn("B2 saveUserData warning in RPC:", err);
    }

    const tag = `data360-user-${userId}`;
    await purgeEdgeCache(this.ctx, [tag]);

    return { ok: true, userId, purgedTag: tag };
  }

  /**
   * RPC method: retrieves messaging session Data 360 (D1 cache -> Salesforce extraction -> store in D1).
   */
  async getMessagingSessionData360(
    sessionId: string,
    options?: ExportData360Options & { bypassCache?: boolean }
  ): Promise<MessagingSessionData360Result> {
    const d1Cache = new D1Data360Cache(this.env?.DB);
    if (!options?.bypassCache) {
      const cached = await d1Cache.getSession(sessionId);
      if (cached) return cached;
    }

    const authBridge = new SalesforceAuthBridge(this.env);
    const authResult = await authBridge.resolveToken(options || {});
    const b2CacheManager = createB2CacheManager(this.env);
    const extractor = new Data360Extractor(undefined, undefined, undefined, b2CacheManager);
    const sessionData = await extractor.extractMessagingSessionData360(authResult.connection, sessionId, options);

    const computedEtag = await computeETag(sessionData);
    await d1Cache.putSession(sessionId, sessionData, {
      orgId: options?.orgId || authResult.connection.orgId,
      ttlSeconds: options?.cacheTtlSeconds,
      etag: computedEtag,
    });

    return sessionData;
  }

  /**
   * RPC method: saves messaging session Data 360 data to D1 and B2, and purges edge cache tag.
   */
  async saveMessagingSessionData360(
    sessionId: string,
    data: any,
    options?: { orgId?: string; ttlSeconds?: number }
  ): Promise<{ ok: boolean; sessionId: string; purgedTag: string }> {
    const orgId = options?.orgId || `session-${sessionId}`;
    const d1Cache = new D1Data360Cache(this.env?.DB);
    const etag = await computeETag(data);
    await d1Cache.putSession(sessionId, data, { orgId, ttlSeconds: options?.ttlSeconds, etag });

    const b2Cache = createB2CacheManager(this.env);
    try {
      await b2Cache.saveSessionData(orgId, sessionId, data);
    } catch (err: unknown) {
      console.warn("B2 saveSessionData warning in RPC:", err);
    }

    const tag = `data360-session-${sessionId}`;
    await purgeEdgeCache(this.ctx, [tag]);

    return { ok: true, sessionId, purgedTag: tag };
  }

  /**
   * RPC method: purges Declarative Workers Cache / edge cache by tags.
   */
  async purgeCache(tags: string | string[]): Promise<{ ok: boolean; tags: string[] }> {
    const tagList = Array.isArray(tags) ? tags : [tags];
    const ok = await purgeEdgeCache(this.ctx, tagList);
    return { ok: ok !== false, tags: tagList };
  }

  /**
   * RPC method: retrieves stored ETag for a user for fast 0-stale conditional validation.
   */
  async getUserETag(userId: string): Promise<string | null> {
    const d1Cache = new D1Data360Cache(this.env?.DB);
    return d1Cache.getUserETag(userId);
  }

  /**
   * RPC method: retrieves stored ETag for a session for fast 0-stale conditional validation.
   */
  async getSessionETag(sessionId: string): Promise<string | null> {
    const d1Cache = new D1Data360Cache(this.env?.DB);
    return d1Cache.getSessionETag(sessionId);
  }

  /**
   * RPC method: retrieves stored ETag for a user's conversation history for fast 0-stale conditional validation.
   */
  async getConversationETag(userId: string): Promise<string | null> {
    const d1Cache = new D1Data360Cache(this.env?.DB);
    return d1Cache.getConversationETag(userId);
  }

  /**
   * RPC method: retrieves stored ETag for global Data 360 for fast 0-stale conditional validation.
   */
  async getGlobalETag(targetId: string): Promise<string | null> {
    const d1Cache = new D1Data360Cache(this.env?.DB);
    return d1Cache.getGlobalETag(targetId);
  }

  /**
   * RPC method: returns composite corresponding data (global, individual, conversation history)
   * with independent smart component caching to maximize cache hits.
   */
  async getCorrespondingData(
    options: CorrespondingDataOptions & ExportData360Options
  ): Promise<CorrespondingDataResult> {
    const { userId, channelId, sessionId, bypassCache } = options;
    const d1Cache = new D1Data360Cache(this.env?.DB);
    const authBridge = new SalesforceAuthBridge(this.env);

    let authResult: any = null;
    const getAuth = async () => {
      if (!authResult) {
        authResult = await authBridge.resolveToken({
          ...options,
          channelId: channelId || options.agentName,
        });
      }
      return authResult;
    };

    // 1. Global Data360 Component
    const targetGlobalId = channelId || options.agentName || "default-channel";
    let globalData: any = null;
    let globalEtag: string = "";
    let isGlobalCached = false;
    let globalSource: "d1" | "b2" | "salesforce" = "salesforce";

    if (!bypassCache) {
      globalData = await d1Cache.getGlobalData360(targetGlobalId);
      if (globalData) {
        isGlobalCached = true;
        globalSource = "d1";
        globalEtag = (await d1Cache.getGlobalETag(targetGlobalId)) || (await computeETag(globalData));
      }
    }

    if (!globalData) {
      const b2CacheManager = createB2CacheManager(this.env);
      const b2Snapshot = options.orgId
        ? await b2CacheManager.getLatestSnapshot(options.orgId, targetGlobalId).catch(() => null)
        : null;
      if (b2Snapshot && !bypassCache) {
        globalData = b2Snapshot;
        globalSource = "b2";
      } else {
        try {
          const auth = await getAuth();
          const extractor = new Data360Extractor(undefined, undefined, undefined, b2CacheManager);
          globalData = await extractor.extractData360(auth.connection, {
            ...options,
            channelId: targetGlobalId,
          });
          globalSource = "salesforce";
        } catch {
          globalData = { channelId: targetGlobalId, status: "unavailable" };
        }
      }
      globalEtag = await computeETag(globalData);
      await d1Cache.putGlobalData360(targetGlobalId, globalData, {
        orgId: options.orgId || authResult?.connection?.orgId,
        etag: globalEtag,
      });
    }

    // 2. Individual Data360 Component
    let userData: any = null;
    let userEtag: string = "";
    let isUserCached = false;
    let userSource: "d1" | "salesforce" = "salesforce";

    if (!bypassCache) {
      userData = await d1Cache.getUser(userId);
      if (userData) {
        isUserCached = true;
        userSource = "d1";
        userEtag = (await d1Cache.getUserETag(userId)) || (await computeETag(userData));
      }
    }

    if (!userData) {
      try {
        const auth = await getAuth();
        const b2CacheManager = createB2CacheManager(this.env);
        const extractor = new Data360Extractor(undefined, undefined, undefined, b2CacheManager);
        userData = await extractor.extractUserData360(auth.connection, userId, options);
        userSource = "salesforce";
      } catch {
        userData = { userId, extractedAt: new Date().toISOString() };
      }
      userEtag = await computeETag(userData);
      await d1Cache.putUser(userId, userData, {
        orgId: options.orgId || authResult?.connection?.orgId,
        etag: userEtag,
      });
    }

    // 3. Conversation History Component
    let convData: any = null;
    let convEtag: string = "";
    let isConvCached = false;
    let convSource: "d1" | "auth_service" | "salesforce" = "auth_service";

    if (!bypassCache) {
      convData = await d1Cache.getConversationHistory(userId);
      if (convData) {
        isConvCached = true;
        convSource = "d1";
        convEtag = (await d1Cache.getConversationETag(userId)) || (await computeETag(convData));
      }
    }

    if (!convData) {
      try {
        convData = await authBridge.getUserConversationHistory(userId, {
          channelId,
          currentSessionId: sessionId,
          teamId: options.teamId,
          orgId: options.orgId,
        });
        if (convData) {
          convSource = "auth_service";
        }
      } catch {
        convData = null;
      }
      if (!convData) {
        convData = {
          userId,
          sessions: [],
          totalSessions: 0,
          totalMessages: 0,
          extractedAt: new Date().toISOString(),
        };
      }
      convEtag = await computeETag(convData);
      await d1Cache.putConversationHistory(userId, convData, {
        orgId: options.orgId || authResult?.connection?.orgId,
        etag: convEtag,
      });
    }

    // 4. Compute composite ETag across the 3 independent components
    const compositeETag = await computeETag(`${globalEtag}:${userEtag}:${convEtag}`);

    return {
      ok: true,
      userId,
      channelId: channelId ?? "",
      sessionId,
      compositeETag,
      cacheBreakdown: {
        globalData360: { cached: isGlobalCached, etag: globalEtag, source: globalSource },
        individualData360: { cached: isUserCached, etag: userEtag, source: userSource },
        conversationHistory: {
          cached: isConvCached,
          etag: convEtag,
          source: convSource,
          sessionCount: Array.isArray(convData?.sessions) ? convData.sessions.length : 0,
          totalMessages: convData?.totalMessages ?? 0,
        },
      },
      globalData360: globalData,
      individualData360: userData,
      conversationHistory: convData,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * RPC method: returns the pure Context required by tubot-agentcode:
   * precompiledAgent, customerData, conversationHistory, globalData, toolCallUrls.
   */
  async getContext(options: GetContextOptions): Promise<Context> {
    const res = await assembleContext(this.env, this.ctx, options);
    return res.context;
  }

  /**
   * RPC method: returns Context with caching breakdown and composite ETag.
   */
  async getContextWithMeta(options: GetContextOptions): Promise<ContextResult> {
    return assembleContext(this.env, this.ctx, options);
  }

  /**
   * RPC method: retrieves precompiled agent code (smartly cached).
   */
  async getAgentCode(agentKey: string): Promise<any> {
    const d1Cache = new D1Data360Cache(this.env?.DB);
    return d1Cache.getAgentCode(agentKey);
  }

  /**
   * RPC method: retrieves callable tool proxy URLs (smartly cached).
   */
  async getToolUrls(channelId: string): Promise<string[]> {
    const d1Cache = new D1Data360Cache(this.env?.DB);
    const urls = await d1Cache.getToolUrls(channelId);
    return urls || [];
  }
}

export function createB2CacheManager(env: Data360Env): B2CacheManager {
  return new B2CacheManager(undefined, {
    keyId: env.BACKBLAZE_KEY_ID || "",
    applicationKey: env.BACKBLAZE_APPLICATION_KEY || "",
    bucketId: env.BACKBLAZE_BUCKET_ID || "",
    bucketName: env.BACKBLAZE_BUCKET_NAME || "",
    endpoint: env.BACKBLAZE_ENDPOINT || "",
    pathPrefix: env.DATA360_PATH_PREFIX || "data360",
  });
}

/**
 * Assembles the full Context required for tubot-agentcode to run:
 * 1. Precompiled Agent Code (CEL AST & Rules from tubot-sf-parser)
 * 2. Customer 360 Data (Profile, verification, state)
 * 3. Customer Multi-Turn Conversation History
 * 4. Global Tenant / Org Data (Data Cloud schema, channel config)
 * 5. Callable Tool Proxy URLs (from retrieve64 / tubot-sf-auth)
 *
 * Each component is independently and smartly cached in D1 / memory.
 */
export async function assembleContext(
  env: Data360Env,
  ctx: any,
  options: GetContextOptions
): Promise<ContextResult> {
  const userId = options.userId;
  if (!userId) {
    throw new Error("Missing required 'userId' in GetContextOptions.");
  }
  const channelId = (options.channelId || options.agentName || "default-channel").trim();
  const agentKey = channelId;
  const d1Cache = new D1Data360Cache(env?.DB);
  const authBridge = new SalesforceAuthBridge(env);
  const b2CacheManager = createB2CacheManager(env);

  let authResult: any = null;
  const getAuth = async () => {
    if (!authResult) {
      authResult = await authBridge.resolveToken({
        ...options,
        channelId,
      });
    }
    return authResult;
  };

  // Zero Trust: When explicit token credentials are provided, validate authorization before reading cache
  if (options.accessToken && options.instanceUrl) {
    await getAuth();
  }

  const writeD1 = async (writePromise: Promise<any>) => {
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(writePromise.catch((err: any) => console.warn("Background cache write error:", err)));
    } else {
      await writePromise;
    }
  };

  // 1. Customer / Individual Data Loader
  const loadCustomerData = async () => {
    let customerData: any = null;
    let userEtag = "";
    let isUserCached = false;
    let userSource: "d1" | "salesforce" = "salesforce";

    if (!options.bypassCache && !options.bypassUserCache) {
      customerData = await d1Cache.getUser(userId);
      if (customerData) {
        isUserCached = true;
        userSource = "d1";
        userEtag = (await d1Cache.getUserETag(userId)) || (await computeETag(customerData));
      }
    }

    if (!customerData) {
      try {
        const auth = await getAuth();
        const extractor = new Data360Extractor(undefined, undefined, undefined, b2CacheManager);
        customerData = await extractor.extractUserData360(auth.connection, userId, options);
        userSource = "salesforce";
      } catch {
        customerData = { userId, extractedAt: new Date().toISOString() };
      }
      userEtag = await computeETag(customerData);
      await writeD1(
        d1Cache.putUser(userId, customerData, {
          orgId: options.orgId || authResult?.connection?.orgId,
          etag: userEtag,
        })
      );
    }
    return { customerData, userEtag, isUserCached, userSource };
  };

  // 2. Customer Conversation History Loader
  const loadConversationHistory = async () => {
    let convData: any = null;
    let convEtag = "";
    let isConvCached = false;
    let convSource: "d1" | "auth_service" | "salesforce" = "auth_service";

    if (!options.bypassCache && !options.bypassConversationCache) {
      convData = await d1Cache.getConversationHistory(userId);
      if (convData) {
        isConvCached = true;
        convSource = "d1";
        convEtag = (await d1Cache.getConversationETag(userId)) || (await computeETag(convData));
      }
    }

    if (!convData) {
      try {
        convData = await authBridge.getUserConversationHistory(userId, {
          channelId,
          currentSessionId: options.sessionId,
          limit: options.conversationLimit,
          teamId: options.teamId,
          orgId: options.orgId,
        });
        if (convData) {
          convSource = "auth_service";
        }
      } catch {
        convData = null;
      }
      if (!convData) {
        convData = {
          userId,
          sessions: [],
          totalSessions: 0,
          totalMessages: 0,
          extractedAt: new Date().toISOString(),
        };
      }
      convEtag = await computeETag(convData);
      await writeD1(
        d1Cache.putConversationHistory(userId, convData, {
          orgId: options.orgId || authResult?.connection?.orgId,
          etag: convEtag,
        })
      );
    }

    // Normalize conversation history into ContextMessage[]
    const conversationMessages: ContextMessage[] = [];
    if (Array.isArray(convData?.sessions)) {
      for (const session of convData.sessions) {
        for (const msg of session.messages || []) {
          const role: "user" | "assistant" | "system" =
            msg.senderType === "user"
              ? "user"
              : msg.senderType === "system"
              ? "system"
              : "assistant";
          conversationMessages.push({ role, content: msg.message });
        }
      }
    }
    if (conversationMessages.length === 0 && options.sessionId) {
      conversationMessages.push({
        role: "user",
        content: `Customer initiated session ${options.sessionId}`,
      });
    }

    return { convData, convEtag, isConvCached, convSource, conversationMessages };
  };

  // 3. Global Data360 Component Loader
  const loadGlobalData = async () => {
    let globalData: any = null;
    let globalEtag = "";
    let isGlobalCached = false;
    let globalSource: "d1" | "b2" | "salesforce" = "salesforce";

    if (!options.bypassCache && !options.bypassGlobalCache) {
      globalData = await d1Cache.getGlobalData360(channelId);
      if (globalData) {
        isGlobalCached = true;
        globalSource = "d1";
        globalEtag = (await d1Cache.getGlobalETag(channelId)) || (await computeETag(globalData));
      }
    }

    if (!globalData) {
      const b2Snapshot = options.orgId
        ? await b2CacheManager.getLatestSnapshot(options.orgId, channelId).catch(() => null)
        : null;
      if (b2Snapshot && !options.bypassCache) {
        globalData = b2Snapshot;
        globalSource = "b2";
      } else {
        try {
          const auth = await getAuth();
          const extractor = new Data360Extractor(undefined, undefined, undefined, b2CacheManager);
          globalData = await extractor.extractData360(auth.connection, {
            ...options,
            channelId,
          });
          globalSource = "salesforce";
        } catch {
          globalData = { channelId, status: "unavailable" };
        }
      }
      globalEtag = await computeETag(globalData);
      await writeD1(
        d1Cache.putGlobalData360(channelId, globalData, {
          orgId: options.orgId || authResult?.connection?.orgId,
          etag: globalEtag,
        })
      );
    }
    return { globalData, globalEtag, isGlobalCached, globalSource };
  };

  // 4. Callable Tool URLs Loader
  const loadToolUrls = async (getGlobalData: () => any) => {
    let toolCallUrls: string[] = [];
    let toolUrlsEtag = "";
    let isToolUrlsCached = false;
    let toolUrlsSource: "d1" | "auth_service" | "retrieve64" = "auth_service";

    if (!options.bypassCache && !options.bypassToolUrlsCache) {
      const cachedUrls = await d1Cache.getToolUrls(channelId);
      if (cachedUrls) {
        toolCallUrls = cachedUrls;
        isToolUrlsCached = true;
        toolUrlsSource = "d1";
        toolUrlsEtag = (await d1Cache.getToolUrlsETag(channelId)) || (await computeETag(toolCallUrls));
      }
    }

    if (!isToolUrlsCached) {
      const gData = getGlobalData();
      try {
        toolCallUrls = await authBridge.getCallableToolUrls(channelId, {
          orgId: options.orgId,
          teamId: options.teamId,
        });
        if (toolCallUrls.length > 0) {
          toolUrlsSource = "retrieve64";
        }
      } catch {
        toolCallUrls = [];
      }

      if (toolCallUrls.length === 0 && Array.isArray(gData?.agentArtifacts?.callableTools)) {
        toolCallUrls = gData.agentArtifacts.callableTools
          .map((t: any) => t.url || t.route)
          .filter(Boolean);
      }

      toolUrlsEtag = await computeETag(toolCallUrls);
      await writeD1(
        d1Cache.putToolUrls(channelId, toolCallUrls, {
          orgId: options.orgId || authResult?.connection?.orgId,
          etag: toolUrlsEtag,
        })
      );
    }
    return { toolCallUrls, toolUrlsEtag, isToolUrlsCached, toolUrlsSource };
  };

  // 5. Precompiled Agent Code Loader
  const loadPrecompiledAgent = async (getGlobalData: () => any) => {
    let precompiledAgent: any = null;
    let agentEtag = "";
    let isAgentCached = false;
    let agentSource: "d1" | "parser" | "provided" = "parser";

    if (!options.bypassCache && !options.bypassAgentCache) {
      precompiledAgent = await d1Cache.getAgentCode(agentKey);
      if (precompiledAgent && Array.isArray(precompiledAgent.topics) && precompiledAgent.topics.length > 0) {
        isAgentCached = true;
        agentSource = "d1";
        agentEtag = (await d1Cache.getAgentCodeETag(agentKey)) || (await computeETag(precompiledAgent));
      } else {
        precompiledAgent = null;
      }
    }

    if (!precompiledAgent) {
      const gData = getGlobalData();
      const scriptOrXml =
        options.agentScript ||
        options.agentXml ||
        gData?.agentArtifacts?.script ||
        gData?.agentArtifacts?.bundleMetaXml ||
        gData?.agentArtifacts?.botXml ||
        `system_prompt: "You are an autonomous Agentforce assistant for ${channelId}."\ntopic agent_router {\n  description: "Root router topic"\n}\n`;

      // 1) Workers RPC on TUBOT_SF_PARSER
      if (env.TUBOT_SF_PARSER && typeof env.TUBOT_SF_PARSER.translateToCel === "function") {
        try {
          precompiledAgent = await env.TUBOT_SF_PARSER.translateToCel(scriptOrXml, {
            validateWithAgentCode: false,
          });
          agentSource = "parser";
        } catch {
          // Fall through
        }
      }

      // 2) Service Binding Fetch
      if (!precompiledAgent && env.TUBOT_SF_PARSER && typeof env.TUBOT_SF_PARSER.fetch === "function") {
        try {
          const parseResp = await env.TUBOT_SF_PARSER.fetch("https://tubot-sf-parser.internal/api/v1/parse", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: scriptOrXml }),
          });
          if (parseResp.ok) {
            precompiledAgent = await parseResp.json();
            agentSource = "parser";
          }
        } catch {
          // Fall through
        }
      }

      // 3) HTTP Fetch to parser URL
      if (!precompiledAgent) {
        const parserUrl =
          env.PARSER_SERVICE_URL || "https://tubot-sf-parser.emalteaproductions.workers.dev/api/v1/parse";
        try {
          const parseResp = await fetch(parserUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: scriptOrXml }),
          });
          if (parseResp.ok) {
            precompiledAgent = await parseResp.json();
            agentSource = "parser";
          }
        } catch {
          // Fall through
        }
      }

      // 4) Fallback template if parser service is unavailable
      if (!precompiledAgent) {
        precompiledAgent = {
          agentName: channelId,
          format: "agent_script",
          description: `Autonomous assistant for ${channelId}`,
          variables: {},
          topics: [
            {
              name: "agent_router",
              description: "Default root router",
              actions: [],
              transitionGates: [],
            },
          ],
        };
        agentSource = "provided";
      }

      agentEtag = await computeETag(precompiledAgent);
      await writeD1(
        d1Cache.putAgentCode(agentKey, precompiledAgent, {
          orgId: options.orgId || authResult?.connection?.orgId,
          etag: agentEtag,
        })
      );
    }
    return { precompiledAgent, agentEtag, isAgentCached, agentSource };
  };

  // Run all 5 component extractions in parallel
  let globalDataResult: any = null;
  const getGData = () => globalDataResult?.globalData;

  const [customerResult, convResult, globalRes, precompiledResult, toolUrlsResult] =
    await Promise.all([
      loadCustomerData(),
      loadConversationHistory(),
      loadGlobalData().then((res) => {
        globalDataResult = res;
        return res;
      }),
      loadPrecompiledAgent(getGData),
      loadToolUrls(getGData),
    ]);

  // Compute composite ETag across all 5 components
  const compositeETag = await computeETag(
    `${precompiledResult.agentEtag}:${customerResult.userEtag}:${convResult.convEtag}:${globalRes.globalEtag}:${toolUrlsResult.toolUrlsEtag}`
  );

  const context: Context = {
    precompiledAgent: precompiledResult.precompiledAgent,
    customerData: customerResult.customerData?.data || customerResult.customerData || {},
    conversationHistory: convResult.conversationMessages,
    globalData: globalRes.globalData || {},
    toolCallUrls: toolUrlsResult.toolCallUrls,
  };

  return {
    ok: true,
    context,
    compositeETag,
    cacheBreakdown: {
      precompiledAgent: {
        cached: precompiledResult.isAgentCached,
        etag: precompiledResult.agentEtag,
        source: precompiledResult.agentSource,
      },
      customerData: {
        cached: customerResult.isUserCached,
        etag: customerResult.userEtag,
        source: customerResult.userSource,
      },
      conversationHistory: {
        cached: convResult.isConvCached,
        etag: convResult.convEtag,
        source: convResult.convSource,
      },
      globalData: {
        cached: globalRes.isGlobalCached,
        etag: globalRes.globalEtag,
        source: globalRes.globalSource,
      },
      toolCallUrls: {
        cached: toolUrlsResult.isToolUrlsCached,
        etag: toolUrlsResult.toolUrlsEtag,
        source: toolUrlsResult.toolUrlsSource,
      },
    },
    timestamp: new Date().toISOString(),
  };
}


function getContentTypeForFile(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "pdf": return "application/pdf";
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "svg": return "image/svg+xml";
    case "webp": return "image/webp";
    case "json": return "application/json";
    case "xml": return "application/xml";
    case "csv": return "text/csv";
    case "txt":
    case "log": return "text/plain; charset=utf-8";
    case "zip": return "application/zip";
    default: return "application/octet-stream";
  }
}

/**
 * Constant-time secret comparison for the /cache/refresh gate.
 * Returns false on length mismatch without revealing which bytes differ.
 */
function timingSafeEqual(provided: string, expected: string): boolean {
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/** Max age for the /cache/refresh recency short-circuit (6 hours). */
const REFRESH_RECENCY_WINDOW_MS = 6 * 60 * 60 * 1000;

function parseHeadersForAuth(request: Request, options: ExportData360Options): ExportData360Options {
  const authHeader = request.headers.get("authorization");
  const instanceHeader = request.headers.get("x-salesforce-instance-url");
  const tokenHeader = request.headers.get("x-salesforce-access-token");

  if (!options.accessToken && authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    options.accessToken = authHeader.slice(7).trim();
  } else if (!options.accessToken && tokenHeader) {
    options.accessToken = tokenHeader.trim();
  }

  if (!options.instanceUrl && instanceHeader) {
    options.instanceUrl = instanceHeader.trim();
  }

  if (!options.teamId && request.headers.get("x-team-id")) {
    options.teamId = request.headers.get("x-team-id")!.trim();
  }
  if (!options.orgId && request.headers.get("x-org-id")) {
    options.orgId = request.headers.get("x-org-id")!.trim();
  }

  return options;
}

export default {
  async fetch(request: Request, env: Data360Env, ctx?: any): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // B2 credentials never authorize an HTTP caller. Resolve its Salesforce
      // identity before selecting an organization storage prefix.
      if (/^\/(api\/)?cache\/(latest|query|download|snapshots)$/.test(path)) {
        const authorization = request.headers.get("authorization") ?? "";
        const instanceUrl = request.headers.get("x-salesforce-instance-url");
        if (!/^Bearer\s+\S+/i.test(authorization) || !instanceUrl) return Response.json({ error: "unauthorized" }, { status: 401 });
        try {
          const auth = await new SalesforceAuthBridge(env).resolveToken({
            accessToken: authorization, instanceUrl,
            orgId: url.searchParams.get("orgId") ?? request.headers.get("x-org-id") ?? undefined,
          });
          url.searchParams.set("orgId", auth.connection.orgId!);
        } catch (error) {
          return Response.json({ error: error instanceof SalesforceAuthorizationError && error.status === 403 ? "forbidden" : "unauthorized" }, { status: error instanceof SalesforceAuthorizationError ? error.status : 401 });
        }
        for (const parameter of ["channelId", "agentName", "snapshotId"]) {
          const value = url.searchParams.get(parameter);
          if (value !== null && !/^[A-Za-z0-9_-]+$/.test(value)) return Response.json({ error: "invalid_request", message: "Invalid cache scope." }, { status: 400 });
        }
      }

    // Health Check
    if (path === "/health" || (path === "/" && request.method === "GET")) {
      return Response.json({
        ok: true,
        service: "tubot-sf-data360",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
      });
    }

    // ==========================================
    // Declarative Cache Purge Endpoint
    // POST /api/data360/cache/purge, POST /data360/cache/purge
    // ==========================================
    if (path === "/api/data360/cache/purge" || path === "/data360/cache/purge") {
      if (request.method !== "POST") {
        return Response.json(
          { error: "method_not_allowed", message: "Only POST is supported for cache purge." },
          { status: 405 }
        );
      }
      try {
        let body: any = {};
        try {
          body = await request.json();
        } catch {}

        let tags: string[] = [];
        if (Array.isArray(body?.tags)) {
          tags = body.tags;
        } else if (typeof body?.tag === "string") {
          tags = [body.tag];
        } else if (url.searchParams.get("tags")) {
          tags = url.searchParams.get("tags")!.split(",").map((t: string) => t.trim()).filter(Boolean);
        } else if (url.searchParams.get("tag")) {
          tags = [url.searchParams.get("tag")!.trim()];
        }

        if (tags.length === 0) {
          return Response.json(
            { error: "invalid_request", message: "tags parameter is required." },
            { status: 400 }
          );
        }

        const canonicalUrl = normalizeCanonicalUrl(request.url);
        const purged = await purgeEdgeCache(ctx, tags, [canonicalUrl]);
        return Response.json(
          {
            ok: purged !== false,
            message: "Cache purged successfully.",
            purgedTags: tags,
          },
          { status: 200 }
        );
      } catch (err: unknown) {
        return Response.json(
          { error: "purge_failed", message: err instanceof Error ? err.message : String(err) },
          { status: 500 }
        );
      }
    }

    // ==========================================
    // Context Endpoint (Pure Requirements for tubot-agentcode)
    // GET/POST /api/v1/context, GET/POST /api/data360/context, GET/POST /data360/context
    // ==========================================
    if (
      path === "/api/v1/context" ||
      path === "/api/data360/context" ||
      path === "/data360/context" ||
      path === "/context"
    ) {
      let body: any = {};
      if (request.method === "POST") {
        try {
          body = await request.json();
        } catch {
          return Response.json(
            { error: "invalid_json", message: "Malformed JSON body." },
            { status: 400 }
          );
        }
      }

      const userId = (
        body.userId ||
        body.user_id ||
        url.searchParams.get("userId") ||
        url.searchParams.get("user_id")
      )?.trim();

      const channelId = (
        body.channelId ||
        body.channel_id ||
        body.agentName ||
        url.searchParams.get("channelId") ||
        url.searchParams.get("channel_id") ||
        url.searchParams.get("agentName") ||
        request.headers.get("x-channel-id")
      )?.trim();

      if (!userId || !channelId) {
        return Response.json(
          {
            error: "invalid_request",
            message: "Both userId and channelId (or agentName) parameters are required.",
          },
          { status: 400 }
        );
      }

      const bypassCache =
        body.bypassCache === true ||
        url.searchParams.get("bypassCache") === "true" ||
        request.headers.get("cache-control")?.includes("no-cache") ||
        false;

      const edgeCache = typeof caches !== "undefined" && (caches as any)?.default ? (caches as any).default : null;
      const cacheUrl = new URL(request.url);
      cacheUrl.searchParams.set("userId", userId);
      cacheUrl.searchParams.set("channelId", channelId);
      if (body.sessionId || url.searchParams.get("sessionId")) {
        cacheUrl.searchParams.set("sessionId", (body.sessionId || url.searchParams.get("sessionId"))!);
      }
      const edgeCacheKey = new Request(cacheUrl.toString(), { method: "GET" });

      if (edgeCache && !bypassCache && request.method === "GET") {
        try {
          const cachedMatch = await edgeCache.match(edgeCacheKey);
          if (cachedMatch) {
            return cachedMatch;
          }
        } catch {
          // Ignore cache match errors
        }
      }

      const authHeader = request.headers.get("authorization") || request.headers.get("Authorization");
      const bearerToken = authHeader?.replace(/^Bearer\s+/i, "")?.trim();
      const instanceUrl =
        request.headers.get("x-salesforce-instance-url") ||
        body.instanceUrl ||
        body.instance_url ||
        url.searchParams.get("instanceUrl");
      const orgId =
        request.headers.get("x-org-id") ||
        body.orgId ||
        body.org_id ||
        url.searchParams.get("orgId");
      const accessToken = bearerToken || body.accessToken || body.access_token;
      const options: GetContextOptions = {
        userId,
        channelId,
        agentName: body.agentName || url.searchParams.get("agentName") || channelId,
        sessionId: body.sessionId || url.searchParams.get("sessionId") || undefined,
        orgId: orgId || undefined,
        teamId: body.teamId || url.searchParams.get("teamId") || undefined,
        accessToken: accessToken || undefined,
        instanceUrl: instanceUrl || undefined,
        agentScript: body.agentScript,
        agentXml: body.agentXml,
        bypassCache,
        bypassAgentCache: body.bypassAgentCache,
        bypassToolUrlsCache: body.bypassToolUrlsCache,
        bypassUserCache: body.bypassUserCache,
        bypassConversationCache: body.bypassConversationCache,
        bypassGlobalCache: body.bypassGlobalCache,
        conversationLimit: body.conversationLimit ? Number(body.conversationLimit) : undefined,
      };

      let result;
      try {
        result = await assembleContext(env, ctx, options);
      } catch (err: any) {
        const status = err.status || (err.message?.includes("401") ? 401 : err.message?.includes("403") ? 403 : 500);
        return Response.json(
          {
            error: status === 401 ? "unauthorized" : status === 403 ? "forbidden" : "context_assembly_failed",
            message: err.message || String(err),
          },
          { status }
        );
      }

      const cacheHeaders = buildDeclarativeCacheHeaders({
        tags: [
          "data360",
          `data360-user-${userId}`,
          `data360-channel-${channelId}`,
          `data360-agent-${channelId}`,
          `data360-tools-${channelId}`,
        ],
        etag: result.compositeETag,
        cacheControl: "public, max-age=0, must-revalidate, s-maxage=300",
      });

      const ifNoneMatch = request.headers.get("if-none-match");
      if (ifNoneMatch && isNotModified(ifNoneMatch, result.compositeETag)) {
        return new Response(null, {
          status: 304,
          headers: cacheHeaders,
        });
      }

      const response = Response.json(result, {
        status: 200,
        headers: cacheHeaders,
      });

      if (edgeCache && !bypassCache && request.method === "GET") {
        try {
          if (ctx && typeof ctx.waitUntil === "function") {
            ctx.waitUntil(edgeCache.put(edgeCacheKey, response.clone()));
          }
        } catch {
          // Ignore cache write errors
        }
      }

      return response;
    }

    // ==========================================
    // Corresponding Data Endpoint (Composite Multi-Tier Caching)
    // GET/POST /api/data360/corresponding-data, GET/POST /data360/corresponding-data
    // ==========================================
    if (path === "/api/data360/corresponding-data" || path === "/data360/corresponding-data") {
      let body: any = {};
      if (request.method === "POST") {
        try {
          body = await request.json();
        } catch {
          return Response.json(
            { error: "invalid_json", message: "Malformed JSON body." },
            { status: 400 }
          );
        }
      }

      const userId = (
        body.userId ||
        body.user_id ||
        body.id ||
        url.searchParams.get("userId") ||
        url.searchParams.get("user_id") ||
        url.searchParams.get("id")
      )?.trim();

      const channelId = (
        body.channelId ||
        body.channel_id ||
        body.agentName ||
        url.searchParams.get("channelId") ||
        url.searchParams.get("channel_id") ||
        url.searchParams.get("agentName") ||
        request.headers.get("x-channel-id")
      )?.trim();

      const sessionId = (
        body.sessionId ||
        body.session_id ||
        body.messagingsession ||
        url.searchParams.get("sessionId") ||
        url.searchParams.get("session_id") ||
        url.searchParams.get("messagingsession")
      )?.trim();

      const bypassCache =
        body.bypassCache === true ||
        url.searchParams.get("bypassCache") === "true" ||
        request.headers.get("cache-control")?.includes("no-cache") ||
        false;

      if (!userId || !channelId) {
        return Response.json(
          {
            error: "invalid_request",
            message: "Both userId and channelId (or agentName) parameters are required.",
          },
          { status: 400 }
        );
      }

      const canonicalUrl = normalizeCanonicalUrl(request.url);
      const canonicalReq = new Request(canonicalUrl, { headers: request.headers });

      const d1Cache = new D1Data360Cache(env.DB);

      // Fast-path ETag check:
      // If client sent If-None-Match, check stored component ETags in D1
      if (request.headers.get("if-none-match") && !bypassCache) {
        const storedGlobalETag = await d1Cache.getGlobalETag(channelId);
        const storedUserETag = await d1Cache.getUserETag(userId);
        const storedConvETag = await d1Cache.getConversationETag(userId);

        if (storedGlobalETag && storedUserETag && storedConvETag) {
          const expectedCompositeETag = await computeETag(
            `${storedGlobalETag}:${storedUserETag}:${storedConvETag}`
          );
          if (isNotModified(request, expectedCompositeETag)) {
            return new Response(null, {
              status: 304,
              headers: buildDeclarativeCacheHeaders({
                tags: [
                  "data360",
                  `data360-global-${channelId}`,
                  `data360-user-${userId}`,
                  `data360-conv-${userId}`,
                ],
                etag: expectedCompositeETag,
              }),
            });
          }
        }
      }

      const options: CorrespondingDataOptions & ExportData360Options = {
        userId,
        channelId,
        sessionId,
        bypassCache,
        orgId: url.searchParams.get("orgId") || body.orgId,
      };
      parseHeadersForAuth(request, options);

      const entrypoint = new TubotSfData360Entrypoint(ctx || ({} as any), env);
      let result: CorrespondingDataResult;
      try {
        result = await entrypoint.getCorrespondingData(options);
      } catch (err: unknown) {
        return Response.json(
          {
            error: "corresponding_data_failed",
            message: err instanceof Error ? err.message : String(err),
          },
          { status: 502 }
        );
      }

      const cacheTags = [
        "data360",
        `data360-global-${channelId}`,
        `data360-user-${userId}`,
        `data360-conv-${userId}`,
      ];

      if (isNotModified(request, result.compositeETag)) {
        return new Response(null, {
          status: 304,
          headers: buildDeclarativeCacheHeaders({
            tags: cacheTags,
            etag: result.compositeETag,
          }),
        });
      }

      const headers = buildDeclarativeCacheHeaders({
        tags: cacheTags,
        etag: result.compositeETag,
      });

      const response = Response.json(result, {
        status: 200,
        headers: {
          ...headers,
          "X-Cache-Global": result.cacheBreakdown.globalData360.cached ? "HIT" : "MISS",
          "X-Cache-Individual": result.cacheBreakdown.individualData360.cached ? "HIT" : "MISS",
          "X-Cache-Conversations": result.cacheBreakdown.conversationHistory.cached ? "HIT" : "MISS",
        },
      });

      return response;
    }

    // ==========================================
    // User Data360 Endpoints
    // GET/POST /api/data360/users/:userId, GET/POST /users/:userId/data360
    // ==========================================
    const userMatch =
      path.match(/^\/(?:api\/)?data360\/users?(?:\/([^\/]+))?$/) ||
      path.match(/^\/(?:api\/)?users\/([^\/]+)\/data360$/);
    if (userMatch) {
      const pathUserId = userMatch[1] ? decodeURIComponent(userMatch[1]) : undefined;
      const targetUserId = pathUserId || url.searchParams.get("userId") || url.searchParams.get("id");

      if (request.method === "GET") {
        if (!targetUserId) {
          return Response.json(
            { error: "invalid_request", message: "userId parameter is required." },
            { status: 400 }
          );
        }

        const canonicalUrl = normalizeCanonicalUrl(request.url);
        const canonicalReq = new Request(canonicalUrl, { headers: request.headers });

        const d1Cache = new D1Data360Cache(env.DB);

        // Fast-path ETag check:
        // Before fetching full data or calling Salesforce, check if request has If-None-Match
        if (request.headers.get("if-none-match")) {
          const storedEtag = await d1Cache.getUserETag(targetUserId);
          if (storedEtag && isNotModified(request, storedEtag)) {
            return new Response(null, {
              status: 304,
              headers: buildDeclarativeCacheHeaders({
                tags: ["data360-user", `data360-user-${targetUserId}`],
                etag: storedEtag,
              }),
            });
          }
        }

        // 1. Declarative Cache check (caches.default in front of worker / local cache)
        if (typeof caches !== "undefined" && caches.default) {
          try {
            const cachedRes = await caches.default.match(canonicalReq);
            if (cachedRes) {
              const cachedEtag = cachedRes.headers.get("etag");
              if (cachedEtag && isNotModified(request, cachedEtag)) {
                return new Response(null, {
                  status: 304,
                  headers: cachedRes.headers,
                });
              }
              return cachedRes;
            }
          } catch {}
        }

        // 2. D1 cache check
        let userData = await d1Cache.getUser(targetUserId);
        let cacheSource = "d1";

        // 3. Salesforce extraction (if cache miss)
        if (!userData) {
          try {
            let options: ExportData360Options = {};
            const channelIdParam = url.searchParams.get("channelId");
            const agentNameParam = url.searchParams.get("agentName");
            const orgIdParam = url.searchParams.get("orgId");
            const apiVersionParam = url.searchParams.get("apiVersion");

            if (channelIdParam) options.channelId = channelIdParam;
            if (agentNameParam) options.agentName = agentNameParam;
            if (orgIdParam) options.orgId = orgIdParam;
            if (apiVersionParam) options.apiVersion = apiVersionParam;

            parseHeadersForAuth(request, options);

            const authBridge = new SalesforceAuthBridge(env);
            const authResult = await authBridge.resolveToken(options);
            const b2CacheManager = createB2CacheManager(env);
            const extractor = new Data360Extractor(undefined, undefined, undefined, b2CacheManager);
            userData = await extractor.extractUserData360(authResult.connection, targetUserId, options);
            cacheSource = "salesforce";

            // 4. Store in D1 cache
            const computedEtag = await computeETag(userData);
            await d1Cache.putUser(targetUserId, userData, {
              orgId: options.orgId || authResult.connection.orgId,
              etag: computedEtag,
            });
          } catch (err: unknown) {
            return Response.json(
              {
                error: "extraction_failed",
                message: err instanceof Error ? err.message : String(err),
              },
              { status: 502 }
            );
          }
        }

        const etag = await computeETag(userData);
        const cacheTags = ["data360-user", `data360-user-${targetUserId}`];

        if (isNotModified(request, etag)) {
          return new Response(null, {
            status: 304,
            headers: buildDeclarativeCacheHeaders({
              tags: cacheTags,
              etag,
            }),
          });
        }

        const headers = buildDeclarativeCacheHeaders({
          tags: cacheTags,
          etag,
        });

        const response = Response.json(userData, {
          status: 200,
          headers: {
            ...headers,
            "X-Cache-Source": cacheSource,
          },
        });

        if (typeof caches !== "undefined" && caches.default) {
          try {
            await caches.default.put(canonicalReq, response.clone());
          } catch {}
        }

        return response;
      }

      if (request.method === "POST") {
        let body: any = {};
        try {
          body = await request.json();
        } catch {
          return Response.json(
            { error: "invalid_json", message: "Malformed JSON body." },
            { status: 400 }
          );
        }

        const effectiveUserId = targetUserId || body.userId || body.id;
        if (!effectiveUserId) {
          return Response.json(
            { error: "invalid_request", message: "userId parameter is required." },
            { status: 400 }
          );
        }

        const payloadData = body.data !== undefined ? body.data : body;
        const orgId =
          url.searchParams.get("orgId") ||
          request.headers.get("x-org-id") ||
          body?.orgId ||
          `user-${effectiveUserId}`;
        const ttlSeconds = body.ttlSeconds;

        // Save to D1
        const d1Cache = new D1Data360Cache(env.DB);
        const etag = await computeETag(payloadData);
        await d1Cache.putUser(effectiveUserId, payloadData, { orgId, ttlSeconds, etag });

        // Save to B2
        const b2Cache = createB2CacheManager(env);
        try {
          await b2Cache.saveUserData(orgId, effectiveUserId, payloadData);
        } catch (err: unknown) {
          console.warn("B2 saveUserData failed in POST handler:", err);
        }

        // Programmatically purge edge cache tag
        const tag = `data360-user-${effectiveUserId}`;
        const canonicalUrl = normalizeCanonicalUrl(request.url);
        await purgeEdgeCache(ctx, [tag], [canonicalUrl]);

        return Response.json(
          {
            ok: true,
            message: "User Data360 saved and edge cache purged.",
            userId: effectiveUserId,
            etag,
            purgedTag: tag,
          },
          {
            status: 200,
            headers: {
              ETag: etag,
            },
          }
        );
      }

      return Response.json(
        { error: "method_not_allowed", message: "Method not allowed on user endpoint." },
        { status: 405 }
      );
    }

    // ==========================================
    // MessagingSession Data360 Endpoints
    // GET/POST /api/data360/messagingsessions/:sessionId, GET/POST /messagingsessions/:sessionId/data360
    // ==========================================
    const sessionMatch =
      path.match(/^\/(?:api\/)?data360\/messagingsessions?(?:\/([^\/]+))?$/) ||
      path.match(/^\/(?:api\/)?messagingsessions\/([^\/]+)\/data360$/);
    if (sessionMatch) {
      const pathSessionId = sessionMatch[1] ? decodeURIComponent(sessionMatch[1]) : undefined;
      const targetSessionId = pathSessionId || url.searchParams.get("sessionId") || url.searchParams.get("id");

      if (request.method === "GET") {
        if (!targetSessionId) {
          return Response.json(
            { error: "invalid_request", message: "sessionId parameter is required." },
            { status: 400 }
          );
        }

        const canonicalUrl = normalizeCanonicalUrl(request.url);
        const canonicalReq = new Request(canonicalUrl, { headers: request.headers });

        const d1Cache = new D1Data360Cache(env.DB);

        // Fast-path ETag check:
        // Before fetching full data or calling Salesforce, check if request has If-None-Match
        if (request.headers.get("if-none-match")) {
          const storedEtag = await d1Cache.getSessionETag(targetSessionId);
          if (storedEtag && isNotModified(request, storedEtag)) {
            return new Response(null, {
              status: 304,
              headers: buildDeclarativeCacheHeaders({
                tags: ["data360-session", `data360-session-${targetSessionId}`],
                etag: storedEtag,
              }),
            });
          }
        }

        // 1. Declarative Cache check
        if (typeof caches !== "undefined" && caches.default) {
          try {
            const cachedRes = await caches.default.match(canonicalReq);
            if (cachedRes) {
              const cachedEtag = cachedRes.headers.get("etag");
              if (cachedEtag && isNotModified(request, cachedEtag)) {
                return new Response(null, {
                  status: 304,
                  headers: cachedRes.headers,
                });
              }
              return cachedRes;
            }
          } catch {}
        }

        // 2. D1 cache check
        let sessionData = await d1Cache.getSession(targetSessionId);
        let cacheSource = "d1";

        // 3. Salesforce extraction (if cache miss)
        if (!sessionData) {
          try {
            let options: ExportData360Options = {};
            const channelIdParam = url.searchParams.get("channelId");
            const agentNameParam = url.searchParams.get("agentName");
            const orgIdParam = url.searchParams.get("orgId");
            const apiVersionParam = url.searchParams.get("apiVersion");

            if (channelIdParam) options.channelId = channelIdParam;
            if (agentNameParam) options.agentName = agentNameParam;
            if (orgIdParam) options.orgId = orgIdParam;
            if (apiVersionParam) options.apiVersion = apiVersionParam;

            parseHeadersForAuth(request, options);

            const authBridge = new SalesforceAuthBridge(env);
            const authResult = await authBridge.resolveToken(options);
            const b2CacheManager = createB2CacheManager(env);
            const extractor = new Data360Extractor(undefined, undefined, undefined, b2CacheManager);
            sessionData = await extractor.extractMessagingSessionData360(authResult.connection, targetSessionId, options);
            cacheSource = "salesforce";

            // 4. Store in D1 cache
            const computedEtag = await computeETag(sessionData);
            await d1Cache.putSession(targetSessionId, sessionData, {
              orgId: options.orgId || authResult.connection.orgId,
              etag: computedEtag,
            });
          } catch (err: unknown) {
            return Response.json(
              {
                error: "extraction_failed",
                message: err instanceof Error ? err.message : String(err),
              },
              { status: 502 }
            );
          }
        }

        const etag = await computeETag(sessionData);
        const cacheTags = ["data360-session", `data360-session-${targetSessionId}`];

        if (isNotModified(request, etag)) {
          return new Response(null, {
            status: 304,
            headers: buildDeclarativeCacheHeaders({
              tags: cacheTags,
              etag,
            }),
          });
        }

        const headers = buildDeclarativeCacheHeaders({
          tags: cacheTags,
          etag,
        });

        const response = Response.json(sessionData, {
          status: 200,
          headers: {
            ...headers,
            "X-Cache-Source": cacheSource,
          },
        });

        if (typeof caches !== "undefined" && caches.default) {
          try {
            await caches.default.put(canonicalReq, response.clone());
          } catch {}
        }

        return response;
      }

      if (request.method === "POST") {
        let body: any = {};
        try {
          body = await request.json();
        } catch {
          return Response.json(
            { error: "invalid_json", message: "Malformed JSON body." },
            { status: 400 }
          );
        }

        const effectiveSessionId = targetSessionId || body.sessionId || body.id;
        if (!effectiveSessionId) {
          return Response.json(
            { error: "invalid_request", message: "sessionId parameter is required." },
            { status: 400 }
          );
        }

        const payloadData = body.data !== undefined ? body.data : body;
        const orgId =
          url.searchParams.get("orgId") ||
          request.headers.get("x-org-id") ||
          body?.orgId ||
          `session-${effectiveSessionId}`;
        const ttlSeconds = body.ttlSeconds;

        // Save to D1
        const d1Cache = new D1Data360Cache(env.DB);
        const etag = await computeETag(payloadData);
        await d1Cache.putSession(effectiveSessionId, payloadData, { orgId, ttlSeconds, etag });

        // Save to B2
        const b2Cache = createB2CacheManager(env);
        try {
          await b2Cache.saveSessionData(orgId, effectiveSessionId, payloadData);
        } catch (err: unknown) {
          console.warn("B2 saveSessionData failed in POST handler:", err);
        }

        // Programmatically purge edge cache tag
        const tag = `data360-session-${effectiveSessionId}`;
        const canonicalUrl = normalizeCanonicalUrl(request.url);
        await purgeEdgeCache(ctx, [tag], [canonicalUrl]);

        return Response.json(
          {
            ok: true,
            message: "MessagingSession Data360 saved and edge cache purged.",
            sessionId: effectiveSessionId,
            etag,
            purgedTag: tag,
          },
          {
            status: 200,
            headers: {
              ETag: etag,
            },
          }
        );
      }

      return Response.json(
        { error: "method_not_allowed", message: "Method not allowed on messagingsession endpoint." },
        { status: 405 }
      );
    }

    // Export & Refresh Endpoints
    if (path === "/export" || path === "/api/export" || path === "/cache/refresh" || path === "/api/cache/refresh") {
      const isRefresh = path === "/cache/refresh" || path === "/api/cache/refresh";

      // Internal gate: ONLY /cache/refresh is authenticated, via HMAC-signed
      // service requests (see panel worker/service-signer.ts). /export behavior
      // is unchanged. TRANSITION: a legacy x-data360-secret bearer is still
      // accepted while callers migrate; it is removed at cutover.
      let refreshRawBody: string | null = null;
      if (isRefresh) {
        if (request.method !== "POST") {
          return Response.json({ error: "method_not_allowed" }, { status: 405 });
        }
        const keys = [env.DATA360_INTERNAL_KEY, env.DATA360_INTERNAL_KEY_NEXT].filter(
          (k): k is string => typeof k === "string" && k.length >= 32,
        );
        if (keys.length === 0) {
          return Response.json({ error: "data360_unconfigured" }, { status: 503 });
        }
        refreshRawBody = await request.text();
        if (refreshRawBody.length > 65536) {
          return Response.json({ error: "invalid_request", message: "Body too large." }, { status: 413 });
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const sig = readSigHeaders(request.headers);
        if (sig) {
          // Signed requests require replay protection; without a D1 binding
          // there is no nonce store, so fail closed instead of skipping it.
          if (!env.DB) {
            return Response.json({ error: "data360_unconfigured" }, { status: 503 });
          }
          const ok =
            (await verifyServiceSignature(keys, request.method, path, refreshRawBody, sig, nowSec)) &&
            (await claimServiceNonce(env.DB, sig.nonce, nowSec));
          if (!ok) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
        } else {
          const providedSecret = request.headers.get("x-data360-secret");
          const legacyOk =
            !!providedSecret && keys.some((k) => timingSafeEqual(providedSecret, k));
          if (!legacyOk) {
            return Response.json({ error: "unauthorized" }, { status: 401 });
          }
        }
      }

      try {
        let options: ExportData360Options = {};

        if (request.method === "POST") {
          const contentType = request.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            try {
              // Refresh bodies were already consumed as text by the HMAC gate.
              options = (isRefresh && refreshRawBody !== null
                ? JSON.parse(refreshRawBody)
                : await request.json()) as ExportData360Options;
            } catch {
              return Response.json({ error: "invalid_json", message: "Malformed JSON body." }, { status: 400 });
            }
          }
        }

        // Merge query parameters
        const channelIdParam = url.searchParams.get("channelId");
        const agentNameParam = url.searchParams.get("agentName");
        const formatParam = url.searchParams.get("format");
        const maxRecordsParam = url.searchParams.get("maxRecords");
        const cacheToB2Param = url.searchParams.get("cacheToB2");
        const cacheTtlParam = url.searchParams.get("cacheTtlSeconds");

        if (channelIdParam && !options.channelId) options.channelId = channelIdParam;
        if (agentNameParam && !options.agentName) options.agentName = agentNameParam;
        if (formatParam && !options.format) options.format = formatParam as "zip" | "json";
        if (maxRecordsParam && !options.maxRecords) options.maxRecords = parseInt(maxRecordsParam, 10);
        if (cacheToB2Param !== null && options.cacheToB2 === undefined) {
          options.cacheToB2 = cacheToB2Param === "true" || cacheToB2Param === "1";
        }
        if (cacheTtlParam && !options.cacheTtlSeconds) {
          options.cacheTtlSeconds = parseInt(cacheTtlParam, 10);
        }

        // If called via /cache/refresh, always enforce cacheToB2 and skip
        // unstructured file bytes. Per-file downloads (plus their redirect hops)
        // exhaust the per-invocation subrequest budget before the B2 save runs;
        // refresh snapshots carry records+metadata, file bytes stay in /export.
        if (isRefresh) {
          options.cacheToB2 = true;
          options.format = "json";
          options.includeUnstructuredFiles = false;
        }

        parseHeadersForAuth(request, options);

        if (!options.channelId && !options.agentName) {
          return Response.json(
            {
              error: "invalid_request",
              message: "A target channelId or agentName parameter is required.",
            },
            { status: 400 }
          );
        }

        // Recency short-circuit: skip re-extraction when the latest tenant-scoped
        // snapshot is fresh (<=6h old). Any lookup failure falls through to extraction.
        if (isRefresh) {
          const refreshTargetId = (options.channelId || options.agentName || "").trim();
          const refreshOrgId = options.orgId || refreshTargetId;
          if (refreshTargetId && refreshOrgId) {
            try {
              const recencyCacheMgr = createB2CacheManager(env);
              const latest = await recencyCacheMgr.getLatestSnapshot(refreshOrgId, refreshTargetId);
              const latestTs = latest ? Date.parse(latest.timestamp || "") : NaN;
              if (latest && !Number.isNaN(latestTs) && Date.now() - latestTs <= REFRESH_RECENCY_WINDOW_MS) {
                const dedupedCache = latest.manifest?.b2Cache ?? {
                  stored: true,
                  bucketName: "",
                  bucketId: "",
                  snapshotId: latest.snapshotId,
                  basePath: `${recencyCacheMgr.rootPrefix()}/${refreshOrgId}/${refreshTargetId}/snapshots/${latest.snapshotId}`,
                  cachedAt: latest.timestamp,
                  bandwidthAlliance: true,
                  totalBytes: latest.totalBytes,
                  fileCount: latest.fileCount,
                };
                return Response.json(
                  {
                    ok: true,
                    deduped: true,
                    message: "Cache is fresh; skipped re-extraction.",
                    cache: dedupedCache,
                    manifest: latest.manifest,
                  },
                  {
                    status: 200,
                    headers: {
                      "Content-Type": "application/json",
                      "X-Bz-Info-Bandwidth-Alliance": "true",
                      "X-B2-Cache-Path": dedupedCache.basePath,
                      "X-B2-Snapshot-Id": dedupedCache.snapshotId,
                    },
                  }
                );
              }
            } catch {
              // Fall through to full extraction on any cache lookup failure.
            }
          }
        }

        // 1. Resolve Salesforce credentials / token via tubot-sf-auth bridge
        const authBridge = new SalesforceAuthBridge(env);
        const authResult = await authBridge.resolveToken(options);

        // 2. Extract Data 360 data via batched requests (and cache to B2 if requested)
        const cacheMgr = createB2CacheManager(env);
        const extractor = new Data360Extractor(undefined, undefined, undefined, cacheMgr);
        const pkg = await extractor.extractData360(authResult.connection, options);

        // If called via /cache/refresh, return confirmation and cache metadata
        if (isRefresh) {
          return Response.json(
            {
              ok: true,
              message: "Cache refreshed successfully in Backblaze B2.",
              cache: pkg.b2Cache,
              manifest: pkg.manifest,
            },
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "X-Bz-Info-Bandwidth-Alliance": "true",
                ...(pkg.b2Cache ? {
                  "X-B2-Cache-Path": pkg.b2Cache.basePath,
                  "X-B2-Snapshot-Id": pkg.b2Cache.snapshotId,
                } : {}),
              },
            }
          );
        }

        // 3. Return JSON or ZIP
        const acceptHeader = request.headers.get("accept") || "";
        if (options.format === "json" || acceptHeader.includes("application/json") && options.format !== "zip") {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "X-Export-Timestamp": pkg.manifest.exportTimestamp,
            "X-Bz-Info-Bandwidth-Alliance": "true",
          };
          if (pkg.b2Cache) {
            headers["X-B2-Cache-Path"] = pkg.b2Cache.basePath;
            headers["X-B2-Snapshot-Id"] = pkg.b2Cache.snapshotId;
          }
          return Response.json(pkg, { status: 200, headers });
        }

        if (!pkg.zipBytes) {
          return Response.json({ error: "zip_failed", message: "Failed to assemble ZIP archive." }, { status: 500 });
        }

        const targetName = (options.channelId || options.agentName || "data360").replace(/[^a-zA-Z0-9_-]/g, "_");
        const timestamp = Date.now();
        const filename = `data360-${targetName}-${timestamp}.zip`;

        const zipHeaders: Record<string, string> = {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "X-Export-Timestamp": pkg.manifest.exportTimestamp,
          "Cache-Control": "no-store",
          "X-Bz-Info-Bandwidth-Alliance": "true",
        };
        if (pkg.b2Cache) {
          zipHeaders["X-B2-Cache-Path"] = pkg.b2Cache.basePath;
          zipHeaders["X-B2-Snapshot-Id"] = pkg.b2Cache.snapshotId;
        }

        return new Response(pkg.zipBytes, {
          status: 200,
          headers: zipHeaders,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const isClientError = msg.includes("must be specified") || msg.includes("cannot be empty");
        if (err instanceof SalesforceAuthorizationError) return Response.json({ error: err.status === 403 ? "forbidden" : "unauthorized" }, { status: err.status });
        return Response.json(
          {
            error: isClientError ? "invalid_request" : "export_failed",
            message: msg,
          },
          { status: isClientError ? 400 : 502 }
        );
      }
    }

    // B2 Cache: Latest Snapshot Endpoint
    if (path === "/cache/latest" || path === "/api/cache/latest") {
      try {
        const channelId = url.searchParams.get("channelId");
        const agentName = url.searchParams.get("agentName");
        const targetId = channelId || agentName;

        if (!targetId) {
          return Response.json(
            { error: "invalid_request", message: "A target channelId or agentName parameter is required." },
            { status: 400 }
          );
        }

        const orgId = url.searchParams.get("orgId") || request.headers.get("x-org-id") || targetId;
        const cacheMgr = createB2CacheManager(env);
        const snapshot = await cacheMgr.getLatestSnapshot(orgId, targetId);

        if (!snapshot) {
          return Response.json(
            { error: "not_found", message: `No cached snapshot found for ${targetId} in org ${orgId}.` },
            { status: 404 }
          );
        }

        return Response.json(snapshot, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Bz-Info-Bandwidth-Alliance": "true",
            "X-B2-Snapshot-Id": snapshot.snapshotId,
          },
        });
      } catch (err: unknown) {
        return Response.json(
          { error: "cache_error", message: err instanceof Error ? err.message : String(err) },
          { status: 500 }
        );
      }
    }

    // B2 Cache: Query Entity Endpoint (DMO, CRM record, File, or Manifest)
    if (path === "/cache/query" || path === "/api/cache/query") {
      try {
        const channelId = url.searchParams.get("channelId");
        const agentName = url.searchParams.get("agentName");
        const targetId = channelId || agentName;

        if (!targetId) {
          return Response.json(
            { error: "invalid_request", message: "A target channelId or agentName parameter is required." },
            { status: 400 }
          );
        }

        const orgId = url.searchParams.get("orgId") || request.headers.get("x-org-id") || targetId;

        const dmo = url.searchParams.get("dmo") || undefined;
        const objectType = url.searchParams.get("objectType") || undefined;
        const objectName = url.searchParams.get("objectName") || undefined;
        const dataSpace = url.searchParams.get("dataSpace") || undefined;
        if (objectType && !DATA_CLOUD_FAMILIES.includes(objectType as DataCloudFamily)) {
          return Response.json({ error: "invalid_request", message: "Unknown Data 360 objectType." }, { status: 400 });
        }
        const crmEntity = url.searchParams.get("crmEntity") || undefined;
        const file = url.searchParams.get("file") || undefined;
        const snapshotId = url.searchParams.get("snapshotId") || undefined;

        const cacheMgr = createB2CacheManager(env);
        const data = await cacheMgr.queryCachedEntity(orgId, targetId, {
          dmo,
          objectType: objectType as DataCloudFamily | undefined,
          objectName,
          dataSpace,
          crmEntity,
          file,
          snapshotId,
        });

        if (data === null || data === undefined) {
          return Response.json(
            { error: "not_found", message: "Requested entity or file not found in cache." },
            { status: 404 }
          );
        }

        if (file && data instanceof Uint8Array) {
          return new Response(data, {
            status: 200,
            headers: {
              "Content-Type": getContentTypeForFile(file),
              "X-Bz-Info-Bandwidth-Alliance": "true",
              "Content-Disposition": `inline; filename="${file.split("/").pop()}"`,
            },
          });
        }

        if (file && typeof data === "string") {
          return new Response(data, {
            status: 200,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "X-Bz-Info-Bandwidth-Alliance": "true",
            },
          });
        }

        return Response.json(data, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Bz-Info-Bandwidth-Alliance": "true",
          },
        });
      } catch (err: unknown) {
        return Response.json(
          { error: "cache_query_error", message: err instanceof Error ? err.message : String(err) },
          { status: 500 }
        );
      }
    }

    // B2 Cache: Download Cached ZIP Archive
    if (path === "/cache/download" || path === "/api/cache/download") {
      try {
        const channelId = url.searchParams.get("channelId");
        const agentName = url.searchParams.get("agentName");
        const targetId = channelId || agentName;

        if (!targetId) {
          return Response.json(
            { error: "invalid_request", message: "A target channelId or agentName parameter is required." },
            { status: 400 }
          );
        }

        const orgId = url.searchParams.get("orgId") || request.headers.get("x-org-id") || targetId;
        const snapshotId = url.searchParams.get("snapshotId") || undefined;
        const cacheMgr = createB2CacheManager(env);
        const zipBytes = await cacheMgr.downloadCachedZip(orgId, targetId, snapshotId);

        if (!zipBytes) {
          return Response.json(
            { error: "not_found", message: "Cached ZIP archive not found." },
            { status: 404 }
          );
        }

        const cleanTarget = targetId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const filename = `data360-${cleanTarget}-${snapshotId || "latest"}.zip`;

        return new Response(zipBytes, {
          status: 200,
          headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "X-Bz-Info-Bandwidth-Alliance": "true",
            "Cache-Control": "private, max-age=3600",
          },
        });
      } catch (err: unknown) {
        return Response.json(
          { error: "cache_download_error", message: err instanceof Error ? err.message : String(err) },
          { status: 500 }
        );
      }
    }

    // B2 Cache: List Snapshots Endpoint
    if (path === "/cache/snapshots" || path === "/api/cache/snapshots") {
      try {
        const channelId = url.searchParams.get("channelId");
        const agentName = url.searchParams.get("agentName");
        const targetId = channelId || agentName;

        if (!targetId) {
          return Response.json(
            { error: "invalid_request", message: "A target channelId or agentName parameter is required." },
            { status: 400 }
          );
        }

        const orgId = url.searchParams.get("orgId") || request.headers.get("x-org-id") || targetId;
        const cacheMgr = createB2CacheManager(env);
        const snapshots = await cacheMgr.listSnapshots(orgId, targetId);

        return Response.json(
          {
            count: snapshots.length,
            snapshots,
          },
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Bz-Info-Bandwidth-Alliance": "true",
            },
          }
        );
      } catch (err: unknown) {
        return Response.json(
          { error: "cache_list_error", message: err instanceof Error ? err.message : String(err) },
          { status: 500 }
        );
      }
    }

    return Response.json({ error: "not_found", message: "Endpoint not found." }, { status: 404 });
    } catch (err: unknown) {
      console.error("Unhandled Worker error in tubot-sf-data360:", err);
      return Response.json(
        {
          error: "internal_error",
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
        { status: 500 }
      );
    }
  },
} satisfies ExportedHandler<Data360Env>;
