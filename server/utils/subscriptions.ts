import Airtable from "airtable";
import Stripe from "stripe";

// Define constants for Airtable
const airtableBaseId = requireEnv("AIRTABLE_BASE_ID");
const airtableTableId = requireEnv("AIRTABLE_TABLE_ID");
const paymentStatusFieldName = requireEnv("PAYMENT_STATUS_FIELD_NAME");

// Initialize Airtable
const table = new Airtable({ apiKey: requireEnv("AIRTABLE_API_KEY") })
  .base(airtableBaseId)
  .table(airtableTableId);

const crmConfig = crmConfigFromEnv();
if (!crmConfig) {
  console.warn("CRM_URL or CRM_STRIPE_WEBHOOK_KEY is unset: payment status goes to Airtable only");
}

interface HandleSubscriptionOptions {
  subscriptionStatus: boolean;
};

/**
 * Checks if a Stripe subscription includes a given product.
 *
 * @param subscription The Stripe subscription object to check.
 * @param productId The ID of the product to look for in the subscription items.
 * @returns true if the subscription includes the product, false otherwise.
 */
export async function subscriptionIncludesProduct(subscription: Stripe.Subscription, productId: string) {
  const subscriptionItems = subscription.items.data;
  const productIds = subscriptionItems.map(subscriptionItemToProductId);
  return productIds.includes(productId);
}

/**
 * Handles a Stripe subscription event by updating the payment status of the
 * associated member in Airtable and CiviCRM.
 *
 * @param subscription The Stripe subscription object associated with the event.
 * @param options An object containing the payment status to set.
 * @returns A promise that resolves when the payment status has been updated.
 */
export async function handleSubscriptionEvent(
  subscription: Stripe.Subscription,
  options: HandleSubscriptionOptions
) {
  const checkoutSession = await getCheckoutSessionBySubscriptionId(
    subscription.id
  );
  await writePaymentStatus(checkoutSession.client_reference_id, options.subscriptionStatus, {
    airtable: setAirtablePaymentStatus,
    crm: crmConfig ? (memberId, status) => setPayingInCrm(crmConfig, memberId, status) : null,
  });
}

/**
 * Extracts the product ID from a Stripe subscription item.
 *
 * @param item The subscription item to extract the product ID from.
 * @returns The product ID as a string.
 */
function subscriptionItemToProductId(item: Stripe.SubscriptionItem): string {
  const product = item.price.product;
  return product instanceof Object ? product.id : product;
}

/**
 * Updates the payment status of the Airtable record with the given ID.
 *
 * @param recordId The Airtable record ID to update.
 * @param status The payment status to set in Airtable.
 */
async function setAirtablePaymentStatus(recordId: string, status: boolean) {
  try {
    const record = await table.find(recordId);

    await record.patchUpdate(
      Object.fromEntries([[paymentStatusFieldName, status]])
    );

    console.log(
      `Airtable record ${record.id} updated with payment status: ${status}`
    );
  } catch (error) {
    console.error(
      `Error updating Airtable record for record ID ${recordId}:`,
      error
    );
    throw error;
  }
}
