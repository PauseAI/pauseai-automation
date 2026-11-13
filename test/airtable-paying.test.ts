import { afterEach, describe, expect, it, vi } from "vitest";
import { syncAirtablePaying, type AirtablePayingStore } from "../lib/airtable-paying";
import { fakeClock } from "./helpers";

const rec = (n: number) => "rec" + String(n).padStart(14, "0");
const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => rec(from + i));

function store(ticked: string[], clock: ReturnType<typeof fakeClock>, missing: string[] = []) {
  const s = {
    listTicked: vi.fn(async () => {
      clock.starts.push(clock.now());
      return ticked;
    }),
    setPaying: vi.fn(async (id: string, _paying: boolean): Promise<"ok" | "not_found"> => {
      clock.starts.push(clock.now());
      return missing.includes(id) ? "not_found" : "ok";
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
    const result = await syncAirtablePaying(paying, s, { dryRun: false, deadline: Infinity, clock });
    expect(s.setPaying.mock.calls).toEqual([
      [rec(50), true],
      [rec(0), false],
    ]);
    expect(result).toMatchObject({ status: "ok", ticked: 20, written: 2, failed: 0 });
  });

  it("paces requests to at most 5 per second", async () => {
    const clock = fakeClock();
    const s = store([], clock);
    await syncAirtablePaying(new Set(ids(0, 6)), s, { dryRun: false, deadline: Infinity, clock });
    const gaps = clock.starts.slice(1).map((start, i) => start - clock.starts[i]);
    expect(gaps).toHaveLength(6);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(200);
  });

  it("counts a row that does not exist as not found and goes on", async () => {
    const clock = fakeClock();
    const s = store([], clock, [rec(1)]);
    const result = await syncAirtablePaying(new Set([rec(1), rec(2)]), s, { dryRun: false, deadline: Infinity, clock });
    expect(result).toMatchObject({ status: "ok", written: 1, notFound: [rec(1)], failed: 0 });
  });

  it("refuses to untick more than max(10, 20%) of the ticked rows", async () => {
    const clock = fakeClock();
    const s = store(ids(0, 100), clock);
    const result = await syncAirtablePaying(new Set(ids(0, 79)), s, { dryRun: false, deadline: Infinity, clock });
    expect(result.status).toBe("refused");
    expect(result.toUntick).toHaveLength(21);
    expect(s.setPaying).not.toHaveBeenCalled();
  });

  it("allows up to 10 unticks on a small table", async () => {
    const clock = fakeClock();
    const s = store(ids(0, 12), clock);
    const result = await syncAirtablePaying(new Set(ids(0, 2)), s, { dryRun: false, deadline: Infinity, clock });
    expect(result).toMatchObject({ status: "ok", written: 10 });
  });

  it("writes nothing in a dry run", async () => {
    const clock = fakeClock();
    const s = store([rec(0)], clock);
    const result = await syncAirtablePaying(new Set([rec(1)]), s, { dryRun: true, deadline: Infinity, clock });
    expect(s.setPaying).not.toHaveBeenCalled();
    expect(result).toMatchObject({ toTick: [rec(1)], toUntick: [rec(0)], written: 0 });
  });

  it("retries a rate limit after 30 s, a few times at most, then counts a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = fakeClock();
    const s = store([], clock);
    s.setPaying.mockRejectedValue(Object.assign(new Error("429"), { statusCode: 429 }));
    const result = await syncAirtablePaying(new Set([rec(1)]), s, { dryRun: false, deadline: Infinity, clock });
    expect(s.setPaying).toHaveBeenCalledTimes(3);
    expect(clock.sleeps.filter((ms) => ms >= 30_000)).toHaveLength(2);
    expect(result).toMatchObject({ status: "ok", failed: 1, written: 0 });
  });

  it("does not retry a client error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = fakeClock();
    const s = store([], clock);
    s.setPaying.mockRejectedValueOnce(Object.assign(new Error("422"), { statusCode: 422 }));
    const result = await syncAirtablePaying(new Set([rec(1), rec(2)]), s, { dryRun: false, deadline: Infinity, clock });
    expect(s.setPaying).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ failed: 1, written: 1 });
  });

  it("stops at the deadline, without waiting past it", async () => {
    const clock = fakeClock();
    const s = store([], clock);
    s.setPaying.mockRejectedValueOnce(Object.assign(new Error("429"), { statusCode: 429 }));
    const result = await syncAirtablePaying(new Set(ids(0, 5)), s, { dryRun: false, deadline: 10_000, clock });
    expect(result.status).toBe("incomplete");
    expect(clock.now()).toBeLessThan(10_000);
  });
});
