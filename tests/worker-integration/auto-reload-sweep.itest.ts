import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { SUPABASE_URL, seedBusiness, serviceDb } from "./harness";

/**
 * The auto-reload sweep against REAL Postgres: the real claim, the real
 * unique index, the real balance readers, the real grant RPCs. Only the
 * Stripe charge is faked, because CI has no Stripe credentials by design.
 *
 * This file exists for the things a mocked Supabase client structurally
 * cannot prove:
 *
 *   - two concurrent sweeps produce exactly one charge (the unique
 *     `attempt_key` and `on conflict do nothing` actually serialize);
 *   - hysteresis works against real balance SQL rather than a stubbed number;
 *   - a stale attempt is RESUMED, so the Stripe idempotency key is unchanged;
 *   - a failed charge gives the reserved monthly budget back;
 *   - three hard declines disable the rule and the next tick charges nothing.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.ITEST_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
process.env.USAGE_PACK_AUTO_RELOAD_ENABLED = "1";
process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_s500";
process.env.STRIPE_SECRET_KEY = "sk_test_itest";

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({ prices: { retrieve: async () => ({}) } }),
  createOffSessionPackCharge: vi.fn()
}));

const { sweepUsagePackAutoReloads } = await import("@/lib/billing/auto-reload-sweep");
const { listAutoReloadCandidates, reenableAutoReloadAfterCardAuthorized } = await import(
  "@/lib/db/auto-reload"
);

/** The SMS 500 pack at the documented $0.02/text default. */
const PACK_PRICE_CENTS = 1_000;
const PACK_TEXTS = 500;
const PLAN_CAP_BLOWOUT_TEXTS = 50_000;

/** Price always agrees, so these tests exercise the claim, not the guard. */
const priceOk = async () => ({ ok: true as const, amountCents: PACK_PRICE_CENTS, currency: "usd" });

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

async function seedTenant(
  db: SupabaseClient,
  label: string,
  rule: Record<string, unknown> = {}
): Promise<string> {
  const businessId = await seedBusiness(db, label);
  {
    const { error } = await db.from("subscriptions").insert({
      id: randomUUID(),
      business_id: businessId,
      tier: "standard",
      status: "active",
      stripe_customer_id: "cus_itest",
      stripe_subscription_id: "sub_itest",
      stripe_current_period_start: daysFromNow(-10)
    });
    if (error) throw new Error(`seed subscription: ${error.message}`);
  }
  {
    const { error } = await db.from("usage_pack_auto_reload_cards").insert({
      business_id: businessId,
      stripe_payment_method_id: "pm_itest",
      card_brand: "visa",
      card_last4: "4242"
    });
    if (error) throw new Error(`seed card: ${error.message}`);
  }
  {
    const { error } = await db.from("usage_pack_auto_reload_rules").insert({
      business_id: businessId,
      category: "sms",
      enabled: true,
      pack_id: "texts_500",
      threshold_units: 100,
      cooldown_minutes: 5,
      ...rule
    });
    if (error) throw new Error(`seed rule: ${error.message}`);
  }
  // Burn the plan allowance so the pack balance alone decides the trigger.
  {
    const { error } = await db.from("daily_usage").insert({
      business_id: businessId,
      usage_date: utcToday(),
      sms_sent: PLAN_CAP_BLOWOUT_TEXTS,
      sms_text_units: PLAN_CAP_BLOWOUT_TEXTS
    });
    if (error) throw new Error(`seed daily_usage: ${error.message}`);
  }
  return businessId;
}

/**
 * Scope the sweep to one tenant.
 *
 * Every itest file shares one database, so an unscoped sweep would pick up a
 * neighbouring test's tenant and charge it. Goes through the real
 * `listAutoReloadCandidates` so the production RPC and its row mapper are
 * still under test; only the filtering is the test's doing.
 */
