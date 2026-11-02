/** Test-only helper: builds HMAC-signed HTTP requests for the data360 HTTP
 * gate (service mode). Signs with the panel mesh signer — the same wire
 * format production service callers use — so gate tests exercise the real
 * verifier (timestamp window, single-use nonces, body digest).
 *
 * NOTE: the HTTP gate verifies `METHOD + pathname` (no query string), so the
 * signature covers the pathname exactly like production binding callers do.
 */

export async function signedRequest(
  env: { DATA360_INTERNAL_KEY?: string },
  method: string,
  url: string,
  opts?: { body?: unknown; headers?: Record<string, string> },
): Promise<Request> {
  const { signServiceRequest } = await import("../../../tubot-new-panel/worker/service-signer");
  const hasBody = method !== "GET" && method !== "HEAD";
  const rawBody =
    !hasBody || opts?.body === undefined
      ? ""
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  const path = new URL(url).pathname;
  const sig = await signServiceRequest(env.DATA360_INTERNAL_KEY!, method, path, rawBody);
  const headers: Record<string, string> = { ...(opts?.headers || {}), ...sig };
  if (hasBody && rawBody && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = "application/json";
  }
  return new Request(url, {
    method,
    headers,
    body: hasBody ? rawBody : undefined,
  });
}

/** Minimal mock D1 for gate-only tests: single-use nonce claims plus schema
 * no-ops. Suites that touch cache tables keep their own richer mocks. */
export function createGateMockD1(): D1Database {
  const nonces = new Map<string, number>();
  const stmt = (sql: string) => ({
    bind: (...args: any[]) => ({
      first: async () => null,
      run: async () => {
        const lower = sql.toLowerCase();
        if (lower.includes("salesforce_self_oauth_internal_nonce")) {
          if (lower.startsWith("delete ")) {
            for (const [k, v] of nonces) if (v <= args[0]) nonces.delete(k);
            return { success: true, meta: { changes: 0 } };
          }
          if (nonces.has(args[0])) return { success: true, meta: { changes: 0 } };
          nonces.set(args[0], args[1]);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    }),
    run: async () => ({ success: true, meta: { changes: 0 } }),
  });
  return {
    exec: async () => ({ count: 0, duration: 0 }),
    prepare: stmt,
  } as unknown as D1Database;
}
