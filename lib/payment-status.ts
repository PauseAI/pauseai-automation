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

/** Whether a subscription includes the product. Only its first page of items is read. */
export function includesProduct(subscription: Stripe.Subscription, productId: string): boolean {
  return subscription.items.data.some((item) => {
    const product = item.price.product;
    return (typeof product === "string" ? product : product.id) === productId;
  });
}

const customerId = (subscription: Stripe.Subscription) =>
  typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

export interface PayingSet {
  /** Member ids (both shapes) with at least one paying subscription to the product. */
  paying: Set<string>;
  /** Member ids with a subscription to the product, paying or not. */
  members: number;
  /** Subscriptions to the product that took their member id from another subscription of the same customer. */
  borrowed: { subscription: string; memberId: string }[];
  /** Subscriptions to the product with no member id. */
  unmapped: string[];
  /** The unmapped subscriptions that are paying: these members are missed until someone repairs them. */
  unmappedPaying: string[];
  /** Member ids of neither shape. */
  invalid: string[];
}

/**
 * The member ids that pay now. A subscription's member id is, in order: its
 * `member_id` metadata (so staff can repair a subscription in Stripe), its
 * checkout session's `client_reference_id`, or the id of another subscription
 * of the same Stripe customer. A member pays if any of their subscriptions to
 * the product is active, trialing or past_due; a member whose subscriptions
 * all ended or left the product is not in the set.
 */
export function buildPayingSet(
  subscriptions: Stripe.Subscription[],
  memberIdBySubscription: Map<string, string>,
  productId: string
): PayingSet {
  const ownId = (subscription: Stripe.Subscription) => {
    const fromMetadata = subscription.metadata?.member_id;
    if (fromMetadata && memberIdKind(fromMetadata)) return fromMetadata;
    return memberIdBySubscription.get(subscription.id);
  };
  const memberIdByCustomer = new Map<string, string>();
  for (const subscription of subscriptions) {
    const memberId = ownId(subscription);
    if (memberId && !memberIdByCustomer.has(customerId(subscription))) {
      memberIdByCustomer.set(customerId(subscription), memberId);
    }
  }
  const set: PayingSet = { paying: new Set(), members: 0, borrowed: [], unmapped: [], unmappedPaying: [], invalid: [] };
  const members = new Set<string>();
  for (const subscription of subscriptions) {
    if (!includesProduct(subscription, productId)) continue;
    const isPaying = PAYING_STATUSES.has(subscription.status);
    let memberId = ownId(subscription);
    if (!memberId) {
      memberId = memberIdByCustomer.get(customerId(subscription));
      if (memberId) set.borrowed.push({ subscription: subscription.id, memberId });
    }
    if (!memberId) {
      set.unmapped.push(subscription.id);
      if (isPaying) set.unmappedPaying.push(subscription.id);
      continue;
    }
    if (!memberIdKind(memberId)) {
      if (!set.invalid.includes(memberId)) set.invalid.push(memberId);
      continue;
    }
    members.add(memberId);
    if (isPaying) set.paying.add(memberId);
  }
  set.members = members.size;
  return set;
}
