import { afterEach, describe, expect, it, vi } from "vitest";
import { syncToken } from "../lib/sync-trigger";

const runPayingSync = vi.fn();
vi.mock("../lib/paying-sync-live", () => ({ runPayingSync }));

const call = async () => {
  const { default: handler } = await import("../netlify/functions/paying-sync-background.mjs");
  return handler(new Request("http://x", { method: "POST", headers: { "x-paying-sync-token": syncToken("sk_test") } }));
};

afterEach(() => {
  vi.unstubAllEnvs();
  runPayingSync.mockReset();
});

describe("paying-sync-background", () => {
  it("throws after a failed discovery, so Netlify retries", async () => {
    vi.stubEnv("STRIPE_API_KEY", "sk_test");
    runPayingSync.mockResolvedValueOnce({ discovery: "failed" });
    await expect(call()).rejects.toThrow(/discovery failed/);
  });

  it("returns normally otherwise", async () => {
    vi.stubEnv("STRIPE_API_KEY", "sk_test");
    runPayingSync.mockResolvedValueOnce({ discovery: "ok", crm: "failed", airtable: "failed" });
    await expect(call()).resolves.toBeUndefined();
  });

  it("does not run without the token", async () => {
    vi.stubEnv("STRIPE_API_KEY", "sk_other");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await call();
    expect(runPayingSync).not.toHaveBeenCalled();
  });
});
