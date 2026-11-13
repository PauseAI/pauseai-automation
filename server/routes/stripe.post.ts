import { defineEventHandler, readBody } from "h3";

// The daily paying sync (netlify/functions/paying-sync*) owns paying status, so
// this only acknowledges Stripe's events until the endpoint is removed from
// Stripe; a real-time path would call CiviCRM's PauseaiPayingMember.set.
export default defineEventHandler(async (event) => {
  const body = await readBody(event).catch(() => null);
  console.log(`Stripe event ignored: ${String(body?.type).slice(0, 64)} ${String(body?.data?.object?.id).slice(0, 64)}`);
  return { status: "success" };
});
