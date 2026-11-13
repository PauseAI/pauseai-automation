import Airtable from "airtable";
import Stripe from "stripe";
import { alert } from "./alert";
import { crmConfigFromEnv, reconcilePayingInCrm } from "./crm";
import { requireEnv } from "./env";
import { paginate, syncPaying, type SyncSummary } from "./paying-sync";

// Netlify stops a background function after 15 minutes. The whole run, Stripe
// listing included, stays within this, so it can always log its summary.
const RUN_BUDGET_MS = 12 * 60_000;

/** Runs the paying sync against Stripe, Airtable and CiviCRM, configured from the environment. */
export async function runPayingSync(): Promise<SyncSummary> {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const stripe = new Stripe(requireEnv("STRIPE_API_KEY"), {
    apiVersion: "2025-04-30.basil" as Stripe.LatestApiVersion,
    timeout: 20_000,
    maxNetworkRetries: 2,
  });
  // The sync paces and retries Airtable requests itself; the client's own
  // rate-limit retry can wait for minutes.
  const table = new Airtable({
    apiKey: requireEnv("AIRTABLE_API_KEY"),
    requestTimeout: 10_000,
    noRetryIfRateLimited: true,
  })
    .base(requireEnv("AIRTABLE_BASE_ID"))
    .table(requireEnv("AIRTABLE_TABLE_ID"));
  const field = requireEnv("PAYMENT_STATUS_FIELD_NAME");
  const crm = crmConfigFromEnv();

  return syncPaying({
    productId: requireEnv("STRIPE_PRODUCT_ID"),
    listSubscriptions: (until) =>
      paginate((starting_after) => stripe.subscriptions.list({ status: "all", limit: 100, starting_after }), until),
    listSessions: (until) =>
      paginate(
        (starting_after) => stripe.checkout.sessions.list({ status: "complete", limit: 100, starting_after }),
        until
      ),
    reconcile: crm ? (memberIds, options) => reconcilePayingInCrm(crm, memberIds, options) : null,
    airtable: {
      // Pages are paced like every other Airtable request.
      listTicked: async () => {
        const ids: string[] = [];
        await table.select({ filterByFormula: `{${field}}`, fields: [field], pageSize: 100 }).eachPage((records, next) => {
          ids.push(...records.map((record) => record.id));
          setTimeout(next, 200);
        });
        return ids;
      },
      setPaying: async (recordId, paying) => {
        try {
          await table.update(recordId, { [field]: paying });
          return "ok";
        } catch (error) {
          const { statusCode, error: code } = error as { statusCode?: number; error?: string };
          if (statusCode === 404 || code === "ROW_DOES_NOT_EXIST") return "not_found";
          throw error;
        }
      },
    },
    dryRun: process.env.PAYING_SYNC_DRY_RUN === "1",
    deadline,
    alert,
  });
}
