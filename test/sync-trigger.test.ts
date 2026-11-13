import { describe, expect, it } from "vitest";
import { isSyncTokenValid, syncToken } from "../lib/sync-trigger";

describe("sync trigger token", () => {
  it("accepts the token for the same key only", () => {
    expect(isSyncTokenValid(syncToken("sk_a"), "sk_a")).toBe(true);
    expect(isSyncTokenValid(syncToken("sk_b"), "sk_a")).toBe(false);
    expect(isSyncTokenValid(null, "sk_a")).toBe(false);
    expect(isSyncTokenValid("short", "sk_a")).toBe(false);
  });
});
