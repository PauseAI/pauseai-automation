// One-off: sets `metadata.member_id` on the subscriptions the paying sync can
// map only through a Tally submission id, so the sync can stop reading
// Airtable's Tally ID column. The id written is the Airtable record id of the
// row the Tally id names, followed through `Merged into` to the surviving row
// by the sync's own rules: CiviCRM keys that contact by it directly, without
// needing merge history. The Tally id goes into `metadata.tally_id` as well.
//
//   STRIPE_API_KEY=… AIRTABLE_API_KEY=… STRIPE_PRODUCT_ID=… vite-node scripts/backfill-member-id.ts
//   … vite-node scripts/backfill-member-id.ts --write <plan hash>
//
// A dry run prints the plan and its hash; --write refuses unless the plan it
// computes has that hash. Run while no sync can follow: once written, the
// sync's Tally misread guard refuses every run until its Tally read is gone.
import { createHash } from "node:crypto";
import Airtable from "airtable";
import Stripe from "stripe";
import { MAX_MERGE_HOPS } from "../lib/airtable-paying";
import { requireEnv } from "../lib/env";
import { memberIdsBySubscription, paginate } from "../lib/paying-sync";
import { chooseMemberId, includesProduct, memberIdKind } from "../lib/payment-status";

const BASE_ID = requireEnv("AIRTABLE_BASE_ID");
const TABLE_ID = requireEnv("AIRTABLE_TABLE_ID");
const TALLY_FIELD = process.env.TALLY_ID_FIELD_NAME || "Tally ID";
const MERGED_INTO_FIELD = "Merged into";
const PRODUCT_ID = requireEnv("STRIPE_PRODUCT_ID");
const PAYING = new Set(["active", "trialing", "past_due"]);

const writeIndex = process.argv.indexOf("--write");
const expectedHash = writeIndex === -1 ? null : process.argv[writeIndex + 1];

const stripe = new Stripe(requireEnv("STRIPE_API_KEY"), {
  apiVersion: "2025-04-30.basil" as Stripe.LatestApiVersion,
  maxNetworkRetries: 2,
});
const table = new Airtable({ apiKey: requireEnv("AIRTABLE_API_KEY") }).base(BASE_ID)(TABLE_ID);

const tallyRows = new Map<string, string[]>();
const mergedInto = new Map<string, string[]>();
for (const record of await table.select({ fields: [TALLY_FIELD, MERGED_INTO_FIELD], pageSize: 100 }).all()) {
  const tallyId = record.get(TALLY_FIELD);
  if (typeof tallyId === "string" && tallyId.trim()) {
    tallyRows.set(tallyId.trim(), [...(tallyRows.get(tallyId.trim()) ?? []), record.id]);
  }
  const links = record.get(MERGED_INTO_FIELD);
  if (Array.isArray(links) && links.length > 0) mergedInto.set(record.id, links as string[]);
}
// As syncAirtablePaying's survivor: null on a fork, a cycle or past the hop limit.
const survivor = (id: string): string | null => {
  const seen = new Set([id]);
  for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
    const links = mergedInto.get(id);
    if (!links) return id;
    if (links.length !== 1 || seen.has(links[0])) return null;
    seen.add((id = links[0]));
  }
  return mergedInto.has(id) ? null : id;
};

const subscriptions: Stripe.Subscription[] = [];
for await (const s of paginate((starting_after) => stripe.subscriptions.list({ status: "all", limit: 100, starting_after }))) {
  if (includesProduct(s, PRODUCT_ID)) subscriptions.push(s);
}
const sessionIds = await memberIdsBySubscription(
  paginate((starting_after) => stripe.checkout.sessions.list({ status: "complete", limit: 100, starting_after }))
);

type Planned = {
  subscription: string;
  status: string;
  tallyId: string;
  row: string;
  memberId: string;
  /** `metadata.member_id` when planned; the write is skipped if it has changed since. */
  previous: string | undefined;
};
const planned: Planned[] = [];
const skipped: { subscription: string; status: string; why: string }[] = [];
for (const s of subscriptions) {
  const previous = s.metadata?.member_id;
  const choice = chooseMemberId(previous, sessionIds.get(s.id) ?? []);
  if ("id" in choice && memberIdKind(choice.id) !== "tally") continue;
  if (!("id" in choice)) {
    skipped.push({ subscription: s.id, status: s.status, why: JSON.stringify(choice) });
    continue;
  }
  const rows = tallyRows.get(choice.id) ?? [];
  const to = rows.length === 1 ? survivor(rows[0]) : null;
  if (to) planned.push({ subscription: s.id, status: s.status, tallyId: choice.id, row: rows[0], memberId: to, previous });
  else skipped.push({ subscription: s.id, status: s.status, why: `Tally id ${choice.id} on ${rows.length} rows${rows.length === 1 ? ", broken merge path" : ""}` });
}
// Paying first, so they land even if a write to an ended subscription fails.
planned.sort((a, b) => Number(PAYING.has(b.status)) - Number(PAYING.has(a.status)));

for (const p of planned) {
  console.log(
    `${p.subscription}\t${p.status}\t${p.tallyId}\t${p.memberId}` +
      `${p.row !== p.memberId ? `\t(row ${p.row}, merged)` : ""}${p.previous ? `\t(member_id was ${p.previous})` : ""}`
  );
}
console.log("\nNot written:");
for (const s of skipped) console.log(`${s.subscription}\t${s.status}\t${s.why}`);
const count = (list: { status: string }[]) => `${list.length} (${list.filter((x) => PAYING.has(x.status)).length} paying)`;
const hash = createHash("sha256")
  .update(planned.map((p) => `${p.subscription}:${p.previous ?? ""}:${p.memberId}`).sort().join("\n"))
  .digest("hex")
  .slice(0, 12);
console.log(
  `\n${subscriptions.length} subscriptions to the product; to write ${count(planned)}, ` +
    `${planned.filter((p) => p.row !== p.memberId).length} of them to a merge survivor, ` +
    `${planned.filter((p) => p.previous).length} replacing a member_id; not written ${count(skipped)}. Plan hash ${hash}`
);

if (expectedHash === null) process.exit(0);
if (expectedHash !== hash) {
  console.error(`--write ${expectedHash} is not this plan's hash ${hash}; nothing written`);
  process.exit(1);
}
let written = 0;
const failed: string[] = [];
for (const p of planned) {
  try {
    const current = await stripe.subscriptions.retrieve(p.subscription);
    if (current.metadata?.member_id !== p.previous) {
      console.error(`${p.subscription}: member_id changed to ${current.metadata?.member_id} since planning; skipped`);
      failed.push(p.subscription);
      continue;
    }
    // Stripe merges metadata keys, so the subscription's other keys stay.
    await stripe.subscriptions.update(p.subscription, { metadata: { member_id: p.memberId, tally_id: p.tallyId } });
    written++;
    console.log(`${p.subscription}: written`);
  } catch (error) {
    console.error(`${p.subscription}: failed:`, (error as Error).message);
    failed.push(p.subscription);
  }
}
console.log(`Wrote member_id on ${written} subscriptions; ${failed.length} not written: ${JSON.stringify(failed)}`);
process.exit(failed.length > 0 ? 1 : 0);
