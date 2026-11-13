// CiviCRM's API4 action for paying status, called with the key of the CRM's
// `stripe-webhook` API account, which may call nothing else.
const SET_PAYING_PATH = "/civicrm/ajax/api4/PauseaiPayingMember/set";
const CRM_TIMEOUT_MS = 10_000;

export interface CrmConfig {
  url: string;
  key: string;
}

export type CrmAnswer = { status: "ok" } | { status: "refused"; reason: string };

/** The CRM settings, or null when either is unset. */
export function crmConfigFromEnv(env: NodeJS.ProcessEnv = process.env): CrmConfig | null {
  const url = env.CRM_URL?.replace(/\/+$/, "");
  const key = env.CRM_STRIPE_WEBHOOK_KEY;
  return url && key ? { url, key } : null;
}

/**
 * Records in CiviCRM whether the member with this id pays, and answers `ok` or
 * the refusal reason. A network error, a timeout, an HTTP error or an answer
 * without a status rejects.
 */
export async function setPayingInCrm(
  config: CrmConfig,
  memberId: string,
  paying: boolean
): Promise<CrmAnswer> {
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
  const row = body?.values?.[0] as { status?: unknown; reason?: unknown } | undefined;
  if (row?.status === "ok") return { status: "ok" };
  if (row?.status === "refused") return { status: "refused", reason: String(row.reason) };
  throw new Error(`CiviCRM answered without a status for member ${memberId}`);
}
