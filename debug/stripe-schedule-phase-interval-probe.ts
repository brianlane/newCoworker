/**
 * Does a subscription SCHEDULE PHASE enforce a single billing interval?
 *
 * `ensureCommitmentSchedule` (src/lib/stripe/client.ts) converts every
 * term-cadence add-on to a monthly equivalent for phase 2, justified as:
 *
 *   "Phase 2 rolls the plan onto the MONTHLY renewal price, and Stripe
 *    requires every item in a phase to share the billing interval"
 *
 * The same claim about SUBSCRIPTIONS turned out to be false (the real rule is
 * multiple-of-shortest, see debug/stripe-interval-constraint-probe.ts), so this
 * checks whether phases behave the same way. Schedules are a different API
 * surface and may not.
 *
 * Read-only in the sense that matters: everything is test mode and torn down.
 *
 *   npx tsx debug/stripe-schedule-phase-interval-probe.ts <sk_test_...>
 */

const testKey = (process.argv[2] ?? process.env.STRIPE_TEST_KEY ?? "").trim();
if (!testKey.startsWith("sk_test_")) {
  console.error("REFUSING TO RUN: need an sk_test_ key.");
  process.exit(1);
}
process.env.STRIPE_SECRET_KEY = testKey;

import Stripe from "stripe";

const stripe = new Stripe(testKey, { apiVersion: "2026-08-26.dahlia" });

type Rec = { interval: "day" | "week" | "month" | "year"; interval_count?: number };

async function product(name: string): Promise<string> {
  return (await stripe.products.create({ name })).id;
}

/**
 * Build a month/24 subscription with one add-on, create a schedule from it,
 * then try to write a two-phase schedule where PHASE 2 carries a monthly plan
 * plus an add-on at `phase2Addon` cadence. Reports accept or reject.
 */
async function probePhase(label: string, phase2Addon: Rec) {
  const customer = await stripe.customers.create({
    description: "schedule phase probe (safe to delete)",
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" }
  });
  let subId: string | null = null;
  let schedId: string | null = null;
  try {
    const planProduct = await product(`plan ${label}`);
    const addonProduct = await product(`addon ${label}`);

    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [
        {
          price_data: {
            currency: "usd",
            product: planProduct,
            unit_amount: 99_00 * 24,
            recurring: { interval: "month", interval_count: 24 }
          }
        }
      ]
    });
    subId = sub.id;

    const schedule = await stripe.subscriptionSchedules.create({
      from_subscription: sub.id
    });
    schedId = schedule.id;
    const current = schedule.current_phase;
    if (!current) throw new Error("no current phase");
    const planPriceId = sub.items.data[0]!.price.id;

    try {
      await stripe.subscriptionSchedules.update(schedule.id, {
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          {
            start_date: current.start_date,
            end_date: current.end_date,
            items: [{ price: planPriceId, quantity: 1 }]
          },
          {
            start_date: current.end_date,
            items: [
              // Phase 2 plan: MONTHLY renewal price, as ensureCommitmentSchedule does.
              {
                price_data: {
                  currency: "usd",
                  product: planProduct,
                  unit_amount: 195_00,
                  recurring: { interval: "month", interval_count: 1 }
                },
                quantity: 1
              },
              // The add-on under test.
              {
                price_data: {
                  currency: "usd",
                  product: addonProduct,
                  unit_amount: 4_99 * (phase2Addon.interval_count ?? 1),
                  recurring: phase2Addon
                },
                quantity: 1
              }
            ]
          }
        ]
      });
      console.log(`  ACCEPTED  ${label}`);
      return "ACCEPTED";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  REJECTED  ${label}\n            ${msg.slice(0, 220)}`);
      return "REJECTED";
    }
  } finally {
    if (schedId) await stripe.subscriptionSchedules.release(schedId).catch(() => {});
    if (subId) await stripe.subscriptions.cancel(subId).catch(() => {});
    await stripe.customers.del(customer.id).catch(() => {});
  }
}

async function main() {
  console.log("Probing subscription SCHEDULE PHASE interval rules (test mode)\n");
  console.log("Phase 2 always carries a month/1 plan price. Varying the add-on:\n");

  await probePhase("phase2: month/1 plan + month/1 addon  (control)", { interval: "month" });
  await probePhase("phase2: month/1 plan + month/24 addon (the claim)", {
    interval: "month",
    interval_count: 24
  });
  await probePhase("phase2: month/1 plan + year/1 addon", { interval: "year" });
  await probePhase("phase2: month/1 plan + week/1 addon   (non-divisible)", {
    interval: "week"
  });

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("UNEXPECTED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
