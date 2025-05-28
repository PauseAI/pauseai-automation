import Stripe from "stripe";

const stripeApiKey = requireEnv("STRIPE_API_KEY");

export const stripe = new Stripe(stripeApiKey as string, {
  apiVersion: "2025-04-30.basil",
});
