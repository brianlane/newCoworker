/**
 * GET /enterprise-offer/<pay_token>/pay — hand off to Stripe Checkout for an
 * enterprise deal.
 *
 * Public by design (mirrors /offer/<pay_token>/pay): the pay_token is the
 * capability. Each visit creates a FRESH subscription-mode Checkout Session
 * for the setup + monthly amounts stored on the deal row (never
 * client-supplied), so the emailed link stays valid indefinitely while raw
 * Checkout URLs expire after 24h. Non-open deals bounce back to the offer
 * page, which explains the state instead of double-subscribing — and the
 * webhook's atomic active-claim catches any double-pay race that slips
 * through by canceling the duplicate subscription.
 */
import { NextResponse } from "next/server";
import { getEnterpriseDealByPayToken } from "@/lib/db/enterprise-deals";
import { getBusiness } from "@/lib/db/businesses";
import { getSubscription } from "@/lib/db/subscriptions";
import { createEnterpriseDealCheckoutSession } from "@/lib/stripe/client";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  context: { params: Promise<{ payToken: string }> }
) {
  const { payToken } = await context.params;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  if (!UUID_RE.test(payToken)) {
    return NextResponse.redirect(`${appUrl}/pricing`, 303);
  }
  const deal = await getEnterpriseDealByPayToken(payToken);
  if (!deal) {
    return NextResponse.redirect(`${appUrl}/pricing`, 303);
  }
  if (deal.status !== "open") {
    return NextResponse.redirect(`${appUrl}/enterprise-offer/${payToken}`, 303);
  }
  const business = await getBusiness(deal.business_id);
  if (!business) {
    return NextResponse.redirect(`${appUrl}/pricing`, 303);
  }
  // Pin the existing Stripe customer when one exists (e.g. from a past
  // white-glove purchase) so charges trace to one customer record.
  const subscription = await getSubscription(deal.business_id);

  const session = await createEnterpriseDealCheckoutSession({
    dealId: deal.id,
    businessId: deal.business_id,
    businessName: business.name,
    monthlyCents: deal.monthly_cents,
    setupCents: deal.setup_cents,
    successUrl: `${appUrl}/enterprise-offer/${payToken}?paid=1`,
    cancelUrl: `${appUrl}/enterprise-offer/${payToken}`,
    customerEmail: business.owner_email ?? undefined,
    customerId: subscription?.stripe_customer_id ?? undefined
  });
  return NextResponse.redirect(session.url, 303);
}
