// CiviCRM's API4 action for paying status, called with the key of the CRM's
// `stripe-webhook` API account, which may call nothing else.
const SET_PAYING_PATH = "/civicrm/ajax/api4/PauseaiPayingMember/set";
const CRM_TIMEOUT_MS = 10_000;

export interface CrmConfig {
  url: string;
  key: string;
}

/** The CRM settings, or null when either is unset. */
export function crmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CrmConfig | null {
  const url = env.CRM_URL?.replace(/\/+$/, "");
  const key = env.CRM_STRIPE_WEBHOOK_KEY;
  return url && key ? { url, key } : null;
}

/**
 * Records in CiviCRM whether the member with this id pays. A refusal is logged
 * and resolves, since a retry gets the same answer, except `not_found`: a
 * member can pay before their signup reaches the CRM, so that rejects, as do a
 * network error, a timeout, an HTTP error and an answer without a status, and
 * Stripe retries.
 */
export async function setPayingInCrm(
  config: CrmConfig,
  memberId: string,
  paying: boolean
): Promise<void> {
  const response = await fetch(config.url + SET_PAYING_PATH, {
    method: "POST",
    headers: {
      // CiviCRM accepts an API key only in X-Civi-Auth.
      "X-Civi-Auth": `Bearer ${config.key}`,
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      params: JSON.stringify({ airtable_record_id: memberId, paying }),
    }),
    signal: AbortSignal.timeout(CRM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`CiviCRM answered HTTP ${response.status} for member ${memberId}`);
  }
  const body = (await response.json()) as { values?: unknown[] } | null;
  const row = body?.values?.[0] as { status?: unknown; reason?: unknown; contact_id?: unknown } | undefined;
  if (row?.status === "ok") {
    console.log(`CiviCRM contact ${row.contact_id} (member ${memberId}) updated with payment status: ${paying}`);
    return;
  }
  if (row?.status === "refused" && row.reason === "not_found") {
    throw new Error(`CiviCRM has no member ${memberId} yet`);
  }
  if (row?.status === "refused") {
    console.warn(`CiviCRM refused payment status ${paying} for member ${memberId}: ${row.reason}`);
    return;
  }
  throw new Error(`CiviCRM answered without a status for member ${memberId}`);
}
