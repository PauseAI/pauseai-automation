// Airtable allows 5 requests per second per base, shared with everything else
// that uses the base, and makes a client that exceeds it wait 30 seconds.
const MIN_INTERVAL_MS = 200;
const RATE_LIMIT_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const MIN_DROP_GUARD = 10;
const MAX_DROP_FRACTION = 0.2;

export interface AirtableClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const realClock: AirtableClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface AirtablePayingStore {
  /** Ids of every row with the payment status ticked. */
  listTicked: () => Promise<string[]>;
  /** Sets one row's payment status; `not_found` when the row does not exist. */
  setPaying: (recordId: string, paying: boolean) => Promise<"ok" | "not_found">;
}

export interface AirtableResult {
  /** `incomplete`: the deadline came before every change was written. */
  status: "ok" | "refused" | "incomplete";
  ticked: number;
  /** Every ticked record id before the sync, for a dry run's review. */
  tickedIds: string[];
  toTick: string[];
  toUntick: string[];
  written: number;
  /** Paying record ids whose row does not exist: skipped, not failed. */
  notFound: string[];
  failed: number;
}

class DeadlineError extends Error {}

const statusCode = (error: unknown) => (error as { statusCode?: number })?.statusCode;

/**
 * Brings Airtable's payment status in line with the paying record ids: reads
 * the ticked rows once and writes only the differences, one request at a time
 * at Airtable's rate limit, retrying a rate limit or server error a little,
 * and never past the deadline. Refuses to untick more than max(10, 20%) of
 * the ticked rows. A dry run reads and diffs only.
 */
export async function syncAirtablePaying(
  payingRecordIds: Set<string>,
  store: AirtablePayingStore,
  options: { dryRun: boolean; deadline: number; clock?: AirtableClock }
): Promise<AirtableResult> {
  const clock = options.clock ?? realClock;
  let nextStart = 0;
  const request = async <T>(call: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      const wait = Math.max(0, nextStart - clock.now());
      if (clock.now() + wait >= options.deadline) throw new DeadlineError();
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

  const ticked = await request(store.listTicked);
  const tickedSet = new Set(ticked);
  const result: AirtableResult = {
    status: "ok",
    ticked: ticked.length,
    tickedIds: ticked,
    toTick: [...payingRecordIds].filter((id) => !tickedSet.has(id)),
    toUntick: ticked.filter((id) => !payingRecordIds.has(id)),
    written: 0,
    notFound: [],
    failed: 0,
  };
  if (result.toUntick.length > Math.max(MIN_DROP_GUARD, MAX_DROP_FRACTION * ticked.length)) {
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

export { DeadlineError };
