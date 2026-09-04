/**
 * Stripe TEST-MODE pass for the priority support add-on (PR #1429).
 *
 * Exercises the real production functions against the real Stripe API, on a
 * simulated 24-month term tenant, which is the configuration that exposes every
 * assumption the design rests on. Unit tests mocked Stripe; this does not.
 *
 * SAFETY: refuses to run on anything but an `sk_test_` key, and never reads
 * STRIPE_SECRET_KEY from .env (that file holds a LIVE key). Pass the test key
 * as the first argument or via STRIPE_TEST_KEY.
 *
 *   npx tsx debug/priority-support-stripe-testmode.ts <sk_test_...>
 *
 * Everything it creates is torn down at the end, and it is all test-mode, so
 * no real money is ever involved.
 */

const testKey = (process.argv[2] ?? process.env.STRIPE_TEST_KEY ?? "").trim();
if (!testKey.startsWith("sk_test_")) {
  console.error(
    "REFUSING TO RUN: need an sk_test_ key. Got " +
      (testKey ? `${testKey.slice(0, 8)}...` : "(nothing)") +
      "\nThis script must never touch live Stripe."
  );
  process.exit(1);
}
// Set BEFORE importing anything that calls getStripe(), and deliberately
// overwrite whatever .env may have put here.
process.env.STRIPE_SECRET_KEY = testKey;

import Stripe from "stripe";
import {
  createPrioritySupportCheckoutSession,
  cancelPrioritySupportSubscription,
  resumePrioritySupportSubscription
} from "@/lib/stripe/client";
import {
  prioritySupportPeriodEnd,
  isPrioritySupportSubscription
} from "@/lib/billing/priority-support";
import {
  PRIORITY_SUPPORT_LINE_NAME,
  PRIORITY_SUPPORT_MONTHLY_CENTS,
  prioritySupportCoverageUntil,
  prioritySupportDaysLeft
} from "@/lib/plans/priority-support";

