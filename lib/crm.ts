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

/** Why sent ids named no member: lists of ids (capped by the CRM) or counts. */
export interface Unresolved {
  not_found: string[];
  invalid: string[];
  erased: number;
  trashed: number;
  not_a_member: number;
}

export interface ReconcileResult {
  status: "ok" | "refused";
  /** `too_many_removals`, `too_many_changes`, `empty_set` or `invalid_request`. */
  reason?: string;
  setTrue: number;
  setFalse: number;
  unresolved: Unresolved;
  /** Contacts whose write failed, as the CRM reports them. */
  failed: unknown[];
  /** The whole answer, for the log: in a dry run it lists the contacts it would change. */
  answer: Record<string, unknown>;
}

const count = (value: unknown) => (typeof value === "number" ? value : 0);
const list = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

function readUnresolved(value: unknown): Unresolved {
  const u = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    not_found: list(u.not_found),
    invalid: list(u.invalid),
    erased: count(u.erased),
    trashed: count(u.trashed),
    not_a_member: count(u.not_a_member),
  };
}

/** Whether any sent id named no member: each is a payer the CRM does not record. */
export const hasUnresolved = (u: Unresolved) =>
  u.not_found.length > 0 || u.invalid.length > 0 || u.erased > 0 || u.trashed > 0 || u.not_a_member > 0;

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
  const result = {
    setTrue: count(answer.set_true),
    setFalse: count(answer.set_false),
    unresolved: readUnresolved(answer.unresolved),
    failed: Array.isArray(answer.failed) ? answer.failed : [],
    answer,
  };
  if (answer.status === "refused") return { status: "refused", reason: String(answer.reason), ...result };
  if (answer.status !== "ok") throw new Error(`CiviCRM reconcile answered status ${String(answer.status)}`);
  return { status: "ok", ...result };
}
