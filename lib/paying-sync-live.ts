import Airtable from "airtable";
import Stripe from "stripe";
import { crmConfigFromEnv, setPayingInCrm } from "./crm";
import { requireEnv } from "./env";
import { paginate, syncPayingMembers, type SyncSummary } from "./paying-sync";

// Netlify stops a background function after 15 minutes; stop starting writes
// well before, so the run still logs its summary.
const RUN_BUDGET_MS = 12 * 60_000;

/** Runs the paying sync against Stripe, Airtable and CiviCRM, configured from the environment. */
export async function runPayingSync(): Promise<SyncSummary> {
  const stopAt = Date.now() + RUN_BUDGET_MS;
  const stripe = new Stripe(requireEnv("STRIPE_API_KEY"), {
    apiVersion: "2025-04-30.basil" as Stripe.LatestApiVersion,
    timeout: 20_000,
    maxNetworkRetries: 2,
  });
  const table = new Airtable({ apiKey: requireEnv("AIRTABLE_API_KEY"), requestTimeout: 10_000 })
    .base(requireEnv("AIRTABLE_BASE_ID"))
    .table(requireEnv("AIRTABLE_TABLE_ID"));
  const field = requireEnv("PAYMENT_STATUS_FIELD_NAME");
  const crm = crmConfigFromEnv();
  if (!crm) console.warn("CRM_URL or CRM_STRIPE_WEBHOOK_KEY is unset: paying status goes to Airtable only");

  return syncPayingMembers({
    productId: requireEnv("STRIPE_PRODUCT_ID"),
    subscriptions: paginate((starting_after) =>
      stripe.subscriptions.list({ status: "all", limit: 100, starting_after })
    ),
    sessions: paginate((starting_after) =>
      stripe.checkout.sessions.list({ status: "complete", limit: 100, starting_after })
    ),
    stopAt,
    writers: {
      // Read first so an unchanged record is not written every day.
      airtable: async (recordId, paying) => {
        const record = await table.find(recordId);
        if (Boolean(record.get(field)) !== paying) await record.patchUpdate({ [field]: paying });
      },
      crm: crm ? (memberId, paying) => setPayingInCrm(crm, memberId, paying) : null,
    },
  });
}
