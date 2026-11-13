import type Stripe from "stripe";
import { syncAirtablePaying, DeadlineError, type AirtableClock, type AirtablePayingStore, type AirtableResult } from "./airtable-paying";
import { hasUnresolved, type ReconcileResult } from "./crm";
import { buildPayingSet, memberIdKind, type PayingSet } from "./payment-status";

export interface Page<T> {
  data: T[];
  has_more: boolean;
}

/** Every item of a Stripe list, page by page; rejects once the deadline has passed. */
export async function* paginate<T extends { id: string }>(
  fetchPage: (startingAfter: string | undefined) => Promise<Page<T>>,
  deadline = Infinity,
  now: () => number = Date.now
): AsyncGenerator<T> {
  let startingAfter: string | undefined;
  for (;;) {
    if (now() >= deadline) throw new DeadlineError("Deadline passed while listing from Stripe");
    const page = await fetchPage(startingAfter);
    yield* page.data;
    if (!page.has_more || page.data.length === 0) return;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

type SessionRef = Pick<Stripe.Checkout.Session, "id" | "subscription" | "client_reference_id">;

/**
 * Subscription id to the `client_reference_id` of a checkout session that
 * created it. A valid id wins over an invalid one, whichever session came first.
 */
export async function memberIdsBySubscription(sessions: AsyncIterable<SessionRef>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for await (const session of sessions) {
    const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    const memberId = session.client_reference_id;
    if (!subscription || !memberId) continue;
    const existing = map.get(subscription);
    if (existing === undefined || (!memberIdKind(existing) && memberIdKind(memberId))) map.set(subscription, memberId);
  }
  return map;
}

export interface SyncDeps {
  productId: string;
  /** Both list from Stripe and must reject once `deadline` has passed (see paginate). */
  listSubscriptions: (deadline: number) => AsyncIterable<Stripe.Subscription>;
  listSessions: (deadline: number) => AsyncIterable<SessionRef>;
  /** Null when the CRM settings are unset. */
  reconcile: ((memberIds: string[], options: { dryRun: boolean; deadline: number }) => Promise<ReconcileResult>) | null;
  airtable: AirtablePayingStore;
  dryRun: boolean;
  /** Lifts Airtable's untick guard (PAYING_SYNC_AIRTABLE_ALLOW_REMOVALS_UNTIL). */
  allowAirtableRemovals?: boolean;
  deadline: number;
  alert: (message: string) => void;
  clock?: AirtableClock;
}

export interface SyncSummary {
  dryRun: boolean;
  discovery: "ok" | "failed";
  set?: PayingSet;
  crm: ReconcileResult | "skipped" | "failed";
  airtable: AirtableResult | "failed";
}

/**
 * Makes CiviCRM and Airtable hold exactly the members who pay now, as Stripe
 * says: the whole paying set goes to the CRM in one reconcile, and Airtable
 * gets the difference to its ticked rows. If listing from Stripe fails or
 * runs past the deadline, nothing is written.
 */
export async function syncPaying(deps: SyncDeps): Promise<SyncSummary> {
  const tag = deps.dryRun ? "Paying sync (dry run)" : "Paying sync";
  let set: PayingSet;
  try {
    const subscriptions: Stripe.Subscription[] = [];
    for await (const subscription of deps.listSubscriptions(deps.deadline)) subscriptions.push(subscription);
    set = buildPayingSet(subscriptions, await memberIdsBySubscription(deps.listSessions(deps.deadline)), deps.productId);
  } catch (error) {
    console.error(`${tag}: listing from Stripe failed, nothing written:`, error);
    deps.alert(`${tag}: listing from Stripe failed or ran past the deadline; nothing written`);
    return { dryRun: deps.dryRun, discovery: "failed", crm: "skipped", airtable: "failed" };
  }
  for (const { subscription, memberId } of set.borrowed) {
    console.log(`${tag}: subscription ${subscription} takes member id ${memberId} from its customer's other subscription`);
  }
  for (const id of set.unmapped) console.warn(`${tag}: subscription ${id} has no member id`);
  for (const id of set.invalid) console.warn(`${tag}: member id of neither shape: ${JSON.stringify(id).slice(0, 64)}`);

  const paying = [...set.paying];
  const payingRecordIds = new Set(paying.filter((id) => memberIdKind(id) === "airtable"));
  if (!deps.reconcile) {
    const signups = paying.length - payingRecordIds.size;
    console.warn(`${tag}: CRM settings unset, writing Airtable only; skipped ${signups} signup ids`);
  }

  const [crm, airtable] = await Promise.all([
    deps.reconcile
      ? deps.reconcile(paying, { dryRun: deps.dryRun, deadline: deps.deadline }).catch((error) => {
          console.error(`${tag}: CiviCRM reconcile failed:`, error);
          return "failed" as const;
        })
      : ("skipped" as const),
    syncAirtablePaying(payingRecordIds, deps.airtable, {
      dryRun: deps.dryRun,
      deadline: deps.deadline,
      allowRemovals: deps.allowAirtableRemovals,
      clock: deps.clock,
    }).catch((error) => {
      console.error(`${tag}: Airtable sync failed:`, error);
      return "failed" as const;
    }),
  ]);

  const crmLine =
    typeof crm === "string"
      ? crm
      : `${crm.status}${crm.reason ? ` (${crm.reason})` : ""}, ${crm.setTrue} set paying, ${crm.setFalse} cleared, ` +
        `${crm.failed.length} failed`;
  const airtableLine =
    typeof airtable === "string"
      ? airtable
      : `${airtable.status}, ${airtable.ticked} ticked, ${airtable.redirected.length} redirected to merge survivors, ` +
        `${airtable.toTick.length} to tick, ${airtable.toUntick.length} to untick` +
        `${airtable.removalsAllowed ? " (untick guard lifted)" : ""}, ${airtable.written} written, ` +
        `${airtable.notFound.length} skipped (not found), ${airtable.failed} failed`;
  console.log(
    `${tag}: ${set.members} members, ${set.paying.size} paying, ${set.borrowed.length} borrowed ids, ` +
      `${set.unmapped.length} unmapped subscriptions, ${set.unmappedPaying.length} of them paying ` +
      `${JSON.stringify(set.unmappedPaying)}, ${set.invalid.length} invalid ids. CiviCRM: ${crmLine}. Airtable: ${airtableLine}.`
  );
  if (typeof crm === "object") {
    console.log(`${tag}: CiviCRM unresolved: ${JSON.stringify(crm.unresolved)}`);
    if (crm.failed.length > 0) console.error(`${tag}: CiviCRM failed writes: ${JSON.stringify(crm.failed)}`);
  }
  if (typeof airtable === "object") {
    for (const { from, to } of airtable.redirected) console.log(`${tag}: Airtable row ${from} was merged into ${to}`);
    if (airtable.notFound.length > 0) {
      console.warn(`${tag}: Airtable records not found, skipped: ${airtable.notFound.join(", ")}`);
    }
  }
  if (deps.dryRun) {
    // Everything a person needs to review before the first real run.
    if (typeof crm === "object") console.log(`${tag}: CiviCRM answer: ${JSON.stringify(crm.answer)}`);
    if (typeof airtable === "object") {
      console.log(`${tag}: Airtable ticked now: ${JSON.stringify(airtable.tickedIds)}`);
      console.log(`${tag}: Airtable would tick ${JSON.stringify(airtable.toTick)}, untick ${JSON.stringify(airtable.toUntick)}`);
    }
  }

  // A payer the stores do not record must never be silent.
  const problems = [
    ...(set.unmappedPaying.length > 0 ? [`${set.unmappedPaying.length} paying subscriptions without a member id`] : []),
    ...(crm === "failed" ? ["CiviCRM failed"] : []),
    ...(typeof crm === "object" && crm.status !== "ok" ? [`CiviCRM ${crm.status} (${crm.reason})`] : []),
    ...(typeof crm === "object" && hasUnresolved(crm.unresolved) ? ["CiviCRM could not resolve some paying ids"] : []),
    ...(typeof crm === "object" && crm.failed.length > 0 ? [`${crm.failed.length} CiviCRM writes failed`] : []),
    ...(airtable === "failed" ? ["Airtable failed"] : []),
    ...(typeof airtable === "object" && airtable.status !== "ok" ? [`Airtable ${airtable.status}`] : []),
    ...(typeof airtable === "object" && airtable.failed > 0 ? [`${airtable.failed} Airtable writes failed`] : []),
  ];
  if (problems.length > 0) deps.alert(`${tag}: ${problems.join("; ")}`);
  return { dryRun: deps.dryRun, discovery: "ok", set, crm, airtable };
}
