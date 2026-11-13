# pauseai-automation

[![Netlify Status](https://api.netlify.com/api/v1/badges/290ed007-d791-4047-b486-ad6a3f7e818d/deploy-status)](https://app.netlify.com/projects/pauseai-automation/deploys)

This repository keeps the paying status of PauseAI members in step with Stripe, in CiviCRM and (for members who still have one) in Airtable.

## How it works

Once a day at 15:00 UTC, the scheduled function `netlify/functions/paying-sync.mts` starts the background function `netlify/functions/paying-sync-background.mts`, which may run for up to 15 minutes. Netlify gives scheduled functions only 30 seconds, and Nitro's scheduled tasks have no Netlify support, so the work runs in the background function and the scheduled one only starts it, with a token derived from `STRIPE_API_KEY` so no one else can.

The sync (`lib/paying-sync.ts`):

1. Lists every Stripe subscription (all statuses) and keeps those that include `STRIPE_PRODUCT_ID`.
2. Lists completed checkout sessions once, to map each subscription to the session's `client_reference_id`: the member's id, set by the onboarding flow.
3. Groups the subscriptions by member. A member pays if any of their subscriptions is `active`, `trialing` or `past_due`, so an old canceled subscription does not override a new one.
4. Writes each member, four at a time (`writeMemberPaying` in `lib/payment-status.ts`): to CiviCRM through the CRM's `PauseaiPayingMember.set` API4 action, called with the API key of its `stripe-webhook` API account, for every id; and to Airtable's payment status field for Airtable record ids (`rec` + 14 characters). A signup id (`mem` + 22 characters) belongs to a member who signed up in CiviCRM alone and goes to CiviCRM only.
5. Logs a summary line: members seen, written, refused, failed, skipped, not reached, and subscriptions without a member id.

A member id of neither shape is logged and skipped. A CiviCRM refusal (`not_found`, `erased`, `trashed`, `not_a_member`, `invalid_request`) is logged and counted. A failed write is logged and counted and does not stop the run; the next day's run tries again. The run stops starting writes after 12 minutes, so it can still log its summary.

While `CRM_URL` or `CRM_STRIPE_WEBHOOK_KEY` is unset, the sync writes Airtable record ids to Airtable only and skips signup ids, with one log line.

The Stripe webhook route `server/routes/stripe.post.ts` only acknowledges events, until the endpoint is removed from Stripe. A real-time path would call `writeMemberPaying`.

Accepted limits:

- Only the first page of a subscription's items is checked for `STRIPE_PRODUCT_ID`.
- A change in Stripe reaches the stores by the next day's run.

Run the unit tests with `pnpm test`.
