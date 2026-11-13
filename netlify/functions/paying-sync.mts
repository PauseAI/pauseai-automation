import { requireEnv } from "../../lib/env";
import { SYNC_TOKEN_HEADER, syncToken } from "../../lib/sync-trigger";

// Scheduled functions stop after 30 seconds, so this only starts the
// background function, which may run for 15 minutes. The time is in UTC and
// keeps clear of the CRM's nightly import and merge.
export const config = { schedule: "0 15 * * *" };

export default async (_request: Request, context: { site?: { url?: string } }) => {
  const siteUrl = context.site?.url ?? process.env.URL;
  const response = await fetch(`${siteUrl}/.netlify/functions/paying-sync-background`, {
    method: "POST",
    headers: { [SYNC_TOKEN_HEADER]: syncToken(requireEnv("STRIPE_API_KEY")) },
  });
  console.log(`Paying sync started: HTTP ${response.status}`);
  return new Response(null, { status: response.ok ? 200 : 500 });
};
