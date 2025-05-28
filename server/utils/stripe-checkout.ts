import { backOff } from "exponential-backoff";
import pTimeout from 'p-timeout';

const TIMEOUT_MS = 25_000;

/**
 * Fetches a Stripe checkout session by subscription ID, with a timeout of 25 seconds and
 * exponential backoff retrying.
 * @param subscriptionId The ID of the subscription to look for.
 * @returns The checkout session object. Throws an error if no session is found.
 */
export async function getCheckoutSessionBySubscriptionId(subscriptionId: string) {
  const checkoutSession = await pTimeout(
    backOff(() => fetchStripeCheckoutSession(subscriptionId)),
    {
      milliseconds: TIMEOUT_MS,
      message: "Timeout while fetching checkout session",
    }
  );
  return checkoutSession;
}

/**
 * Fetches a Stripe checkout session by subscription ID. Throws an error if no session is
 * found.
 * @param subscriptionId The ID of the subscription to look for.
 * @returns The checkout session object.
 */
async function fetchStripeCheckoutSession(subscriptionId: string) {
  const response = await stripe.checkout.sessions.list({
    subscription: subscriptionId,
  });
  if (response.data.length === 0) {
    throw new Error("No checkout session found");
  }
  return response.data[0];
}
