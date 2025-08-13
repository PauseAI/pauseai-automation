import Airtable from "airtable";
import Stripe from "stripe";

const ALPHANUMERIC_REGEX = /^[a-zA-Z0-9]+$/;

// Define constants for Airtable
const airtableBaseId = requireEnv("AIRTABLE_BASE_ID");
const airtableTableId = requireEnv("AIRTABLE_TABLE_ID");
const tallyIdFieldName = requireEnv("TALLY_ID_FIELD_NAME");
const paymentStatusFieldName = requireEnv("PAYMENT_STATUS_FIELD_NAME");

// Initialize Airtable
const table = new Airtable({ apiKey: requireEnv("AIRTABLE_API_KEY") })
  .base(airtableBaseId)
  .table(airtableTableId);

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
 * associated Airtable record.
 *
 * @param subscription The Stripe subscription object associated with the event.
 * @param options An object containing the payment status to set in Airtable.
 * @returns A promise that resolves when the payment status has been updated.
 */
export async function handleSubscriptionEvent(
  subscription: Stripe.Subscription,
  options: HandleSubscriptionOptions
) {
  const checkoutSession = await getCheckoutSessionBySubscriptionId(
    subscription.id
  );
  const tallyId = checkoutSession.client_reference_id;

  await setPaymentStatus(tallyId, options.subscriptionStatus);
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
 * Updates the payment status of an Airtable record associated with the given Tally ID.
 *
 * @param tallyId The Tally ID to look up in Airtable.
 * @param status The payment status to set in Airtable.
 */
async function setPaymentStatus(tallyId: string, status: boolean) {
  try {
    // Validate Tally ID, Stripe passes on user input
    if (!ALPHANUMERIC_REGEX.test(tallyId)) {
      throw new Error("Invalid Tally ID");
    }

    // Find the record with the matching Tally ID
    const records = await table
      .select({
        filterByFormula: `{${tallyIdFieldName}} = '${tallyId}'`,
      })
      .firstPage();

    if (records.length === 0) {
      console.warn(`No Airtable record found with Tally ID: ${tallyId}`);
      return;
    }

    const record = records[0];

    // Update the payment status
    await record.patchUpdate(
      Object.fromEntries([[paymentStatusFieldName, status]])
    );

    console.log(
      `Airtable record ${record.id} updated with payment status: ${status}`
    );
  } catch (error) {
    console.error(
      `Error updating Airtable record for Tally ID ${tallyId}:`,
      error
    );
    throw error; // Re-throw the error for further handling if needed
  }
}
