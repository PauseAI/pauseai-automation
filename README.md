# pauseai-automation

[![Netlify Status](https://api.netlify.com/api/v1/badges/290ed007-d791-4047-b486-ad6a3f7e818d/deploy-status)](https://app.netlify.com/projects/pauseai-automation/deploys)

This repository contains webhook endpoints for updating the payment status of paying members in Airtable.

## How it works

When a member completes a Stripe checkout, Stripe sends subscription webhook events to this service. The webhook reads the `client_reference_id` from the Stripe checkout session — this is the **Airtable record ID** of the member (set by the onboarding flow when a volunteer opts in to becoming a paying member). The webhook then fetches that Airtable record directly by ID and updates its payment status field.

> **Note:** Previously, `client_reference_id` was a Tally submission ID, and the webhook looked up the Airtable record by matching a dedicated field. With the migration to the custom onboarding flow, `client_reference_id` is now the Airtable record ID itself, so the lookup is a direct `find()` instead of a filtered search. The `TALLY_ID_FIELD_NAME` env var is no longer required.

## CiviCRM

PauseAI's CRM (CiviCRM) is taking over member data, so the webhook also records the payment status there, through the CRM's `PauseaiPayingMember.set` API4 action, called with the API key of the CRM's `stripe-webhook` API account. `client_reference_id` is either an Airtable record ID (`rec` + 14 characters), which goes to both Airtable and CiviCRM, or a signup ID (`mem` + 22 characters) for a member who signed up in CiviCRM alone, which goes to CiviCRM only.

Set `CRM_URL` and `CRM_STRIPE_WEBHOOK_KEY` to turn this on. While either is unset, the webhook writes to Airtable only.

A `client_reference_id` of neither shape and a CiviCRM refusal (for example `not_found`) are logged and answered with 200, since a retry cannot fix them. A failed Airtable write, a CiviCRM network error, timeout or HTTP error make the webhook fail so that Stripe retries the event; both writes are idempotent, so a retry repeats the one that succeeded harmlessly.

Run the unit tests with `pnpm test`.
