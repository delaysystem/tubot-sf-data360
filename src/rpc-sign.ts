// Central RPC-signing helper for tubot-sf-auth service-binding calls.
//
// Frozen contract: every auth RPC call appends a TRAILING arg named `signed`
// carrying {caller, org, timestamp, nonce, signature}.
//   orgKey = HKDF-SHA256(callerKey, salt "tubot-rpc-org-v1", info caller + "\n" + org)
//   canonical = caller + "\n" + org + "\n" + method + "\n" + timestamp + "\n" + nonce + "\n" + argsDigest
//   argsDigest = lowercase hex sha256 of stableJson(businessArgsArray)
//   signature = base64url(HMAC-SHA256(orgKey, canonical)) via WebCrypto subtle.
// The signer throws fail-fast (never sends unsigned) when SF_AUTH_CALLER_KEY
// is missing or shorter than 32 chars, or the org id is malformed.

export const RPC_SIGNER_CALLER_ID = "data360";
export const RPC_SIGNER_MIN_KEY_LENGTH = 32;

export interface RpcSignedEnvelope {
  caller: string;
  org: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

export function stableJson(v: any): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (v instanceof Uint8Array) return JSON.stringify(Array.from(v));
  if (Array.isArray(v)) return "[" + v.map(stableJson).join(",") + "]";
  const o = v;
  return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + stableJson(o[k])).join(",") + "}";
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function randomNonce(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function resolveCallerKey(env: { SF_AUTH_CALLER_KEY?: unknown }): string {
  const key = env.SF_AUTH_CALLER_KEY;
  if (typeof key !== "string" || key.length < RPC_SIGNER_MIN_KEY_LENGTH) {
    throw new Error("SF_AUTH_CALLER_KEY is missing or too short; refusing to send unsigned RPC.");
  }
  return key;
}

const ORG_RE = /^[A-Za-z0-9]{15,18}$/;

/** Fail-fast org check: throws on a malformed Salesforce org id. */
export function assertOrgId(org: unknown): string {
  if (typeof org !== "string" || !ORG_RE.test(org)) {
    throw new Error("RPC org is missing or malformed; refusing to send unsigned RPC.");
  }
  return org;
}

/** Per-org HMAC key: HKDF-SHA256(masterKey, "tubot-rpc-org-v1", caller + "\n" + orgId). */
export async function deriveOrgKey(masterKey: string, caller: string, orgId: string): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey("raw", new TextEncoder().encode(masterKey), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("tubot-rpc-org-v1"),
      info: new TextEncoder().encode(caller + "\n" + orgId) },
    ikm, 256);
  return new Uint8Array(bits);
}

export async function signRpcEnvelope(args: {
  caller: string;
  callerKey: string;
  org: string;
  method: string;
  businessArgs: unknown[];
  timestamp?: string;
  nonce?: string;
}): Promise<RpcSignedEnvelope> {
  if (typeof args.callerKey !== "string" || args.callerKey.length < RPC_SIGNER_MIN_KEY_LENGTH) {
    throw new Error("SF_AUTH_CALLER_KEY is missing or too short; refusing to send unsigned RPC.");
  }
  assertOrgId(args.org);
  const timestamp = args.timestamp ?? Math.floor(Date.now() / 1000).toString();
  const nonce = args.nonce ?? randomNonce();
  const argsDigest = await sha256Hex(stableJson(args.businessArgs));
  const canonical = args.caller + "\n" + args.org + "\n" + args.method + "\n" + timestamp + "\n" + nonce + "\n" + argsDigest;
  const orgKey = await deriveOrgKey(args.callerKey, args.caller, args.org);
  const cryptoKey = await crypto.subtle.importKey(
    "raw", orgKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(canonical));
  return { caller: args.caller, org: args.org, timestamp, nonce, signature: base64UrlEncode(new Uint8Array(sig)) };
}
