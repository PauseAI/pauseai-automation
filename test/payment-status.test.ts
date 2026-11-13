import { describe, expect, it } from "vitest";
import { buildPayingSet, chooseMemberId, memberIdKind } from "../lib/payment-status";
import { MEM, MEM2, PRODUCT, REC, REC2, TALLY, TALLY2, subscription } from "./helpers";

describe("memberIdKind", () => {
  it("tells the three id shapes apart and rejects anything else", () => {
    expect(memberIdKind(REC)).toBe("airtable");
    expect(memberIdKind(MEM)).toBe("signup");
    for (const id of [TALLY, "81x7BbP", "abc123", "abcd1234"]) expect(memberIdKind(id)).toBe("tally");
    for (const id of [null, "", REC + "x", MEM.slice(0, -1), "rec-AAAAAAAAAAAAA", "cus_123", "abc12", "abcd12345", "KYle-vK", " KYle2vK"]) {
      expect(memberIdKind(id)).toBeNull();
    }
  });
});

describe("chooseMemberId", () => {
  it("takes a record or signup id over a Tally id, from either source", () => {
    expect(chooseMemberId(TALLY, [REC])).toEqual({ id: REC });
    expect(chooseMemberId(MEM, [TALLY])).toEqual({ id: MEM });
    expect(chooseMemberId(undefined, [TALLY, MEM])).toEqual({ id: MEM });
  });

  it("takes the metadata's id over the sessions' of the same kind", () => {
    expect(chooseMemberId(MEM, [REC])).toEqual({ id: MEM });
    expect(chooseMemberId(MEM, [REC, REC2])).toEqual({ id: MEM });
    expect(chooseMemberId(TALLY, [TALLY2])).toEqual({ id: TALLY });
  });

  it("calls sessions naming different ids of the same kind a conflict", () => {
    expect(chooseMemberId(undefined, [REC, MEM])).toEqual({ conflict: [REC, MEM] });
    expect(chooseMemberId(undefined, [TALLY, TALLY2])).toEqual({ conflict: [TALLY, TALLY2] });
    expect(chooseMemberId(undefined, [REC, REC])).toEqual({ id: REC });
    expect(chooseMemberId(TALLY, [REC, REC2])).toEqual({ conflict: [REC, REC2] });
  });

  it("ignores session ids of no known shape", () => {
    expect(chooseMemberId(undefined, [REC, "junk-id"])).toEqual({ id: REC });
    expect(chooseMemberId(undefined, ["junk-id"])).toEqual({ none: true });
    expect(chooseMemberId(undefined, [])).toEqual({ none: true });
    expect(chooseMemberId("", [REC])).toEqual({ id: REC });
  });

  it("keeps metadata of no known shape as final, without falling back to the sessions", () => {
    expect(chooseMemberId("junk-id", [REC])).toEqual({ invalidMetadata: "junk-id" });
  });
});

describe("buildPayingSet", () => {
  const build = (subs: ReturnType<typeof subscription>[], map: Record<string, string | string[]>, index: Record<string, string[]> = {}) =>
    buildPayingSet(
      subs,
      new Map(Object.entries(map).map(([sub, ids]) => [sub, [ids].flat()])),
      PRODUCT,
      new Map(Object.entries(index))
    );

  it("pays when any subscription is active, so an old canceled one does not override a new one", () => {
    const set = build([subscription("a", "canceled"), subscription("b", "active")], { a: REC, b: REC });
    expect([...set.paying]).toEqual([REC]);
    expect(set.members).toBe(1);
  });

  it("does not pay with only canceled subscriptions, so the CRM clears the member", () => {
    const set = build([subscription("a", "canceled"), subscription("b", "canceled")], { a: REC, b: REC });
    expect(set.paying.size).toBe(0);
    expect(set.members).toBe(1);
  });

  it.each(["active", "trialing", "past_due"] as const)("pays when %s", (status) => {
    expect([...build([subscription("a", status, [{ id: PRODUCT }])], { a: MEM }).paying]).toEqual([MEM]);
  });

  it.each(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"] as const)("does not pay when %s", (status) => {
    expect(build([subscription("a", status)], { a: MEM }).paying.size).toBe(0);
  });

  it("leaves out a subscription that left the product, so the CRM clears the member", () => {
    const set = build([subscription("a", "active", ["prod_other"])], { a: REC });
    expect(set.paying.size).toBe(0);
    expect(set.members).toBe(0);
  });

  it("leaves a subscription without an id unmapped, even when the customer's other subscription is mapped", () => {
    const set = build(
      [subscription("old", "canceled", [PRODUCT], "cus_1"), subscription("new", "active", [PRODUCT], "cus_1")],
      { old: MEM }
    );
    expect(set.paying.size).toBe(0);
    expect(set.members).toBe(1);
    expect(set.unmapped).toEqual(["new"]);
    expect(set.unmappedPaying).toEqual(["new"]);
  });

  it("lists the unmapped subscriptions and the paying ones among them", () => {
    const set = build([subscription("a", "active"), subscription("b", "active"), subscription("c", "canceled")], { b: MEM2 });
    expect(set.unmapped).toEqual(["a", "c"]);
    expect(set.unmappedPaying).toEqual(["a"]);
    expect([...set.paying]).toEqual([MEM2]);
  });

  it("takes member_id metadata before the sessions, so staff can repair a subscription", () => {
    const repaired = subscription("a", "active");
    repaired.metadata = { member_id: MEM };
    expect([...build([repaired], { a: REC }).paying]).toEqual([MEM]);
  });

  it("leaves a subscription with member_id metadata of no known shape unmapped and reports it", () => {
    const bad = subscription("a", "active");
    bad.metadata = { member_id: "junk-id" };
    const set = build([bad], { a: REC });
    expect(set.paying.size).toBe(0);
    expect(set.unmappedPaying).toEqual(["a"]);
    expect(set.invalid).toEqual(["junk-id"]);
    expect(set.invalidMetadata).toEqual([{ subscription: "a", id: "junk-id" }]);
  });

  it("leaves out session ids of no known shape and reports them", () => {
    const set = build([subscription("a", "active")], { a: "junk-id" });
    expect(set.invalid).toEqual(["junk-id"]);
    expect(set.paying.size).toBe(0);
    expect(set.members).toBe(0);
    expect(set.unmappedPaying).toEqual(["a"]);
  });

  it("leaves a subscription whose sessions name different ids unmapped and reports it", () => {
    const set = build([subscription("a", "active")], { a: [REC, REC2] });
    expect(set.conflicting).toEqual([{ subscription: "a", ids: [REC, REC2] }]);
    expect(set.paying.size).toBe(0);
    expect(set.unmappedPaying).toEqual(["a"]);
  });
});

