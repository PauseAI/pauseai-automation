import type Stripe from "stripe";

// The id the website passes to Stripe as `client_reference_id`: an Airtable
// record id, or the signup id of a member who signed up in CiviCRM alone.
// Subscriptions started before 2026-07-16 carry the member's Tally submission
// id instead, which the Airtable row records in its Tally ID field. Tally does
// not document the format; the ids seen are 7 alphanumeric characters.
// Stripe passes the id on from the checkout link, so it is user input.
const AIRTABLE_RECORD_ID_REGEX = /^rec[a-zA-Z0-9]{14}$/;
const SIGNUP_ID_REGEX = /^mem[a-zA-Z0-9]{22}$/;
const TALLY_ID_REGEX = /^[a-zA-Z0-9]{6,8}$/;

const PAYING_STATUSES: ReadonlySet<Stripe.Subscription.Status> = new Set(["active", "trialing", "past_due"]);

export type MemberIdKind = "airtable" | "signup" | "tally";

export function memberIdKind(id: string | null | undefined): MemberIdKind | null {
  if (id && AIRTABLE_RECORD_ID_REGEX.test(id)) return "airtable";
  if (id && SIGNUP_ID_REGEX.test(id)) return "signup";
  if (id && TALLY_ID_REGEX.test(id)) return "tally";
  return null;
}

/** How strongly an id names a member: a record or signup id over a Tally id, a Tally id over anything else. */
export function memberIdStrength(id: string | null | undefined): number {
  const kind = memberIdKind(id);
  return kind === "airtable" || kind === "signup" ? 2 : kind === "tally" ? 1 : 0;
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
  /** Record and signup ids with at least one paying subscription to the product. */
  paying: Set<string>;
  /** Member ids with a subscription to the product, paying or not. */
  members: number;
  /** Subscriptions to the product that took their member id from another subscription of the same customer. */
  borrowed: { subscription: string; memberId: string }[];
  /** Subscriptions to the product with no valid member id. */
  unmapped: string[];
  /** The unmapped subscriptions that are paying: these payers are missed until someone repairs them. */
  unmappedPaying: string[];
  /** Member ids of no known shape. */
  invalid: string[];
  /** Subscriptions to the product named by a Tally id, and how many Airtable rows hold it (1: resolved). */
  tally: { subscription: string; tallyId: string; rows: number }[];
}

/**
 * The member ids that pay now. A subscription's member id is, in order: its
 * `member_id` metadata (so staff can repair a subscription in Stripe), its
 * checkout session's `client_reference_id`, or, when the customer's other
 * subscriptions name exactly one valid member id, that one. A record or
 * signup id from either source beats a Tally id. A Tally id becomes the record
 * id of the one Airtable row `tallyIndex` lists for it, and is no id when it
 * lists none or several; a customer with such a Tally id lends no id, since
 * the subscription may belong to someone else. A member pays if any of their
 * subscriptions to the product is active, trialing or past_due; a member
 * whose subscriptions all ended or left the product is not in the set.
 */
export function buildPayingSet(
  subscriptions: Stripe.Subscription[],
  memberIdBySubscription: Map<string, string>,
  productId: string,
  tallyIndex: Map<string, string[]> = new Map()
): PayingSet {
  const ownId = (subscription: Stripe.Subscription): { memberId?: string; tally?: { tallyId: string; rows: number } } => {
    const sources = [subscription.metadata?.member_id, memberIdBySubscription.get(subscription.id)];
    const direct = sources.find((id) => memberIdStrength(id) === 2);
    if (direct) return { memberId: direct };
    const tallyIds = sources.filter((id): id is string => memberIdKind(id) === "tally");
    const tallyId = tallyIds.find((id) => tallyIndex.get(id)?.length === 1) ?? tallyIds[0];
    if (!tallyId) return { memberId: sources[1] };
    const rows = tallyIndex.get(tallyId) ?? [];
    return { memberId: rows.length === 1 ? rows[0] : undefined, tally: { tallyId, rows: rows.length } };
  };
  const validIdsByCustomer = new Map<string, Set<string>>();
  const unresolvedTallyCustomers = new Set<string>();
  for (const subscription of subscriptions) {
    const { memberId, tally } = ownId(subscription);
    if (tally && tally.rows !== 1) unresolvedTallyCustomers.add(customerId(subscription));
    if (!memberId || !memberIdKind(memberId)) continue;
    const ids = validIdsByCustomer.get(customerId(subscription)) ?? new Set<string>();
    validIdsByCustomer.set(customerId(subscription), ids.add(memberId));
  }
  const set: PayingSet = { paying: new Set(), members: 0, borrowed: [], unmapped: [], unmappedPaying: [], invalid: [], tally: [] };
  const members = new Set<string>();
  for (const subscription of subscriptions) {
    if (!includesProduct(subscription, productId)) continue;
    const isPaying = PAYING_STATUSES.has(subscription.status);
    const own = ownId(subscription);
    let memberId = own.memberId;
    if (own.tally) set.tally.push({ subscription: subscription.id, ...own.tally });
    if (memberId && !memberIdKind(memberId)) {
      if (!set.invalid.includes(memberId)) set.invalid.push(memberId);
      memberId = undefined;
    }
    if (!memberId && !unresolvedTallyCustomers.has(customerId(subscription))) {
      const candidates = validIdsByCustomer.get(customerId(subscription));
      if (candidates?.size === 1) {
        memberId = [...candidates][0];
        set.borrowed.push({ subscription: subscription.id, memberId });
      }
    }
    if (!memberId) {
      set.unmapped.push(subscription.id);
      if (isPaying) set.unmappedPaying.push(subscription.id);
      continue;
    }
    members.add(memberId);
    if (isPaying) set.paying.add(memberId);
  }
  set.members = members.size;
  return set;
}
