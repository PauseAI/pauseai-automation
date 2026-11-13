// CiviCRM's API4 actions for paying status, called with the key of the CRM's
// `stripe-webhook` API account, which may call nothing else.
const API_PATH = "/civicrm/ajax/api4/";
// One reconcile call writes every difference. Cloudflare in front of the CRM
// cuts a request at 100 s; the CRM finishes a write even after the caller
// gives up, and the next day's run picks up anything left.
const RECONCILE_TIMEOUT_MS = 60_000;

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

/** Calls one API4 action and answers its result row. Rejects on a network error, timeout, HTTP error or a row without a status. */
export async function callCrm(
  config: CrmConfig,
  action: string,
  params: unknown,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const response = await fetch(config.url + API_PATH + action, {
    method: "POST",
    headers: {
      // CiviCRM accepts an API key only in X-Civi-Auth.
      "X-Civi-Auth": `Bearer ${config.key}`,
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ params: JSON.stringify(params) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`CiviCRM ${action} answered HTTP ${response.status}`);
  const body = (await response.json()) as { values?: unknown[] } | null;
  const row = body?.values?.[0];
  if (typeof row !== "object" || row === null || typeof (row as { status?: unknown }).status !== "string") {
    throw new Error(`CiviCRM ${action} answered without a status`);
  }
  return row as Record<string, unknown>;
}

export interface ReconcileResult {
  status: "ok" | "refused";
  /** `too_many_removals`, `too_many_changes` or `empty_set`. */
  reason?: string;
  setTrue: number;
  setFalse: number;
  /** Ids the CRM could not resolve to a member, by reason. */
  unresolved: Record<string, string[]>;
  /** The whole answer, for the log: in a dry run it lists the contacts it would change. */
  answer: Record<string, unknown>;
}

const count = (value: unknown) => (typeof value === "number" ? value : 0);

/**
 * Sends the whole set of paying member ids to the CRM in one call. The CRM
 * makes exactly those members paying, writing only the differences, or
 * refuses when its guard trips. A dry run writes nothing.
 */
export async function reconcilePayingInCrm(
  config: CrmConfig,
  memberIds: string[],
  options: { dryRun: boolean; deadline: number }
): Promise<ReconcileResult> {
  const timeLeft = options.deadline - Date.now();
  if (timeLeft <= 0) throw new Error("Deadline passed before the CiviCRM reconcile");
  const answer = await callCrm(
    config,
    "PauseaiPayingMember/reconcile",
    { member_ids: memberIds, dry_run: options.dryRun },
    Math.min(RECONCILE_TIMEOUT_MS, timeLeft)
  );
  const unresolved = (answer.unresolved as Record<string, string[]> | undefined) ?? {};
  if (answer.status === "refused") {
    return { status: "refused", reason: String(answer.reason), setTrue: 0, setFalse: 0, unresolved, answer };
  }
  if (answer.status !== "ok") throw new Error(`CiviCRM reconcile answered status ${String(answer.status)}`);
  return { status: "ok", setTrue: count(answer.set_true), setFalse: count(answer.set_false), unresolved, answer };
}
