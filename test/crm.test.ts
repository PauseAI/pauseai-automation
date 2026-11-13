import { afterEach, describe, expect, it, vi } from "vitest";
import { callCrm, crmConfigFromEnv, hasUnresolved, reconcilePayingInCrm } from "../lib/crm";
import { MEM, REC } from "./helpers";

const CONFIG = { url: "https://crm.test", key: "secret-key" };
const FAR = Date.now() + 3_600_000;

function answers(...rows: unknown[]) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ values: [rows.shift()] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}


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

// Answers as pauseai-civicrm's tests/leaks/probe-paying-member.php expects them
// (feat/1278-paying-reconcile), with its probe ids and made-up contact ids.
const PROBE_UNRESOLVED = {
  not_found: ["recPAIPAYnone0001"],
  erased: 1,
  trashed: 2,
  not_a_member: 2,
  invalid: ["bogus", "7"],
};
const PROBE_DRY_RUN = {
  status: "ok",
  current: 2,
  target: 3,
  ignored_true: 2,
  unresolved: PROBE_UNRESOLVED,
  dry_run: true,
  set_true: 0,
  set_false: 0,
  set_true_ids: [],
  set_false_ids: [],
  would_set_true: [
    { contact_id: 101, external_identifier: "airtable:Members:recPAIPAYpaid0001" },
    { contact_id: 102, external_identifier: "airtable:Members:recPAIPAYsurv0001" },
  ],
  would_set_false: [{ contact_id: 103, external_identifier: "airtable:Members:recPAIPAYflag0002" }],
};
const PROBE_WRITE = {
  status: "ok",
  current: 2,
  target: 3,
  ignored_true: 2,
  unresolved: PROBE_UNRESOLVED,
  dry_run: false,
  set_true: 2,
  set_false: 1,
  set_true_ids: [101, 102],
  set_false_ids: [103],
};
const PROBE_REFUSED = {
  status: "refused",
  reason: "too_many_removals",
  current: 14,
  target: 1,
  ignored_true: 0,
  unresolved: { not_found: [], erased: 0, trashed: 0, not_a_member: 0, invalid: [] },
  dry_run: false,
  additions: 0,
  removals: 13,
  removal_limit: 12,
  max_changes: 200,
};

describe("reconcilePayingInCrm", () => {
  it("makes one call with the whole set and reads a write's answer", async () => {
    const fetchMock = answers(PROBE_WRITE);
    const result = await reconcilePayingInCrm(CONFIG, [REC, MEM], { dryRun: false, deadline: FAR });
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse((init.body as URLSearchParams).get("params")!)).toEqual({ member_ids: [REC, MEM], dry_run: false });
    expect(result).toMatchObject({ status: "ok", setTrue: 2, setFalse: 1, unresolved: PROBE_UNRESOLVED, failed: [] });
    expect(hasUnresolved(result.unresolved)).toBe(true);
  });

  it("reads the failed list", async () => {
    const failed = [{ contact_id: 104, reason: "exception" }];
    answers({ ...PROBE_WRITE, failed });
    const result = await reconcilePayingInCrm(CONFIG, [REC], { dryRun: false, deadline: FAR });
    expect(result.failed).toEqual(failed);
  });

  it("answers a refusal with its reason", async () => {
    answers(PROBE_REFUSED);
    const result = await reconcilePayingInCrm(CONFIG, [REC], { dryRun: false, deadline: FAR });
    expect(result).toMatchObject({ status: "refused", reason: "too_many_removals", answer: { removal_limit: 12 } });
    expect(hasUnresolved(result.unresolved)).toBe(false);
  });

  it("keeps a dry run's whole answer for the log", async () => {
    const fetchMock = answers(PROBE_DRY_RUN);
    const result = await reconcilePayingInCrm(CONFIG, [REC], { dryRun: true, deadline: FAR });
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse((init.body as URLSearchParams).get("params")!)).toMatchObject({ dry_run: true });
    expect(result.answer).toEqual(PROBE_DRY_RUN);
  });

  it("rejects without calling once the deadline has passed", async () => {
    const fetchMock = answers(PROBE_WRITE);
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
