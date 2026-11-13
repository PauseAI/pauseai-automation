import { describe, expect, it } from "vitest";
import { buildPayingSet, memberIdKind } from "../lib/payment-status";
import { MEM, MEM2, PRODUCT, REC, REC2, subscription } from "./helpers";

describe("memberIdKind", () => {
  it("tells the two id shapes apart and rejects anything else", () => {
    expect(memberIdKind(REC)).toBe("airtable");
    expect(memberIdKind(MEM)).toBe("signup");
    for (const id of [null, "", REC + "x", MEM.slice(0, -1), "rec-AAAAAAAAAAAAA", "cus_123"]) {
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

