import type Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AirtableRecordNotFoundError,
  isPayingSubscription,
  memberIdKind,
  recordSubscriptionStatus,
  writePaymentStatus,
} from "../server/utils/payment-status";

const REC = "rec" + "A".repeat(14);
const MEM = "mem" + "b".repeat(22);
const PRODUCT = "prod_member";

const writers = (crm: boolean) => ({
  airtable: vi.fn(async (_id: string, _status: boolean) => {}),
  crm: crm ? vi.fn(async (_id: string, _status: boolean) => {}) : null,
});

function subscription(status: Stripe.Subscription.Status, products: (string | { id: string })[]) {
  return {
    id: "sub_1",
    status,
    items: { data: products.map((product) => ({ price: { product } })) },
  } as unknown as Stripe.Subscription;
}

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

describe("isPayingSubscription", () => {
  it.each(["active", "trialing", "past_due"] as const)("is paying when %s with the product", (status) => {
    expect(isPayingSubscription(subscription(status, ["prod_other", PRODUCT]), PRODUCT)).toBe(true);
    expect(isPayingSubscription(subscription(status, [{ id: PRODUCT }]), PRODUCT)).toBe(true);
  });

  it.each(["active", "trialing", "past_due"] as const)("is not paying when %s without the product", (status) => {
    expect(isPayingSubscription(subscription(status, ["prod_other"]), PRODUCT)).toBe(false);
  });

  it.each(["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"] as const)(
    "is not paying when %s, even with the product",
    (status) => {
      expect(isPayingSubscription(subscription(status, [PRODUCT]), PRODUCT)).toBe(false);
    }
  );
});

describe("recordSubscriptionStatus", () => {
  it("writes the live status, not the event's: an old update of a since canceled subscription writes false", async () => {
    const w = writers(true);
    const retrieveSubscription = vi.fn(async () => subscription("canceled", [PRODUCT]));
    await recordSubscriptionStatus("sub_1", {
      productId: PRODUCT,
      retrieveSubscription,
      clientReferenceId: async () => REC,
      writers: w,
    });
    expect(retrieveSubscription).toHaveBeenCalledWith("sub_1");
    expect(w.airtable).toHaveBeenCalledWith(REC, false);
    expect(w.crm).toHaveBeenCalledWith(REC, false);
  });

  it("writes true for a live active subscription with the product", async () => {
    const w = writers(true);
    await recordSubscriptionStatus("sub_1", {
      productId: PRODUCT,
      retrieveSubscription: async () => subscription("active", [PRODUCT]),
      clientReferenceId: async () => MEM,
      writers: w,
    });
    expect(w.crm).toHaveBeenCalledWith(MEM, true);
    expect(w.airtable).not.toHaveBeenCalled();
  });
});

describe("writePaymentStatus", () => {
  it("writes an Airtable record id to Airtable and the CRM", async () => {
    const w = writers(true);
    await writePaymentStatus(REC, true, w);
    expect(w.airtable).toHaveBeenCalledWith(REC, true);
    expect(w.crm).toHaveBeenCalledWith(REC, true);
  });

  it("writes a signup id to the CRM only", async () => {
    const w = writers(true);
    await writePaymentStatus(MEM, false, w);
    expect(w.airtable).not.toHaveBeenCalled();
    expect(w.crm).toHaveBeenCalledWith(MEM, false);
  });

  it("writes an Airtable record id to Airtable alone without CRM settings", async () => {
    const w = writers(false);
    await writePaymentStatus(REC, true, w);
    expect(w.airtable).toHaveBeenCalledWith(REC, true);
  });

  it("rejects a signup id without CRM settings, so Stripe retries", async () => {
    const w = writers(false);
    await expect(writePaymentStatus(MEM, true, w)).rejects.toThrow(/No CRM settings/);
    expect(w.airtable).not.toHaveBeenCalled();
  });

  it("logs and resolves for an id of neither shape", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = writers(true);
    await writePaymentStatus("not-an-id", true, w);
    await writePaymentStatus(null, true, w);
    expect(w.airtable).not.toHaveBeenCalled();
    expect(w.crm).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(2);
  });

  it("still writes the CRM when Airtable fails, then rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = writers(true);
    w.airtable.mockRejectedValueOnce(new Error("airtable down"));
    await expect(writePaymentStatus(REC, true, w)).rejects.toThrow("airtable down");
    expect(w.crm).toHaveBeenCalledWith(REC, true);
  });

  it("still writes Airtable when the CRM fails, then rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = writers(true);
    w.crm!.mockRejectedValueOnce(new Error("crm down"));
    await expect(writePaymentStatus(REC, true, w)).rejects.toThrow("crm down");
    expect(w.airtable).toHaveBeenCalledWith(REC, true);
  });

  it("logs every failure when both writes fail", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = writers(true);
    w.airtable.mockRejectedValueOnce(new Error("airtable down"));
    w.crm!.mockRejectedValueOnce(new Error("crm down"));
    await expect(writePaymentStatus(REC, true, w)).rejects.toThrow("airtable down");
    const logged = error.mock.calls.map((call) => (call[1] as Error).message);
    expect(logged).toEqual(["airtable down", "crm down"]);
  });

  it("resolves when the Airtable record is gone but the CRM write succeeded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = writers(true);
    w.airtable.mockRejectedValueOnce(new AirtableRecordNotFoundError("gone"));
    await expect(writePaymentStatus(REC, true, w)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rejects when the Airtable record is gone and the CRM write failed too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = writers(true);
    w.airtable.mockRejectedValueOnce(new AirtableRecordNotFoundError("gone"));
    w.crm!.mockRejectedValueOnce(new Error("crm down"));
    await expect(writePaymentStatus(REC, true, w)).rejects.toThrow("gone");
  });

  it("rejects when the Airtable record is gone and there are no CRM settings", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const w = writers(false);
    w.airtable.mockRejectedValueOnce(new AirtableRecordNotFoundError("gone"));
    await expect(writePaymentStatus(REC, true, w)).rejects.toThrow("gone");
  });
});
