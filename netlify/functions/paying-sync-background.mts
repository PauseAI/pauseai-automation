import { requireEnv } from "../../lib/env";
import { runPayingSync } from "../../lib/paying-sync-live";
import { SYNC_TOKEN_HEADER, isSyncTokenValid } from "../../lib/sync-trigger";

// Netlify answers 202 at once and runs this for up to 15 minutes, and retries
// it twice if it throws. Only a failed Stripe listing, which wrote nothing,
// throws; other failures are logged and alerted, and the next day's run retries.
export const config = { background: true };

export default async (request: Request) => {
  if (!isSyncTokenValid(request.headers.get(SYNC_TOKEN_HEADER), requireEnv("STRIPE_API_KEY"))) {
    console.warn("Paying sync refused: bad token");
    return;
  }
  const summary = await runPayingSync();
  if (summary.discovery === "failed") throw new Error("Paying sync: listing from Stripe failed");
};
