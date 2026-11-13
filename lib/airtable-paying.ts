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

export interface AirtablePayingStore {
  /** One page of the ticked rows, or of the merged-away rows. */
  listPage: (rows: "ticked" | "merged", offset: string | undefined) => Promise<{ records: AirtableRow[]; offset?: string }>;
  /** Sets one row's payment status; `not_found` when the row does not exist. */
  setPaying: (recordId: string, paying: boolean) => Promise<"ok" | "not_found">;
}

export interface AirtableResult {
  /** `incomplete`: the deadline came before every change was written. */
  status: "ok" | "refused" | "incomplete";
  ticked: number;
  /** Every ticked live record id before the sync, for a dry run's review. */
  tickedIds: string[];
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

/**
 * Brings Airtable's payment status in line with the paying record ids. It
 * reads the ticked rows and the merged-away rows once, page by page, then
 * writes only the differences, one request at a time at Airtable's rate
 * limit, retrying a rate limit or server error a little, and never past the
 * deadline. A paying merged-away row ticks its surviving row instead, and
 * merged-away rows are never written. It refuses to untick more than max(10,
 * 20%) of the ticked rows unless `allowRemovals`. A dry run reads and diffs only.
 */
export async function syncAirtablePaying(
  payingRecordIds: Set<string>,
  store: AirtablePayingStore,
  options: { dryRun: boolean; deadline: number; allowRemovals?: boolean; clock?: AirtableClock }
): Promise<AirtableResult> {
  const clock = options.clock ?? realClock;
  let nextStart = 0;
  const request = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      const wait = Math.max(0, nextStart - clock.now());
      if (clock.now() + wait >= options.deadline) throw new DeadlineError("Deadline passed during the Airtable sync");
      if (wait > 0) await clock.sleep(wait);
      nextStart = clock.now() + MIN_INTERVAL_MS;
      try {
        return await call();
      } catch (error) {
        const code = statusCode(error);
        const retryable = code === undefined || code === 429 || code >= 500;
        if (!retryable || attempt >= MAX_ATTEMPTS) throw error;
        nextStart = clock.now() + (code === 429 ? RATE_LIMIT_WAIT_MS : 1_000 * attempt);
      }
    }
  };
  const listAll = async (rows: "ticked" | "merged") => {
    const records: AirtableRow[] = [];
    let offset: string | undefined;
    do {
      const page = await request(() => store.listPage(rows, offset));
      records.push(...page.records);
      offset = page.offset;
    } while (offset);
    return records;
  };

  const mergedInto = new Map<string, string>();
  for (const row of await listAll("merged")) {
    if (row.mergedInto?.[0]) mergedInto.set(row.id, row.mergedInto[0]);
  }
  const survivor = (id: string) => {
    for (let hop = 0; hop < MAX_MERGE_HOPS && mergedInto.has(id); hop++) id = mergedInto.get(id)!;
    return id;
  };
  const redirected: { from: string; to: string }[] = [];
  const target = new Set<string>();
  for (const id of payingRecordIds) {
    const to = survivor(id);
    if (to !== id) redirected.push({ from: id, to });
    target.add(to);
  }

  const ticked = (await listAll("ticked")).map((row) => row.id).filter((id) => !mergedInto.has(id));
  const tickedSet = new Set(ticked);
  const result: AirtableResult = {
    status: "ok",
    ticked: ticked.length,
    tickedIds: ticked,
    redirected,
    toTick: [...target].filter((id) => !tickedSet.has(id) && !mergedInto.has(id)),
    toUntick: ticked.filter((id) => !target.has(id)),
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
