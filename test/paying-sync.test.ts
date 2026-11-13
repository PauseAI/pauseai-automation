import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconcileResult } from "../lib/crm";
import { memberIdsBySubscription, paginate, syncPaying, type Page, type SyncDeps } from "../lib/paying-sync";
import { MEM, MEM2, PRODUCT, REC, REC2, fakeClock, session, subscription } from "./helpers";

async function* from<T>(items: T[]) {
  yield* items;
}

const okReconcile = (fields: Partial<ReconcileResult> = {}): ReconcileResult => ({
  status: "ok",
  setTrue: 0,
  setFalse: 0,
  unresolved: {},
  answer: {},
  ...fields,
});

function deps(overrides: Partial<SyncDeps> = {}) {
  const reconcile = vi.fn(async (_ids: string[], _options: { dryRun: boolean; deadline: number }) => okReconcile());
  const airtable = {
    listTicked: vi.fn(async () => [REC2]),
    setPaying: vi.fn(async (_id: string, _paying: boolean) => "ok" as const),
  };
  const alert = vi.fn();
  const d: SyncDeps = {
    productId: PRODUCT,
    listSubscriptions: () =>
      from([
        subscription("sub_1", "active"),
        subscription("sub_2", "canceled"),
        subscription("sub_3", "active"),
        subscription("sub_4", "active", ["prod_other"]),
      ]),
    listSessions: () =>
      from([session("cs_1", "sub_1", REC), session("cs_2", "sub_2", REC2), session("cs_3", "sub_3", MEM), session("cs_4", "sub_4", MEM2)]),
    reconcile,
    airtable,
    dryRun: false,
    deadline: Infinity,
    alert,
    clock: fakeClock(),
    ...overrides,
  };
  return { d, reconcile, airtable, alert };
}

beforeEach(() => {
  for (const level of ["log", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("paginate and memberIdsBySubscription", () => {
  it("maps subscriptions to member ids across pages", async () => {
    const pages: Record<string, Page<ReturnType<typeof session>>> = {
      start: { data: [session("cs_1", "sub_1", REC), session("cs_2", null, REC2)], has_more: true },
      cs_2: { data: [session("cs_3", "sub_3", null), session("cs_4", "sub_4", MEM)], has_more: true },
      cs_4: { data: [session("cs_5", "sub_5", MEM2)], has_more: false },
    };
    const fetchPage = vi.fn(async (startingAfter: string | undefined) => pages[startingAfter ?? "start"]);
    const map = await memberIdsBySubscription(paginate(fetchPage));
    expect(fetchPage.mock.calls.map((call) => call[0])).toEqual([undefined, "cs_2", "cs_4"]);
    expect([...map]).toEqual([
      ["sub_1", REC],
      ["sub_4", MEM],
      ["sub_5", MEM2],
    ]);
  });
});

describe("syncPaying", () => {
  it("sends the whole paying set to the CRM and diffs Airtable", async () => {
    const { d, reconcile, airtable, alert } = deps();
    const summary = await syncPaying(d);
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile.mock.calls[0][0].sort()).toEqual([MEM, REC].sort());
    expect(reconcile.mock.calls[0][1]).toMatchObject({ dryRun: false });
    expect(airtable.setPaying.mock.calls).toEqual([
      [REC, true],
      [REC2, false],
    ]);
    expect(alert).not.toHaveBeenCalled();
    expect(summary.discovery).toBe("ok");
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toMatch(/3 members, 2 paying/);
  });

  it("in a dry run calls reconcile with dry_run and writes nothing to Airtable", async () => {
    const { d, reconcile, airtable } = deps({ dryRun: true });
    await syncPaying(d);
    expect(reconcile.mock.calls[0][1]).toMatchObject({ dryRun: true });
    expect(airtable.setPaying).not.toHaveBeenCalled();
    const logged = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(logged.some((line) => line.includes(`would tick ["${REC}"], untick ["${REC2}"]`))).toBe(true);
    expect(logged.some((line) => line.includes(`ticked now: ["${REC2}"]`))).toBe(true);
    expect(logged.some((line) => line.includes("CiviCRM answer:"))).toBe(true);
  });

  it("writes nothing and alerts when listing from Stripe runs past the deadline", async () => {
    let now = 0;
    const pages = vi.fn(async () => {
      now += 400_000;
      return { data: [subscription("sub_1", "active")], has_more: true };
    });
    const { d, reconcile, airtable, alert } = deps({
      deadline: 1_000_000,
      listSubscriptions: (deadline) => paginate(pages, deadline, () => now),
    });
    const summary = await syncPaying(d);
    expect(pages).toHaveBeenCalledTimes(3);
    expect(summary.discovery).toBe("failed");
    expect(reconcile).not.toHaveBeenCalled();
    expect(airtable.listTicked).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledOnce();
  });

  it("writes nothing and alerts when listing from Stripe fails", async () => {
    const { d, reconcile, airtable, alert } = deps({
      listSessions: () =>
        paginate(async () => {
          throw new Error("stripe down");
        }),
    });
    await syncPaying(d);
    expect(reconcile).not.toHaveBeenCalled();
    expect(airtable.listTicked).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledOnce();
  });

  it("alerts on a CRM refusal and still syncs Airtable", async () => {
    const { d, airtable, alert, reconcile } = deps();
    reconcile.mockResolvedValueOnce(okReconcile({ status: "refused", reason: "too_many_removals" }));
    await syncPaying(d);
    expect(airtable.setPaying).toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toMatch(/CiviCRM refused \(too_many_removals\)/);
  });

  it("alerts when the CRM call fails", async () => {
    const { d, alert, reconcile } = deps();
    reconcile.mockRejectedValueOnce(new Error("timeout"));
    await syncPaying(d);
    expect(alert.mock.calls[0][0]).toMatch(/CiviCRM failed/);
  });

  it("reports unmapped paying subscriptions in the summary", async () => {
    const { d } = deps({
      listSubscriptions: () => from([subscription("sub_1", "active"), subscription("sub_lost", "active")]),
    });
    await syncPaying(d);
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toMatch(/1 unmapped subscriptions, 1 of them paying \["sub_lost"\]/);
  });

  it("alerts when Airtable refuses the unticks", async () => {
    const many = Array.from({ length: 30 }, (_, i) => "rec" + String(i).padStart(14, "0"));
    const { d, alert } = deps();
    d.airtable.listTicked = async () => many;
    await syncPaying(d);
    expect(alert.mock.calls[0][0]).toMatch(/Airtable refused/);
  });

  it("without CRM settings writes Airtable only and skips signup ids with one log line", async () => {
    const { d, airtable, alert } = deps({ reconcile: null });
    await syncPaying(d);
    expect(airtable.setPaying.mock.calls).toEqual([
      [REC, true],
      [REC2, false],
    ]);
    const lines = vi.mocked(console.warn).mock.calls.filter((call) => String(call[0]).includes("skipped 1 signup ids"));
    expect(lines).toHaveLength(1);
    expect(alert).not.toHaveBeenCalled();
  });
});
