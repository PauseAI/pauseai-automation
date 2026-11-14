import { describe, expect, it } from "vitest";
import { buildPayingSet, chooseMemberId, memberIdKind } from "../lib/payment-status";
import { MEM, MEM2, PRODUCT, REC, REC2, TALLY, TALLY2, subscription } from "./helpers";

describe("memberIdKind", () => {
  it("tells the two id shapes apart and rejects anything else", () => {
    expect(memberIdKind(REC)).toBe("airtable");
    expect(memberIdKind(MEM)).toBe("signup");
    for (const id of [null, "", REC + "x", MEM.slice(0, -1), "rec-AAAAAAAAAAAAA", "cus_123", TALLY]) {
      expect(memberIdKind(id)).toBeNull();
    }
  });
});

describe("chooseMemberId", () => {
  it("takes the metadata's id over the sessions'", () => {
    expect(chooseMemberId(MEM, [REC])).toEqual({ id: MEM });
    expect(chooseMemberId(MEM, [REC, REC2])).toEqual({ id: MEM });
    expect(chooseMemberId(REC, [TALLY])).toEqual({ id: REC });
  });

  it("calls sessions naming different ids a conflict", () => {
    expect(chooseMemberId(undefined, [REC, MEM])).toEqual({ conflict: [REC, MEM] });
    expect(chooseMemberId(undefined, [REC, REC])).toEqual({ id: REC });
  });

  it("ignores session ids of no known shape", () => {
    expect(chooseMemberId(undefined, [REC, "junk-id"])).toEqual({ id: REC });
    expect(chooseMemberId(undefined, ["junk-id"])).toEqual({ none: true });
    expect(chooseMemberId(undefined, [])).toEqual({ none: true });
    expect(chooseMemberId("", [REC])).toEqual({ id: REC });
  });

  it("keeps metadata of no known shape as final, without falling back to the sessions", () => {
    expect(chooseMemberId("junk-id", [REC])).toEqual({ invalidMetadata: "junk-id" });
    expect(chooseMemberId(TALLY, [REC])).toEqual({ invalidMetadata: TALLY });
  });
});

describe("buildPayingSet", () => {
  const build = (subs: ReturnType<typeof subscription>[], map: Record<string, string | string[]>) =>
    buildPayingSet(subs, new Map(Object.entries(map).map(([sub, ids]) => [sub, [ids].flat()])), PRODUCT);

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

  it("leaves a Tally id in the sessions unmapped and counted invalid, and takes a record id in the metadata over it", () => {
    const repaired = subscription("b", "active");
    repaired.metadata = { member_id: REC };
    const set = build([subscription("a", "active"), repaired], { a: TALLY, b: TALLY2 });
    expect([...set.paying]).toEqual([REC]);
    expect(set.unmapped).toEqual(["a"]);
    expect(set.unmappedPaying).toEqual(["a"]);
    expect(set.invalid).toEqual([TALLY]);
    expect(set.invalidMetadata).toEqual([]);
  });
});
