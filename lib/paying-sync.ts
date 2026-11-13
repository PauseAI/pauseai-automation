import type Stripe from "stripe";
import {
  pacedAirtableRequests,
  readTallyIndex,
  realClock,
  syncAirtablePaying,
  DeadlineError,
  type AirtableClock,
  type AirtablePayingStore,
  type AirtableResult,
} from "./airtable-paying";
import { hasUnresolved, type ReconcileOptions, type ReconcileResult } from "./crm";
import { buildPayingSet, memberIdKind, memberIdStrength, type PayingSet } from "./payment-status";

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
 * created it. A record or signup id wins over a Tally id, and a Tally id over
 * an invalid one, whichever session came first.
 */
export async function memberIdsBySubscription(sessions: AsyncIterable<SessionRef>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for await (const session of sessions) {
    const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
    const memberId = session.client_reference_id;
    if (!subscription || !memberId) continue;
    const existing = map.get(subscription);
    if (existing === undefined || memberIdStrength(memberId) > memberIdStrength(existing)) map.set(subscription, memberId);
  }
  return map;
}

export interface SyncDeps {
  productId: string;
  /** Both list from Stripe and must reject once `deadline` has passed (see paginate). */
  listSubscriptions: (deadline: number) => AsyncIterable<Stripe.Subscription>;
  listSessions: (deadline: number) => AsyncIterable<SessionRef>;
  /** Null when the CRM settings are unset. */
  reconcile: ((memberIds: string[], options: ReconcileOptions) => Promise<ReconcileResult>) | null;
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
 * gets the difference to its ticked rows. Tally ids are resolved to Airtable
 * record ids first, since the CRM knows members by record id. If listing from
 * Stripe or reading the Tally IDs fails or runs past the deadline, or no Tally
 * id the subscriptions carry matches a row, nothing is written.
 */
export async function syncPaying(deps: SyncDeps): Promise<SyncSummary> {
  const tag = deps.dryRun ? "Paying sync (dry run)" : "Paying sync";
  const airtableRequest = pacedAirtableRequests(deps.deadline, deps.clock);
  let stage = "listing from Stripe";
  let set: PayingSet;
  try {
    const subscriptions: Stripe.Subscription[] = [];
    for await (const subscription of deps.listSubscriptions(deps.deadline)) subscriptions.push(subscription);
    const sessionIds = await memberIdsBySubscription(deps.listSessions(deps.deadline));
    stage = "reading Tally IDs from Airtable";
    const tallyIndex = await readTallyIndex(deps.airtable, airtableRequest);
    if ((deps.clock ?? realClock).now() >= deps.deadline) throw new DeadlineError("Deadline passed reading Tally IDs");
    set = buildPayingSet(subscriptions, sessionIds, deps.productId, tallyIndex);
    // None matching means the Tally ID field is misread (renamed, retyped, or
    // TALLY_ID_FIELD_NAME wrong); the CRM would clear every Tally payer.
    if (set.tally.length > 0 && !set.tally.some(({ rows }) => rows === 1)) {
      throw new Error(`none of ${set.tally.length} Tally ids matches an Airtable row`);
    }
  } catch (error) {
    console.error(`${tag}: ${stage} failed, nothing written:`, error);
    deps.alert(`${tag}: ${stage} failed or ran past the deadline; nothing written`);
    return { dryRun: deps.dryRun, discovery: "failed", crm: "skipped", airtable: "failed" };
  }
  for (const { subscription, memberId } of set.borrowed) {
    console.log(`${tag}: subscription ${subscription} takes member id ${memberId} from its customer's other subscription`);
  }
  for (const { subscription, tallyId, rows } of set.tally) {
    if (rows === 0) console.warn(`${tag}: subscription ${subscription}: Tally id ${tallyId} not found`);
    if (rows > 1) console.warn(`${tag}: subscription ${subscription}: Tally id ${tallyId} on ${rows} rows`);
  }
  for (const id of set.unmapped) console.warn(`${tag}: subscription ${id} has no member id`);
  for (const id of set.invalid) console.warn(`${tag}: member id of no known shape: ${JSON.stringify(id).slice(0, 64)}`);

  const paying = [...set.paying];
  const payingRecordIds = new Set(paying.filter((id) => memberIdKind(id) === "airtable"));
  if (!deps.reconcile) {
    const signups = paying.length - payingRecordIds.size;
    console.warn(`${tag}: CRM settings unset, writing Airtable only; skipped ${signups} signup ids`);
  }

  const [crm, airtable] = await Promise.all([
    deps.reconcile
      ? deps.reconcile(paying, {
          dryRun: deps.dryRun,
          deadline: deps.deadline,
          unmappedPaying: set.unmappedPaying.length,
        }).catch((error) => {
          console.error(`${tag}: CiviCRM reconcile failed:`, error);
          return "failed" as const;
        })
      : ("skipped" as const),
    syncAirtablePaying(payingRecordIds, deps.airtable, {
      dryRun: deps.dryRun,
      allowRemovals: deps.allowAirtableRemovals,
      request: airtableRequest,
    }).catch((error) => {
      console.error(`${tag}: Airtable sync failed:`, error);
      return "failed" as const;
    }),
  ]);

  const tallyCount = (test: (rows: number) => boolean) => set.tally.filter(({ rows }) => test(rows)).length;
  const crmLine =
    typeof crm === "string"
      ? crm
      : `${crm.status}${crm.reason ? ` (${crm.reason})` : ""}, ${crm.setTrue} set paying, ${crm.setFalse} cleared, ` +
        `${crm.failed.length} failed`;
  const airtableLine =
    typeof airtable === "string"
      ? airtable
      : `${airtable.status}, ${airtable.ticked} ticked, ${airtable.redirected.length} redirected to merge survivors, ` +
        `${airtable.brokenMerges.length} broken merge paths, ` +
        `${airtable.toTick.length} to tick, ${airtable.toUntick.length} to untick` +
        `${airtable.removalsAllowed ? " (untick guard lifted)" : ""}, ${airtable.written} written, ` +
        `${airtable.notFound.length} skipped (not found), ${airtable.failed} failed`;
  console.log(
    `${tag}: ${set.members} members, ${set.paying.size} paying, ${set.borrowed.length} borrowed ids, ` +
      `${tallyCount((rows) => rows === 1)} resolved via Tally id, ${tallyCount((rows) => rows === 0)} Tally ids not found, ` +
      `${tallyCount((rows) => rows > 1)} Tally ids on several rows, ` +
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
    ...(typeof airtable === "object" && airtable.brokenMerges.length > 0
      ? [`Airtable merge paths that end on no single survivor, from ${airtable.brokenMerges.join(", ")}; no row unticked`]
      : []),
  ];
  if (problems.length > 0) deps.alert(`${tag}: ${problems.join("; ")}`);
  return { dryRun: deps.dryRun, discovery: "ok", set, crm, airtable };
}
