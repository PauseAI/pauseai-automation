import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconcileResult } from "../lib/crm";
import { memberIdsBySubscription, paginate, syncPaying, type Page, type SyncDeps } from "../lib/paying-sync";
import type { AirtableRows } from "../lib/airtable-paying";
import { MEM, MEM2, PRODUCT, REC, REC2, TALLY, TALLY2, fakeClock, session, subscription } from "./helpers";

async function* from<T>(items: T[]) {
  yield* items;
}

const NONE = { not_found: [], invalid: [], erased: 0, trashed: 0, not_a_member: 0 };
const okReconcile = (fields: Partial<ReconcileResult> = {}): ReconcileResult => ({
  status: "ok",
  setTrue: 0,
  setFalse: 0,
  unresolved: NONE,
  failed: [],
  answer: {},
  ...fields,
});

function deps(overrides: Partial<SyncDeps> = {}) {
  const reconcile = vi.fn(async (_ids: string[], _options: { dryRun: boolean; deadline: number }) => okReconcile());
  const airtable = {
    listPage: vi.fn(async (kind: AirtableRows, _offset: string | undefined) => ({
      records: kind === "ticked" ? [{ id: REC2 }] : [],
    })),
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
    expect(reconcile.mock.calls[0][1]).toMatchObject({ dryRun: false, unmappedPaying: 0 });
    expect(airtable.setPaying.mock.calls).toEqual([
      [REC, true],
      [REC2, false],
    ]);
    expect(alert).not.toHaveBeenCalled();
    expect(summary.discovery).toBe("ok");
    const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => /3 members, 2 paying/.test(line))).toBe(true);
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
    expect(airtable.listPage).not.toHaveBeenCalled();
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
    expect(airtable.listPage).not.toHaveBeenCalled();
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

  it("reports and alerts unmapped paying subscriptions", async () => {
    const { d, alert } = deps({
      listSubscriptions: () => from([subscription("sub_1", "active"), subscription("sub_lost", "active")]),
    });
    await syncPaying(d);
    expect(vi.mocked(d.reconcile!).mock.calls[0][1]).toMatchObject({ unmappedPaying: 1 });
    const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => /1 unmapped subscriptions, 1 of them paying \["sub_lost"\]/.test(line))).toBe(true);
    expect(alert.mock.calls[0][0]).toMatch(/1 paying subscriptions without a member id/);
  });

  it("logs the full unresolved on every run and alerts when any id is unresolved", async () => {
    const { d, alert, reconcile } = deps();
    const unresolved = { ...NONE, not_found: [MEM], trashed: 1 };
    reconcile.mockResolvedValueOnce(okReconcile({ unresolved }));
    await syncPaying(d);
    const lines = vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
    expect(lines).toContain(`Paying sync: CiviCRM unresolved: ${JSON.stringify(unresolved)}`);
    expect(alert.mock.calls[0][0]).toMatch(/could not resolve/);
  });

  it.each([{ erased: 1 }, { not_a_member: 2 }, { invalid: ["x"] }])("alerts on unresolved %o", async (fields) => {
    const { d, alert, reconcile } = deps();
    reconcile.mockResolvedValueOnce(okReconcile({ unresolved: { ...NONE, ...fields } }));
    await syncPaying(d);
    expect(alert).toHaveBeenCalledOnce();
  });

  it("alerts on failed CiviCRM writes", async () => {
    const { d, alert, reconcile } = deps();
    reconcile.mockResolvedValueOnce(okReconcile({ failed: [{ contact_id: 5, reason: "exception" }] }));
    await syncPaying(d);
    expect(alert.mock.calls[0][0]).toMatch(/1 CiviCRM writes failed/);
  });

  it("alerts on a broken Airtable merge path, naming the row", async () => {
    const { d, alert, airtable } = deps();
    d.airtable.listPage = async (kind) => ({
      records: kind === "ticked" ? [{ id: REC2 }] : [{ id: REC, mergedInto: [REC2, MEM2] }],
    });
    await syncPaying(d);
    expect(airtable.setPaying).not.toHaveBeenCalled();
    expect(alert.mock.calls[0][0]).toMatch(new RegExp(`merge paths .*${REC}; no row unticked`));
  });

  it("passes the untick override to the Airtable sync", async () => {
    const many = Array.from({ length: 30 }, (_, i) => "rec" + String(i).padStart(14, "0"));
    const { d, alert, airtable } = deps({ allowAirtableRemovals: true });
    d.airtable.listPage = async (kind) => ({ records: kind === "ticked" ? many.map((id) => ({ id })) : [] });
    await syncPaying(d);
    expect(airtable.setPaying).toHaveBeenCalledTimes(31);
    expect(alert).not.toHaveBeenCalled();
  });

  it("alerts when Airtable refuses the unticks", async () => {
    const many = Array.from({ length: 30 }, (_, i) => "rec" + String(i).padStart(14, "0"));
    const { d, alert } = deps();
    d.airtable.listPage = async (kind) => ({ records: kind === "ticked" ? many.map((id) => ({ id })) : [] });
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

  describe("with Tally ids", () => {
    const REC3 = "rec" + "C".repeat(14);
    const tallyDeps = (rows: Record<AirtableRows, { id: string; mergedInto?: string[]; tallyId?: string }[]>) => {
      const built = deps({
        listSubscriptions: () =>
          from([
            subscription("sub_t", "active", [PRODUCT], "cus_t"),
            subscription("sub_t2", "active", [PRODUCT], "cus_t"),
            subscription("sub_lost", "active"),
          ]),
        listSessions: () => from([session("cs_t", "sub_t", TALLY), session("cs_lost", "sub_lost", TALLY2)]),
      });
      built.airtable.listPage.mockImplementation(async (kind) => ({ records: rows[kind] }));
      return built;
    };
    const logged = (level: "log" | "warn") => vi.mocked(console[level]).mock.calls.map((call) => String(call[0]));

    it("reads the Tally IDs before the CRM and sends it the resolved record id", async () => {
      const { d, reconcile, airtable, alert } = tallyDeps({
        tally: [{ id: REC, tallyId: ` ${TALLY}\n` }],
        ticked: [],
        links: [],
      });
      reconcile.mockImplementationOnce(async () => {
        expect(airtable.listPage.mock.calls.map((call) => call[0])).toEqual(["tally"]);
        return okReconcile();
      });
      await syncPaying(d);
      expect(reconcile.mock.calls[0][0]).toEqual([REC]);
      expect(reconcile.mock.calls[0][1]).toMatchObject({ unmappedPaying: 1 });
      expect(airtable.setPaying.mock.calls).toEqual([[REC, true]]);
      expect(logged("log").some((line) => line.includes(`subscription sub_t2 takes member id ${REC}`))).toBe(true);
      expect(logged("warn")).toContain(`Paying sync: subscription sub_lost: Tally id ${TALLY2} not found`);
      expect(
        logged("log").some((line) => /1 resolved via Tally id, 1 Tally ids not found, 0 Tally ids on several rows/.test(line))
      ).toBe(true);
      expect(alert.mock.calls[0][0]).toMatch(/1 paying subscriptions without a member id/);
    });

    it("ticks the survivor when the Tally id's row was merged away", async () => {
      const { d, reconcile, airtable } = tallyDeps({
        tally: [{ id: REC, tallyId: TALLY }],
        ticked: [],
        links: [{ id: REC, mergedInto: [REC3] }],
      });
      await syncPaying(d);
      expect(reconcile.mock.calls[0][0]).toEqual([REC]);
      expect(airtable.setPaying.mock.calls).toEqual([[REC3, true]]);
      expect(logged("log")).toContain(`Paying sync: Airtable row ${REC} was merged into ${REC3}`);
    });

    it("leaves a Tally id on several rows unmapped and says how many", async () => {
      const { d, reconcile } = tallyDeps({
        tally: [
          { id: REC, tallyId: TALLY },
          { id: REC2, tallyId: TALLY },
        ],
        ticked: [],
        links: [],
      });
      await syncPaying(d);
      expect(reconcile.mock.calls[0][0]).toEqual([]);
      expect(reconcile.mock.calls[0][1]).toMatchObject({ unmappedPaying: 3 });
      expect(logged("warn")).toContain(`Paying sync: subscription sub_t: Tally id ${TALLY} on 2 rows`);
    });

    it("writes nothing and alerts when reading the Tally IDs fails", async () => {
      const { d, reconcile, airtable, alert } = tallyDeps({ tally: [], ticked: [], links: [] });
      airtable.listPage.mockRejectedValue(Object.assign(new Error("forbidden"), { statusCode: 403 }));
      const summary = await syncPaying(d);
      expect(summary.discovery).toBe("failed");
      expect(reconcile).not.toHaveBeenCalled();
      expect(airtable.setPaying).not.toHaveBeenCalled();
      expect(alert.mock.calls[0][0]).toMatch(/reading Tally IDs from Airtable failed/);
    });

    it("does not read the Tally IDs when no subscription carries one", async () => {
      const { d, airtable } = deps();
      await syncPaying(d);
      expect(airtable.listPage.mock.calls.map((call) => call[0])).not.toContain("tally");
    });
  });
});
