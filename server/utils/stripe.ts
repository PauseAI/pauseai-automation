import Stripe from "stripe";

const stripeApiKey = requireEnv("STRIPE_API_KEY");

export const stripe = new Stripe(stripeApiKey, {
  apiVersion: "2025-04-30.basil",
  // Bounded so the webhook answers well within Netlify's function time limit.
  timeout: 8_000,
  maxNetworkRetries: 1,
});
