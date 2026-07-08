/**
 * Public payment page for an enterprise deal — the durable, emailable link
 * (/enterprise-offer/<pay_token>) an admin sends to an enterprise owner. The
 * pay_token is an unguessable capability; the page shows the deal's setup +
 * monthly price and hands off to Stripe Checkout via
 * /enterprise-offer/<pay_token>/pay, which creates a fresh subscription-mode
 * session per click so the link never expires the way a raw Checkout URL
 * (24h) would.
 *
 * Deliberately public (no auth), mirroring /offer/<pay_token>: the token is
 * the capability, and the page never exposes anything beyond the prices the
 * admin set.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEnterpriseDealByPayToken } from "@/lib/db/enterprise-deals";
import { getBusiness } from "@/lib/db/businesses";

export const dynamic = "force-dynamic";

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export default async function EnterpriseOfferPayPage({
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
  const deal = await getEnterpriseDealByPayToken(payToken);
  if (!deal) notFound();
  const business = await getBusiness(deal.business_id);

  const justPaid = query.paid === "1";
  const state: "open" | "active" | "revoked" | "canceled" =
    deal.status === "open" && !justPaid ? "open" : justPaid ? "active" : deal.status;

  return (
    <main className="min-h-screen bg-deep-ink flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-parchment/15 bg-deep-ink/60 p-8 space-y-4">
        <p className="text-xs uppercase tracking-wider text-parchment/40">
          NewCoworker · Enterprise plan
        </p>
        <h1 className="text-2xl font-bold text-parchment">
          {business ? `Enterprise plan for ${business.name}` : "Enterprise plan"}
        </h1>

        {state === "open" && (
          <>
            <p className="text-3xl font-semibold text-parchment">
              {currency.format(deal.monthly_cents / 100)}
              <span className="ml-2 text-sm font-normal text-parchment/40">per month</span>
            </p>
            {deal.setup_cents > 0 && (
              <p className="text-sm text-parchment/60">
                Plus a one-time {currency.format(deal.setup_cents / 100)} setup fee, billed with
                your first month.
              </p>
            )}
            <Link
              href={`/enterprise-offer/${payToken}/pay`}
              prefetch={false}
              className="block w-full rounded-lg bg-claw-green px-4 py-3 text-center font-semibold text-deep-ink hover:bg-opacity-90"
            >
              Continue to secure payment
            </Link>
            <p className="text-[11px] text-parchment/40">
              Payments are processed by Stripe. Your subscription renews monthly until canceled.
            </p>
          </>
        )}
        {state === "active" && (
          <p className="rounded-md border border-claw-green/40 bg-claw-green/10 px-3 py-2 text-sm text-claw-green">
            {justPaid
              ? "Payment received — thank you! Your enterprise subscription is now active."
              : "This plan is already active. Contact us if anything looks off."}
          </p>
        )}
        {(state === "revoked" || state === "canceled") && (
          <p className="rounded-md border border-spark-orange/40 bg-spark-orange/10 px-3 py-2 text-sm text-spark-orange">
            This offer is no longer available. Reply to the email you received and we&apos;ll
            sort it out.
          </p>
        )}
      </div>
    </main>
  );
}
