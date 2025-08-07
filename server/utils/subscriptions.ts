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
  paymentStatus: boolean;
}

/**
 * Handles a Stripe customer subscription created or deleted event by
 * updating the Airtable payment status associated with the provided Tally ID.
 *
 * @param stripeEvent The Stripe event data.
 * @param options Options for handling the event.
 * @param options.paymentStatus The payment status to set in Airtable.
 */
export async function handleSubscriptionEvent(
  stripeEvent: Stripe.CustomerSubscriptionCreatedEvent | Stripe.CustomerSubscriptionDeletedEvent,
  options: HandleSubscriptionOptions
) {
  const subscription = stripeEvent.data.object;
  const checkoutSession = await getCheckoutSessionBySubscriptionId(
    subscription.id
  );
  const tallyId = checkoutSession.client_reference_id;
  await setPaymentStatus(tallyId, options.paymentStatus);
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
