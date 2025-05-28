import { H3Event, readRawBody } from "h3";
import Stripe from "stripe";

const stripeWebhookSecret = requireEnv("STRIPE_WEBHOOK_SECRET");
const stripeApiKey = requireEnv("STRIPE_API_KEY");

export const stripe = new Stripe(stripeApiKey as string, {
  apiVersion: "2025-04-30.basil",
});

/**
 * Verifies that a webhook event was sent by Stripe.
 *
 * @param event The H3 event object for the webhook request.
 * @returns The verified Stripe event, or null if verification fails.
 */
export async function verifyStripeWebhook(
  event: H3Event
): Promise<Stripe.Event | null> {
  const signature = event.node.req.headers["stripe-signature"];
  const rawBody = await readRawBody(event);

  if (!signature || !rawBody) {
    console.error("Missing signature or raw body for webhook");
    return null;
  }

  try {
    const stripeEvent = Stripe.webhooks.constructEvent(
      rawBody,
      signature,
      stripeWebhookSecret
    );
    return stripeEvent;
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return null;
  }
}
