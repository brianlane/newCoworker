import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { seedBusiness, serviceDb } from "./harness";

/**
 * Usage-pack grants against the REAL stack: every migration, the real
 * `apply_*_grant_from_checkout` RPCs, the real balance readers, and the real
 * consume path.
 *
 * Why this exists: nothing in the repo executed a single line of the grant
 * PL/pgSQL before this file. `tests/stripe-webhook-route.test.ts` mocks the
 * Supabase client so `rpc()` is a `vi.fn()` that answers `{ok: true}`, which
 * proves the route passes the right arguments and nothing about what the
 * database then does with them. Idempotency lives in a UNIQUE constraint, the
 * entitlement check lives in a subquery, and the spillover lives in an
 * `order by expires_at ... for update`; none of those can be asserted against
 * a mock.
 *
 * Scope note: the expiry VALUE (max(period end, purchased + 30d)) is computed
 * app-side in the Stripe webhook, so it is asserted in
 * stripe-webhook-grants.itest.ts. What this file pins is that the RPC stores
 * the timestamp it is handed and that every balance reader honours it.
 */

const ACTIVE_SUB = "sub_itest_active";

/** Any value above the largest non-enterprise monthly SMS cap. */
const PLAN_CAP_BLOWOUT_TEXTS = 50_000;

type GrantResult = { ok: boolean; reason?: string; grant_id?: string; duplicate?: boolean };

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function seedActiveSubscription(
  db: SupabaseClient,
  businessId: string,
  over: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await db.from("subscriptions").insert({
    id: randomUUID(),
    business_id: businessId,
    tier: "standard",
    status: "active",
    stripe_subscription_id: ACTIVE_SUB,
    stripe_current_period_start: daysFromNow(-10),
    ...over
  });
  if (error) throw new Error(`seedActiveSubscription: ${error.message}`);
}

async function grantVoice(
  db: SupabaseClient,
  businessId: string,
  sessionId: string,
  seconds: number,
  expiresAt = daysFromNow(30)
): Promise<GrantResult> {
  const { data, error } = await db.rpc("apply_voice_bonus_grant_from_checkout", {
    p_business_id: businessId,
    p_checkout_session_id: sessionId,
    p_seconds_purchased: seconds,
    p_expires_at: expiresAt
  });
  if (error) throw new Error(`grantVoice: ${error.message}`);
  return data as GrantResult;
}

async function grantSms(
  db: SupabaseClient,
  businessId: string,
  sessionId: string,
  texts: number,
  expiresAt = daysFromNow(30)
): Promise<GrantResult> {
  const { data, error } = await db.rpc("apply_sms_bonus_grant_from_checkout", {
    p_business_id: businessId,
    p_checkout_session_id: sessionId,
    p_texts_purchased: texts,
    p_expires_at: expiresAt
  });
  if (error) throw new Error(`grantSms: ${error.message}`);
  return data as GrantResult;
}

async function grantChat(
  db: SupabaseClient,
  businessId: string,
  sessionId: string,
  micros: number,
  expiresAt = daysFromNow(30)
): Promise<GrantResult> {
  const { data, error } = await db.rpc("apply_chat_credit_grant_from_checkout", {
    p_business_id: businessId,
    p_checkout_session_id: sessionId,
    p_credit_micros: micros,
    p_expires_at: expiresAt
  });
  if (error) throw new Error(`grantChat: ${error.message}`);
  return data as GrantResult;
}

async function voiceBonusAvailable(db: SupabaseClient, businessId: string): Promise<number> {
  const { data, error } = await db
    .from("voice_bonus_grants")
    .select("seconds_remaining, expires_at, voided_at")
    .eq("business_id", businessId);
  if (error) throw new Error(`voiceBonusAvailable: ${error.message}`);
  const now = Date.now();
  return (data as Array<{ seconds_remaining: number; expires_at: string; voided_at: string | null }>)
    .filter((g) => g.voided_at === null && Date.parse(g.expires_at) > now)
    .reduce((sum, g) => sum + g.seconds_remaining, 0);
}

async function smsBonusRemaining(db: SupabaseClient, businessId: string): Promise<number> {
  const { data, error } = await db.rpc("sms_bonus_texts_remaining", { p_business_id: businessId });
  if (error) throw new Error(`smsBonusRemaining: ${error.message}`);
  return Number(data);
}

