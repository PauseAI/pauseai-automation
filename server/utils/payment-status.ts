import type Stripe from "stripe";

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

/** Whether a subscription, as Stripe holds it now, makes its member a paying member. */
export function isPayingSubscription(subscription: Stripe.Subscription, productId: string): boolean {
  return (
    PAYING_STATUSES.has(subscription.status) &&
    subscription.items.data.some((item) => {
      const product = item.price.product;
      return (typeof product === "string" ? product : product.id) === productId;
    })
  );
}

type PaymentStatusWriter = (memberId: string, status: boolean) => Promise<void>;

export interface PaymentStatusWriters {
  airtable: PaymentStatusWriter;
  /** Null when the CRM settings are unset. */
  crm: PaymentStatusWriter | null;
}

/**
 * Writes the payment status to Airtable (Airtable record ids only) and to
 * CiviCRM (every id). An id of neither shape is logged and ignored, since a
 * retry cannot fix it. Both writes are idempotent, so when either fails this
 * logs every failure and rejects, and Stripe retries both.
 */
export async function writePaymentStatus(
  memberId: string | null,
  status: boolean,
  writers: PaymentStatusWriters
): Promise<void> {
  const kind = memberIdKind(memberId);
  if (!kind) {
    console.error(
      `Ignoring client_reference_id that is neither an Airtable record id nor a signup id: ${JSON.stringify(memberId)?.slice(0, 64)}`
    );
    return;
  }
  if (kind === "signup" && !writers.crm) {
    // Rejecting keeps the event in Stripe's retries until the CRM settings are set.
    throw new Error(`No CRM settings to record payment status for signup id ${memberId}`);
  }
  const writes = [
    ...(kind === "airtable" ? [writers.airtable(memberId, status)] : []),
    ...(writers.crm ? [writers.crm(memberId, status)] : []),
  ];
  const failures = (await Promise.allSettled(writes))
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  for (const failure of failures) {
    console.error(`Payment status ${status} for member ${memberId} not recorded:`, failure);
  }
  if (failures.length > 0) throw failures[0];
}

export interface SubscriptionEventDeps {
  productId: string;
  retrieveSubscription: (subscriptionId: string) => Promise<Stripe.Subscription>;
  clientReferenceId: (subscriptionId: string) => Promise<string | null>;
  writers: PaymentStatusWriters;
}

/**
 * Records the payment status a subscription gives its member. The status is
 * read from Stripe now rather than taken from the event, so an event that
 * arrives late, out of order or as a retry still records the current status.
 */
export async function recordSubscriptionStatus(subscriptionId: string, deps: SubscriptionEventDeps): Promise<void> {
  const paying = isPayingSubscription(await deps.retrieveSubscription(subscriptionId), deps.productId);
  const memberId = await deps.clientReferenceId(subscriptionId);
  await writePaymentStatus(memberId, paying, deps.writers);
}
