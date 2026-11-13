import { createHmac, timingSafeEqual } from "node:crypto";

// The background function's URL is public. The scheduled function proves it
// is the caller with a token derived from STRIPE_API_KEY, which both have, so
// no extra secret is needed and the key itself never travels.
export const SYNC_TOKEN_HEADER = "x-paying-sync-token";

export function syncToken(stripeApiKey: string): string {
  return createHmac("sha256", stripeApiKey).update("paying-sync").digest("hex");
}

export function isSyncTokenValid(received: string | null, stripeApiKey: string): boolean {
  const expected = new TextEncoder().encode(syncToken(stripeApiKey));
  const actual = new TextEncoder().encode(received ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
