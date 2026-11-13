import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrmAnswer } from "../lib/crm";
import { memberIdsBySubscription, paginate, syncPayingMembers, type Page } from "../lib/paying-sync";
import { MEM, PRODUCT, REC, subscription, writers } from "./helpers";

const REC2 = "rec" + "B".repeat(14);
const MEM2 = "mem" + "c".repeat(22);

async function* from<T>(items: T[]) {
  yield* items;
}

const session = (id: string, subscriptionId: string | null, memberId: string | null) => ({
  id,
  subscription: subscriptionId,
  client_reference_id: memberId,
});

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

describe("syncPayingMembers", () => {
  it("aggregates per member and writes each member once", async () => {
    const w = writers(true);
    const summary = await syncPayingMembers({
      productId: PRODUCT,
      subscriptions: from([
        subscription("sub_old", "canceled"),
        subscription("sub_new", "active"),
        subscription("sub_gone", "canceled"),
        subscription("sub_other", "active", ["prod_other"]),
      ]),
      sessions: from([
        session("cs_1", "sub_old", REC),
        session("cs_2", "sub_new", REC),
        session("cs_3", "sub_gone", MEM),
        session("cs_4", "sub_other", MEM2),
      ]),
      writers: w,
    });
    expect(w.crm!.mock.calls.sort()).toEqual([
      [MEM, false],
      [REC, true],
    ]);
    expect(w.airtable.mock.calls).toEqual([[REC, true]]);
    expect(summary).toMatchObject({ members: 2, written: 2, failed: 0, unmapped: 0 });
  });

  it("isolates failures, counts refusals, skips bad ids and reports a summary", async () => {
    const answers: Record<string, CrmAnswer | Error> = {
      [REC]: { status: "ok" },
      [REC2]: new Error("crm down"),
      [MEM]: { status: "refused", reason: "not_found" },
      [MEM2]: { status: "ok" },
    };
    const w = writers(true);
    w.crm = vi.fn(async (id: string) => {
      const answer = answers[id];
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const ids = [REC, REC2, MEM, MEM2, "junk"];
    const summary = await syncPayingMembers({
      productId: PRODUCT,
      subscriptions: from([...ids.map((_, i) => subscription(`sub_${i}`, "active")), subscription("sub_x", "active")]),
      sessions: from(ids.map((id, i) => session(`cs_${i}`, `sub_${i}`, id))),
      writers: w,
    });
    expect(summary).toEqual({
      members: 5,
      written: 2,
      refused: 1,
      failed: 1,
      skipped: 1,
      notReached: 0,
      unmapped: 1,
    });
    expect(w.crm).toHaveBeenCalledTimes(4);
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toMatch(/5 members, 2 written, 1 refused, 1 failed/);
  });

  it("writes at most `concurrency` members at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const w = writers(true);
    w.crm = vi.fn(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return { status: "ok" } as const;
    });
    const ids = Array.from({ length: 10 }, (_, i) => "mem" + String(i).padStart(22, "x"));
    const summary = await syncPayingMembers({
      productId: PRODUCT,
      subscriptions: from(ids.map((_, i) => subscription(`sub_${i}`, "active"))),
      sessions: from(ids.map((id, i) => session(`cs_${i}`, `sub_${i}`, id))),
      writers: w,
      concurrency: 4,
    });
    expect(peak).toBe(4);
    expect(summary.written).toBe(10);
  });

  it("stops starting writes at the deadline and counts the rest", async () => {
    const w = writers(true);
    const summary = await syncPayingMembers({
      productId: PRODUCT,
      subscriptions: from([subscription("sub_1", "active")]),
      sessions: from([session("cs_1", "sub_1", MEM)]),
      writers: w,
      stopAt: Date.now() - 1,
    });
    expect(summary).toMatchObject({ members: 1, written: 0, notReached: 1 });
    expect(w.crm).not.toHaveBeenCalled();
  });

  it("without CRM settings writes Airtable for record ids and skips signup ids with one log line", async () => {
    const w = writers(false);
    const summary = await syncPayingMembers({
      productId: PRODUCT,
      subscriptions: from([subscription("sub_1", "active"), subscription("sub_2", "active"), subscription("sub_3", "active")]),
      sessions: from([session("cs_1", "sub_1", REC), session("cs_2", "sub_2", MEM), session("cs_3", "sub_3", MEM2)]),
      writers: w,
    });
    expect(w.airtable.mock.calls).toEqual([[REC, true]]);
    expect(summary).toMatchObject({ written: 1, skipped: 2 });
    const skipLines = vi.mocked(console.warn).mock.calls.filter((call) => String(call[0]).includes("skipped"));
    expect(skipLines).toHaveLength(1);
  });
});
