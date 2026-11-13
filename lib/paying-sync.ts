import type Stripe from "stripe";
import { includesProduct, isPayingMember, memberIdKind, writeMemberPaying, type PaymentStatusWriters } from "./payment-status";

export interface Page<T> {
  data: T[];
  has_more: boolean;
}

/** Every item of a Stripe list, page by page. */
export async function* paginate<T extends { id: string }>(
  fetchPage: (startingAfter: string | undefined) => Promise<Page<T>>
): AsyncGenerator<T> {
  let startingAfter: string | undefined;
  for (;;) {
    const page = await fetchPage(startingAfter);
    yield* page.data;
    if (!page.has_more || page.data.length === 0) return;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

type SessionRef = Pick<Stripe.Checkout.Session, "id" | "subscription" | "client_reference_id">;

/** Subscription id to the `client_reference_id` of the checkout session that created it. */
export async function memberIdsBySubscription(sessions: AsyncIterable<SessionRef>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for await (const session of sessions) {
    const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    if (subscription && session.client_reference_id) map.set(subscription, session.client_reference_id);
  }
  return map;
}

/** Runs `task` over `items`, at most `limit` at a time, until `stopAt` (ms since epoch). */
async function forEachLimited<T>(
  items: T[],
  limit: number,
  stopAt: number,
  task: (item: T) => Promise<void>
): Promise<number> {
  let next = 0;
  const worker = async () => {
    while (next < items.length && Date.now() < stopAt) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return items.length - next;
}

export interface SyncDeps {
  productId: string;
  subscriptions: AsyncIterable<Stripe.Subscription>;
  sessions: AsyncIterable<SessionRef>;
  writers: PaymentStatusWriters;
  concurrency?: number;
  /** When to stop starting member writes, in ms since epoch. */
  stopAt?: number;
}

export interface SyncSummary {
  members: number;
  written: number;
  refused: number;
  skipped: number;
  failed: number;
  notReached: number;
  unmapped: number;
}

/**
 * Writes the paying status of every member with a subscription to the
 * product, as Stripe holds it now. A member pays if any of their
 * subscriptions does. One member's failure does not stop the others.
 */
export async function syncPayingMembers(deps: SyncDeps): Promise<SyncSummary> {
  const subscriptions: Stripe.Subscription[] = [];
  for await (const subscription of deps.subscriptions) {
    if (includesProduct(subscription, deps.productId)) subscriptions.push(subscription);
  }
  const memberIds = await memberIdsBySubscription(deps.sessions);

  const byMember = new Map<string, Stripe.Subscription[]>();
  let unmapped = 0;
  for (const subscription of subscriptions) {
    const memberId = memberIds.get(subscription.id);
    if (!memberId) {
      unmapped++;
      console.warn(`Subscription ${subscription.id} has no checkout session with a client_reference_id`);
      continue;
    }
    byMember.set(memberId, [...(byMember.get(memberId) ?? []), subscription]);
  }

  const summary: SyncSummary = {
    members: byMember.size,
    written: 0,
    refused: 0,
    skipped: 0,
    failed: 0,
    notReached: 0,
    unmapped,
  };
  let skippedSignups = 0;
  summary.notReached = await forEachLimited(
    [...byMember],
    deps.concurrency ?? 4,
    deps.stopAt ?? Infinity,
    async ([memberId, memberSubscriptions]) => {
      if (!memberIdKind(memberId)) {
        console.error(`Skipping client_reference_id of neither id shape: ${JSON.stringify(memberId).slice(0, 64)}`);
        summary.skipped++;
        return;
      }
      try {
        const result = await writeMemberPaying(memberId, isPayingMember(memberSubscriptions, deps.productId), deps.writers);
        if (result.outcome === "skipped") skippedSignups++;
        summary[result.outcome]++;
      } catch {
        summary.failed++;
      }
    }
  );
  if (skippedSignups > 0) {
    console.warn(`CRM settings unset: skipped ${skippedSignups} signup ids`);
  }
  console.log(
    `Paying sync: ${summary.members} members, ${summary.written} written, ${summary.refused} refused, ` +
      `${summary.failed} failed, ${summary.skipped} skipped, ${summary.notReached} not reached, ` +
      `${summary.unmapped} subscriptions without a member id`
  );
  return summary;
}
