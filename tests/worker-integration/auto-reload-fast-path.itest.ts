import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { SUPABASE_URL, seedBusiness, serviceDb } from "./harness";

/**
 * The auto-reload fast path, against real Postgres.
 *
 * The 15 minute sweep was the weakest part of the design: one ten minute
 * voice call can take a tenant from comfortably above their threshold to
 * zero, and the top-up then lands up to fifteen minutes later, after calls
 * have already been refused.
 *
 * The fix is a stamp written by database TRIGGERS on the tables consumption
 * writes, plus a second job that runs every minute over only the stamped
 * rules. Triggers are the part that genuinely cannot be unit tested: whether
 * `try_reserve_sms_outbound_slot` and `voice_try_finalize_settlement` actually
 * cause a stamp is a property of the schema, not of any TypeScript we wrote.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.ITEST_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
process.env.STRIPE_SMS_BONUS_500_PRICE_ID = "price_s500";
process.env.STRIPE_SECRET_KEY = "sk_test_itest";

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({ prices: { retrieve: async () => ({}) } }),
  createOffSessionPackCharge: vi.fn()
}));

const { sweepUsagePackAutoReloads } = await import("@/lib/billing/auto-reload-sweep");
const { listFlaggedAutoReloadCandidates } = await import("@/lib/db/auto-reload");

const PACK_PRICE_CENTS = 1_000;
const PLAN_CAP_BLOWOUT_TEXTS = 50_000;

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
  const inserts: Array<[string, Record<string, unknown>]> = [
    [
      "subscriptions",
      {
        id: randomUUID(),
        business_id: businessId,
        tier: "standard",
        status: "active",
        stripe_customer_id: "cus_itest",
        stripe_subscription_id: "sub_itest",
        stripe_current_period_start: daysFromNow(-10)
      }
    ],
    [
      "usage_pack_auto_reload_cards",
      { business_id: businessId, stripe_payment_method_id: "pm_itest" }
    ],
    [
      "usage_pack_auto_reload_rules",
      {
        business_id: businessId,
        category: "sms",
        enabled: true,
        pack_id: "texts_500",
        threshold_units: 100,
        cooldown_minutes: 5,
        ...rule
      }
    ]
  ];
  for (const [table, row] of inserts) {
    const { error } = await db.from(table).insert(row);
    if (error) throw new Error(`seed ${table}: ${error.message}`);
  }
  return businessId;
}

async function needsCheckAt(
  db: SupabaseClient,
  businessId: string,
  category = "sms"
): Promise<string | null> {
  const { data, error } = await db
    .from("usage_pack_auto_reload_rules")
    .select("needs_check_at")
    .eq("business_id", businessId)
    .eq("category", category)
    .single();
  if (error) throw new Error(`needsCheckAt: ${error.message}`);
  return (data as { needs_check_at: string | null }).needs_check_at;
}

describe("auto-reload fast path against real Postgres", () => {
  const db = serviceDb();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("the triggers", () => {
    it("stamps the rule when a real outbound text is reserved", async () => {
      // Drives try_reserve_sms_outbound_slot, the function that actually runs
      // on every outbound text. Nothing in TypeScript stamps this: if the
      // trigger were missing, this test is the only thing that would notice.
      const businessId = await seedTenant(db, "Fast path itest (sms reserve)");
      expect(await needsCheckAt(db, businessId)).toBeNull();

      const { error } = await db.rpc("try_reserve_sms_outbound_slot", {
        p_business_id: businessId
      });
      if (error) throw new Error(`reserve: ${error.message}`);

      expect(await needsCheckAt(db, businessId)).not.toBeNull();
    });

    it("stamps when a purchased text is consumed past the plan cap", async () => {
      const businessId = await seedTenant(db, "Fast path itest (sms bonus)");
      {
        const { error } = await db.from("daily_usage").insert({
          business_id: businessId,
          usage_date: utcToday(),
          sms_sent: PLAN_CAP_BLOWOUT_TEXTS,
          sms_text_units: PLAN_CAP_BLOWOUT_TEXTS
        });
        if (error) throw new Error(`seed daily_usage: ${error.message}`);
      }
      const { error: grantErr } = await db.rpc("apply_sms_bonus_grant_from_checkout", {
        p_business_id: businessId,
        p_checkout_session_id: `cs_${randomUUID()}`,
        p_texts_purchased: 500,
        p_expires_at: daysFromNow(30)
      });
      if (grantErr) throw new Error(`grant: ${grantErr.message}`);

      // Clear whatever the seeding stamped so the assertion is about the send.
      await db
        .from("usage_pack_auto_reload_rules")
        .update({ needs_check_at: null })
        .eq("business_id", businessId);

      const { data } = await db.rpc("try_reserve_sms_outbound_slot", {
        p_business_id: businessId
      });
      expect(data).toMatchObject({ ok: true, source: "bonus" });
      expect(await needsCheckAt(db, businessId)).not.toBeNull();
    });

    it("stamps voice when a call settles against the included pool", async () => {
      // The case that motivated the whole change: one long call crossing the
      // threshold on its own.
      const businessId = await seedTenant(db, "Fast path itest (voice settle)", {
        category: "voice",
        pack_id: "min_30",
        threshold_units: 900
      });
      const periodStart = daysFromNow(-10);
      const { error } = await db.from("voice_billing_period_usage").insert({
        business_id: businessId,
        stripe_period_start: periodStart,
        tier_cap_seconds: 15_000,
        committed_included_seconds: 0
      });
      if (error) throw new Error(`seed voice usage: ${error.message}`);
      expect(await needsCheckAt(db, businessId, "voice")).toBeNull();

      const { error: bumpErr } = await db
        .from("voice_billing_period_usage")
        .update({ committed_included_seconds: 14_800 })
        .eq("business_id", businessId);
      if (bumpErr) throw new Error(`commit seconds: ${bumpErr.message}`);

      expect(await needsCheckAt(db, businessId, "voice")).not.toBeNull();
    });

    it("does not stamp a rule that is off or paused", async () => {
      // The stamped set has to stay small for the every-minute job to be
      // cheap, so rules that could not fire anyway never enter it.
      const off = await seedTenant(db, "Fast path itest (off)", { enabled: false });
      const paused = await seedTenant(db, "Fast path itest (paused)", {
        paused_at: new Date().toISOString(),
        paused_reason: "authentication_required"
      });

      for (const id of [off, paused]) {
        const { error } = await db.rpc("try_reserve_sms_outbound_slot", { p_business_id: id });
        if (error) throw new Error(`reserve: ${error.message}`);
      }

      expect(await needsCheckAt(db, off)).toBeNull();
      expect(await needsCheckAt(db, paused)).toBeNull();
    });

    it("a stamped tenant with paused billing STILL surfaces from the flagged claim (decision, 2026-08-28)", async () => {
      // Auto-reload is the tenant's own standing instruction to buy
      // consumables; the admin pause comps the plan fee, not packs. Both
      // candidate paths agree (the slow-path itest pins the same), so a
      // paused tenant's top-up fires instead of silently draining.
      const businessId = await seedTenant(db, "Fast path itest (billing paused)");
      const { error: reserveErr } = await db.rpc("try_reserve_sms_outbound_slot", {
        p_business_id: businessId
      });
      if (reserveErr) throw new Error(`reserve: ${reserveErr.message}`);
      expect(await needsCheckAt(db, businessId)).not.toBeNull();

      const { error: pauseErr } = await db
        .from("subscriptions")
        .update({ billing_paused: true })
        .eq("business_id", businessId);
      if (pauseErr) throw new Error(`pause: ${pauseErr.message}`);

      const claimed = await listFlaggedAutoReloadCandidates(200, db as never);
      expect(claimed.filter((c) => c.businessId === businessId)).toHaveLength(1);
    });

    it("keeps the first stamp, so the queue stays FIFO", async () => {
      const businessId = await seedTenant(db, "Fast path itest (fifo)");
      await db.rpc("try_reserve_sms_outbound_slot", { p_business_id: businessId });
      const first = await needsCheckAt(db, businessId);

      await new Promise((r) => setTimeout(r, 20));
      await db.rpc("try_reserve_sms_outbound_slot", { p_business_id: businessId });

      // A busy tenant must not keep pushing itself to the back of the queue.
      expect(await needsCheckAt(db, businessId)).toBe(first);
    });

    it("costs nothing for a tenant with no auto-reload rule", async () => {
      // The stamp is a primary-key update that matches zero rows for the
      // overwhelming majority of tenants. This proves it is harmless, not
      // that it is fast, but a throw here would break every outbound text.
      const bare = await seedBusiness(db, "Fast path itest (no rule)");
      const { error } = await db.rpc("try_reserve_sms_outbound_slot", { p_business_id: bare });
      expect(error).toBeNull();
    });
  });

  describe("the flagged candidate queue", () => {
    it("returns a stamped rule once and clears the stamp", async () => {
      const businessId = await seedTenant(db, "Fast path itest (queue)");
      await db.rpc("try_reserve_sms_outbound_slot", { p_business_id: businessId });

      const first = await listFlaggedAutoReloadCandidates(200, db as never);
      expect(first.some((c) => c.businessId === businessId)).toBe(true);
      expect(await needsCheckAt(db, businessId)).toBeNull();

      // Behaves like a queue: a second reader gets nothing, so two concurrent
      // fast ticks cannot both work the same rule.
      const second = await listFlaggedAutoReloadCandidates(200, db as never);
      expect(second.some((c) => c.businessId === businessId)).toBe(false);
    });

    it("still honours the cooldown, so the fast path is not a way around it", async () => {
      const businessId = await seedTenant(db, "Fast path itest (cooldown)", {
        cooldown_minutes: 60,
        last_attempt_at: new Date().toISOString()
      });
      await db.rpc("try_reserve_sms_outbound_slot", { p_business_id: businessId });

      const rows = await listFlaggedAutoReloadCandidates(200, db as never);
      expect(rows.some((c) => c.businessId === businessId)).toBe(false);
    });

    it("excludes a tenant whose card was revoked", async () => {
      const businessId = await seedTenant(db, "Fast path itest (revoked card)");
      await db
        .from("usage_pack_auto_reload_cards")
        .update({ revoked_at: new Date().toISOString() })
        .eq("business_id", businessId);
      await db.rpc("try_reserve_sms_outbound_slot", { p_business_id: businessId });

      const rows = await listFlaggedAutoReloadCandidates(200, db as never);
      expect(rows.some((c) => c.businessId === businessId)).toBe(false);
    });
  });

  describe("end to end", () => {
    it("tops the tenant up on the pass right after the text that drained them", async () => {
      // The whole point of the change, measured the way it matters: a send
      // happens, and the very next minute-pass charges. No fifteen minute wait.
      const businessId = await seedTenant(db, "Fast path itest (end to end)");
      {
        const { error } = await db.from("daily_usage").insert({
          business_id: businessId,
          usage_date: utcToday(),
          sms_sent: PLAN_CAP_BLOWOUT_TEXTS,
          sms_text_units: PLAN_CAP_BLOWOUT_TEXTS
        });
        if (error) throw new Error(`seed daily_usage: ${error.message}`);
      }
      await db.rpc("try_reserve_sms_outbound_slot", { p_business_id: businessId });

      let charged = 0;
      const res = await sweepUsagePackAutoReloads({
        client: db as never,
        mode: "flagged",
        resolvePrice: priceOk as never,
        charge: async () => {
          charged += 1;
          return { ok: true as const, paymentIntentId: `pi_fast_${randomUUID().slice(0, 8)}` };
        },
        listCandidates: async (limit: number, client: SupabaseClient) => {
          const all = await listFlaggedAutoReloadCandidates(limit, client as never);
          return all.filter((c) => c.businessId === businessId);
        }
      } as never);

      expect(charged).toBe(1);
      expect(res).toMatchObject({ charged: 1, granted: 1 });
    });

    it("does nothing when no rule is stamped", async () => {
      // The normal case for the every-minute job, and the reason it is
      // affordable to run sixty times an hour.
      const res = await sweepUsagePackAutoReloads({
        client: db as never,
        mode: "flagged",
        resolvePrice: priceOk as never,
        charge: async () => {
          throw new Error("must not charge");
        },
        listCandidates: async () => []
      } as never);
      expect(res).toMatchObject({ scanned: 0, charged: 0 });
    });
  });
});
