# pauseai-automation

[![Netlify Status](https://api.netlify.com/api/v1/badges/290ed007-d791-4047-b486-ad6a3f7e818d/deploy-status)](https://app.netlify.com/projects/pauseai-automation/deploys)

This repository keeps the paying status of PauseAI members in step with Stripe, in CiviCRM and (for members who still have one) in Airtable.

## How it works

Once a day at 15:00 UTC, the scheduled function `netlify/functions/paying-sync.mts` starts the background function `netlify/functions/paying-sync-background.mts`, which may run for up to 15 minutes. Netlify gives scheduled functions only 30 seconds, and Nitro's scheduled tasks have no Netlify support, so the work runs in the background function and the scheduled one only starts it, with a token derived from `STRIPE_API_KEY` so no one else can.

The sync (`lib/paying-sync.ts`) makes CiviCRM and Airtable hold exactly the members who pay now, as Stripe says:

1. It lists every Stripe subscription (all statuses) and every completed checkout session.
2. It finds each subscription's member id: its `member_id` metadata if it has a valid one (so staff can repair a subscription in Stripe by adding it), else its checkout session's `client_reference_id`, else, when the same Stripe customer's other subscriptions name exactly one valid member id, that one (each such borrow is logged). Ids are Airtable record ids (`rec` + 14 characters) or signup ids (`mem` + 22 characters) of members who signed up in CiviCRM alone.
3. A member id pays if any of its subscriptions to `STRIPE_PRODUCT_ID` is `active`, `trialing` or `past_due`. A member whose subscriptions all ended or left the product is not in the set.
4. It sends the whole paying set to CiviCRM's `PauseaiPayingMember.reconcile` in one call, with the API key of the CRM's `stripe-webhook` API account. CiviCRM resolves the ids (following merges), sets paying for those members, clears it for everyone else, and writes only the differences, or refuses when its own guard trips (`too_many_removals`, `too_many_changes`, `empty_set`). Its answer lists the ids it could not resolve (`unresolved`) and any contacts whose write failed (`failed`).
5. It reads Airtable's ticked rows and its merged-away rows (those with a `Merged into` link) once, and writes only the differences for `rec` ids, at most 5 requests per second, with a short retry of its own. A paying merged-away row ticks its surviving row instead, and merged-away rows are never written. It refuses to untick more than max(10, 20%) of the ticked rows. A paying record id whose row does not exist is skipped.
6. It logs a summary line, CiviCRM's `unresolved`, and every borrow and merge redirect.

The whole run, Stripe listing included, has a 12-minute budget. If listing from Stripe fails or runs past it, nothing is written, and the background function throws so Netlify retries it twice. Other failures are logged and alerted, and the next day's run tries again.

An alert is a log line starting `[paying-sync ALERT]` (the repo has no error reporting service). It is raised so that a missed payer is never silent: for a paying subscription without a member id, any id CiviCRM could not resolve, a failed CiviCRM write, a refusal, a failure, or the deadline.

`PAYING_SYNC_DRY_RUN=1` makes a run read, diff and log only: CiviCRM's full answer (the contacts it would set and clear), every currently ticked Airtable record id, and the record ids Airtable would tick and untick. The first run after deploying is a dry run, and the first real run happens only after a person has reviewed its log.

`PAYING_SYNC_AIRTABLE_ALLOW_REMOVALS_UNTIL`, an ISO time at most 24 hours ahead (for example `2026-11-20T18:00:00Z`), lifts Airtable's untick guard until then, for a legitimate mass cancellation. A time further ahead or in the past is ignored. CiviCRM's guard has its own override in the CRM.

While `CRM_URL` or `CRM_STRIPE_WEBHOOK_KEY` is unset, the sync writes Airtable only and skips signup ids, with one log line.

The Stripe webhook route `server/routes/stripe.post.ts` only acknowledges events, until the endpoint is removed from Stripe. A real-time path would also need the CRM's `stripe-webhook` API key allowed to call `PauseaiPayingMember.set` again.

Accepted limits:

- Only the first page of a subscription's items is checked for `STRIPE_PRODUCT_ID`.
- A change in Stripe reaches the stores by the next day's run.
- Two runs at once (a Run now during the scheduled run) can race; the next day's run corrects it.
- Members marked paying by hand, without a Stripe subscription, are cleared.

Run the unit tests with `pnpm test`.
