import { createApp, toWebHandler } from "h3";
import { describe, expect, it, vi } from "vitest";
import handler from "../server/routes/stripe.post";

describe("POST /stripe", () => {
  const app = createApp().use("/stripe", handler);
  const call = toWebHandler(app);

  it.each([
    JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } }),
    "not json",
  ])("acknowledges with 200 and does nothing else", async (body) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await call(
      new Request("http://localhost/stripe", { method: "POST", headers: { "content-type": "application/json" }, body })
    );
    expect(response.status).toBe(200);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });

  it("logs the event type and subscription id", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await call(
      new Request("http://localhost/stripe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "customer.subscription.updated", data: { object: { id: "sub_9" } } }),
      })
    );
    expect(log.mock.calls[0][0]).toBe("Stripe event ignored: customer.subscription.updated sub_9");
    log.mockRestore();
  });
});
