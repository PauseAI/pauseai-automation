import { describe, expect, it } from "vitest";
import { buildPayingSet, memberIdKind } from "../lib/payment-status";
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

describe("buildPayingSet", () => {
  const build = (subs: ReturnType<typeof subscription>[], map: Record<string, string>) =>
    buildPayingSet(subs, new Map(Object.entries(map)), PRODUCT);

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

  it("borrows the member id from another subscription of the same customer", () => {
    const set = build(
      [subscription("old", "canceled", [PRODUCT], "cus_1"), subscription("new", "active", [PRODUCT], "cus_1")],
      { old: MEM }
    );
    expect([...set.paying]).toEqual([MEM]);
    expect(set.unmapped).toEqual([]);
  });

  it("borrows from a subscription without the product too", () => {
    const set = build(
      [subscription("donation", "active", ["prod_other"], "cus_1"), subscription("member", "active", [PRODUCT], "cus_1")],
      { donation: REC2 }
    );
    expect([...set.paying]).toEqual([REC2]);
  });

  it("counts a subscription with no member id, even through its customer, as unmapped, and lists the paying ones", () => {
    const set = build(
      [
        subscription("a", "active", [PRODUCT], "cus_1"),
        subscription("b", "active", [PRODUCT], "cus_2"),
        subscription("c", "canceled", [PRODUCT], "cus_3"),
      ],
      { b: MEM2 }
    );
    expect(set.unmapped).toEqual(["a", "c"]);
    expect(set.unmappedPaying).toEqual(["a"]);
    expect([...set.paying]).toEqual([MEM2]);
  });

  it("takes member_id metadata before the session map, so staff can repair a subscription", () => {
    const repaired = subscription("a", "active");
    repaired.metadata = { member_id: MEM };
    const set = build([repaired], { a: REC });
    expect([...set.paying]).toEqual([MEM]);
  });

  it("ignores member_id metadata of neither shape", () => {
    const bad = subscription("a", "active");
    bad.metadata = { member_id: "junk" };
    expect([...build([bad], { a: REC }).paying]).toEqual([REC]);
  });

  it("lends a metadata member id to the customer's other subscriptions and reports the borrow", () => {
    const repaired = subscription("a", "canceled", [PRODUCT], "cus_1");
    repaired.metadata = { member_id: MEM };
    const set = build([repaired, subscription("b", "active", [PRODUCT], "cus_1")], {});
    expect([...set.paying]).toEqual([MEM]);
    expect(set.borrowed).toEqual([{ subscription: "b", memberId: MEM }]);
  });

  it("leaves out ids of neither shape", () => {
    const set = build([subscription("a", "active")], { a: "junk" });
    expect(set.invalid).toEqual(["junk"]);
    expect(set.paying.size).toBe(0);
    expect(set.members).toBe(0);
  });

  it("does not borrow when the customer's other subscriptions name different valid ids", () => {
    const set = build(
      [
        subscription("a", "canceled", [PRODUCT], "cus_1"),
        subscription("b", "canceled", [PRODUCT], "cus_1"),
        subscription("c", "active", [PRODUCT], "cus_1"),
      ],
      { a: REC, b: MEM }
    );
    expect(set.borrowed).toEqual([]);
    expect(set.unmappedPaying).toEqual(["c"]);
  });

  it("does not borrow an invalid id, and counts the subscription as unmapped", () => {
    const set = build([subscription("a", "canceled", [PRODUCT], "cus_1"), subscription("b", "active", [PRODUCT], "cus_1")], {
      a: "junk",
    });
    expect(set.borrowed).toEqual([]);
    expect(set.unmappedPaying).toEqual(["b"]);
    expect(set.invalid).toEqual(["junk"]);
  });

  it("borrows the one valid id when another subscription of the customer has an invalid one", () => {
    const set = build(
      [
        subscription("a", "canceled", [PRODUCT], "cus_1"),
        subscription("b", "canceled", [PRODUCT], "cus_1"),
        subscription("c", "active", [PRODUCT], "cus_1"),
      ],
      { a: "junk", b: MEM }
    );
    expect(set.borrowed).toEqual([
      { subscription: "a", memberId: MEM },
      { subscription: "c", memberId: MEM },
    ]);
    expect([...set.paying]).toEqual([MEM]);
    expect(set.unmapped).toEqual([]);
  });

  it("counts a paying subscription with an invalid id as unmapped paying", () => {
    const set = build([subscription("a", "active")], { a: "junk" });
    expect(set.unmappedPaying).toEqual(["a"]);
  });
});

describe("buildPayingSet with Tally ids", () => {
  const REC3 = "rec" + "C".repeat(14);
  const build = (subs: ReturnType<typeof subscription>[], map: Record<string, string>, index: Record<string, string[]>) =>
    buildPayingSet(subs, new Map(Object.entries(map)), PRODUCT, new Map(Object.entries(index)));

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

  it("lends a resolved Tally id to the customer's other subscriptions", () => {
    const set = build(
      [subscription("old", "canceled", [PRODUCT], "cus_1"), subscription("new", "active", [PRODUCT], "cus_1")],
      { old: TALLY },
      { [TALLY]: [REC] }
    );
    expect([...set.paying]).toEqual([REC]);
    expect(set.borrowed).toEqual([{ subscription: "new", memberId: REC }]);
  });

  it("does not let an unresolved Tally id borrow another person's resolved id on the same customer", () => {
    const set = build(
      [subscription("alice", "active", [PRODUCT], "cus_1"), subscription("bob", "canceled", [PRODUCT], "cus_1")],
      { alice: TALLY, bob: TALLY2 },
      { [TALLY]: [REC, REC2], [TALLY2]: [REC3] }
    );
    expect(set.borrowed).toEqual([]);
    expect(set.paying.size).toBe(0);
    expect(set.unmappedPaying).toEqual(["alice"]);
  });

  it("lends nothing from a customer with an unresolved Tally id", () => {
    const set = build(
      [
        subscription("unknown", "canceled", [PRODUCT], "cus_1"),
        subscription("known", "canceled", [PRODUCT], "cus_1"),
        subscription("bare", "active", [PRODUCT], "cus_1"),
      ],
      { unknown: TALLY, known: TALLY2 },
      { [TALLY2]: [REC3] }
    );
    expect(set.borrowed).toEqual([]);
    expect(set.unmappedPaying).toEqual(["bare"]);
    expect(set.unmapped).toEqual(["unknown", "bare"]);
  });

  it("takes a session's record id over an unresolvable Tally id in the metadata", () => {
    const sub = subscription("a", "active");
    sub.metadata = { member_id: TALLY };
    const set = build([sub], { a: REC }, {});
    expect([...set.paying]).toEqual([REC]);
    expect(set.tally).toEqual([]);
  });

  it("takes a session's signup id over a resolvable Tally id in the metadata", () => {
    const sub = subscription("a", "active");
    sub.metadata = { member_id: TALLY };
    expect([...build([sub], { a: MEM }, { [TALLY]: [REC] }).paying]).toEqual([MEM]);
  });

  it("still counts a junk id as invalid", () => {
    const set = build([subscription("a", "active")], { a: "KYle-vK" }, { "KYle-vK": [REC] });
    expect(set.invalid).toEqual(["KYle-vK"]);
    expect(set.paying.size).toBe(0);
    expect(set.tally).toEqual([]);
  });
});
