import type Stripe from "stripe";
import type { CrmAnswer } from "./crm";

// The id the website passes to Stripe as `client_reference_id`: an Airtable
// record id, or the signup id of a member who signed up in CiviCRM alone.
// Stripe passes it on from the checkout link, so it is user input.
const AIRTABLE_RECORD_ID_REGEX = /^rec[a-zA-Z0-9]{14}$/;
const SIGNUP_ID_REGEX = /^mem[a-zA-Z0-9]{22}$/;

const PAYING_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set(["active", "trialing", "past_due"]);

export type MemberIdKind = "airtable" | "signup";

export function memberIdKind(id: string | null): MemberIdKind | null {
  if (id && AIRTABLE_RECORD_ID_REGEX.test(id)) return "airtable";
  if (id && SIGNUP_ID_REGEX.test(id)) return "signup";
  return null;
}

/** Whether a subscription includes the product. Only its first page of items is read. */
export function includesProduct(subscription: Stripe.Subscription, productId: string): boolean {
  return subscription.items.data.some((item) => {
    const product = item.price.product;
    return (typeof product === "string" ? product : product.id) === productId;
  });
}

/** Whether any of a member's subscriptions makes them a paying member now. */
export function isPayingMember(subscriptions: Stripe.Subscription[], productId: string): boolean {
  return subscriptions.some(
    (subscription) => PAYING_STATUSES.has(subscription.status) && includesProduct(subscription, productId)
  );
}

export interface PaymentStatusWriters {
  airtable: (recordId: string, paying: boolean) => Promise<void>;
  /** Null when the CRM settings are unset. */
  crm: ((memberId: string, paying: boolean) => Promise<CrmAnswer>) | null;
}

export type WriteOutcome = { outcome: "written" } | { outcome: "refused"; reason: string } | { outcome: "skipped" };

/**
 * Writes a member's paying status: to CiviCRM for every id, and to Airtable for
 * Airtable record ids. Without CRM settings a signup id is skipped. Both writes
 * are attempted; if either fails, every failure is logged and this rejects.
 * Both are idempotent.
 */
export async function writeMemberPaying(
  memberId: string,
  paying: boolean,
  writers: PaymentStatusWriters
): Promise<WriteOutcome> {
  const kind = memberIdKind(memberId);
  if (!kind || (kind === "signup" && !writers.crm)) return { outcome: "skipped" };
  const [airtable, crm] = await Promise.allSettled([
    kind === "airtable" ? writers.airtable(memberId, paying) : Promise.resolve(),
    writers.crm ? writers.crm(memberId, paying) : Promise.resolve(null),
  ]);
  const failures = [airtable, crm]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  for (const failure of failures) {
    console.error(`Paying status ${paying} for member ${memberId} not recorded:`, failure);
  }
  if (failures.length > 0) throw failures[0];
  const answer = crm.status === "fulfilled" ? crm.value : null;
  if (answer?.status === "refused") {
    console.warn(`CiviCRM refused paying status ${paying} for member ${memberId}: ${answer.reason}`);
    return { outcome: "refused", reason: answer.reason };
  }
  return { outcome: "written" };
}
