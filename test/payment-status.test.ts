import { afterEach, describe, expect, it, vi } from "vitest";
import { isPayingMember, memberIdKind, writeMemberPaying } from "../lib/payment-status";
import { MEM, PRODUCT, REC, subscription, writers } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("memberIdKind", () => {
  it("tells the two id shapes apart and rejects anything else", () => {
    expect(memberIdKind(REC)).toBe("airtable");
    expect(memberIdKind(MEM)).toBe("signup");
    for (const id of [null, "", REC + "x", MEM.slice(0, -1), "rec-AAAAAAAAAAAAA", "cus_123"]) {
      expect(memberIdKind(id)).toBeNull();
    }
  });
});

describe("isPayingMember", () => {
  it("is paying when any subscription is active, so an old canceled one does not override a new one", () => {
    expect(isPayingMember([subscription("a", "canceled"), subscription("b", "active")], PRODUCT)).toBe(true);
    expect(isPayingMember([subscription("b", "active"), subscription("a", "canceled")], PRODUCT)).toBe(true);
  });

  it("is not paying with only canceled subscriptions", () => {
    expect(isPayingMember([subscription("a", "canceled"), subscription("b", "canceled")], PRODUCT)).toBe(false);
  });

  it.each(["active", "trialing", "past_due"] as const)("is paying when %s", (status) => {
    expect(isPayingMember([subscription("a", status)], PRODUCT)).toBe(true);
    expect(isPayingMember([subscription("a", status, [{ id: PRODUCT }])], PRODUCT)).toBe(true);
  });

  it.each(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"] as const)(
    "is not paying when %s",
    (status) => {
      expect(isPayingMember([subscription("a", status)], PRODUCT)).toBe(false);
    }
  );

  it("ignores a subscription without the product", () => {
    expect(isPayingMember([subscription("a", "active", ["prod_other"])], PRODUCT)).toBe(false);
  });
});

describe("writeMemberPaying", () => {
  it("writes an Airtable record id to Airtable and the CRM", async () => {
    const w = writers(true);
    await expect(writeMemberPaying(REC, true, w)).resolves.toEqual({ outcome: "written" });
    expect(w.airtable).toHaveBeenCalledWith(REC, true);
    expect(w.crm).toHaveBeenCalledWith(REC, true);
  });

  it("writes a signup id to the CRM only", async () => {
    const w = writers(true);
    await expect(writeMemberPaying(MEM, false, w)).resolves.toEqual({ outcome: "written" });
    expect(w.airtable).not.toHaveBeenCalled();
    expect(w.crm).toHaveBeenCalledWith(MEM, false);
  });

  it("writes an Airtable record id to Airtable alone without CRM settings", async () => {
    const w = writers(false);
    await expect(writeMemberPaying(REC, true, w)).resolves.toEqual({ outcome: "written" });
    expect(w.airtable).toHaveBeenCalledWith(REC, true);
  });

  it("skips a signup id without CRM settings", async () => {
    const w = writers(false);
    await expect(writeMemberPaying(MEM, true, w)).resolves.toEqual({ outcome: "skipped" });
    expect(w.airtable).not.toHaveBeenCalled();
  });

  it("answers a CRM refusal with its reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = writers(true, { status: "refused", reason: "not_found" });
    await expect(writeMemberPaying(REC, true, w)).resolves.toEqual({ outcome: "refused", reason: "not_found" });
    expect(w.airtable).toHaveBeenCalledWith(REC, true);
  });

  it("logs every failure when both writes fail, and rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = writers(true);
    w.airtable.mockRejectedValueOnce(new Error("airtable down"));
    w.crm!.mockRejectedValueOnce(new Error("crm down"));
    await expect(writeMemberPaying(REC, true, w)).rejects.toThrow("airtable down");
    expect(error.mock.calls.map((call) => (call[1] as Error).message)).toEqual(["airtable down", "crm down"]);
  });

  it("still writes the CRM when Airtable fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = writers(true);
    w.airtable.mockRejectedValueOnce(new Error("airtable down"));
    await expect(writeMemberPaying(REC, true, w)).rejects.toThrow("airtable down");
    expect(w.crm).toHaveBeenCalledWith(REC, true);
  });
});
