// Airtable allows 5 requests per second per base, shared with everything else
// that uses the base, and makes a client that exceeds it wait 30 seconds.
const MIN_INTERVAL_MS = 200;
const RATE_LIMIT_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const MIN_DROP_GUARD = 10;
const MAX_DROP_FRACTION = 0.2;
const MAX_MERGE_HOPS = 5;
const MAX_OVERRIDE_AHEAD_MS = 24 * 3_600_000;

export interface AirtableClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const realClock: AirtableClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface AirtableRow {
  id: string;
  /** The `Merged into` link: set on a row merged away into another. */
  mergedInto?: string[];
}

export type AirtableRowSet = "ticked" | "links";

export interface AirtablePayingStore {
  /**
   * One page of the ticked rows, or of every row with its `Merged into` link.
   * The links are read unfiltered: a formula on a link field sees the linked
   * rows' primary field text, which can be blank.
   */
  listPage: (rows: AirtableRowSet, offset: string | undefined) => Promise<{ records: AirtableRow[]; offset?: string }>;
  /** Sets one row's payment status; `not_found` when the row does not exist. */
  setPaying: (recordId: string, paying: boolean) => Promise<"ok" | "not_found">;
}

export interface AirtableResult {
  /** `incomplete`: the deadline came before every change was written. */
  status: "ok" | "refused" | "incomplete";
  ticked: number;
  /** Every ticked live record id before the sync, for a dry run's review. */
  tickedIds: string[];
  /**
   * Paying record ids of merged-away rows whose merge path does not end on one
   * surviving row (a cycle, a fork, too long). Nothing is ticked for them, and
   * no row is unticked in the run.
   */
  brokenMerges: string[];
  /** Paying record ids of merged-away rows, and the surviving row ticked in their place. */
  redirected: { from: string; to: string }[];
  toTick: string[];
  toUntick: string[];
  /** Whether PAYING_SYNC_AIRTABLE_ALLOW_REMOVALS_UNTIL lifted the untick guard. */
  removalsAllowed: boolean;
  written: number;
  /** Paying record ids whose row does not exist: skipped, not failed. */
  notFound: string[];
  failed: number;
}

export class DeadlineError extends Error {}

const statusCode = (error: unknown) => (error as { statusCode?: number })?.statusCode;

/**
 * Whether an override lifts the untick guard: an ISO time in the future, at
 * most 24 hours ahead, so a forgotten setting cannot disable the guard for long.
 */
export function removalOverrideActive(until: string | undefined, now: number): boolean {
  const expiry = until ? Date.parse(until) : NaN;
  return Number.isFinite(expiry) && expiry > now && expiry - now <= MAX_OVERRIDE_AHEAD_MS;
}

/** Runs one Airtable request at a time. */
export type AirtableRequest = <T>(call: () => Promise<T>) => Promise<T>;

/**
 * Runs Airtable requests at the base's rate limit, retrying a rate limit or
 * server error a little, and never past the deadline. Every request of a run
 * goes through one of these, so the pacing holds across reads and writes.
 */
export function pacedAirtableRequests(deadline: number, clock: AirtableClock = realClock): AirtableRequest {
  let nextStart = 0;
  return async (call) => {
    for (let attempt = 1; ; attempt++) {
      const wait = Math.max(0, nextStart - clock.now());
      if (clock.now() + wait >= deadline) throw new DeadlineError("Deadline passed during the Airtable sync");
      if (wait > 0) await clock.sleep(wait);
      nextStart = clock.now() + MIN_INTERVAL_MS;
      try {
        return await call();
      } catch (error) {
        const code = statusCode(error);
        // The client reports a timeout or connection error with a null status.
        const retryable = code == null || code === 429 || code >= 500;
        if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
        nextStart = clock.now() + (code === 429 ? RATE_LIMIT_WAIT_MS : 1_000 * attempt);
      }
    }
  };
}

async function listAll(store: AirtablePayingStore, request: AirtableRequest, rows: AirtableRowSet) {
  const records: AirtableRow[] = [];
  let offset: string | undefined;
  do {
    const page = await request(() => store.listPage(rows, offset));
    records.push(...page.records);
    offset = page.offset;
  } while (offset);
  return records;
}

/**
 * Brings Airtable's payment status in line with the paying record ids. It
 * reads the ticked rows and every row's merge link once, page by page, then
 * writes only the differences, every request through `request`. A paying
 * merged-away row ticks its surviving row instead, and merged-away rows are
 * never written. A merge path that does not end on one survivor ticks nothing
 * and stops all unticks for the run, since the set is then uncertain. It
 * refuses to untick more than max(10, 20%) of the ticked rows unless
 * `allowRemovals`. A dry run reads and diffs only.
 */
export async function syncAirtablePaying(
  payingRecordIds: Set<string>,
  store: AirtablePayingStore,
  options: { dryRun: boolean; allowRemovals?: boolean; request: AirtableRequest }
): Promise<AirtableResult> {
  const { request } = options;

  const mergedInto = new Map<string, string[]>();
  for (const row of await listAll(store, request, "links")) {
    if (Array.isArray(row.mergedInto) && row.mergedInto.length > 0) mergedInto.set(row.id, row.mergedInto);
  }
  // The surviving row a merged-away row leads to, or null when its path forks,
  // cycles or runs past the hop limit.
  const survivor = (id: string): string | null => {
    const seen = new Set<string>([id]);
    for (let hop = 0; hop < MAX_MERGE_HOPS; hop++) {
      const links = mergedInto.get(id);
      if (!links) return id;
      if (links.length !== 1 || seen.has(links[0])) return null;
      id = links[0];
      seen.add(id);
    }
    return mergedInto.has(id) ? null : id;
  };
  const redirected: { from: string; to: string }[] = [];
  const brokenMerges: string[] = [];
  const target = new Set<string>();
  for (const id of payingRecordIds) {
    const to = survivor(id);
    if (to === null) brokenMerges.push(id);
    else {
      if (to !== id) redirected.push({ from: id, to });
      target.add(to);
    }
  }

  const ticked = (await listAll(store, request, "ticked")).map((row) => row.id).filter((id) => !mergedInto.has(id));
  const tickedSet = new Set(ticked);
  const result: AirtableResult = {
    status: "ok",
    ticked: ticked.length,
    tickedIds: ticked,
    brokenMerges,
    redirected,
    toTick: [...target].filter((id) => !tickedSet.has(id) && !mergedInto.has(id)),
    toUntick: brokenMerges.length > 0 ? [] : ticked.filter((id) => !target.has(id)),
    removalsAllowed: Boolean(options.allowRemovals),
    written: 0,
    notFound: [],
    failed: 0,
  };
  if (!options.allowRemovals && result.toUntick.length > Math.max(MIN_DROP_GUARD, MAX_DROP_FRACTION * ticked.length)) {
    return { ...result, status: "refused" };
  }
  if (options.dryRun) return result;

  const changes: [string, boolean][] = [
    ...result.toTick.map((id): [string, boolean] => [id, true]),
    ...result.toUntick.map((id): [string, boolean] => [id, false]),
  ];
  for (const [recordId, paying] of changes) {
    try {
      const outcome = await request(() => store.setPaying(recordId, paying));
      if (outcome === "not_found") result.notFound.push(recordId);
      else result.written++;
    } catch (error) {
      if (error instanceof DeadlineError) return { ...result, status: "incomplete" };
      result.failed++;
      console.error(`Airtable record ${recordId}: payment status ${paying} not written:`, error);
    }
  }
  return result;
}
