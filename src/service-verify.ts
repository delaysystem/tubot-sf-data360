/** Verifier half of the worker-to-worker fetch HMAC (see panel
 * worker/service-signer.ts for the signing half and wire format).
 *
 * Canonical string: METHOD + "\n" + path + "\n" + timestamp + "\n" + nonce +
 * "\n" + hex(sha256(rawBody)). Headers x-tubot-sig-timestamp/nonce/signature.
 * Nonces are single-use via the shared salesforce_self_oauth_internal_nonce
 * D1 table (same table the auth fetch/RPC HMACs use; present in both shared
 * DBs, so no migration is needed).
 */

export const SIG_TIMESTAMP_RE = /^\d{10}$/;
export const SIG_NONCE_RE = /^[A-Za-z0-9_-]{24}$/;
export const SIG_SIGNATURE_RE = /^[A-Za-z0-9_-]{43}$/;
export const SIG_TIMESTAMP_WINDOW_SEC = 60;
export const SIG_NONCE_TTL_SEC = 120;

export interface ServiceSigHeaders {
  timestamp: string;
  nonce: string;
  signature: string;
}

export function readSigHeaders(headers: Headers): ServiceSigHeaders | null {
  const timestamp = headers.get("x-tubot-sig-timestamp") || "";
  const nonce = headers.get("x-tubot-sig-nonce") || "";
  const signature = headers.get("x-tubot-sig-signature") || "";
  if (!timestamp && !nonce && !signature) return null;
  return { timestamp, nonce, signature };
}

/** RPC envelopes: bare names, or raw panel signer output (header names). */
export type RpcEnvelopeInput = ServiceSigHeaders | {
  "x-tubot-sig-timestamp"?: unknown;
  "x-tubot-sig-nonce"?: unknown;
  "x-tubot-sig-signature"?: unknown;
};

/** Normalizes either envelope shape to bare names; garbage stays garbage (rejected downstream). */
export function normalizeRpcEnvelope(envelope: RpcEnvelopeInput | undefined | null): ServiceSigHeaders | undefined {
  if (!envelope || typeof envelope !== "object") return undefined;
  const e = envelope as Record<string, unknown>;
  return {
    timestamp: (e.timestamp ?? e["x-tubot-sig-timestamp"] ?? "") as string,
    nonce: (e.nonce ?? e["x-tubot-sig-nonce"] ?? "") as string,
    signature: (e.signature ?? e["x-tubot-sig-signature"] ?? "") as string,
  };
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Hex(data: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function timingSafeEqualHex(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const xa = new Uint8Array(da);
  const xb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= xa[i] ^ xb[i];
  return diff === 0;
}

export function serviceSignatureCanonical(
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  bodyDigest: string,
): string {
  return `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyDigest}`;
}

/** Pure crypto check (no D1). Returns true when any key verifies. */
export async function verifyServiceSignature(
  keys: string[],
  method: string,
  path: string,
  bodyText: string,
  sig: ServiceSigHeaders,
  nowSec: number,
): Promise<boolean> {
  if (!SIG_TIMESTAMP_RE.test(sig.timestamp) || !SIG_NONCE_RE.test(sig.nonce) || !SIG_SIGNATURE_RE.test(sig.signature)) {
    return false;
  }
  const ts = Number(sig.timestamp);
  if (!Number.isSafeInteger(ts) || Math.abs(nowSec - ts) > SIG_TIMESTAMP_WINDOW_SEC) return false;
  const bodyDigest = await sha256Hex(bodyText);
  const canonical = serviceSignatureCanonical(method, path, sig.timestamp, sig.nonce, bodyDigest);
  for (const key of keys) {
    if (typeof key !== "string" || key.length < 32) continue;
    const cryptoKey = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const raw = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(canonical));
    if (await timingSafeEqualHex(base64url(new Uint8Array(raw)), sig.signature)) return true;
  }
  return false;
}

export interface NonceDb {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
    };
    run(): Promise<{ meta?: { changes?: number } }>;
  };
}

/** RPC caller auth: same mesh key as the fetch HMAC, canonicalized over the
 * method name and JSON args. Envelopes are produced by signRpcEnvelope
 * (panel worker/service-signer.ts). No keys, DB, or envelope fails closed. */
export async function verifyRpcEnvelope(
  keys: string[],
  db: NonceDb | undefined,
  method: string,
  args: unknown,
  envelope: RpcEnvelopeInput | undefined,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const bare = normalizeRpcEnvelope(envelope);
  if (!bare || !db || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(method)) return false;
  const validKeys = keys.filter((k): k is string => typeof k === "string" && k.length >= 32);
  if (validKeys.length === 0) return false;
  const bodyText = JSON.stringify(args ?? null);
  return (await verifyServiceSignature(validKeys, "RPC", `/rpc/${method}`, bodyText, bare, nowSec)) &&
    (await claimServiceNonce(db, bare.nonce, nowSec));
}

const nonceSchemasInitialized = new WeakSet<object>();

/** Idempotent nonce-table DDL (table + expiry index), once per DB handle.
 * F10: the per-RPC expired-nonce DELETE was an unindexed SCAN scaling with
 * live nonces; the expires_at index turns it into a SEARCH. */
export async function ensureNonceSchema(db: NonceDb): Promise<void> {
  if (!db || typeof db !== "object" || nonceSchemasInitialized.has(db)) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS salesforce_self_oauth_internal_nonce (nonce_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS salesforce_self_oauth_internal_nonce_expiry_idx ON salesforce_self_oauth_internal_nonce (expires_at)").run();
  nonceSchemasInitialized.add(db);
}

/** Single-use nonce claim. Returns false on replay (or D1 failure fail-closed by caller choice). */
export async function claimServiceNonce(db: NonceDb, nonce: string, nowSec: number): Promise<boolean> {
  await ensureNonceSchema(db);
  const nonceHash = await sha256Hex(`sig-nonce:${nonce}`);
  await db.prepare("DELETE FROM salesforce_self_oauth_internal_nonce WHERE expires_at <= ?").bind(nowSec).run();
  const inserted = await db.prepare(
    "INSERT OR IGNORE INTO salesforce_self_oauth_internal_nonce (nonce_hash, expires_at) VALUES (?, ?)",
  ).bind(nonceHash, nowSec + SIG_NONCE_TTL_SEC).run();
  return (inserted.meta?.changes ?? 0) === 1;
}
