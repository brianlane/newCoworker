/**
 * What does Stripe ACTUALLY enforce about mixed billing intervals on one
 * subscription?
 *
 * The priority support design (PR #1429) was justified on "Stripe requires
 * every item on one subscription to share a billing interval, so a monthly
 * $400 line cannot ride a 12/24-month membership". The test-mode pass showed
 * Stripe accepting exactly that item, so this probe pins down the real rule.
 *
 * Each case gets its OWN throwaway subscription, so a probe that succeeds
 * cannot pollute a later assertion.
 *
 *   npx tsx debug/stripe-interval-constraint-probe.ts <sk_test_...>
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

async function productId(name: string): Promise<string> {
  return (await stripe.products.create({ name })).id;
}

/** Try to add an item with `add` cadence to a subscription whose plan is `base`. */
async function probe(label: string, base: Rec, add: Rec) {
  const customer = await stripe.customers.create({
    description: "interval constraint probe (safe to delete)",
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" }
  });
  let subId: string | null = null;
  try {
    const sub = await stripe.subscriptions.create({
      customer: customer.id,
      items: [
        {
          price_data: {
            currency: "usd",
            product: await productId(`base ${label}`),
            unit_amount: 100_00,
            recurring: base
          }
        }
      ]
    });
    subId = sub.id;

    try {
      const item = await stripe.subscriptionItems.create({
        subscription: sub.id,
        price_data: {
          currency: "usd",
          product: await productId(`add ${label}`),
          unit_amount: 400_00,
          recurring: add
        }
      });
      const r = item.price.recurring;
      console.log(
        `  ACCEPTED  ${label}\n` +
          `            added item is interval=${r?.interval} interval_count=${r?.interval_count}`
      );
      // What would the next invoice actually look like?
      const after = await stripe.subscriptions.retrieve(sub.id, { expand: ["items.data.price"] });
      const ends = after.items.data.map((i) => {
        const raw = i as unknown as { current_period_end?: number };
        return raw.current_period_end;
      });
      console.log(
        `            item period ends: ${ends
          .map((e) => (e ? new Date(e * 1000).toISOString().slice(0, 10) : "?"))
          .join(" | ")}`
      );
      return "ACCEPTED";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  REJECTED  ${label}\n            ${msg.slice(0, 200)}`);
      return "REJECTED";
    }
  } finally {
    if (subId) await stripe.subscriptions.cancel(subId).catch(() => {});
    await stripe.customers.del(customer.id).catch(() => {});
  }
}

async function main() {
  console.log("Probing Stripe's real mixed-interval rule (test mode)\n");

  console.log("[A] same interval, DIFFERENT interval_count");
  await probe("month/24 base + month/1 item", { interval: "month", interval_count: 24 }, { interval: "month" });
  await probe("month/12 base + month/1 item", { interval: "month", interval_count: 12 }, { interval: "month" });
  await probe("month/1 base + month/24 item", { interval: "month" }, { interval: "month", interval_count: 24 });

  console.log("\n[B] DIFFERENT interval");
  await probe("month/1 base + year/1 item", { interval: "month" }, { interval: "year" });
  await probe("month/24 base + year/1 item", { interval: "month", interval_count: 24 }, { interval: "year" });
  await probe("month/1 base + week/1 item", { interval: "month" }, { interval: "week" });

  console.log("\nDone.");
  process.exit(0);
}

main().catch((err) => {
  console.error("UNEXPECTED:", err instanceof Error ? err.message : err);
  process.exit(1);
});
