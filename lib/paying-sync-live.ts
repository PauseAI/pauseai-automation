import Airtable from "airtable";
import Stripe from "stripe";
import { removalOverrideActive } from "./airtable-paying";
import { alert } from "./alert";
import { crmConfigFromEnv, reconcilePayingInCrm } from "./crm";
import { requireEnv } from "./env";
import { paginate, syncPaying, type SyncSummary } from "./paying-sync";

// The link pauseai-civicrm's scripts/import/merge-members.py sets on a row
// merged away into another; the CRM's import skips such rows too.
const MERGED_INTO_FIELD = "Merged into";

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
  const base = new Airtable({
    apiKey: requireEnv("AIRTABLE_API_KEY"),
    requestTimeout: 10_000,
    noRetryIfRateLimited: true,
  }).base(requireEnv("AIRTABLE_BASE_ID"));
  const tableId = requireEnv("AIRTABLE_TABLE_ID");
  const table = base(tableId);
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
      listPage: async (rows, offset) => {
        const shown = rows === "ticked" ? field : MERGED_INTO_FIELD;
        const response = await base.makeRequest({
          path: `/${encodeURIComponent(tableId)}`,
          qs: { filterByFormula: `{${shown}}`, fields: [shown], pageSize: 100, ...(offset ? { offset } : {}) },
        });
        const body = response.body as { records: { id: string; fields: Record<string, unknown> }[]; offset?: string };
        return {
          records: body.records.map((record) => ({
            id: record.id,
            mergedInto: record.fields[MERGED_INTO_FIELD] as string[] | undefined,
          })),
          offset: body.offset,
        };
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
    allowAirtableRemovals: removalOverrideActive(process.env.PAYING_SYNC_AIRTABLE_ALLOW_REMOVALS_UNTIL, Date.now()),
    dryRun: process.env.PAYING_SYNC_DRY_RUN === "1",
    deadline,
    alert,
  });
}
