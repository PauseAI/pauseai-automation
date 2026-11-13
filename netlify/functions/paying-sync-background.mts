import { requireEnv } from "../../lib/env";
import { runPayingSync } from "../../lib/paying-sync-live";
import { SYNC_TOKEN_HEADER, isSyncTokenValid } from "../../lib/sync-trigger";

// Netlify answers 202 at once and runs this for up to 15 minutes; if it
// throws (a Stripe listing failed), Netlify retries it twice.
export const config = { background: true };

export default async (request: Request) => {
  if (!isSyncTokenValid(request.headers.get(SYNC_TOKEN_HEADER), requireEnv("STRIPE_API_KEY"))) {
    console.warn("Paying sync refused: bad token");
    return;
  }
  await runPayingSync();
};
