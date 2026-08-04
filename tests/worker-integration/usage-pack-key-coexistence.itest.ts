import { beforeAll, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { SUPABASE_URL, seedBusiness, serviceDb } from "./harness";

/**
 * Three different purchase paths write grants into the SAME three tables,
 * keyed by the SAME `stripe_checkout_session_id text unique` column:
 *
 *   cs_<sessionId>                        manual one-time pack (Checkout)
 *   inv_<invoiceId>:<category>:<packId>   recurring membership add-on (invoice.paid)
 *   pi_<paymentIntentId>                  auto-reload (added in Phase 2)
 *
 * The column is a plain text unique index, so the three shapes coexisting is
 * a convention, not something the schema enforces. Today nothing tests it:
 * `tests/membership-pack-addon-grants.test.ts` asserts the synthetic key
 * against a `vi.fn()`, which cannot tell you whether two shapes collide,
 * whether the balances sum, or which grant a consume actually drains.
 *
 * This file pins that convention against real Postgres, and drives the real
 * `applyMembershipPackAddonsFromInvoice` so the `inv_` shape comes from
 * production code rather than a string literal copied into a test.
 */

// The add-on grant helper builds its own service client from the app env
// vars; point it at the itest stack BEFORE the lazy import inside it runs.
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.ITEST_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

import { applyMembershipPackAddonsFromInvoice } from "@/lib/billing/membership-pack-addon-grants";

const MANUAL_TEXTS = 500;
const ADDON_TEXTS = 2_000;
const PLAN_CAP_BLOWOUT_TEXTS = 50_000;

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function epochDaysFromNow(days: number): number {
  return Math.floor((Date.now() + days * 24 * 60 * 60 * 1000) / 1000);
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A paid renewal invoice carrying one SMS add-on pack. Shaped as the webhook
 * receives it; `commitmentMonthsFromStripeSubscription` reads items[0] to
 * decide the multiplier, so the monthly recurrence keeps it at 1x.
 */
function addonSubscription(overrides: Record<string, unknown> = {}): Stripe.Subscription {
  return {
    id: "sub_itest_addons",
    status: "active",
    metadata: { addonSms: `texts_2000:1:${ADDON_TEXTS}` },
    current_period_start: epochDaysFromNow(-10),
    current_period_end: epochDaysFromNow(20),
    items: {
      data: [{ price: { recurring: { interval: "month", interval_count: 1 } } }]
    },
    ...overrides
  } as unknown as Stripe.Subscription;
}

function paidInvoice(id: string): Stripe.Invoice {
  return {
    id,
    amount_paid: 4_320,
    created: Math.floor(Date.now() / 1000)
  } as unknown as Stripe.Invoice;
}

async function seedActiveSubscription(db: SupabaseClient, businessId: string): Promise<void> {
  const { error } = await db.from("subscriptions").insert({
    id: randomUUID(),
    business_id: businessId,
    tier: "standard",
    status: "active",
    stripe_subscription_id: "sub_itest_addons",
    stripe_current_period_start: daysFromNow(-10)
  });
  if (error) throw new Error(`seedActiveSubscription: ${error.message}`);
}

async function smsGrantRows(
  db: SupabaseClient,
  businessId: string
): Promise<Array<{ stripe_checkout_session_id: string; texts_remaining: number }>> {
  const { data, error } = await db
    .from("sms_bonus_grants")
    .select("stripe_checkout_session_id, texts_remaining, expires_at")
    .eq("business_id", businessId)
    .order("expires_at", { ascending: true });
  if (error) throw new Error(`smsGrantRows: ${error.message}`);
  return data as Array<{ stripe_checkout_session_id: string; texts_remaining: number }>;
}

async function smsBonusRemaining(db: SupabaseClient, businessId: string): Promise<number> {
  const { data, error } = await db.rpc("sms_bonus_texts_remaining", { p_business_id: businessId });
  if (error) throw new Error(`smsBonusRemaining: ${error.message}`);
  return Number(data);
}

describe("manual packs and recurring add-on packs share one grant table", () => {
  const db = serviceDb();
  const manualSession = `cs_${randomUUID()}`;
  const invoiceId = `in_${randomUUID().slice(0, 12)}`;
  let businessId = "";
  let addonKey = "";

  beforeAll(async () => {
    businessId = await seedBusiness(db, "Pack key coexistence itest");
    await seedActiveSubscription(db, businessId);

    // 1. The tenant buys a pack by hand through Checkout. Expiry deliberately
    //    LATER than the add-on's so FIFO ordering is observable below.
    const { error } = await db.rpc("apply_sms_bonus_grant_from_checkout", {
      p_business_id: businessId,
      p_checkout_session_id: manualSession,
      p_texts_purchased: MANUAL_TEXTS,
      p_expires_at: daysFromNow(60)
    });
    if (error) throw new Error(`manual grant: ${error.message}`);

    // 2. Their renewal invoice pays, and the recurring add-on grants through
    //    the real production helper. Its expiry is max(period end, +30d),
    //    which lands before the manual grant's 60 days.
    await applyMembershipPackAddonsFromInvoice({
      invoice: paidInvoice(invoiceId),
      stripeSubscription: addonSubscription(),
      businessId,
      eventId: "evt_itest_coexistence"
    });

    const rows = await smsGrantRows(db, businessId);
    addonKey =
      rows.find((r) => r.stripe_checkout_session_id !== manualSession)
        ?.stripe_checkout_session_id ?? "";
  });

  it("writes two distinct rows, neither swallowed by the unique index", async () => {
    const rows = await smsGrantRows(db, businessId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.stripe_checkout_session_id).sort()).toEqual(
      [manualSession, addonKey].sort()
    );
  });

  it("builds the add-on key from production code, in the documented shape", () => {
    // Not a literal copied into the test: this is whatever
    // sourceIdForGrant() actually produced.
    expect(addonKey).toBe(`inv_${invoiceId}:sms:texts_2000`);
  });

  it("sums both sources into one balance", async () => {
    expect(await smsBonusRemaining(db, businessId)).toBe(MANUAL_TEXTS + ADDON_TEXTS);
  });

  it("replaying either key grants nothing extra", async () => {
    const before = await smsBonusRemaining(db, businessId);

    // Same invoice delivered twice (Stripe retries, or invoice.paid racing
    // checkout.session.completed).
    await applyMembershipPackAddonsFromInvoice({
      invoice: paidInvoice(invoiceId),
      stripeSubscription: addonSubscription(),
      businessId,
      eventId: "evt_itest_coexistence_replay"
    });
    // Same manual Checkout session delivered twice.
    await db.rpc("apply_sms_bonus_grant_from_checkout", {
      p_business_id: businessId,
      p_checkout_session_id: manualSession,
      p_texts_purchased: MANUAL_TEXTS,
      p_expires_at: daysFromNow(60)
    });

    expect(await smsGrantRows(db, businessId)).toHaveLength(2);
    expect(await smsBonusRemaining(db, businessId)).toBe(before);
  });

  it("grants a fresh allotment on the NEXT invoice, without colliding", async () => {
    // The whole point of keying on the invoice id: a renewal must top up.
    const before = await smsBonusRemaining(db, businessId);
    const renewalId = `in_${randomUUID().slice(0, 12)}`;

    await applyMembershipPackAddonsFromInvoice({
      invoice: paidInvoice(renewalId),
      stripeSubscription: addonSubscription(),
      businessId,
      eventId: "evt_itest_coexistence_renewal"
    });

    expect(await smsGrantRows(db, businessId)).toHaveLength(3);
    expect(await smsBonusRemaining(db, businessId)).toBe(before + ADDON_TEXTS);
  });

  it("drains the earliest-expiring grant first, whatever wrote it", async () => {
    // Consumption must not care which purchase path created the row.
    const { error } = await db.from("daily_usage").insert({
      business_id: businessId,
      usage_date: utcToday(),
      sms_sent: PLAN_CAP_BLOWOUT_TEXTS
    });
    if (error) throw new Error(`seed daily_usage: ${error.message}`);

    const { data, error: reserveErr } = await db.rpc("try_reserve_sms_outbound_slot", {
      p_business_id: businessId
    });
    if (reserveErr) throw new Error(`reserve: ${reserveErr.message}`);
    expect(data).toMatchObject({ ok: true, source: "bonus" });

    const rows = await smsGrantRows(db, businessId);
    const manual = rows.find((r) => r.stripe_checkout_session_id === manualSession);
    const addon = rows.find((r) => r.stripe_checkout_session_id === addonKey);
    // The add-on expires first (period end / +30d) so it pays, and the
    // manual pack bought for 60 days is untouched.
    expect(addon?.texts_remaining).toBe(ADDON_TEXTS - 1);
    expect(manual?.texts_remaining).toBe(MANUAL_TEXTS);
  });

  it("claws back one source without touching the others", async () => {
    const before = await smsBonusRemaining(db, businessId);

    const { error } = await db.rpc("void_sms_bonus_grant_by_checkout_session", {
      p_checkout_session_id: manualSession,
      p_reason: "refund"
    });
    if (error) throw new Error(`void: ${error.message}`);

    // Only the manual pack's remaining balance leaves; the two add-on
    // grants survive untouched.
    expect(await smsBonusRemaining(db, businessId)).toBe(before - MANUAL_TEXTS);
    const rows = await smsGrantRows(db, businessId);
    expect(rows.find((r) => r.stripe_checkout_session_id === addonKey)?.texts_remaining).toBe(
      ADDON_TEXTS - 1
    );
  });

  it("blocks the add-on grant when nothing was actually paid", async () => {
    // A $0 invoice (the trial_end admin lever) must not mint a free pack:
    // the amount is not what sizes the grant, so idempotency alone would
    // never catch this.
    const freeBiz = await seedBusiness(db, "Pack key coexistence itest (unpaid)");
    await seedActiveSubscription(db, freeBiz);

    await applyMembershipPackAddonsFromInvoice({
      invoice: { ...paidInvoice(`in_${randomUUID().slice(0, 12)}`), amount_paid: 0 } as Stripe.Invoice,
      stripeSubscription: addonSubscription(),
      businessId: freeBiz,
      eventId: "evt_itest_coexistence_unpaid"
    });

    expect(await smsGrantRows(db, freeBiz)).toHaveLength(0);
  });

  it("blocks the add-on grant when Stripe says the subscription is not entitled", async () => {
    const lapsedBiz = await seedBusiness(db, "Pack key coexistence itest (past due)");
    await seedActiveSubscription(db, lapsedBiz);

    await applyMembershipPackAddonsFromInvoice({
      invoice: paidInvoice(`in_${randomUUID().slice(0, 12)}`),
      stripeSubscription: addonSubscription({ status: "past_due" }),
      businessId: lapsedBiz,
      eventId: "evt_itest_coexistence_pastdue"
    });

    expect(await smsGrantRows(db, lapsedBiz)).toHaveLength(0);
  });
});
