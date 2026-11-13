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

const isRecordOrSignupId = (id: string | undefined) => {
  const kind = memberIdKind(id);
  return kind === "airtable" || kind === "signup";
};
const isTallyId = (id: string | undefined) => memberIdKind(id) === "tally";

/**
 * The raw id a subscription names, from its `member_id` metadata and its
 * checkout sessions' ids, before a Tally id is resolved. A record or signup id
 * beats a Tally id, and within each, the metadata beats the sessions, so staff
 * can repair a subscription in Stripe. The metadata's id is final even when it
 * does not resolve or has no known shape, since staff set it to override the
 * sessions. Sessions naming different ids of the same kind conflict.
 */
export function chooseMemberId(
  metadataId: string | undefined,
  sessionIds: string[]
): { id: string } | { conflict: string[] } | { invalidMetadata: string } | { none: true } {
  if (metadataId && !memberIdKind(metadataId)) return { invalidMetadata: metadataId };
  for (const matches of [isRecordOrSignupId, isTallyId]) {
    if (metadataId && matches(metadataId)) return { id: metadataId };
    const fromSessions = [...new Set(sessionIds.filter(matches))];
    if (fromSessions.length === 1) return { id: fromSessions[0] };
    if (fromSessions.length > 1) return { conflict: fromSessions };
  }
  return { none: true };
}

/** Whether a subscription includes the product. Only its first page of items is read. */
export function includesProduct(subscription: Stripe.Subscription, productId: string): boolean {
  return subscription.items.data.some((item) => {
    const product = item.price.product;
    return (typeof product === "string" ? product : product.id) === productId;
  });
}

export interface PayingSet {
  /** Record and signup ids with at least one paying subscription to the product. */
  paying: Set<string>;
  /** Member ids with a subscription to the product, paying or not. */
  members: number;
  /** Subscriptions to the product with no valid member id. */
  unmapped: string[];
  /** The unmapped subscriptions that are paying: these payers are missed until someone repairs them. */
  unmappedPaying: string[];
  /** Ids of no known shape: `member_id` metadata, and session ids on subscriptions that name no other id. */
  invalid: string[];
  /** Subscriptions to the product whose `member_id` metadata has no known shape. */
  invalidMetadata: { subscription: string; id: string }[];
  /** Subscriptions to the product whose checkout sessions name different ids. */
  conflicting: { subscription: string; ids: string[] }[];
  /** Subscriptions to the product named by a Tally id, and how many Airtable rows hold it (1: resolved). */
  tally: { subscription: string; tallyId: string; rows: number }[];
}

/**
 * The member ids that pay now. A subscription's member id is the one
 * chooseMemberId picks; a Tally id becomes the record id of the one Airtable
 * row `tallyIndex` lists for it, and is no id when it lists none or several.
 * A subscription without an id is unmapped; it never takes the id of another
 * subscription, since a Stripe customer can pay for several people. A member
 * pays if any of their subscriptions to the product is active, trialing or
 * past_due; a member whose subscriptions all ended or left the product is not
 * in the set.
 */
export function buildPayingSet(
  subscriptions: Stripe.Subscription[],
  sessionIdsBySubscription: Map<string, string[]>,
  productId: string,
  tallyIndex: Map<string, string[]> = new Map()
): PayingSet {
  const set: PayingSet = {
    paying: new Set(),
    members: 0,
    unmapped: [],
    unmappedPaying: [],
    invalid: [],
    invalidMetadata: [],
    conflicting: [],
    tally: [],
  };
  const addInvalid = (id: string) => {
    if (!set.invalid.includes(id)) set.invalid.push(id);
  };
  const members = new Set<string>();
  for (const subscription of subscriptions) {
    if (!includesProduct(subscription, productId)) continue;
    const sessionIds = sessionIdsBySubscription.get(subscription.id) ?? [];
    const choice = chooseMemberId(subscription.metadata?.member_id, sessionIds);
    let memberId: string | undefined;
    if ("conflict" in choice) set.conflicting.push({ subscription: subscription.id, ids: choice.conflict });
    else if ("invalidMetadata" in choice) {
      set.invalidMetadata.push({ subscription: subscription.id, id: choice.invalidMetadata });
      addInvalid(choice.invalidMetadata);
    } else if ("none" in choice) sessionIds.forEach(addInvalid);
    else if (isTallyId(choice.id)) {
      const rows = tallyIndex.get(choice.id) ?? [];
      set.tally.push({ subscription: subscription.id, tallyId: choice.id, rows: rows.length });
      if (rows.length === 1) memberId = rows[0];
    } else memberId = choice.id;
    if (!memberId) {
      set.unmapped.push(subscription.id);
      if (PAYING_STATUSES.has(subscription.status)) set.unmappedPaying.push(subscription.id);
      continue;
    }
    members.add(memberId);
    if (PAYING_STATUSES.has(subscription.status)) set.paying.add(memberId);
  }
  set.members = members.size;
  return set;
}