function onlyFor(businessId: string) {
  return async (limit: number, db: SupabaseClient) => {
    const all = await listAutoReloadCandidates(limit, db as never);
    return all.filter((c) => c.businessId === businessId);
  };
}

async function rule(db: SupabaseClient, businessId: string): Promise<Record<string, unknown>> {
  const { data, error } = await db
    .from("usage_pack_auto_reload_rules")
    .select("*")
    .eq("business_id", businessId)
    .eq("category", "sms")
    .single();
  if (error) throw new Error(`rule: ${error.message}`);
  return data as Record<string, unknown>;
}

async function events(
  db: SupabaseClient,
  businessId: string
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await db
    .from("usage_pack_auto_reload_events")
    .select("*")
    .eq("business_id", businessId)
    .order("id", { ascending: true });
  if (error) throw new Error(`events: ${error.message}`);
  return data as Array<Record<string, unknown>>;
}

async function bonusRemaining(db: SupabaseClient, businessId: string): Promise<number> {
  const { data, error } = await db.rpc("sms_bonus_texts_remaining", { p_business_id: businessId });
  if (error) throw new Error(`bonusRemaining: ${error.message}`);
  return Number(data);
}

describe("auto-reload sweep against real Postgres", () => {
  const db = serviceDb();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("the full loop", () => {
    let businessId = "";
    let chargeCalls = 0;

    beforeAll(async () => {
      businessId = await seedTenant(db, "Auto-reload sweep itest (loop)");
    });

    it("charges, grants, and lifts the balance above the threshold", async () => {
      chargeCalls = 0;
      const res = await sweepUsagePackAutoReloads({
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => {
          chargeCalls += 1;
          return { ok: true, paymentIntentId: `pi_itest_${businessId.slice(0, 8)}` };
        },
        listCandidates: onlyFor(businessId)
      } as never);

      expect(chargeCalls).toBe(1);
      expect(res).toMatchObject({ charged: 1, granted: 1 });
      expect(await bonusRemaining(db, businessId)).toBe(PACK_TEXTS);

      const ledger = await events(db, businessId);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ status: "succeeded", units_granted: PACK_TEXTS });
      // The grant is keyed on the PaymentIntent, alongside any cs_/inv_ rows.
      expect(ledger[0]!.grant_source_id).toBe(`pi_pi_itest_${businessId.slice(0, 8)}`);
    });

    it("does nothing on the next tick, because the balance is now above threshold", async () => {
      // Hysteresis proven against real balance SQL: no armed flag, no re-arm
      // job, the reload itself changes the quantity being measured.
      chargeCalls = 0;
      await db
        .from("usage_pack_auto_reload_rules")
        .update({ last_attempt_at: null })
        .eq("business_id", businessId);

      const res = await sweepUsagePackAutoReloads({
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => {
          chargeCalls += 1;
          return { ok: true, paymentIntentId: "pi_should_not_happen" };
        },
        listCandidates: onlyFor(businessId)
      } as never);

      expect(chargeCalls).toBe(0);
      expect(res.skipped).toBe(1);
      expect(await events(db, businessId)).toHaveLength(1);
    });
  });

  describe("concurrency", () => {
    it("charges exactly once when two sweeps run at the same time", async () => {
      // The whole double-charge defence. A mocked client cannot prove that
      // `insert ... on conflict (attempt_key) do nothing` serializes; only a
      // real unique index can.
      const businessId = await seedTenant(db, "Auto-reload sweep itest (concurrent)");
      // Grant keys are globally unique, and real PaymentIntent ids are too, so
      // a fixed fake id would collide with a previous run of this same test
      // and silently credit another business.
      const runId = randomUUID().slice(0, 8);
      let chargeCalls = 0;
      const deps = {
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => {
          chargeCalls += 1;
          // Hold the claim briefly so both sweeps genuinely overlap.
          await new Promise((r) => setTimeout(r, 50));
          return { ok: true as const, paymentIntentId: `pi_conc_${runId}_${chargeCalls}` };
        },
        listCandidates: onlyFor(businessId)
      };

      await Promise.all([
        sweepUsagePackAutoReloads(deps as never),
        sweepUsagePackAutoReloads(deps as never)
      ]);

      expect(chargeCalls).toBe(1);
      expect(await events(db, businessId)).toHaveLength(1);
      expect(await bonusRemaining(db, businessId)).toBe(PACK_TEXTS);
    });
  });

  describe("a stale in-flight attempt", () => {
    it("is resumed on the same event id, keeping the idempotency key stable", async () => {
      // A new event row would mean a new Stripe idempotency key, and Stripe
      // would create a second PaymentIntent for a charge that may already
      // have succeeded.
      const businessId = await seedTenant(db, "Auto-reload sweep itest (stale)");
      const claim = await db.rpc("usage_pack_auto_reload_claim", {
        p_business_id: businessId,
        p_category: "sms",
        p_pack_id: "texts_500",
        p_amount_cents: PACK_PRICE_CENTS,
        p_balance_units: 0,
        p_threshold_units: 100,
        p_platform_max_cents: null
      });
      const eventId = (claim.data as { event_id: number }).event_id;

      // Age the attempt and the rule past the 15 minute in-flight window.
      const long = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      await db.from("usage_pack_auto_reload_events").update({ created_at: long }).eq("id", eventId);
      await db
        .from("usage_pack_auto_reload_rules")
        .update({ in_flight_at: long, last_attempt_at: long })
        .eq("business_id", businessId);

      const seenEventIds: number[] = [];
      await sweepUsagePackAutoReloads({
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async (p: { eventId: number }) => {
          seenEventIds.push(p.eventId);
          return { ok: true as const, paymentIntentId: "pi_resumed" };
        },
        listCandidates: onlyFor(businessId)
      } as never);

      expect(seenEventIds).toEqual([eventId]);
      expect(await events(db, businessId)).toHaveLength(1);
    });
  });

  describe("a failed charge", () => {
    it("gives the reserved monthly budget back", async () => {
      // Otherwise a run of declines would silently eat a tenant's monthly
      // allowance without ever buying them anything.
      const businessId = await seedTenant(db, "Auto-reload sweep itest (decline)", {
        monthly_limit_cents: 3_000
      });

      await sweepUsagePackAutoReloads({
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => ({
          ok: false as const,
          error: { code: "card_declined", decline_code: "do_not_honor", message: "declined" }
        }),
        listCandidates: onlyFor(businessId)
      } as never);

      const r = await rule(db, businessId);
      expect(r.month_spent_cents).toBe(0);
      expect(r.month_charges).toBe(0);
      expect(r.consecutive_failures).toBe(1);
      expect(r.enabled).toBe(true);
      expect((await events(db, businessId))[0]).toMatchObject({ status: "failed" });
    });

    it("charges once per cooldown window even if the sweep runs repeatedly", async () => {
      // The bucket in `attempt_key` is derived from wall-clock time, so three
      // ticks inside one window collide on the unique index and only the
      // first one reaches the card. Clearing last_attempt_at is not enough,
      // which is exactly the belt-and-braces the design wants.
      const businessId = await seedTenant(db, "Auto-reload sweep itest (window)", {
        cooldown_minutes: 60
      });
      let chargeCalls = 0;
      const deps = {
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => {
          chargeCalls += 1;
          return { ok: false as const, error: { code: "expired_card", message: "expired" } };
        },
        listCandidates: onlyFor(businessId)
      };

      for (let i = 0; i < 3; i += 1) {
        await sweepUsagePackAutoReloads(deps as never);
        await db
          .from("usage_pack_auto_reload_rules")
          .update({ last_attempt_at: null })
          .eq("business_id", businessId);
      }

      expect(chargeCalls).toBe(1);
      expect(await events(db, businessId)).toHaveLength(1);
    });

    it("disables the rule after three hard declines and then charges nothing", async () => {
      const businessId = await seedTenant(db, "Auto-reload sweep itest (suspend)", {
        cooldown_minutes: 5
      });
      let chargeCalls = 0;
      const deps = {
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => {
          chargeCalls += 1;
          return {
            ok: false as const,
            error: { code: "expired_card", message: "expired" }
          };
        },
        listCandidates: onlyFor(businessId)
      };

      for (let i = 0; i < 3; i += 1) {
        await sweepUsagePackAutoReloads(deps as never);
        // Free the cooldown AND the attempt bucket. The bucket is computed
        // from now() inside the claim RPC, which a test cannot advance, so
        // rewriting the already-settled attempt's key is the stand-in for the
        // clock moving into the next window.
        await db
          .from("usage_pack_auto_reload_rules")
          .update({ last_attempt_at: null })
          .eq("business_id", businessId);
        // Scoped to the one row that still holds a bucket key: attempt_key is
        // UNIQUE, so rewriting several rows to one value fails the update.
        const { error: freeErr } = await db
          .from("usage_pack_auto_reload_events")
          .update({ attempt_key: `spent:${randomUUID()}` })
          .eq("business_id", businessId)
          .neq("status", "pending")
          .not("attempt_key", "like", "spent:%");
        if (freeErr) throw new Error(`free attempt bucket: ${freeErr.message}`);
      }

      expect(chargeCalls).toBe(3);
      const r = await rule(db, businessId);
      expect(r.enabled).toBe(false);
      expect(r.disabled_reason).toBe("payment_failures");

      // A disabled rule is not even a candidate any more.
      await sweepUsagePackAutoReloads(deps as never);
      expect(chargeCalls).toBe(3);
    });
  });

  describe("a bank challenge", () => {
    it("pauses without counting toward suspension", async () => {
      // Counting 3DS as a decline would auto-disable well-behaved non-US
      // cards after three ordinary challenges.
      const businessId = await seedTenant(db, "Auto-reload sweep itest (3ds)");
      await sweepUsagePackAutoReloads({
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => ({
          ok: false as const,
          error: { code: "authentication_required", message: "3DS required" }
        }),
        listCandidates: onlyFor(businessId)
      } as never);

      const r = await rule(db, businessId);
      expect(r.paused_reason).toBe("authentication_required");
      expect(r.consecutive_failures).toBe(0);
      // The tenant asked for this; they should not have to re-opt in after a
      // bank challenge.
      expect(r.enabled).toBe(true);
      expect(r.month_spent_cents).toBe(0);
      expect((await events(db, businessId))[0]).toMatchObject({ status: "requires_action" });
    });
  });

  describe("the monthly budget ceiling", () => {
    it("refuses the charge and pauses once the limit would be exceeded", async () => {
      const businessId = await seedTenant(db, "Auto-reload sweep itest (budget)", {
        monthly_limit_cents: PACK_PRICE_CENTS
      });

      // First reload fits exactly inside the ceiling.
      await sweepUsagePackAutoReloads({
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => ({ ok: true as const, paymentIntentId: "pi_budget_1" }),
        listCandidates: onlyFor(businessId)
      } as never);
      expect((await rule(db, businessId)).month_spent_cents).toBe(PACK_PRICE_CENTS);

      // Drain the pack again and clear the cooldown so only the budget stops it.
      await db.from("sms_bonus_grants").update({ texts_remaining: 0 }).eq("business_id", businessId);
      await db
        .from("usage_pack_auto_reload_rules")
        .update({ last_attempt_at: null })
        .eq("business_id", businessId);

      let secondCharge = 0;
      await sweepUsagePackAutoReloads({
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => {
          secondCharge += 1;
          return { ok: true as const, paymentIntentId: "pi_budget_2" };
        },
        listCandidates: onlyFor(businessId)
      } as never);

      expect(secondCharge).toBe(0);
      expect((await rule(db, businessId)).paused_reason).toBe("monthly_limit_reached");
    });
  });

  describe("candidates the prefilter must exclude", () => {
    it("skips a tenant with no authorized card", async () => {
      const businessId = await seedTenant(db, "Auto-reload sweep itest (no card)");
      await db.from("usage_pack_auto_reload_cards").delete().eq("business_id", businessId);

      let charged = 0;
      await sweepUsagePackAutoReloads({
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => {
          charged += 1;
          return { ok: true as const, paymentIntentId: "pi_nope" };
        },
        listCandidates: onlyFor(businessId)
      } as never);
      expect(charged).toBe(0);
    });

    it("skips a tenant whose card was revoked", async () => {
      const businessId = await seedTenant(db, "Auto-reload sweep itest (revoked)");
      await db
        .from("usage_pack_auto_reload_cards")
        .update({ revoked_at: new Date().toISOString() })
        .eq("business_id", businessId);

      let charged = 0;
      await sweepUsagePackAutoReloads({
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => {
          charged += 1;
          return { ok: true as const, paymentIntentId: "pi_nope" };
        },
        listCandidates: onlyFor(businessId)
      } as never);
      expect(charged).toBe(0);
    });

    it("skips a tenant whose billing an operator paused (real SQL, the M2-class gate)", async () => {
      // A paused sub deliberately KEEPS status 'active' so dunning and
      // teardown never fire; the pause lever's promise is "not charged",
      // and this sweep charges the card off-session. The gate lives in the
      // candidates SQL, which a mocked builder cannot prove.
      const businessId = await seedTenant(db, "Auto-reload sweep itest (paused)");
      await db
        .from("subscriptions")
        .update({ billing_paused: true })
        .eq("business_id", businessId);

      let charged = 0;
      await sweepUsagePackAutoReloads({
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => {
          charged += 1;
          return { ok: true as const, paymentIntentId: "pi_paused" };
        },
        listCandidates: onlyFor(businessId)
      } as never);
      expect(charged).toBe(0);
    });

    it("skips a tenant whose subscription lapsed", async () => {
      const businessId = await seedTenant(db, "Auto-reload sweep itest (lapsed)");
      await db
        .from("subscriptions")
        .update({ status: "canceled" })
        .eq("business_id", businessId);

      let charged = 0;
      await sweepUsagePackAutoReloads({
        client: db as never,
        resolvePrice: priceOk as never,
        charge: async () => {
          charged += 1;
          return { ok: true as const, paymentIntentId: "pi_nope" };
        },
        listCandidates: onlyFor(businessId)
      } as never);
      expect(charged).toBe(0);
    });
  });

  describe("disable for a business", () => {
    it("never touches a family the tenant deliberately switched off", async () => {
      // The card-detached disable is REVERSED when a new card is authorized.
      // If it stamped its reason onto an off-by-choice family, that family
      // would come back on and start charging money the tenant never
      // authorized for it.
      const businessId = await seedTenant(db, "Auto-reload sweep itest (off by choice)");
      const { error } = await db.from("usage_pack_auto_reload_rules").insert({
        business_id: businessId,
        category: "voice",
        enabled: false,
        pack_id: "min_30",
        threshold_units: 900
      });
      if (error) throw new Error(`seed voice rule: ${error.message}`);

      const { data: count } = await db.rpc("usage_pack_auto_reload_disable_for_business", {
        p_business_id: businessId,
        p_reason: "card_detached"
      });
      // Only the enabled SMS rule was affected.
      expect(Number(count)).toBe(1);

      const { data: rows } = await db
        .from("usage_pack_auto_reload_rules")
        .select("category, enabled, disabled_reason")
        .eq("business_id", businessId);
      const byCategory = new Map(
        (rows as Array<{ category: string; enabled: boolean; disabled_reason: string | null }>).map(
          (r) => [r.category, r]
        )
      );
      expect(byCategory.get("sms")).toMatchObject({
        enabled: false,
        disabled_reason: "card_detached"
      });
      expect(byCategory.get("voice")).toMatchObject({
        enabled: false,
        disabled_reason: null
      });

      // Authorizing a new card brings back only the family that was on.
      const restored = await reenableAutoReloadAfterCardAuthorized(businessId, db as never);
      expect(restored).toBe(1);

      const { data: after } = await db
        .from("usage_pack_auto_reload_rules")
        .select("category, enabled")
        .eq("business_id", businessId);
      const enabledAfter = new Map(
        (after as Array<{ category: string; enabled: boolean }>).map((r) => [r.category, r.enabled])
      );
      expect(enabledAfter.get("sms")).toBe(true);
      expect(enabledAfter.get("voice")).toBe(false);
    });

    it("leaves a rule disabled for its own reason alone", async () => {
      const businessId = await seedTenant(db, "Auto-reload sweep itest (prior reason)");
      await db
        .from("usage_pack_auto_reload_rules")
        .update({ enabled: false, disabled_reason: "payment_failures" })
        .eq("business_id", businessId);

      await db.rpc("usage_pack_auto_reload_disable_for_business", {
        p_business_id: businessId,
        p_reason: "card_detached"
      });
      const r = await rule(db, businessId);
      // Not re-stamped, so a later card authorization cannot resurrect it.
      expect(r.disabled_reason).toBe("payment_failures");
      expect(await reenableAutoReloadAfterCardAuthorized(businessId, db as never)).toBe(0);
    });

    it("closes an in-flight attempt and refunds its reserved budget", async () => {
      // The claim debits month_spent_cents BEFORE charging. Disabling
      // mid-attempt without settling would leave a tenant's monthly allowance
      // consumed by a charge that never completed, plus a `pending` ledger
      // row nothing would ever close.
      const businessId = await seedTenant(db, "Auto-reload sweep itest (mid-flight)", {
        monthly_limit_cents: 5_000
      });
      const claim = await db.rpc("usage_pack_auto_reload_claim", {
        p_business_id: businessId,
        p_category: "sms",
        p_pack_id: "texts_500",
        p_amount_cents: PACK_PRICE_CENTS,
        p_balance_units: 0,
        p_threshold_units: 100,
        p_platform_max_cents: null,
        p_currency: "usd"
      });
      expect((claim.data as { ok: boolean }).ok).toBe(true);
      expect((await rule(db, businessId)).month_spent_cents).toBe(PACK_PRICE_CENTS);

      await db.rpc("usage_pack_auto_reload_disable_for_business", {
        p_business_id: businessId,
        p_reason: "subscription_canceled"
      });

      const r = await rule(db, businessId);
      expect(r.month_spent_cents).toBe(0);
      expect(r.month_charges).toBe(0);
      expect(r.enabled).toBe(false);

      const ledger = await events(db, businessId);
      expect(ledger).toHaveLength(1);
      // Closed, not left dangling.
      expect(ledger[0]).toMatchObject({
        status: "abandoned",
        failure_code: "subscription_canceled"
      });
      expect(ledger[0]!.settled_at).not.toBeNull();
    });

    it("stops every rule and revokes the card on a dispute", async () => {
      const businessId = await seedTenant(db, "Auto-reload sweep itest (dispute)");
      const { data } = await db.rpc("usage_pack_auto_reload_disable_for_business", {
        p_business_id: businessId,
        p_reason: "dispute"
      });
      expect(Number(data)).toBe(1);

      const r = await rule(db, businessId);
      expect(r.enabled).toBe(false);
      expect(r.disabled_reason).toBe("dispute");

      const { data: card } = await db
        .from("usage_pack_auto_reload_cards")
        .select("revoked_at")
        .eq("business_id", businessId)
        .single();
      // A chargeback on an unattended charge revokes the mandate too.
      expect((card as { revoked_at: string | null }).revoked_at).not.toBeNull();
    });
  });
});
