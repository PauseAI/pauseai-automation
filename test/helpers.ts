import type Stripe from "stripe";
import { vi } from "vitest";
import type { CrmAnswer } from "../lib/crm";

export const REC = "rec" + "A".repeat(14);
export const MEM = "mem" + "b".repeat(22);
export const PRODUCT = "prod_member";

export function subscription(
  id: string,
  status: Stripe.Subscription.Status,
  products: (string | { id: string })[] = [PRODUCT]
) {
  return {
    id,
    status,
    items: { data: products.map((product) => ({ price: { product } })) },
  } as unknown as Stripe.Subscription;
}

export const writers = (crm: boolean, answer: CrmAnswer = { status: "ok" }) => ({
  airtable: vi.fn(async (_id: string, _paying: boolean) => {}),
  crm: crm ? vi.fn(async (_id: string, _paying: boolean): Promise<CrmAnswer> => answer) : null,
});