const stripe = new Stripe(testKey, { apiVersion: "2026-08-26.dahlia" });
const BIZ = "00000000-0000-4000-8000-0000000000ff";
const DAY = 24 * 60 * 60 * 1000;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? ` (${detail})` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` (${detail})` : ""}`);
  }
}

/** Period end off a subscription, tolerating both Stripe shapes. */
function rawPeriodEnd(sub: Stripe.Subscription): number | null {
  const raw = sub as unknown as {
    current_period_end?: number | null;
    items?: { data?: Array<{ current_period_end?: number | null }> };
  };
  const top = raw.current_period_end;
  if (typeof top === "number") return top;
  const item = raw.items?.data?.[0]?.current_period_end;
  return typeof item === "number" ? item : null;
}

async function main() {
  console.log(`Stripe test mode, key ${testKey.slice(0, 12)}...\n`);
  const created: { customer?: string; membership?: string; priority?: string } = {};

  try {
    // ---- Set up a 24-month term tenant -------------------------------------
    const customer = await stripe.customers.create({
      email: "priority-support-testmode@example.com",
      description: "PR #1429 test-mode pass (safe to delete)",
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" }
    });
    created.customer = customer.id;
    console.log(`customer ${customer.id}`);

    console.log("\n[1] 24-month membership subscription");
    // NOTE: subscriptions.create price_data takes a product ID, unlike Checkout
    // line_items which accept inline product_data. Different shapes, same API.
    const membershipProduct = await stripe.products.create({
      name: "Standard plan (24mo, test)"
    });
    const membership = await stripe.subscriptions.create({
      customer: customer.id,
      items: [
        {
          price_data: {
            currency: "usd",
            product: membershipProduct.id,
            unit_amount: 99_00 * 24,
            recurring: { interval: "month", interval_count: 24 }
          }
        }
      ],
      metadata: { businessId: BIZ }
    });
    created.membership = membership.id;
    const membershipEnd = rawPeriodEnd(membership);
    const membershipMonths = membershipEnd
      ? (membershipEnd * 1000 - Date.now()) / (30.44 * DAY)
      : 0;
    check(
      "membership bills at interval_count 24",
      membership.items.data[0]?.price.recurring?.interval_count === 24,
      `interval_count=${membership.items.data[0]?.price.recurring?.interval_count}`
    );
    check(
      "membership period end is ~24 months out",
      membershipMonths > 23 && membershipMonths < 25,
      `${membershipMonths.toFixed(1)} months`
    );

    // ---- What Stripe actually enforces ------------------------------------
    // CORRECTION (verified 2026-08-17): the original justification for a
    // separate subscription was "Stripe requires every item to share a billing
    // interval, so a monthly line cannot ride a 12/24-month membership". That
    // is FALSE. Stripe's real rule, quoted from its own error, is that each
    // item's recurring period must be a MULTIPLE OF THE SHORTEST one, so
    // month/1 alongside month/24 is accepted and bills on its own cadence.
    // Only non-divisible pairs (month + week) are refused.
    //
    // Probed on a THROWAWAY subscription so a success cannot pollute the
    // membership assertions below, which is what made this run report two
    // failures instead of one.
    console.log("\n[2] Stripe's real mixed-interval rule");
    const probeCustomer = await stripe.customers.create({
      description: "interval probe (safe to delete)"
    });
    const probeSub = await stripe.subscriptions.create({
      customer: probeCustomer.id,
      items: [
        {
          price_data: {
            currency: "usd",
            product: (await stripe.products.create({ name: "probe base (test)" })).id,
            unit_amount: 99_00 * 24,
            recurring: { interval: "month", interval_count: 24 }
          }
        }
      ],
      payment_behavior: "default_incomplete"
    });
    let monthlyOnTermAccepted = false;
    try {
      await stripe.subscriptionItems.create({
        subscription: probeSub.id,
        price_data: {
          currency: "usd",
          product: (await stripe.products.create({ name: "probe monthly (test)" })).id,
          unit_amount: PRIORITY_SUPPORT_MONTHLY_CENTS,
          recurring: { interval: "month", interval_count: 1 }
        }
      });
      monthlyOnTermAccepted = true;
    } catch {
      monthlyOnTermAccepted = false;
    }
    check(
      "month/1 IS allowed on a month/24 subscription (premise was wrong)",
      monthlyOnTermAccepted,
      monthlyOnTermAccepted ? "accepted, as the multiple-of-shortest rule predicts" : "rejected"
    );
    let weekOnMonthRejected = false;
    try {
      await stripe.subscriptionItems.create({
        subscription: probeSub.id,
        price_data: {
          currency: "usd",
          product: (await stripe.products.create({ name: "probe weekly (test)" })).id,
          unit_amount: 1_00,
          recurring: { interval: "week", interval_count: 1 }
        }
      });
    } catch {
      weekOnMonthRejected = true;
    }
    check(
      "a NON-divisible period (week on month) is still refused",
      weekOnMonthRejected,
      "confirms the rule is multiple-of-shortest, not identical-interval"
    );
    await stripe.subscriptions.cancel(probeSub.id).catch(() => {});
    await stripe.customers.del(probeCustomer.id).catch(() => {});

    // ---- The real checkout builder -----------------------------------------
    console.log("\n[3] createPrioritySupportCheckoutSession (real production function)");
    const session = await createPrioritySupportCheckoutSession({
      businessId: BIZ,
      successUrl: "https://example.com/ok",
      cancelUrl: "https://example.com/no",
      customerId: customer.id,
      userId: "test-user"
    });
    const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
      expand: ["line_items"]
    });
    const line = fullSession.line_items?.data?.[0];
    check("session mode is subscription", fullSession.mode === "subscription");
    check("session attaches to the existing customer", fullSession.customer === customer.id);
    check(
      "line is $400",
      line?.amount_total === PRIORITY_SUPPORT_MONTHLY_CENTS,
      `${line?.amount_total}`
    );
    check(
      "line description is the sentinel name",
      line?.description === PRIORITY_SUPPORT_LINE_NAME,
      `${line?.description}`
    );
    check(
      "session metadata carries subscriptionKind",
      fullSession.metadata?.subscriptionKind === "priority_support"
    );

    // ---- Simulate the completed checkout -----------------------------------
    // Checkout itself needs a browser, so create the subscription Stripe would
    // have created, with the identical shape the session declares.
    console.log("\n[4] priority support subscription (what that checkout creates)");
    const priorityProduct = await stripe.products.create({
      name: PRIORITY_SUPPORT_LINE_NAME
    });
    const priority = await stripe.subscriptions.create({
      customer: customer.id,
      items: [
        {
          price_data: {
            currency: "usd",
            product: priorityProduct.id,
            unit_amount: PRIORITY_SUPPORT_MONTHLY_CENTS,
            recurring: { interval: "month" }
          }
        }
      ],
      metadata: { businessId: BIZ, subscriptionKind: "priority_support" }
    });
    created.priority = priority.id;
    const rec = priority.items.data[0]?.price.recurring;
    check("two live subscriptions coexist on one customer", true, `${membership.id} + ${priority.id}`);
    check("priority bills monthly", rec?.interval === "month", `interval=${rec?.interval}`);
    check(
      "priority has NO term multiplier",
      (rec?.interval_count ?? 1) === 1,
      `interval_count=${rec?.interval_count}`
    );
    check("priority charges $400", priority.items.data[0]?.price.unit_amount === 40_000);

    // ---- The 4b regression, at the Stripe level ----------------------------
    console.log("\n[5] the membership must be untouched by all of that");
    const membershipAfter = await stripe.subscriptions.retrieve(membership.id);
    const endAfter = rawPeriodEnd(membershipAfter);
    check(
      "membership period end unchanged",
      endAfter === membershipEnd,
      `before=${membershipEnd} after=${endAfter}`
    );
    check(
      "membership still has exactly one item",
      membershipAfter.items.data.length === 1,
      `${membershipAfter.items.data.length} item(s)`
    );

    // ---- The helpers, against a REAL Stripe object -------------------------
    console.log("\n[6] helpers read the real Stripe object, not a hand-built fixture");
    check(
      "isPrioritySupportSubscription recognizes it",
      isPrioritySupportSubscription(priority)
    );
    check(
      "isPrioritySupportSubscription rejects the membership",
      !isPrioritySupportSubscription(membershipAfter)
    );
    const periodEnd = prioritySupportPeriodEnd(priority);
    check(
      "prioritySupportPeriodEnd resolves from the live object",
      periodEnd !== null,
      periodEnd ? periodEnd.toISOString() : "NULL"
    );
    const shape =
      (priority as unknown as { current_period_end?: number }).current_period_end !== undefined
        ? "top-level"
        : "per-item";
    console.log(`        (this API version reports period end at the ${shape} level)`);
    if (periodEnd) {
      const days = (periodEnd.getTime() - Date.now()) / DAY;
      check("priority period is ~1 month", days > 27 && days < 33, `${days.toFixed(1)} days`);
      const coverage = prioritySupportCoverageUntil(periodEnd);
      const covDays = prioritySupportDaysLeft("standard", coverage.toISOString());
      check(
        "coverage lands ~33 days out (period + 3d grace)",
        covDays !== null && covDays >= 31 && covDays <= 35,
        `${covDays} days`
      );
    }

    // ---- Cancel and resume round-trip --------------------------------------
    console.log("\n[7] cancel then resume, the real functions");
    const canceled = await cancelPrioritySupportSubscription(priority.id);
    check("cancel sets cancel_at_period_end", canceled.cancel_at_period_end === true);
    check("cancel does NOT end it immediately", canceled.status === "active", canceled.status);
    const resumed = await resumePrioritySupportSubscription(priority.id);
    check("resume clears cancel_at_period_end", resumed.cancel_at_period_end === false);
    check("resume keeps the same subscription", resumed.id === priority.id);
    const resumedEnd = rawPeriodEnd(resumed);
    check(
      "resume does not move the period (no new charge)",
      resumedEnd === rawPeriodEnd(priority),
      `${resumedEnd}`
    );
  } finally {
    console.log("\n[cleanup]");
    for (const id of [created.priority, created.membership]) {
      if (!id) continue;
      try {
        await stripe.subscriptions.cancel(id);
        console.log(`  canceled ${id}`);
      } catch (err) {
        console.log(`  could not cancel ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (created.customer) {
      try {
        await stripe.customers.del(created.customer);
        console.log(`  deleted ${created.customer}`);
      } catch (err) {
        console.log(`  could not delete customer: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("\nUNEXPECTED ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
