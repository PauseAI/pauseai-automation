export default defineEventHandler(async (event) => {
  const stripeEvent = await verifyStripeWebhook(event);

  if (!stripeEvent) {
    event.node.res.statusCode = 400;
    return { status: "error", message: "Webhook verification failed" };
  }

  switch (stripeEvent.type) {
    case "customer.subscription.created":
      await handleSubscriptionEvent(stripeEvent, { paymentStatus: true });
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionEvent(stripeEvent, { paymentStatus: false });
      break;
    default:
      event.node.res.statusCode = 400;
      return { status: "error", message: "Unexpected Stripe event type" };
  }

  return { status: "success" };
});
