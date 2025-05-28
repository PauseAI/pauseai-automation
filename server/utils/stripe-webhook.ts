import { EventHandler, H3Event, readRawBody } from "h3";
import Stripe from "stripe";
import { requireEnv } from "./env";

const stripeWebhookSecret = requireEnv("STRIPE_WEBHOOK_SECRET");
const stripeApiKey = requireEnv("STRIPE_API_KEY");

export const stripe = new Stripe(stripeApiKey as string, {
  apiVersion: "2025-04-30.basil",
});

type StripeEventOfType<T extends Stripe.Event.Type> = Extract<
  Stripe.Event,
  { type: T }
>;

/**
 * Creates an H3 event handler that verifies a Stripe webhook event.
 * @param type The type of Stripe event to expect.
 * @param handler The handler function that will be called with the verified event.
 * @returns A function that can be used as an H3 event handler.
 */
export function createStripeHandler<T extends Stripe.Event.Type>(
  type: T,
  handler: (event: StripeEventOfType<T>) => Promise<void>
): EventHandler {
  return async (event: H3Event) => {
    const stripeEvent = await verifyStripeWebhook(event);
    if (!stripeEvent) {
      event.node.res.statusCode = 400;
      return { status: "error", message: "Webhook verification failed" };
    }
    if (stripeEvent.type != type) {
      event.node.res.statusCode = 400;
      return { status: "error", message: "Mismatched event type" };
    }

    await handler(stripeEvent as StripeEventOfType<T>);
    return { status: "success" };
  };
}

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
