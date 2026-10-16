import { describe, it, expect } from "vitest";
import { TubotSfData360Entrypoint } from "../src/index";

const RPC_METHODS = [
  "exportData360Zip", "extractData360", "getLatestCache", "queryCache",
  "downloadCachedZip", "listSnapshots", "getUserData360", "saveUserData360",
  "getMessagingSessionData360", "saveMessagingSessionData360", "purgeCache",
  "getUserETag", "getSessionETag", "getConversationETag", "getGlobalETag",
  "getCorrespondingData", "getContext", "getContextWithMeta", "getAgentCode",
  "getToolUrls",
];

describe("data360 RPC caller auth", () => {
  it("exposes exactly the guarded method set", () => {
    const names = Object.getOwnPropertyNames(TubotSfData360Entrypoint.prototype)
      .filter(n => n !== "constructor" && typeof (TubotSfData360Entrypoint.prototype as any)[n] === "function");
    expect(names.sort()).toEqual([...RPC_METHODS].sort());
  });

  it("every method rejects envelope-less calls before any side effect", async () => {
    const sabotaged = { DB: { prepare() { throw new Error("D1 must not be touched before the guard"); } } };
    const entrypoint = new TubotSfData360Entrypoint({}, sabotaged) as unknown as Record<string, (...a: never[]) => Promise<unknown>>;
    for (const name of RPC_METHODS) {
      await expect(entrypoint[name]()).rejects.toThrow("data360_rpc_unauthorized");
    }
  });
});
