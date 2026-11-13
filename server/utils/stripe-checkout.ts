import { backOff } from "exponential-backoff";
import pTimeout from 'p-timeout';

// The session can take a moment to be listed after subscription.created. Kept
// short so the webhook answers well within Netlify's function time limit; a
// timeout fails the event and Stripe retries it.
const TIMEOUT_MS = 6_000;

/**
 * Fetches a Stripe checkout session by subscription ID, with a timeout of 6 seconds and
 * exponential backoff retrying.
 * @param subscriptionId The ID of the subscription to look for.
 * @returns The checkout session object. Throws an error if no session is found.
 */
export async function getCheckoutSessionBySubscriptionId(subscriptionId: string) {
  const checkoutSession = await pTimeout(
    backOff(() => fetchStripeCheckoutSession(subscriptionId), {
      numOfAttempts: 5,
      startingDelay: 250,
      maxDelay: 2_000,
    }),
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
