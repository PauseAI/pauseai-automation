import type Stripe from "stripe";
import type { AirtableClock } from "../lib/airtable-paying";

export const REC = "rec" + "A".repeat(14);
export const REC2 = "rec" + "B".repeat(14);
export const MEM = "mem" + "b".repeat(22);
export const MEM2 = "mem" + "c".repeat(22);
export const PRODUCT = "prod_member";
export const TALLY = "KYle2vK";
export const TALLY2 = "A7v1k6e";

export function subscription(
  id: string,
  status: Stripe.Subscription.Status,
  products: (string | { id: string })[] = [PRODUCT],
  customer = `cus_${id}`
) {
  return {
    id,
    status,
    customer,
    items: { data: products.map((product) => ({ price: { product } })) },
  } as unknown as Stripe.Subscription;
}

export const session = (id: string, subscriptionId: string | null, memberId: string | null) => ({
  id,
  subscription: subscriptionId,
  client_reference_id: memberId,
});

/** A clock whose sleep advances time at once, recording each sleep. */
export function fakeClock(start = 0): AirtableClock & { sleeps: number[]; starts: number[] } {
  let now = start;
  const clock = {
    sleeps: [] as number[],
    starts: [] as number[],
    now: () => now,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      now += ms;
    },
  };
  return clock;
}
