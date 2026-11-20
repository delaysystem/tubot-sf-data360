import { describe, it, expect } from "vitest";
import { decideRefreshResume } from "../src/index";
import type { ExportManifest } from "../src/types";

describe("decideRefreshResume", () => {
  const base = (pending?: unknown) => ({ pendingAgentRetrieve: pending }) as unknown as ExportManifest;

  it("resumes a well-formed pending handle", () => {
    expect(decideRefreshResume(base({
      asyncId: "09S000000000001", apiVersion: "65.0", agent: "CoolAgent", attempts: 10, startedAt: "2026-10-15T00:00:00Z",
    }))).toEqual({ asyncId: "09S000000000001", apiVersion: "65.0" });
  });

  it("drops malformed handles and empty manifests", () => {
    expect(decideRefreshResume(undefined)).toBeNull();
    expect(decideRefreshResume(null)).toBeNull();
    expect(decideRefreshResume(base(undefined))).toBeNull();
    expect(decideRefreshResume(base({ asyncId: "../../x", apiVersion: "65.0" }))).toBeNull();
    expect(decideRefreshResume(base({ asyncId: "09S000000000001", apiVersion: "v65" }))).toBeNull();
    expect(decideRefreshResume(base({ asyncId: "short", apiVersion: "65.0" }))).toBeNull();
  });
});
