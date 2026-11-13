import Airtable from "airtable";

// Define constants for Airtable
const airtableBaseId = requireEnv("AIRTABLE_BASE_ID");
const airtableTableId = requireEnv("AIRTABLE_TABLE_ID");
const paymentStatusFieldName = requireEnv("PAYMENT_STATUS_FIELD_NAME");
const productId = requireEnv("STRIPE_PRODUCT_ID");

// Initialize Airtable. The client otherwise waits out rate limits with retries
// that can outlast the function's time limit; Stripe retries the event instead.
const table = new Airtable({
  apiKey: requireEnv("AIRTABLE_API_KEY"),
  requestTimeout: 10_000,
  noRetryIfRateLimited: true,
})
  .base(airtableBaseId)
  .table(airtableTableId);

const crmConfig = crmConfigFromEnv();
if (!crmConfig) {
  console.warn("CRM_URL or CRM_STRIPE_WEBHOOK_KEY is unset: payment status goes to Airtable only");
}

/**
 * Handles a Stripe subscription event by updating the payment status of the
 * associated member in Airtable and CiviCRM.
 *
 * @param subscriptionId The ID of the subscription the event is about.
 * @returns A promise that resolves when the payment status has been updated.
 */
export async function handleSubscriptionEvent(subscriptionId: string) {
  await recordSubscriptionStatus(subscriptionId, {
    productId,
    retrieveSubscription: (id) => stripe.subscriptions.retrieve(id),
    clientReferenceId: async (id) => (await getCheckoutSessionBySubscriptionId(id)).client_reference_id,
    writers: {
      airtable: setAirtablePaymentStatus,
      crm: crmConfig ? (memberId, status) => setPayingInCrm(crmConfig, memberId, status) : null,
    },
  });
}

/**
 * Updates the payment status of the Airtable record with the given ID.
 *
 * @param recordId The Airtable record ID to update.
 * @param status The payment status to set in Airtable.
 */
async function setAirtablePaymentStatus(recordId: string, status: boolean) {
  const record = await table.find(recordId);

  await record.patchUpdate(
    Object.fromEntries([[paymentStatusFieldName, status]])
  );

  console.log(
    `Airtable record ${record.id} updated with payment status: ${status}`
  );
}
