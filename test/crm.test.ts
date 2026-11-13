import { afterEach, describe, expect, it, vi } from "vitest";
import { callCrm, crmConfigFromEnv, reconcilePayingInCrm } from "../lib/crm";
import { MEM, REC } from "./helpers";

const CONFIG = { url: "https://crm.test", key: "secret-key" };
const FAR = Date.now() + 3_600_000;

function answers(...rows: unknown[]) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ values: [rows.shift()] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const ok = (fields: Record<string, unknown>) => ({ status: "ok", set_true: 0, set_false: 0, ...fields });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("crmConfigFromEnv", () => {
  it("needs both settings and drops a trailing slash", () => {
    expect(crmConfigFromEnv({ CRM_URL: "https://crm.test/", CRM_STRIPE_WEBHOOK_KEY: "k" })).toEqual({
      url: "https://crm.test",
      key: "k",
    });
    expect(crmConfigFromEnv({ CRM_URL: "https://crm.test" })).toBeNull();
    expect(crmConfigFromEnv({ CRM_STRIPE_WEBHOOK_KEY: "k" })).toBeNull();
  });
});

describe("callCrm", () => {
  it("posts the API4 call with the key in X-Civi-Auth", async () => {
    const fetchMock = answers({ status: "ok" });
    await callCrm(CONFIG, "PauseaiPayingMember/reconcile", { member_ids: [REC], dry_run: true }, 1_000);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://crm.test/civicrm/ajax/api4/PauseaiPayingMember/reconcile");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Civi-Auth"]).toBe("Bearer secret-key");
    expect(JSON.parse((init.body as URLSearchParams).get("params")!)).toEqual({ member_ids: [REC], dry_run: true });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([500, 503, 401])("rejects on HTTP %i", async (status) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
    await expect(callCrm(CONFIG, "X/y", {}, 1_000)).rejects.toThrow(`HTTP ${status}`);
  });

  it("rejects on an answer without a status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ values: [] }))));
    await expect(callCrm(CONFIG, "X/y", {}, 1_000)).rejects.toThrow(/without a status/);
  });
});

describe("reconcilePayingInCrm", () => {
  it("makes one call with the whole set and reads the counts", async () => {
    const fetchMock = answers(ok({ set_true: 150, set_false: 50, unresolved: { not_found: [MEM] } }));
    const result = await reconcilePayingInCrm(CONFIG, [REC, MEM], { dryRun: false, deadline: FAR });
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse((init.body as URLSearchParams).get("params")!)).toEqual({ member_ids: [REC, MEM], dry_run: false });
    expect(result).toMatchObject({ status: "ok", setTrue: 150, setFalse: 50, unresolved: { not_found: [MEM] } });
  });

  it.each(["too_many_removals", "too_many_changes", "empty_set"])("answers a %s refusal", async (reason) => {
    answers({ status: "refused", reason, current: 300, target: 10 });
    const result = await reconcilePayingInCrm(CONFIG, [REC], { dryRun: false, deadline: FAR });
    expect(result).toMatchObject({ status: "refused", reason, answer: { current: 300 } });
  });

  it("keeps a dry run's whole answer for the log", async () => {
    const fetchMock = answers(ok({ dry_run: true, set_true_ids: [{ contact_id: 1, external_identifier: "x" }] }));
    const result = await reconcilePayingInCrm(CONFIG, [REC], { dryRun: true, deadline: FAR });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse((init.body as URLSearchParams).get("params")!)).toMatchObject({ dry_run: true });
    expect(result.answer).toMatchObject({ set_true_ids: [{ contact_id: 1 }] });
  });

  it("rejects without calling once the deadline has passed", async () => {
    const fetchMock = answers(ok({}));
    await expect(reconcilePayingInCrm(CONFIG, [REC], { dryRun: false, deadline: Date.now() - 1 })).rejects.toThrow(/Deadline/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects on a timeout, without retrying", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(reconcilePayingInCrm(CONFIG, [REC], { dryRun: false, deadline: FAR })).rejects.toThrow(/timeout/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