async function chatCreditMicros(db: SupabaseClient, businessId: string): Promise<number> {
  const { data, error } = await db.rpc("chat_active_credit_micros", { p_business_id: businessId });
  if (error) throw new Error(`chatCreditMicros: ${error.message}`);
  return Number(data);
}

async function countGrants(
  db: SupabaseClient,
  table: string,
  businessId: string
): Promise<number> {
  const { count, error } = await db
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("business_id", businessId);
  if (error) throw new Error(`countGrants(${table}): ${error.message}`);
  return count ?? 0;
}

describe("usage-pack grant RPCs against real Postgres", () => {
  const db = serviceDb();
  let businessId = "";

  beforeAll(async () => {
    businessId = await seedBusiness(db, "Usage pack grants itest");
    await seedActiveSubscription(db, businessId);
  });

  describe("a grant lands and every balance reader sees it", () => {
    it("credits voice seconds", async () => {
      const res = await grantVoice(db, businessId, `cs_${randomUUID()}`, 1_800);
      expect(res.ok).toBe(true);
      expect(res.duplicate).toBe(false);
      expect(await voiceBonusAvailable(db, businessId)).toBe(1_800);
    });

    it("credits SMS texts through sms_bonus_texts_remaining", async () => {
      const before = await smsBonusRemaining(db, businessId);
      const res = await grantSms(db, businessId, `cs_${randomUUID()}`, 500);
      expect(res.ok).toBe(true);
      expect(await smsBonusRemaining(db, businessId)).toBe(before + 500);
    });

    it("credits chat credit through chat_active_credit_micros", async () => {
      const before = await chatCreditMicros(db, businessId);
      const res = await grantChat(db, businessId, `cs_${randomUUID()}`, 5_000_000);
      expect(res.ok).toBe(true);
      expect(await chatCreditMicros(db, businessId)).toBe(before + 5_000_000);
    });
  });

  describe("idempotency is the UNIQUE constraint, not a hope", () => {
    it("replays a voice session id without granting twice", async () => {
      const sessionId = `cs_${randomUUID()}`;
      const before = await voiceBonusAvailable(db, businessId);
      const rowsBefore = await countGrants(db, "voice_bonus_grants", businessId);

      const first = await grantVoice(db, businessId, sessionId, 600);
      const second = await grantVoice(db, businessId, sessionId, 600);

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      // Same grant row comes back, so a replay is observably a no-op.
      expect(second.grant_id).toBe(first.grant_id);
      expect(await voiceBonusAvailable(db, businessId)).toBe(before + 600);
      expect(await countGrants(db, "voice_bonus_grants", businessId)).toBe(rowsBefore + 1);
    });

    it("replays an SMS session id without granting twice", async () => {
      const sessionId = `cs_${randomUUID()}`;
      const before = await smsBonusRemaining(db, businessId);
      await grantSms(db, businessId, sessionId, 500);
      const second = await grantSms(db, businessId, sessionId, 500);
      expect(second.duplicate).toBe(true);
      expect(await smsBonusRemaining(db, businessId)).toBe(before + 500);
    });

    it("replays a chat session id without granting twice", async () => {
      const sessionId = `cs_${randomUUID()}`;
      const before = await chatCreditMicros(db, businessId);
      await grantChat(db, businessId, sessionId, 10_000_000);
      const second = await grantChat(db, businessId, sessionId, 10_000_000);
      expect(second.duplicate).toBe(true);
      expect(await chatCreditMicros(db, businessId)).toBe(before + 10_000_000);
    });

    it("ignores a replay that changes the amount", async () => {
      // A retried webhook with a mutated payload must not top up the grant.
      const sessionId = `cs_${randomUUID()}`;
      const before = await smsBonusRemaining(db, businessId);
      await grantSms(db, businessId, sessionId, 500);
      const inflated = await grantSms(db, businessId, sessionId, 10_000);
      expect(inflated.duplicate).toBe(true);
      expect(await smsBonusRemaining(db, businessId)).toBe(before + 500);
    });

    it("trims the session id, so whitespace cannot mint a second grant", async () => {
      const sessionId = `cs_${randomUUID()}`;
      const before = await chatCreditMicros(db, businessId);
      await grantChat(db, businessId, sessionId, 5_000_000);
      const padded = await grantChat(db, businessId, `  ${sessionId}  `, 5_000_000);
      expect(padded.duplicate).toBe(true);
      expect(await chatCreditMicros(db, businessId)).toBe(before + 5_000_000);
    });
  });

  describe("input guards", () => {
    it("refuses a blank session id", async () => {
      expect((await grantVoice(db, businessId, "   ", 600)).reason).toBe("missing_session_id");
      expect((await grantSms(db, businessId, "", 500)).reason).toBe("missing_session_id");
      expect((await grantChat(db, businessId, "", 5_000_000)).reason).toBe("missing_session_id");
    });

    it("refuses a non-positive amount", async () => {
      expect((await grantVoice(db, businessId, `cs_${randomUUID()}`, 0)).reason).toBe(
        "invalid_seconds"
      );
      expect((await grantSms(db, businessId, `cs_${randomUUID()}`, -5)).reason).toBe(
        "invalid_texts"
      );
      expect((await grantChat(db, businessId, `cs_${randomUUID()}`, 0)).reason).toBe(
        "invalid_credit"
      );
    });
  });

  describe("entitlement is re-checked in the database, not only in the route", () => {
    it("refuses every family when the subscription is not active", async () => {
      const lapsed = await seedBusiness(db, "Usage pack grants itest (lapsed)");
      await seedActiveSubscription(db, lapsed, { status: "canceled" });

      expect((await grantVoice(db, lapsed, `cs_${randomUUID()}`, 600)).reason).toBe(
        "no_active_subscription"
      );
      expect((await grantSms(db, lapsed, `cs_${randomUUID()}`, 500)).reason).toBe(
        "no_active_subscription"
      );
      expect((await grantChat(db, lapsed, `cs_${randomUUID()}`, 5_000_000)).reason).toBe(
        "no_active_subscription"
      );
      expect(await countGrants(db, "sms_bonus_grants", lapsed)).toBe(0);
    });

    it("refuses when the subscription is active but has no Stripe id", async () => {
      // A row stuck mid-signup: locally active, never linked to Stripe.
      const unlinked = await seedBusiness(db, "Usage pack grants itest (unlinked)");
      await seedActiveSubscription(db, unlinked, { stripe_subscription_id: null });
      expect((await grantSms(db, unlinked, `cs_${randomUUID()}`, 500)).reason).toBe(
        "no_active_subscription"
      );
    });
  });

  describe("expiry is honoured by the balance readers", () => {
    it("excludes an already-expired grant from every balance", async () => {
      const expired = await seedBusiness(db, "Usage pack grants itest (expired)");
      await seedActiveSubscription(db, expired);

      await grantVoice(db, expired, `cs_${randomUUID()}`, 1_200, daysFromNow(-1));
      await grantSms(db, expired, `cs_${randomUUID()}`, 500, daysFromNow(-1));
      await grantChat(db, expired, `cs_${randomUUID()}`, 5_000_000, daysFromNow(-1));

      // The rows exist; they simply do not count.
      expect(await countGrants(db, "sms_bonus_grants", expired)).toBe(1);
      expect(await voiceBonusAvailable(db, expired)).toBe(0);
      expect(await smsBonusRemaining(db, expired)).toBe(0);
      expect(await chatCreditMicros(db, expired)).toBe(0);
    });
  });

  describe("clawback", () => {
    it("fully voids each family and drops it out of the balance", async () => {
      const clawed = await seedBusiness(db, "Usage pack grants itest (clawback)");
      await seedActiveSubscription(db, clawed);

      const voiceSession = `cs_${randomUUID()}`;
      const smsSession = `cs_${randomUUID()}`;
      const chatSession = `cs_${randomUUID()}`;
      await grantVoice(db, clawed, voiceSession, 1_800);
      await grantSms(db, clawed, smsSession, 500);
      await grantChat(db, clawed, chatSession, 5_000_000);

      await db.rpc("void_voice_bonus_grant_by_checkout_session", {
        p_checkout_session_id: voiceSession,
        p_reason: "refund"
      });
      await db.rpc("void_sms_bonus_grant_by_checkout_session", {
        p_checkout_session_id: smsSession,
        p_reason: "refund"
      });
      await db.rpc("void_chat_credit_grant_by_checkout_session", {
        p_checkout_session_id: chatSession,
        p_reason: "refund"
      });

      expect(await voiceBonusAvailable(db, clawed)).toBe(0);
      expect(await smsBonusRemaining(db, clawed)).toBe(0);
      expect(await chatCreditMicros(db, clawed)).toBe(0);
    });

    it("reduces proportionally on a partial refund", async () => {
      const partial = await seedBusiness(db, "Usage pack grants itest (partial)");
      await seedActiveSubscription(db, partial);
      const smsSession = `cs_${randomUUID()}`;
      await grantSms(db, partial, smsSession, 500);

      await db.rpc("void_sms_bonus_grant_by_checkout_session", {
        p_checkout_session_id: smsSession,
        p_reason: "refund",
        p_clawback_texts: 200
      });

      expect(await smsBonusRemaining(db, partial)).toBe(300);
    });
  });

  describe("SMS bonus is really consumed once the plan cap is gone", () => {
    let spillover = "";

    beforeAll(async () => {
      spillover = await seedBusiness(db, "Usage pack grants itest (sms spillover)");
      await seedActiveSubscription(db, spillover);
      // Blow past any non-enterprise monthly cap so the very next reserve has
      // to spill into the purchased balance.
      const { error } = await db.from("daily_usage").insert({
        business_id: spillover,
        usage_date: utcToday(),
        sms_sent: PLAN_CAP_BLOWOUT_TEXTS
      });
      if (error) throw new Error(`seed daily_usage: ${error.message}`);
    });

    it("refuses the send when the cap is gone and no pack is held", async () => {
      const { data, error } = await db.rpc("try_reserve_sms_outbound_slot", {
        p_business_id: spillover
      });
      if (error) throw new Error(`reserve: ${error.message}`);
      expect(data).toMatchObject({ ok: false, reason: "monthly_sms_limit" });
    });

    it("spills into the pack and decrements it", async () => {
      await grantSms(db, spillover, `cs_${randomUUID()}`, 500);
      expect(await smsBonusRemaining(db, spillover)).toBe(500);

      const { data, error } = await db.rpc("try_reserve_sms_outbound_slot", {
        p_business_id: spillover
      });
      if (error) throw new Error(`reserve: ${error.message}`);
      expect(data).toMatchObject({ ok: true, source: "bonus" });
      expect(await smsBonusRemaining(db, spillover)).toBe(499);
    });

    it("refunds the text when the send fails", async () => {
      const { error } = await db.rpc("release_sms_outbound_slot", {
        p_business_id: spillover,
        p_refund_bonus: true
      });
      if (error) throw new Error(`release: ${error.message}`);
      expect(await smsBonusRemaining(db, spillover)).toBe(500);
    });

    it("never refunds past the purchased amount", async () => {
      // Double-release on an already-full grant must not mint a text.
      const { error } = await db.rpc("release_sms_outbound_slot", {
        p_business_id: spillover,
        p_refund_bonus: true
      });
      if (error) throw new Error(`release: ${error.message}`);
      expect(await smsBonusRemaining(db, spillover)).toBe(500);
    });

    it("drains the earliest-expiring pack first", async () => {
      const fifo = await seedBusiness(db, "Usage pack grants itest (sms fifo)");
      await seedActiveSubscription(db, fifo);
      const { error } = await db.from("daily_usage").insert({
        business_id: fifo,
        usage_date: utcToday(),
        sms_sent: PLAN_CAP_BLOWOUT_TEXTS
      });
      if (error) throw new Error(`seed daily_usage: ${error.message}`);

      const soonSession = `cs_${randomUUID()}`;
      const laterSession = `cs_${randomUUID()}`;
      await grantSms(db, fifo, laterSession, 10, daysFromNow(60));
      await grantSms(db, fifo, soonSession, 10, daysFromNow(5));

      const { error: reserveErr } = await db.rpc("try_reserve_sms_outbound_slot", {
        p_business_id: fifo
      });
      if (reserveErr) throw new Error(`reserve: ${reserveErr.message}`);

      const { data: rows } = await db
        .from("sms_bonus_grants")
        .select("stripe_checkout_session_id, texts_remaining")
        .eq("business_id", fifo);
      const bySession = new Map(
        (rows as Array<{ stripe_checkout_session_id: string; texts_remaining: number }>).map((r) => [
          r.stripe_checkout_session_id,
          r.texts_remaining
        ])
      );
      expect(bySession.get(soonSession)).toBe(9);
      expect(bySession.get(laterSession)).toBe(10);
    });
  });

  describe("voice bonus is really consumed after the included pool", () => {
    it("reserves from the pack and debits it at settlement", async () => {
      const voiceBiz = await seedBusiness(db, "Usage pack grants itest (voice consume)");
      const periodStart = daysFromNow(-10);
      await seedActiveSubscription(db, voiceBiz, { stripe_current_period_start: periodStart });
      await grantVoice(db, voiceBiz, `cs_${randomUUID()}`, 600);

      const callControlId = `itest:cc:${randomUUID()}`;
      // tier_cap_seconds 0 means the included pool is already gone, so the
      // whole grant has to come out of the purchased pack.
      const { data: reserved, error: reserveErr } = await db.rpc("voice_reserve_for_call", {
        p_business_id: voiceBiz,
        p_call_control_id: callControlId,
        p_tier: "standard",
        p_max_concurrent: 3,
        p_stripe_period_start: periodStart,
        p_tier_cap_seconds: 0
      });
      if (reserveErr) throw new Error(`reserve: ${reserveErr.message}`);
      expect(reserved).toMatchObject({ ok: true });

      const { data: reservation } = await db
        .from("voice_reservations")
        .select("reserved_included_seconds, reserved_bonus_seconds")
        .eq("call_control_id", callControlId)
        .single();
      const held = reservation as {
        reserved_included_seconds: number;
        reserved_bonus_seconds: number;
      };
      expect(held.reserved_included_seconds).toBe(0);
      expect(held.reserved_bonus_seconds).toBeGreaterThan(0);

      // A 2 minute call: per-minute rounding settles it at 120 seconds.
      const startedAt = new Date(Date.now() - 60 * 60 * 1000);
      const endedAt = new Date(startedAt.getTime() + 120 * 1000);
      {
        const { error } = await db
          .from("voice_reservations")
          .update({
            state: "active",
            answer_issued_at: startedAt.toISOString(),
            ws_connected_at: startedAt.toISOString()
          })
          .eq("call_control_id", callControlId);
        if (error) throw new Error(`activate reservation: ${error.message}`);
      }

      const { data: transcript, error: transcriptErr } = await db
        .from("voice_call_transcripts")
        .insert({
          business_id: voiceBiz,
          call_control_id: callControlId,
          caller_e164: "+14165550188",
          model: "gemini-3.1-flash-live-preview",
          status: "completed",
          direction: "inbound",
          started_at: startedAt.toISOString(),
          ended_at: endedAt.toISOString()
        })
        .select("id")
        .single();
      if (transcriptErr) throw new Error(`seed transcript: ${transcriptErr.message}`);

      // Zero-turn calls are always billed at 0, so the pack would never be
      // touched without a real turn on the transcript.
      const { error: turnsErr } = await db.from("voice_call_transcript_turns").insert([
        {
          transcript_id: (transcript as { id: string }).id,
          role: "caller",
          content: "Are you open?",
          turn_index: 0
        },
        {
          transcript_id: (transcript as { id: string }).id,
          role: "assistant",
          content: "Yes, until five.",
          turn_index: 1
        }
      ]);
      if (turnsErr) throw new Error(`seed turns: ${turnsErr.message}`);

      {
        const { error } = await db.from("voice_settlements").upsert(
          {
            call_control_id: callControlId,
            business_id: voiceBiz,
            telnyx_ended_at: endedAt.toISOString(),
            bridge_media_ended_at: endedAt.toISOString(),
            first_signal_at: endedAt.toISOString()
          },
          { onConflict: "call_control_id" }
        );
        if (error) throw new Error(`seed settlement: ${error.message}`);
      }

      const { data: settled, error: settleErr } = await db.rpc("voice_try_finalize_settlement", {
        p_call_control_id: callControlId
      });
      if (settleErr) throw new Error(`finalize: ${settleErr.message}`);
      expect(settled).toMatchObject({ ok: true, billable_seconds: 120 });
      expect((settled as { committed_bonus_seconds: number }).committed_bonus_seconds).toBe(120);

      // The pack actually paid for the call, and the included ledger did not.
      expect(await voiceBonusAvailable(db, voiceBiz)).toBe(480);
      const { data: usage } = await db
        .from("voice_billing_period_usage")
        .select("committed_included_seconds")
        .eq("business_id", voiceBiz)
        .single();
      expect((usage as { committed_included_seconds: number }).committed_included_seconds).toBe(0);
    });
  });
});