describe("buildPayingSet with Tally ids", () => {
  const REC3 = "rec" + "C".repeat(14);
  const build = (subs: ReturnType<typeof subscription>[], map: Record<string, string | string[]>, index: Record<string, string[]>) =>
    buildPayingSet(
      subs,
      new Map(Object.entries(map).map(([sub, ids]) => [sub, [ids].flat()])),
      PRODUCT,
      new Map(Object.entries(index))
    );
  const withMetadata = (id: string, memberId: string) => {
    const sub = subscription(id, "active");
    sub.metadata = { member_id: memberId };
    return sub;
  };

  it("resolves a Tally id on exactly one row to that row's record id", () => {
    const set = build([subscription("a", "active")], { a: TALLY }, { [TALLY]: [REC] });
    expect([...set.paying]).toEqual([REC]);
    expect(set.tally).toEqual([{ subscription: "a", tallyId: TALLY, rows: 1 }]);
    expect(set.unmapped).toEqual([]);
    expect(set.invalid).toEqual([]);
  });

  it("leaves a Tally id on no row unmapped and reports it", () => {
    const set = build([subscription("a", "active")], { a: TALLY }, { [TALLY2]: [REC] });
    expect(set.paying.size).toBe(0);
    expect(set.tally).toEqual([{ subscription: "a", tallyId: TALLY, rows: 0 }]);
    expect(set.unmappedPaying).toEqual(["a"]);
    expect(set.invalid).toEqual([]);
  });

  it("leaves a Tally id on several rows unmapped and reports how many", () => {
    const set = build([subscription("a", "active")], { a: TALLY }, { [TALLY]: [REC, REC2] });
    expect(set.paying.size).toBe(0);
    expect(set.tally).toEqual([{ subscription: "a", tallyId: TALLY, rows: 2 }]);
    expect(set.unmappedPaying).toEqual(["a"]);
  });

  it("matches Tally ids case-sensitively", () => {
    const set = build([subscription("a", "active")], { a: TALLY.toLowerCase() }, { [TALLY]: [REC] });
    expect(set.tally).toEqual([{ subscription: "a", tallyId: TALLY.toLowerCase(), rows: 0 }]);
  });

  it.each([
    ["missing", {}],
    ["ambiguous", { [TALLY]: [REC, REC2] }],
  ])("keeps the metadata Tally id when it is %s, over a session's resolvable one, so the other person is not marked paying", (_, index) => {
    const set = build([withMetadata("a", TALLY)], { a: TALLY2 }, { ...index, [TALLY2]: [REC3] });
    expect(set.paying.size).toBe(0);
    expect(set.unmappedPaying).toEqual(["a"]);
    expect(set.tally).toEqual([{ subscription: "a", tallyId: TALLY, rows: index[TALLY]?.length ?? 0 }]);
  });

  it("takes a session's record id over an unresolvable Tally id in the metadata", () => {
    const set = build([withMetadata("a", TALLY)], { a: REC }, {});
    expect([...set.paying]).toEqual([REC]);
    expect(set.tally).toEqual([]);
  });

  it("takes a session's signup id over a resolvable Tally id in the metadata", () => {
    expect([...build([withMetadata("a", TALLY)], { a: MEM }, { [TALLY]: [REC] }).paying]).toEqual([MEM]);
  });

  it("leaves a subscription whose sessions name different Tally ids unmapped, without resolving either", () => {
    const set = build([subscription("a", "active")], { a: [TALLY, TALLY2] }, { [TALLY]: [REC], [TALLY2]: [REC2] });
    expect(set.conflicting).toEqual([{ subscription: "a", ids: [TALLY, TALLY2] }]);
    expect(set.paying.size).toBe(0);
    expect(set.tally).toEqual([]);
  });

  it("still counts a junk id as invalid", () => {
    const set = build([subscription("a", "active")], { a: "KYle-vK" }, { "KYle-vK": [REC] });
    expect(set.invalid).toEqual(["KYle-vK"]);
    expect(set.paying.size).toBe(0);
    expect(set.tally).toEqual([]);
  });
});
