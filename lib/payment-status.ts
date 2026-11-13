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
  /** Subscriptions to the product whose Tally id names exactly one Airtable row, and that row's record id. */
  viaTally: { subscription: string; tallyId: string; memberId: string }[];
  /** Subscriptions to the product whose Tally id names no Airtable row. */
  tallyNotFound: { subscription: string; tallyId: string }[];
  /** Subscriptions to the product whose Tally id names more than one Airtable row. */
  tallyAmbiguous: { subscription: string; tallyId: string; rows: number }[];
}

/**
 * The member ids that pay now. A subscription's member id is, in order: its
 * `member_id` metadata (so staff can repair a subscription in Stripe), its
 * checkout session's `client_reference_id`, or, when the customer's other
 * subscriptions name exactly one valid member id, that one. A Tally id becomes
 * the record id of the one Airtable row `tallyIndex` lists for it, and is no
 * id when it lists none or several. A member pays if
 * any of their subscriptions to the product is active, trialing or past_due;
 * a member whose subscriptions all ended or left the product is not in the set.
 */
export function buildPayingSet(
  subscriptions: Stripe.Subscription[],
  memberIdBySubscription: Map<string, string>,
  productId: string,
  tallyIndex: Map<string, string[]> = new Map()
): PayingSet {
  const ownId = (subscription: Stripe.Subscription): { memberId?: string; tallyId?: string; rows?: string[] } => {
    const fromMetadata = subscription.metadata?.member_id;
    const memberId = fromMetadata && memberIdKind(fromMetadata) ? fromMetadata : memberIdBySubscription.get(subscription.id);
    if (!memberId || memberIdKind(memberId) !== "tally") return { memberId };
    const rows = tallyIndex.get(memberId) ?? [];
    return { memberId: rows.length === 1 ? rows[0] : undefined, tallyId: memberId, rows };
  };
  const validIdsByCustomer = new Map<string, Set<string>>();
  for (const subscription of subscriptions) {
    const { memberId } = ownId(subscription);
    if (!memberId || !memberIdKind(memberId)) continue;
    const ids = validIdsByCustomer.get(customerId(subscription)) ?? new Set<string>();
    validIdsByCustomer.set(customerId(subscription), ids.add(memberId));
  }
  const set: PayingSet = {
    paying: new Set(),
    members: 0,
    borrowed: [],
    unmapped: [],
    unmappedPaying: [],
    invalid: [],
    viaTally: [],
    tallyNotFound: [],
    tallyAmbiguous: [],
  };
  const members = new Set<string>();
  for (const subscription of subscriptions) {
    if (!includesProduct(subscription, productId)) continue;
    const isPaying = PAYING_STATUSES.has(subscription.status);
    const own = ownId(subscription);
    let memberId = own.memberId;
    if (own.tallyId !== undefined) {
      const tallyId = own.tallyId;
      if (memberId) set.viaTally.push({ subscription: subscription.id, tallyId, memberId });
      else if (own.rows?.length) set.tallyAmbiguous.push({ subscription: subscription.id, tallyId, rows: own.rows.length });
      else set.tallyNotFound.push({ subscription: subscription.id, tallyId });
    }
    if (memberId && !memberIdKind(memberId)) {
      if (!set.invalid.includes(memberId)) set.invalid.push(memberId);
      memberId = undefined;
    }
    if (!memberId) {
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