/**
 * The low-balance alert must count purchased packs.
 *
 * Before 20260822061519 the headroom formula read only the included pool, so
 * a tenant holding purchased minutes still got "running low" emails advising
 * them to buy the pack they already owned. With auto-reload live that becomes
 * self-contradictory: we would charge them, top them up, and email "running
 * low" about the same balance.
 */
describe("voice low-balance alerts count purchased bonus seconds", () => {
  const db = serviceDb();

  async function seedExhaustedVoiceTenant(label: string): Promise<string> {
    const businessId = await seedBusiness(db, label);
    await seedActiveSubscription(db, businessId);
    const periodStart = daysFromNow(-10);
    // Included pool fully spent: headroom is 0 without a pack.
    const { error } = await db.from("voice_billing_period_usage").insert({
      business_id: businessId,
      stripe_period_start: periodStart,
      tier_cap_seconds: 15_000,
      committed_included_seconds: 15_000,
      low_balance_alert_armed: true
    });
    if (error) throw new Error(`seed voice usage: ${error.message}`);
    return businessId;
  }

  async function claimedTargets(businessId: string): Promise<unknown[]> {
    const { data, error } = await db.rpc("voice_claim_low_balance_alert_targets", {
      p_threshold_seconds: 300
    });
    if (error) throw new Error(`claim targets: ${error.message}`);
    return (data as Array<{ business_id: string }>).filter((r) => r.business_id === businessId);
  }

  it("still alerts a tenant with no pack", async () => {
    const businessId = await seedExhaustedVoiceTenant("Voice low balance itest (no pack)");
    expect(await claimedTargets(businessId)).toHaveLength(1);
  });

  it("does NOT alert a tenant holding purchased minutes", async () => {
    const businessId = await seedExhaustedVoiceTenant("Voice low balance itest (has pack)");
    await grantVoice(db, businessId, `cs_${randomUUID()}`, 1_800);
    expect(await claimedTargets(businessId)).toHaveLength(0);
  });

  it("alerts again once the pack is nearly gone", async () => {
    const businessId = await seedExhaustedVoiceTenant("Voice low balance itest (pack spent)");
    const session = `cs_${randomUUID()}`;
    await grantVoice(db, businessId, session, 1_800);
    expect(await claimedTargets(businessId)).toHaveLength(0);

    // Burn the pack down under the 300 second threshold.
    await db
      .from("voice_bonus_grants")
      .update({ seconds_remaining: 120 })
      .eq("stripe_checkout_session_id", session);
    expect(await claimedTargets(businessId)).toHaveLength(1);
  });

  it("ignores an expired pack, which cannot pay for a call", async () => {
    const businessId = await seedExhaustedVoiceTenant("Voice low balance itest (expired pack)");
    await grantVoice(db, businessId, `cs_${randomUUID()}`, 1_800, daysFromNow(-1));
    expect(await claimedTargets(businessId)).toHaveLength(1);
  });

  it("re-arms a business only when its total headroom is back above the threshold", async () => {
    const businessId = await seedExhaustedVoiceTenant("Voice low balance itest (re-arm)");
    // Alerted once, so the flag is now disarmed.
    expect(await claimedTargets(businessId)).toHaveLength(1);

    const { data: noPack } = await db.rpc("voice_sync_low_balance_alert_armed_for_business", {
      p_business_id: businessId,
      p_threshold_seconds: 300
    });
    expect(Number(noPack)).toBe(0);

    await grantVoice(db, businessId, `cs_${randomUUID()}`, 1_800);
    const { data: withPack } = await db.rpc("voice_sync_low_balance_alert_armed_for_business", {
      p_business_id: businessId,
      p_threshold_seconds: 300
    });
    expect(Number(withPack)).toBe(1);
  });
});
