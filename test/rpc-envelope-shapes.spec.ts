import { describe, it, expect } from "vitest";
import { verifyRpcEnvelope, normalizeRpcEnvelope } from "../src/service-verify";
import { signRpcEnvelope } from "../../tubot-new-panel/worker/service-signer";

const KEY = "test-mesh-key-0123456789abcdef0123456789";

/** Minimal NonceDb: single-use nonces in memory. */
function mockNonceDb() {
  const claimed = new Set<string>();
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) { bound = args; return stmt; },
        async run() {
          const lower = sql.toLowerCase();
          if (lower.includes("create table")) return { meta: { changes: 0 } };
          if (lower.includes("delete from")) return { meta: { changes: 0 } };
          if (lower.includes("insert or ignore")) {
            const key = String(bound[0]);
            if (claimed.has(key)) return { meta: { changes: 0 } };
            claimed.add(key);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return stmt;
    },
  };
}

describe("verifyRpcEnvelope shape tolerance", () => {
  it("accepts raw panel signer output (header-named fields)", async () => {
    const args = [{ agentName: "Coral_Cloud_Employee_Agent" }];
    const headers = await signRpcEnvelope(KEY, "extractData360", args);
    expect(headers).toHaveProperty("x-tubot-sig-signature");
    const ok = await verifyRpcEnvelope([KEY], mockNonceDb() as any, "extractData360", args, headers);
    expect(ok).toBe(true);
  });

  it("accepts bare {timestamp, nonce, signature} envelopes", async () => {
    const args = [{ agentName: "Coral_Cloud_Employee_Agent" }];
    const h = await signRpcEnvelope(KEY, "extractData360", args);
    const bare = normalizeRpcEnvelope(h);
    expect(bare).toEqual({
      timestamp: h["x-tubot-sig-timestamp"],
      nonce: h["x-tubot-sig-nonce"],
      signature: h["x-tubot-sig-signature"],
    });
    const ok = await verifyRpcEnvelope([KEY], mockNonceDb() as any, "extractData360", args, bare);
    expect(ok).toBe(true);
  });

  it("still rejects tampered and replayed envelopes", async () => {
    const args = [{ agentName: "Coral_Cloud_Employee_Agent" }];
    const db = mockNonceDb() as any;
    const h = await signRpcEnvelope(KEY, "extractData360", args);
    expect(await verifyRpcEnvelope([KEY], db, "extractData360", args, h)).toBe(true);
    // Replay the same nonce: rejected.
    expect(await verifyRpcEnvelope([KEY], db, "extractData360", args, h)).toBe(false);
    // Tampered body: rejected.
    const h2 = await signRpcEnvelope(KEY, "extractData360", args);
    expect(await verifyRpcEnvelope([KEY], mockNonceDb() as any, "extractData360", [{ agentName: "Other" }], h2)).toBe(false);
  });
});
