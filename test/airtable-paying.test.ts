import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pacedAirtableRequests,
  readTallyIndex,
  removalOverrideActive,
  syncAirtablePaying,
  type AirtablePayingStore,
  type AirtableRow,
  type AirtableRowSet,
} from "../lib/airtable-paying";
import { fakeClock } from "./helpers";

const rec = (n: number) => "rec" + String(n).padStart(14, "0");
const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => rec(from + i));

/** A store over ticked ids, merge links (loser -> links) and Tally IDs (row -> value), served in pages of `pageSize`. */
function store(
  ticked: string[],
  clock: ReturnType<typeof fakeClock>,
  options: {
    missing?: string[];
    merged?: Record<string, string | string[]>;
    tally?: Record<string, unknown>;
    pageSize?: number;
  } = {}
) {
  const pageSize = options.pageSize ?? 100;
  const rows = {
    ticked: ticked.map((id): AirtableRow => ({ id })),
    // Every row is listed for its links; most have none.
    links: [
      { id: rec(9000) },
      ...Object.entries(options.merged ?? {}).map(([id, to]): AirtableRow => ({ id, mergedInto: [to].flat() })),
      { id: rec(9001), mergedInto: [] },
    ],
    tally: Object.entries(options.tally ?? {}).map(([id, tallyId]) => ({ id, tallyId }) as AirtableRow),
  };
  const s = {
    listPage: vi.fn(async (kind: AirtableRowSet, offset: string | undefined) => {
      clock.starts.push(clock.now());
      const start = Number(offset ?? 0);
      const end = start + pageSize;
      return { records: rows[kind].slice(start, end), offset: end < rows[kind].length ? String(end) : undefined };
    }),
    setPaying: vi.fn(async (id: string, _paying: boolean): Promise<"ok" | "not_found"> => {
      clock.starts.push(clock.now());
      return options.missing?.includes(id) ? "not_found" : "ok";
    }),
  };
  return s satisfies AirtablePayingStore;
}

afterEach(() => vi.restoreAllMocks());

