/**
 * Cloudflare Declarative Workers Cache and D1 Database Cache helpers.
 * Handles safe edge caching, tag-based invalidation, canonical URL normalization,
 * signature immunity, and multi-tier persistence (Declarative Edge -> D1 -> B2).
 */

export const DEFAULT_CACHE_CONTROL = "public, max-age=0, must-revalidate, s-maxage=300";

export const CACHE_BUSTING_PARAMS = [
  "t",
  "sig",
  "signature",
  "timestamp",
  "nonce",
  "_",
  "cb",
  "cachebust",
  "x-channel-signature",
  "x-channel-timestamp",
  "x-channel-nonce",
];

const FORBIDDEN_VARY_HEADERS = new Set([
  "authorization",
  "x-channel-signature",
  "x-channel-timestamp",
  "x-channel-nonce",
  "signature",
  "timestamp",
]);

/**
 * Strips cache-busting nonces and query signatures (?t=..., ?sig=..., ?timestamp=...)
 * to produce a clean, canonical cache key URL.
 */
export function normalizeCanonicalUrl(urlInput: string | URL): string {
  const url = new URL(typeof urlInput === "string" ? urlInput : urlInput.toString());
  for (const param of CACHE_BUSTING_PARAMS) {
    url.searchParams.delete(param);
  }
  const keys = Array.from(url.searchParams.keys());
  for (const key of keys) {
    if (CACHE_BUSTING_PARAMS.includes(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return url.toString();
}

/**
 * Returns a new URL with signature and cache-busting params removed.
 */
export function getCanonicalUrl(urlInput: string | URL): URL {
  return new URL(normalizeCanonicalUrl(urlInput));
}

/**
 * Ensures Vary header never includes Authorization or signature headers that break edge caching.
 */
export function sanitizeVaryHeader(vary?: string | string[]): string | undefined {
  if (!vary) return undefined;
  const list = (Array.isArray(vary) ? vary : vary.split(","))
    .map((v) => v.trim())
    .filter((v) => Boolean(v) && !FORBIDDEN_VARY_HEADERS.has(v.toLowerCase()));
  return list.length > 0 ? list.join(", ") : undefined;
}

/**
 * Sanitizes response headers to ensure no signature-related Vary headers exist.
 */
export function sanitizeHeaders(headers: Headers): Headers {
  const vary = headers.get("vary");
  if (vary) {
    const clean = sanitizeVaryHeader(vary);
    if (clean) {
      headers.set("vary", clean);
    } else {
      headers.delete("vary");
    }
  }
  return headers;
}

/**
 * Generates standard Declarative Workers Cache response headers with Cache-Tag and ETag.
 */
export function buildDeclarativeCacheHeaders(options?: {
  tags?: string[];
  etag?: string;
  cacheControl?: string;
  vary?: string | string[];
}): Record<string, string> {
  const headers: Record<string, string> = {
    "Cache-Control": options?.cacheControl || DEFAULT_CACHE_CONTROL,
  };
  if (options?.tags && options.tags.length > 0) {
    headers["Cache-Tag"] = options.tags.join(",");
  }
  if (options?.etag) {
    headers["ETag"] = options.etag;
  }
  const cleanVary = sanitizeVaryHeader(options?.vary);
  if (cleanVary) {
    headers["Vary"] = cleanVary;
  }
  return headers;
}

/**
 * Computes a strong safe ETag from content using SHA-256.
 */
export async function computeETag(data: string | Uint8Array | object): Promise<string> {
  const bytes =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
      ? data
      : new TextEncoder().encode(JSON.stringify(data));
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hashHex.slice(0, 32)}"`;
}

/**
 * Checks If-None-Match header against the computed ETag.
 */
export function isNotModified(requestOrHeader: Request | string | null | undefined, etag: string): boolean {
  if (!requestOrHeader || !etag) return false;
  const ifNoneMatch = typeof requestOrHeader === "string" ? requestOrHeader : requestOrHeader.headers?.get?.("if-none-match");
  if (!ifNoneMatch) return false;
  const cleanEtag = etag.replace(/^W\//, "").replace(/"/g, "");
  const matchValues = ifNoneMatch.split(",").map((v) => v.trim().replace(/^W\//, "").replace(/"/g, ""));
  return matchValues.includes("*") || matchValues.includes(cleanEtag);
}

/**
 * Programmatic edge cache purge helper using ctx?.cache?.purge?.({ tags })
 * with fallback to caches.default.delete().
 */
export async function purgeEdgeCache(
  ctx: any,
  tags: string[],
  fallbackUrls?: string | string[] | Request
): Promise<boolean> {
  if (!tags || tags.length === 0) return true;

  // 1. Programmatic Cloudflare Declarative Workers Cache purge by tags
  if (typeof ctx?.cache?.purge === "function") {
    try {
      const res = await ctx.cache.purge({ tags });
      if (res !== false) {
        return true;
      }
    } catch (err) {
      console.warn("ctx.cache.purge failed, attempting fallback:", err);
    }
  }

  // 2. Fallback to caches.default.delete()
  try {
    if (typeof caches !== "undefined" && caches.default) {
      if (fallbackUrls) {
        const urls = Array.isArray(fallbackUrls) ? fallbackUrls : [fallbackUrls];
        for (const u of urls) {
          await caches.default.delete(u as any);
        }
      }
      return true;
    }
  } catch (err) {
    console.warn("caches.default.delete fallback failed:", err);
  }

  return false;
}

export const D1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS data360_user_cache (
  user_id TEXT PRIMARY KEY,
  org_id TEXT,
  data TEXT NOT NULL,
  etag TEXT,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS data360_session_cache (
  session_id TEXT PRIMARY KEY,
  org_id TEXT,
  data TEXT NOT NULL,
  etag TEXT,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
`;

export interface MemoryCacheEntry<T> {
  data: T;
  etag: string;
  expiresAt: number;
}

export interface MemoryCacheBucket {
  user: Map<string, MemoryCacheEntry<any>>;
  session: Map<string, MemoryCacheEntry<any>>;
  conv: Map<string, MemoryCacheEntry<any>>;
  global: Map<string, MemoryCacheEntry<any>>;
  agent: Map<string, MemoryCacheEntry<any>>;
  toolUrls: Map<string, MemoryCacheEntry<string[]>>;
}

const dbCacheStore = new WeakMap<object, MemoryCacheBucket>();
const fallbackBucket: MemoryCacheBucket = {
  user: new Map(),
  session: new Map(),
  conv: new Map(),
  global: new Map(),
  agent: new Map(),
  toolUrls: new Map(),
};

export function getCacheBucket(db?: D1Database): MemoryCacheBucket {
  if (!db || typeof db !== "object") return fallbackBucket;
  let bucket = dbCacheStore.get(db);
  if (!bucket) {
    bucket = {
      user: new Map(),
      session: new Map(),
      conv: new Map(),
      global: new Map(),
      agent: new Map(),
      toolUrls: new Map(),
    };
    dbCacheStore.set(db, bucket);
  }
  return bucket;
}

// Sub-millisecond in-memory cache exports (points to default isolate bucket)
export const memUserCache = fallbackBucket.user;
export const memSessionCache = fallbackBucket.session;
export const memConvCache = fallbackBucket.conv;
export const memGlobalCache = fallbackBucket.global;
export const memAgentCache = fallbackBucket.agent;
export const memToolUrlsCache = fallbackBucket.toolUrls;

/**
 * Clear all in-memory caches (useful for testing or cache purge)
 */
export function clearAllMemoryCaches(db?: D1Database): void {
  if (db && typeof db === "object") {
    dbCacheStore.delete(db);
  }
  fallbackBucket.user.clear();
  fallbackBucket.session.clear();
  fallbackBucket.conv.clear();
  fallbackBucket.global.clear();
  fallbackBucket.agent.clear();
  fallbackBucket.toolUrls.clear();
}

/**
 * D1 database cache helper using env.DB.
 * Automatically initializes tables and provides get, put, and delete methods
 * for user and session data.
 */
export class D1Data360Cache {
  private static schemasInitialized = new WeakSet<object>();

  constructor(private readonly db?: D1Database) {}

  public get bucket(): MemoryCacheBucket {
    return getCacheBucket(this.db);
  }

  async ensureSchema(): Promise<void> {
    if (!this.db || typeof this.db !== "object") return;
    if (D1Data360Cache.schemasInitialized.has(this.db)) return;
    try {
      await this.db
        .prepare(`
          CREATE TABLE IF NOT EXISTS data360_user_cache (
            user_id TEXT PRIMARY KEY,
            org_id TEXT,
            data TEXT NOT NULL,
            etag TEXT,
            updated_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `)
        .run();
      await this.db
        .prepare(`
          CREATE TABLE IF NOT EXISTS data360_session_cache (
            session_id TEXT PRIMARY KEY,
            org_id TEXT,
            data TEXT NOT NULL,
            etag TEXT,
            updated_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `)
        .run();
      await this.db
        .prepare(`
          CREATE TABLE IF NOT EXISTS data360_conversation_cache (
            user_id TEXT PRIMARY KEY,
            org_id TEXT,
            data TEXT NOT NULL,
            etag TEXT,
            session_count INTEGER DEFAULT 0,
            total_messages INTEGER DEFAULT 0,
            updated_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `)
        .run();
      await this.db
        .prepare(`
          CREATE TABLE IF NOT EXISTS data360_global_cache (
            target_id TEXT PRIMARY KEY,
            org_id TEXT,
            data TEXT NOT NULL,
            etag TEXT,
            updated_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `)
        .run();
      await this.db
        .prepare(`
          CREATE TABLE IF NOT EXISTS data360_agent_code_cache (
            agent_key TEXT PRIMARY KEY,
            org_id TEXT,
            data TEXT NOT NULL,
            etag TEXT,
            updated_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `)
        .run();
      await this.db
        .prepare(`
          CREATE TABLE IF NOT EXISTS data360_tool_urls_cache (
            channel_id TEXT PRIMARY KEY,
            org_id TEXT,
            urls TEXT NOT NULL,
            etag TEXT,
            updated_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL
          )
        `)
        .run();
      D1Data360Cache.schemasInitialized.add(this.db);
    } catch (err) {
      console.warn("ensureSchema error:", err);
      D1Data360Cache.schemasInitialized.add(this.db);
    }
  }

  async getUserETag(userId: string): Promise<string | null> {
    const mem = this.bucket.user.get(userId);
    const now = Date.now();
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.etag;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT etag, expires_at FROM data360_user_cache WHERE user_id = ?")
        .bind(userId)
        .first<{ etag: string | null; expires_at: number }>();

      if (!row || !row.etag) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteUser(userId).catch(() => {});
        return null;
      }
      return row.etag;
    } catch {
      return null;
    }
  }

  async getUser(userId: string): Promise<any | null> {
    const now = Date.now();
    const mem = this.bucket.user.get(userId);
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.data;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT data, etag, expires_at FROM data360_user_cache WHERE user_id = ?")
        .bind(userId)
        .first<{ data: string; etag: string | null; expires_at: number }>();

      if (!row) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteUser(userId).catch(() => {});
        return null;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        parsed = row.data;
      }
      this.bucket.user.set(userId, { data: parsed, etag: row.etag || "", expiresAt: row.expires_at });
      return parsed;
    } catch {
      return null;
    }
  }

  async putUser(
    userId: string,
    data: any,
    options?: { orgId?: string; ttlSeconds?: number; etag?: string }
  ): Promise<void> {
    const now = Date.now();
    const ttlSeconds = options?.ttlSeconds ?? 300;
    const expiresAt = ttlSeconds > 0 ? now + ttlSeconds * 1000 : 0;
    const orgId = options?.orgId || null;
    const dataStr = typeof data === "string" ? data : JSON.stringify(data);
    const etag = options?.etag || (await computeETag(dataStr));
    let parsed: any;
    try {
      parsed = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      parsed = data;
    }

    this.bucket.user.set(userId, { data: parsed, etag, expiresAt });

    if (!this.db) return;
    await this.ensureSchema();

    await this.db
      .prepare(`
        INSERT INTO data360_user_cache (user_id, org_id, data, etag, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          org_id = excluded.org_id,
          data = excluded.data,
          etag = excluded.etag,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `)
      .bind(userId, orgId, dataStr, etag, now, expiresAt)
      .run();
  }

  async deleteUser(userId: string): Promise<boolean> {
    this.bucket.user.delete(userId);
    if (!this.db) return false;
    await this.ensureSchema();
    try {
      const res = await this.db
        .prepare("DELETE FROM data360_user_cache WHERE user_id = ?")
        .bind(userId)
        .run();
      return (res?.meta?.changes ?? 1) > 0;
    } catch {
      return false;
    }
  }

  async getSessionETag(sessionId: string): Promise<string | null> {
    const mem = this.bucket.session.get(sessionId);
    const now = Date.now();
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.etag;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT etag, expires_at FROM data360_session_cache WHERE session_id = ?")
        .bind(sessionId)
        .first<{ etag: string | null; expires_at: number }>();

      if (!row || !row.etag) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteSession(sessionId).catch(() => {});
        return null;
      }
      return row.etag;
    } catch {
      return null;
    }
  }

  async getSession(sessionId: string): Promise<any | null> {
    const now = Date.now();
    const mem = this.bucket.session.get(sessionId);
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.data;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT data, etag, expires_at FROM data360_session_cache WHERE session_id = ?")
        .bind(sessionId)
        .first<{ data: string; etag: string | null; expires_at: number }>();

      if (!row) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteSession(sessionId).catch(() => {});
        return null;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        parsed = row.data;
      }
      this.bucket.session.set(sessionId, { data: parsed, etag: row.etag || "", expiresAt: row.expires_at });
      return parsed;
    } catch {
      return null;
    }
  }

  async putSession(
    sessionId: string,
    data: any,
    options?: { orgId?: string; ttlSeconds?: number; etag?: string }
  ): Promise<void> {
    const now = Date.now();
    const ttlSeconds = options?.ttlSeconds ?? 300;
    const expiresAt = ttlSeconds > 0 ? now + ttlSeconds * 1000 : 0;
    const orgId = options?.orgId || null;
    const dataStr = typeof data === "string" ? data : JSON.stringify(data);
    const etag = options?.etag || (await computeETag(dataStr));
    let parsed: any;
    try {
      parsed = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      parsed = data;
    }

    this.bucket.session.set(sessionId, { data: parsed, etag, expiresAt });

    if (!this.db) return;
    await this.ensureSchema();

    await this.db
      .prepare(`
        INSERT INTO data360_session_cache (session_id, org_id, data, etag, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          org_id = excluded.org_id,
          data = excluded.data,
          etag = excluded.etag,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `)
      .bind(sessionId, orgId, dataStr, etag, now, expiresAt)
      .run();
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    this.bucket.session.delete(sessionId);
    if (!this.db) return false;
    await this.ensureSchema();
    try {
      const res = await this.db
        .prepare("DELETE FROM data360_session_cache WHERE session_id = ?")
        .bind(sessionId)
        .run();
      return (res?.meta?.changes ?? 1) > 0;
    } catch {
      return false;
    }
  }

  async getConversationETag(userId: string): Promise<string | null> {
    const mem = this.bucket.conv.get(userId);
    const now = Date.now();
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.etag || null;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT etag, expires_at FROM data360_conversation_cache WHERE user_id = ?")
        .bind(userId)
        .first<{ etag: string | null; expires_at: number }>();

      if (!row || !row.etag) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteConversationHistory(userId).catch(() => {});
        return null;
      }
      return row.etag;
    } catch {
      return null;
    }
  }

  async getConversationHistory(userId: string): Promise<any | null> {
    const mem = this.bucket.conv.get(userId);
    const now = Date.now();
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.data;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT data, etag, expires_at FROM data360_conversation_cache WHERE user_id = ?")
        .bind(userId)
        .first<{ data: string; etag: string | null; expires_at: number }>();

      if (!row) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteConversationHistory(userId).catch(() => {});
        return null;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        parsed = row.data;
      }
      this.bucket.conv.set(userId, { data: parsed, etag: row.etag || "", expiresAt: row.expires_at });
      return parsed;
    } catch {
      return null;
    }
  }

  async putConversationHistory(
    userId: string,
    data: any,
    options?: {
      orgId?: string;
      ttlSeconds?: number;
      etag?: string;
      sessionCount?: number;
      totalMessages?: number;
    }
  ): Promise<void> {
    const now = Date.now();
    const ttlSeconds = options?.ttlSeconds ?? 300;
    const expiresAt = ttlSeconds > 0 ? now + ttlSeconds * 1000 : 0;
    const orgId = options?.orgId || null;
    const dataStr = typeof data === "string" ? data : JSON.stringify(data);
    const etag = options?.etag || (await computeETag(dataStr));
    const sessionCount = options?.sessionCount ?? (Array.isArray(data?.sessions) ? data.sessions.length : 0);
    const totalMessages = options?.totalMessages ?? data?.totalMessages ?? 0;
    let parsed: any;
    try {
      parsed = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      parsed = data;
    }

    this.bucket.conv.set(userId, { data: parsed, etag, expiresAt });

    if (!this.db) return;
    await this.ensureSchema();

    await this.db
      .prepare(`
        INSERT INTO data360_conversation_cache (user_id, org_id, data, etag, session_count, total_messages, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          org_id = excluded.org_id,
          data = excluded.data,
          etag = excluded.etag,
          session_count = excluded.session_count,
          total_messages = excluded.total_messages,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `)
      .bind(userId, orgId, dataStr, etag, sessionCount, totalMessages, now, expiresAt)
      .run();
  }

  async deleteConversationHistory(userId: string): Promise<boolean> {
    this.bucket.conv.delete(userId);
    if (!this.db) return false;
    await this.ensureSchema();
    try {
      const res = await this.db
        .prepare("DELETE FROM data360_conversation_cache WHERE user_id = ?")
        .bind(userId)
        .run();
      return (res?.meta?.changes ?? 1) > 0;
    } catch {
      return false;
    }
  }

  async getGlobalETag(targetId: string): Promise<string | null> {
    const mem = this.bucket.global.get(targetId);
    const now = Date.now();
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.etag || null;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT etag, expires_at FROM data360_global_cache WHERE target_id = ?")
        .bind(targetId)
        .first<{ etag: string | null; expires_at: number }>();

      if (!row || !row.etag) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteGlobalData360(targetId).catch(() => {});
        return null;
      }
      return row.etag;
    } catch {
      return null;
    }
  }

  async getGlobalData360(targetId: string): Promise<any | null> {
    const mem = this.bucket.global.get(targetId);
    const now = Date.now();
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.data;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT data, etag, expires_at FROM data360_global_cache WHERE target_id = ?")
        .bind(targetId)
        .first<{ data: string; etag: string | null; expires_at: number }>();

      if (!row) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteGlobalData360(targetId).catch(() => {});
        return null;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        parsed = row.data;
      }
      this.bucket.global.set(targetId, { data: parsed, etag: row.etag || "", expiresAt: row.expires_at });
      return parsed;
    } catch {
      return null;
    }
  }

  async putGlobalData360(
    targetId: string,
    data: any,
    options?: { orgId?: string; ttlSeconds?: number; etag?: string }
  ): Promise<void> {
    const now = Date.now();
    const ttlSeconds = options?.ttlSeconds ?? 600; // Global data can be cached longer by default (10m)
    const expiresAt = ttlSeconds > 0 ? now + ttlSeconds * 1000 : 0;
    const orgId = options?.orgId || null;
    const dataStr = typeof data === "string" ? data : JSON.stringify(data);
    const etag = options?.etag || (await computeETag(dataStr));
    let parsed: any;
    try {
      parsed = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      parsed = data;
    }

    this.bucket.global.set(targetId, { data: parsed, etag, expiresAt });

    if (!this.db) return;
    await this.ensureSchema();

    await this.db
      .prepare(`
        INSERT INTO data360_global_cache (target_id, org_id, data, etag, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_id) DO UPDATE SET
          org_id = excluded.org_id,
          data = excluded.data,
          etag = excluded.etag,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `)
      .bind(targetId, orgId, dataStr, etag, now, expiresAt)
      .run();
  }

  async deleteGlobalData360(targetId: string): Promise<boolean> {
    this.bucket.global.delete(targetId);
    if (!this.db) return false;
    await this.ensureSchema();
    try {
      const res = await this.db
        .prepare("DELETE FROM data360_global_cache WHERE target_id = ?")
        .bind(targetId)
        .run();
      return (res?.meta?.changes ?? 1) > 0;
    } catch {
      return false;
    }
  }

  // --- Smart Agent Code Caching (Precompiled CEL AST & Rules) ---

  async getAgentCodeETag(agentKey: string): Promise<string | null> {
    const mem = this.bucket.agent.get(agentKey);
    const now = Date.now();
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.etag || null;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT etag, expires_at FROM data360_agent_code_cache WHERE agent_key = ?")
        .bind(agentKey)
        .first<{ etag: string | null; expires_at: number }>();

      if (!row || !row.etag) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteAgentCode(agentKey).catch(() => {});
        return null;
      }
      return row.etag;
    } catch {
      return null;
    }
  }

  async getAgentCode(agentKey: string): Promise<any | null> {
    const mem = this.bucket.agent.get(agentKey);
    const now = Date.now();
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.data;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT data, etag, expires_at FROM data360_agent_code_cache WHERE agent_key = ?")
        .bind(agentKey)
        .first<{ data: string; etag: string | null; expires_at: number }>();

      if (!row) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteAgentCode(agentKey).catch(() => {});
        return null;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(row.data);
      } catch {
        parsed = row.data;
      }
      this.bucket.agent.set(agentKey, { data: parsed, etag: row.etag || "", expiresAt: row.expires_at });
      return parsed;
    } catch {
      return null;
    }
  }

  async putAgentCode(
    agentKey: string,
    data: any,
    options?: { orgId?: string; ttlSeconds?: number; etag?: string }
  ): Promise<void> {
    const now = Date.now();
    // Default 24 hours TTL for compiled agent code
    const ttlSeconds = options?.ttlSeconds ?? 86400;
    const expiresAt = ttlSeconds > 0 ? now + ttlSeconds * 1000 : 0;
    const orgId = options?.orgId || null;
    const dataStr = typeof data === "string" ? data : JSON.stringify(data);
    const etag = options?.etag || (await computeETag(dataStr));
    let parsed: any;
    try {
      parsed = typeof data === "string" ? JSON.parse(data) : data;
    } catch {
      parsed = data;
    }

    this.bucket.agent.set(agentKey, { data: parsed, etag, expiresAt });

    if (!this.db) return;
    await this.ensureSchema();

    await this.db
      .prepare(`
        INSERT INTO data360_agent_code_cache (agent_key, org_id, data, etag, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_key) DO UPDATE SET
          org_id = excluded.org_id,
          data = excluded.data,
          etag = excluded.etag,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `)
      .bind(agentKey, orgId, dataStr, etag, now, expiresAt)
      .run();
  }

  async deleteAgentCode(agentKey: string): Promise<boolean> {
    this.bucket.agent.delete(agentKey);
    if (!this.db) return false;
    await this.ensureSchema();
    try {
      const res = await this.db
        .prepare("DELETE FROM data360_agent_code_cache WHERE agent_key = ?")
        .bind(agentKey)
        .run();
      return (res?.meta?.changes ?? 1) > 0;
    } catch {
      return false;
    }
  }

  // --- Smart Tool Call URLs Caching (Proxy URLs from retrieve64 / tubot-sf-auth) ---

  async getToolUrlsETag(channelId: string): Promise<string | null> {
    const mem = this.bucket.toolUrls.get(channelId);
    const now = Date.now();
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.etag || null;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT etag, expires_at FROM data360_tool_urls_cache WHERE channel_id = ?")
        .bind(channelId)
        .first<{ etag: string | null; expires_at: number }>();

      if (!row || !row.etag) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteToolUrls(channelId).catch(() => {});
        return null;
      }
      return row.etag;
    } catch {
      return null;
    }
  }

  async getToolUrls(channelId: string): Promise<string[] | null> {
    const mem = this.bucket.toolUrls.get(channelId);
    const now = Date.now();
    if (mem && (mem.expiresAt === 0 || mem.expiresAt > now)) {
      return mem.data;
    }

    if (!this.db) return null;
    await this.ensureSchema();
    try {
      const row = await this.db
        .prepare("SELECT urls, etag, expires_at FROM data360_tool_urls_cache WHERE channel_id = ?")
        .bind(channelId)
        .first<{ urls: string; etag: string | null; expires_at: number }>();

      if (!row) return null;
      if (row.expires_at > 0 && row.expires_at < now) {
        await this.deleteToolUrls(channelId).catch(() => {});
        return null;
      }
      let parsedUrls: string[] = [];
      try {
        const parsed = JSON.parse(row.urls);
        parsedUrls = Array.isArray(parsed) ? parsed : [];
      } catch {
        parsedUrls = [];
      }
      this.bucket.toolUrls.set(channelId, { data: parsedUrls, etag: row.etag || "", expiresAt: row.expires_at });
      return parsedUrls;
    } catch {
      return null;
    }
  }

  async putToolUrls(
    channelId: string,
    urls: string[],
    options?: { orgId?: string; ttlSeconds?: number; etag?: string }
  ): Promise<void> {
    const now = Date.now();
    // Default 1 hour TTL for callable tool endpoints
    const ttlSeconds = options?.ttlSeconds ?? 3600;
    const expiresAt = ttlSeconds > 0 ? now + ttlSeconds * 1000 : 0;
    const orgId = options?.orgId || null;
    const urlsStr = JSON.stringify(urls || []);
    const etag = options?.etag || (await computeETag(urlsStr));

    this.bucket.toolUrls.set(channelId, { data: urls || [], etag, expiresAt });

    if (!this.db) return;
    await this.ensureSchema();

    await this.db
      .prepare(`
        INSERT INTO data360_tool_urls_cache (channel_id, org_id, urls, etag, updated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          org_id = excluded.org_id,
          urls = excluded.urls,
          etag = excluded.etag,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at
      `)
      .bind(channelId, orgId, urlsStr, etag, now, expiresAt)
      .run();
  }

  async deleteToolUrls(channelId: string): Promise<boolean> {
    this.bucket.toolUrls.delete(channelId);
    if (!this.db) return false;
    await this.ensureSchema();
    try {
      const res = await this.db
        .prepare("DELETE FROM data360_tool_urls_cache WHERE channel_id = ?")
        .bind(channelId)
        .run();
      return (res?.meta?.changes ?? 1) > 0;
    } catch {
      return false;
    }
  }
}

