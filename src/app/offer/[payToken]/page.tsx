/**
 * Public payment page for a custom white-glove offer — the durable, emailable
 * link (/offer/<pay_token>) an admin sends to a prospect (or an existing
 * owner). The pay_token is an unguessable capability; the page shows what the
 * offer is and hands off to Stripe Checkout via /offer/<pay_token>/pay, which
 * creates a fresh session per click so the link never expires the way a raw
 * Checkout URL (24h) would.
 *
 * Deliberately public (no auth): prospect offers are payable BEFORE any
 * account exists. The page never exposes anything beyond what the admin put
 * in the offer itself.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWhiteGloveOfferByPayToken } from "@/lib/db/white-glove-offers";

export const dynamic = "force-dynamic";

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export default async function OfferPayPage({
  params,
  searchParams
}: {
  params: Promise<{ payToken: string }>;
  searchParams?: Promise<{ paid?: string }>;
}) {
  const { payToken } = await params;
  const query = (await searchParams) ?? {};
  // Fail closed on malformed tokens without hitting the DB.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payToken)) {
    notFound();
  }
  const offer = await getWhiteGloveOfferByPayToken(payToken);
  if (!offer) notFound();

  const justPaid = query.paid === "1";
  const state: "open" | "paid" | "revoked" =
    offer.status === "open" && !justPaid ? "open" : offer.status === "revoked" ? "revoked" : "paid";

  return (
    <main className="min-h-screen bg-deep-ink flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-parchment/15 bg-deep-ink/60 p-8 space-y-4">
        <p className="text-xs uppercase tracking-wider text-parchment/40">
          NewCoworker · White-glove service
        </p>
        <h1 className="text-2xl font-bold text-parchment">{offer.name}</h1>
        {offer.description && (
          <p className="text-sm leading-relaxed text-parchment/60">{offer.description}</p>
        )}

        {state === "open" && (
          <>
            <p className="text-3xl font-semibold text-parchment">
              {currency.format(offer.amount_cents / 100)}
              <span className="ml-2 text-sm font-normal text-parchment/40">one-time</span>
            </p>
            <Link
              href={`/offer/${payToken}/pay`}
              prefetch={false}
              className="block w-full rounded-lg bg-claw-green px-4 py-3 text-center font-semibold text-deep-ink hover:bg-opacity-90"
            >
              Continue to secure payment
            </Link>
            <p className="text-[11px] text-parchment/40">
              Payments are processed by Stripe. You&apos;ll get an email confirmation and a
              booking link right after checkout.
            </p>
          </>
        )}
        {state === "paid" && (
          <p className="rounded-md border border-claw-green/40 bg-claw-green/10 px-3 py-2 text-sm text-claw-green">
            {justPaid
              ? "Payment received — thank you! Check your email for the confirmation and booking link."
              : "This offer has already been paid. Check your email for the confirmation, or contact us if anything's missing."}
          </p>
        )}
        {state === "revoked" && (
          <p className="rounded-md border border-spark-orange/40 bg-spark-orange/10 px-3 py-2 text-sm text-spark-orange">
            This offer is no longer available. Reply to the email you received and we&apos;ll
            sort it out.
          </p>
        )}
      </div>
    </main>
  );
}