describe("syncAirtablePaying", () => {
  it("writes only the differences: ticks missing rows, unticks extra ones", async () => {
    const clock = fakeClock();
    const s = store(ids(0, 20), clock);
    const paying = new Set([...ids(1, 20), rec(50)]);
    const result = await syncAirtablePaying(paying, s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(s.setPaying.mock.calls).toEqual([
      [rec(50), true],
      [rec(0), false],
    ]);
    expect(result).toMatchObject({ status: "ok", ticked: 20, written: 2, failed: 0 });
  });

  it("reads every page of ticked rows", async () => {
    const clock = fakeClock();
    const s = store(ids(0, 25), clock, { pageSize: 10 });
    const result = await syncAirtablePaying(new Set(ids(0, 25)), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(s.listPage.mock.calls.filter((call) => call[0] === "ticked")).toHaveLength(3);
    expect(result).toMatchObject({ ticked: 25, toTick: [], toUntick: [] });
  });

  it("paces requests, pages included, to at most 5 per second", async () => {
    const clock = fakeClock();
    const s = store(ids(100, 115), clock, { pageSize: 5 });
    await syncAirtablePaying(new Set([...ids(100, 115), ...ids(0, 3)]), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    const gaps = clock.starts.slice(1).map((start, i) => start - clock.starts[i]);
    expect(gaps.length).toBeGreaterThan(5);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(200);
  });

  it("ticks the survivor for a paying merged-away row and never writes the merged-away row", async () => {
    const clock = fakeClock();
    const s = store([rec(1)], clock, { merged: { [rec(1)]: rec(2) } });
    const result = await syncAirtablePaying(new Set([rec(1)]), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(s.setPaying.mock.calls).toEqual([[rec(2), true]]);
    expect(result.redirected).toEqual([{ from: rec(1), to: rec(2) }]);
  });

  it("does not untick a survivor whose merged-away row holds the subscription", async () => {
    const clock = fakeClock();
    const s = store([rec(2)], clock, { merged: { [rec(1)]: rec(2) } });
    const result = await syncAirtablePaying(new Set([rec(1)]), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(s.setPaying).not.toHaveBeenCalled();
    expect(result).toMatchObject({ toTick: [], toUntick: [] });
  });

  it("follows a merge chain to its end", async () => {
    const clock = fakeClock();
    const s = store([], clock, { merged: { [rec(1)]: rec(2), [rec(2)]: rec(3) } });
    await syncAirtablePaying(new Set([rec(1)]), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(s.setPaying.mock.calls).toEqual([[rec(3), true]]);
  });

  it("follows a chain of five links", async () => {
    const clock = fakeClock();
    const s = store([], clock, { merged: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [rec(n), rec(n + 1)])) });
    const result = await syncAirtablePaying(new Set([rec(1)]), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(s.setPaying.mock.calls).toEqual([[rec(6), true]]);
    expect(result.brokenMerges).toEqual([]);
  });

  it.each([
    ["a cycle", { [rec(1)]: rec(2), [rec(2)]: rec(1) }],
    ["a self link", { [rec(1)]: rec(1) }],
    ["a chain longer than five", Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [rec(n), rec(n + 1)]))],
    ["a fork", { [rec(1)]: [rec(2), rec(3)] }],
    ["a fork further down", { [rec(1)]: rec(2), [rec(2)]: [rec(3), rec(4)] }],
  ])("treats %s as a broken path: ticks nothing for it and unticks nothing", async (_name, merged) => {
    const clock = fakeClock();
    const s = store([rec(7), rec(40)], clock, { merged });
    const result = await syncAirtablePaying(new Set([rec(1), rec(30)]), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(result.brokenMerges).toEqual([rec(1)]);
    expect(result.toUntick).toEqual([]);
    expect(s.setPaying.mock.calls).toEqual([[rec(30), true]]);
  });

  it("counts a row that does not exist as skipped, not failed, and goes on", async () => {
    const clock = fakeClock();
    const s = store([], clock, { missing: [rec(1)] });
    const result = await syncAirtablePaying(new Set([rec(1), rec(2)]), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(result).toMatchObject({ status: "ok", written: 1, notFound: [rec(1)], failed: 0 });
  });

  it("refuses to untick more than max(10, 20%) of the ticked rows", async () => {
    const clock = fakeClock();
    const s = store(ids(0, 100), clock);
    const result = await syncAirtablePaying(new Set(ids(0, 79)), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(result.status).toBe("refused");
    expect(result.toUntick).toHaveLength(21);
    expect(s.setPaying).not.toHaveBeenCalled();
  });

  it("unticks past the guard when the override allows it", async () => {
    const clock = fakeClock();
    const s = store(ids(0, 100), clock);
    const result = await syncAirtablePaying(new Set(ids(0, 79)), s, {
      dryRun: false,
      allowRemovals: true,
      request: pacedAirtableRequests(Infinity, clock),
    });
    expect(result).toMatchObject({ status: "ok", written: 21, removalsAllowed: true });
  });

  it("allows up to 10 unticks on a small table", async () => {
    const clock = fakeClock();
    const s = store(ids(0, 12), clock);
    const result = await syncAirtablePaying(new Set(ids(0, 2)), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(result).toMatchObject({ status: "ok", written: 10 });
  });

  it("writes nothing in a dry run", async () => {
    const clock = fakeClock();
    const s = store([rec(0)], clock);
    const result = await syncAirtablePaying(new Set([rec(1)]), s, { dryRun: true, request: pacedAirtableRequests(Infinity, clock) });
    expect(s.setPaying).not.toHaveBeenCalled();
    expect(result).toMatchObject({ tickedIds: [rec(0)], toTick: [rec(1)], toUntick: [rec(0)], written: 0 });
  });

  it("retries a rate limit after 30 s, a few times at most, then counts a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = fakeClock();
    const s = store([], clock);
    s.setPaying.mockRejectedValue(Object.assign(new Error("429"), { statusCode: 429 }));
    const result = await syncAirtablePaying(new Set([rec(1)]), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(s.setPaying).toHaveBeenCalledTimes(3);
    expect(clock.sleeps.filter((ms) => ms >= 30_000)).toHaveLength(2);
    expect(result).toMatchObject({ status: "ok", failed: 1, written: 0 });
  });

  it.each([null, undefined])("retries a timeout or connection error (status %s)", async (code) => {
    const clock = fakeClock();
    const s = store([], clock);
    s.setPaying.mockRejectedValueOnce(Object.assign(new Error("timeout"), { statusCode: code }));
    const result = await syncAirtablePaying(new Set([rec(1)]), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(s.setPaying).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ written: 1, failed: 0 });
  });

  it("retries a listing page that timed out", async () => {
    const clock = fakeClock();
    const s = store([rec(1)], clock);
    const original = s.listPage.getMockImplementation()!;
    s.listPage.mockImplementationOnce(async () => {
      throw Object.assign(new Error("timeout"), { statusCode: null });
    });
    s.listPage.mockImplementation(original);
    const result = await syncAirtablePaying(new Set([rec(1)]), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(result).toMatchObject({ status: "ok", ticked: 1 });
  });

  it("does not retry a client error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = fakeClock();
    const s = store([], clock);
    s.setPaying.mockRejectedValueOnce(Object.assign(new Error("422"), { statusCode: 422 }));
    const result = await syncAirtablePaying(new Set([rec(1), rec(2)]), s, { dryRun: false, request: pacedAirtableRequests(Infinity, clock) });
    expect(s.setPaying).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ failed: 1, written: 1 });
  });

  it("checks the deadline before each page of the listing", async () => {
    const clock = fakeClock();
    const s = store(ids(0, 50), clock, { pageSize: 10 });
    await expect(syncAirtablePaying(new Set(), s, { dryRun: true, request: pacedAirtableRequests(700, clock) })).rejects.toThrow(/Deadline/);
    expect(s.listPage.mock.calls.filter((call) => call[0] === "ticked").length).toBeLessThan(5);
  });

  it("stops writing at the deadline, without waiting past it", async () => {
    const clock = fakeClock();
    const s = store([], clock);
    s.setPaying.mockRejectedValueOnce(Object.assign(new Error("429"), { statusCode: 429 }));
    const result = await syncAirtablePaying(new Set(ids(0, 5)), s, { dryRun: false, request: pacedAirtableRequests(10_000, clock) });
    expect(result.status).toBe("incomplete");
    expect(clock.now()).toBeLessThan(10_000);
  });
});

describe("removalOverrideActive", () => {
  const now = Date.parse("2026-11-13T12:00:00Z");
  it("is active until its time, at most 24 hours ahead", () => {
    expect(removalOverrideActive("2026-11-13T18:00:00Z", now)).toBe(true);
    expect(removalOverrideActive("2026-11-14T12:00:00Z", now)).toBe(true);
    expect(removalOverrideActive("2026-11-14T12:00:01Z", now)).toBe(false);
    expect(removalOverrideActive("2026-11-13T11:59:59Z", now)).toBe(false);
    expect(removalOverrideActive("not a time", now)).toBe(false);
    expect(removalOverrideActive(undefined, now)).toBe(false);
  });
});

describe("readTallyIndex", () => {
  it("maps each trimmed Tally id to every row holding it, across pages, paced", async () => {
    const clock = fakeClock();
    const s = store([], clock, {
      pageSize: 2,
      tally: { [rec(1)]: " KYle2vK\n", [rec(2)]: "A7v1k6e", [rec(3)]: "KYle2vK", [rec(4)]: "  " },
    });
    const index = await readTallyIndex(s, pacedAirtableRequests(Infinity, clock));
    expect([...index]).toEqual([
      ["KYle2vK", [rec(1), rec(3)]],
      ["A7v1k6e", [rec(2)]],
    ]);
    expect(s.listPage.mock.calls.map((call) => call[0])).toEqual(["tally", "tally"]);
    expect(clock.starts[1] - clock.starts[0]).toBeGreaterThanOrEqual(200);
  });

  it("skips values that are not text, as a retyped field returns", async () => {
    const clock = fakeClock();
    const s = store([], clock, { tally: { [rec(1)]: ["KYle2vK"], [rec(2)]: 7 } });
    expect((await readTallyIndex(s, pacedAirtableRequests(Infinity, clock))).size).toBe(0);
  });

  it("matches case-sensitively", async () => {
    const clock = fakeClock();
    const s = store([], clock, { tally: { [rec(1)]: "kyle2vk" } });
    const index = await readTallyIndex(s, pacedAirtableRequests(Infinity, clock));
    expect(index.get("KYle2vK")).toBeUndefined();
  });
});
