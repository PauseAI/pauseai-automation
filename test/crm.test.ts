import { afterEach, describe, expect, it, vi } from "vitest";
import { crmConfigFromEnv, setPayingInCrm } from "../lib/crm";

const CONFIG = { url: "https://crm.test", key: "secret-key" };
const MEM = "mem" + "b".repeat(22);

function answer(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("crmConfigFromEnv", () => {
  it("needs both settings and drops a trailing slash", () => {
    expect(crmConfigFromEnv({ CRM_URL: "https://crm.test/", CRM_STRIPE_WEBHOOK_KEY: "k" })).toEqual({
      url: "https://crm.test",
      key: "k",
    });
    expect(crmConfigFromEnv({ CRM_URL: "https://crm.test" })).toBeNull();
    expect(crmConfigFromEnv({ CRM_STRIPE_WEBHOOK_KEY: "k" })).toBeNull();
    expect(crmConfigFromEnv({ CRM_URL: "", CRM_STRIPE_WEBHOOK_KEY: "k" })).toBeNull();
  });
});

describe("setPayingInCrm", () => {
  it("posts the API4 call with the key in X-Civi-Auth", async () => {
    const fetchMock = answer(200, { values: [{ status: "ok", contact_id: 7 }] });
    await expect(setPayingInCrm(CONFIG, MEM, true)).resolves.toEqual({ status: "ok" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://crm.test/civicrm/ajax/api4/PauseaiPayingMember/set");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Civi-Auth"]).toBe("Bearer secret-key");
    const params = JSON.parse((init.body as URLSearchParams).get("params")!);
    expect(params).toEqual({ airtable_record_id: MEM, paying: true });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["not_found", "erased", "trashed", "not_a_member", "invalid_request"])(
    "answers a %s refusal with its reason",
    async (reason) => {
      answer(200, { values: [{ status: "refused", reason }] });
      await expect(setPayingInCrm(CONFIG, MEM, false)).resolves.toEqual({ status: "refused", reason });
    }
  );

  it.each([500, 503, 401])("rejects on HTTP %i", async (status) => {
    answer(status, { error_message: "x" });
    await expect(setPayingInCrm(CONFIG, MEM, true)).rejects.toThrow(`HTTP ${status}`);
  });

  it("rejects on an answer without a status", async () => {
    answer(200, { values: [] });
    await expect(setPayingInCrm(CONFIG, MEM, true)).rejects.toThrow(/without a status/);
  });

  it("rejects on a network error or timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }));
    await expect(setPayingInCrm(CONFIG, MEM, true)).rejects.toThrow(/timeout/);
  });
});
