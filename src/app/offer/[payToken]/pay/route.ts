/**
 * GET /offer/<pay_token>/pay — hand off to Stripe Checkout for a custom
 * white-glove offer.
 *
 * Public by design: the pay_token is the capability (prospect offers are paid
 * before any account exists). Each visit creates a FRESH Checkout Session for
 * the amount stored on the offer row (never client-supplied), so the emailed
 * /offer/<token> link stays valid indefinitely while raw Checkout URLs expire
 * after 24h. Non-open offers bounce back to the offer page, which explains
 * the state instead of charging twice — and the webhook's atomic paid-claim
 * catches any double-charge race that slips through.
 */
import { NextResponse } from "next/server";
import { getWhiteGloveOfferByPayToken } from "@/lib/db/white-glove-offers";
import { createWhiteGloveCheckoutSession } from "@/lib/stripe/client";

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
  const offer = await getWhiteGloveOfferByPayToken(payToken);
  if (!offer) {
    return NextResponse.redirect(`${appUrl}/pricing`, 303);
  }
  if (offer.status !== "open") {
    return NextResponse.redirect(`${appUrl}/offer/${payToken}`, 303);
  }

  const session = await createWhiteGloveCheckoutSession({
    packageId: "custom",
    packageName: offer.name,
    amountCents: offer.amount_cents,
    businessId: offer.business_id ?? undefined,
    offerId: offer.id,
    successUrl: `${appUrl}/offer/${payToken}?paid=1`,
    cancelUrl: `${appUrl}/offer/${payToken}`,
    customerEmail: offer.recipient_email ?? undefined
  });
  return NextResponse.redirect(session.url, 303);
}
