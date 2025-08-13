const PRODUCT_ID = requireEnv("STRIPE_PRODUCT_ID");

export default defineEventHandler(async (event) => {
  const stripeEvent = await verifyStripeWebhook(event);

  if (!stripeEvent) {
    event.node.res.statusCode = 400;
    return { status: "error", message: "Webhook verification failed" };
  }

  switch (stripeEvent.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
      const isPayingMember = await subscriptionIncludesProduct(stripeEvent.data.object, PRODUCT_ID);
      await handleSubscriptionEvent(stripeEvent.data.object, { subscriptionStatus: isPayingMember });
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionEvent(stripeEvent.data.object, { subscriptionStatus: false });
      break;
    default:
      event.node.res.statusCode = 400;
      return { status: "error", message: "Unexpected Stripe event type" };
  }

  return { status: "success" };
});
