import { afterEach, describe, expect, it, vi } from "vitest";
import { memberIdKind, writePaymentStatus } from "../server/utils/payment-status";

const REC = "rec" + "A".repeat(14);
const MEM = "mem" + "b".repeat(22);

const writers = (crm: boolean) => ({
  airtable: vi.fn(async () => {}),
  crm: crm ? vi.fn(async () => {}) : null,
});

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
    const w = writers(true);
    w.airtable.mockRejectedValueOnce(new Error("airtable down"));
    await expect(writePaymentStatus(REC, true, w)).rejects.toThrow("airtable down");
    expect(w.crm).toHaveBeenCalledWith(REC, true);
  });

  it("still writes Airtable when the CRM fails, then rejects", async () => {
    const w = writers(true);
    w.crm!.mockRejectedValueOnce(new Error("crm down"));
    await expect(writePaymentStatus(REC, true, w)).rejects.toThrow("crm down");
    expect(w.airtable).toHaveBeenCalledWith(REC, true);
  });
});
