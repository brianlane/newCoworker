import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { seedBusiness, serviceDb } from "./harness";

/**
 * Hangup-before-answer must not leave a settlement the sweep cannot close.
 *
 * Production incident 2026-09-09 (Amy Laidlaw): Telnyx 90018 released the
 * reservation, the hangup webhook still wrote voice_settlements, and
 * voice_try_finalize_settlement returned reservation_released. The health
 * cron then paged a stuck settlement every hour.
 *
 * This suite drives the real RPCs against the local Supabase stack:
 *   1. Released + never-connected finalizes at 0, no usage debit.
 *   2. Released but connected still refuses (must not re-commit minutes
 *      that were already returned).
 */

process.env.NEXT_PUBLIC_SUPABASE_URL =
  process.env.ITEST_SUPABASE_URL ?? "http://127.0.0.1:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.ITEST_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const TIER_CAP_SECONDS = 15_000;

async function committedSeconds(db: SupabaseClient, businessId: string): Promise<number> {
  const { data, error } = await db
    .from("voice_billing_period_usage")
    .select("committed_included_seconds")
    .eq("business_id", businessId)
    .single();
  if (error) throw new Error(`committedSeconds: ${error.message}`);
  return (data as { committed_included_seconds: number }).committed_included_seconds;
}

describe("never-answered hangup settlements finalize at 0", () => {
  const db = serviceDb();
  let businessId = "";
  let periodStart = "";

  beforeAll(async () => {
    businessId = await seedBusiness(db, "Never-answered settlement itest");
    periodStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const { error } = await db.from("subscriptions").insert({
      id: randomUUID(),
      business_id: businessId,
      tier: "standard",
      status: "active",
      stripe_current_period_start: periodStart
    });
    if (error) throw new Error(`seed subscription: ${error.message}`);
  });

  it("closes a released never-connected settlement at 0 billable", async () => {
    const callControlId = `itest:never-answered:${randomUUID()}`;
    const { data: reserved, error: reserveErr } = await db.rpc("voice_reserve_for_call", {
      p_business_id: businessId,
      p_call_control_id: callControlId,
      p_tier: "standard",
      p_max_concurrent: 3,
      p_stripe_period_start: periodStart,
      p_tier_cap_seconds: TIER_CAP_SECONDS
    });
    if (reserveErr) throw new Error(`reserve: ${reserveErr.message}`);
    expect((reserved as { ok: boolean }).ok).toBe(true);

    const { error: relErr } = await db.rpc("voice_release_reservation_on_answer_fail", {
      p_call_control_id: callControlId
    });
    if (relErr) throw new Error(`release: ${relErr.message}`);

    const { data: resv } = await db
      .from("voice_reservations")
      .select("id, state, ws_connected_at, answer_issued_at")
      .eq("call_control_id", callControlId)
      .single();
    expect(resv).toMatchObject({
      state: "released",
      ws_connected_at: null,
      answer_issued_at: null
    });

    const endedAt = new Date().toISOString();
    const { error: settleErr } = await db.from("voice_settlements").upsert(
      {
        call_control_id: callControlId,
        business_id: businessId,
        reservation_id: (resv as { id: string }).id,
        telnyx_ended_at: endedAt,
        first_signal_at: endedAt,
        telnyx_reported_duration_seconds: 1
      },
      { onConflict: "call_control_id" }
    );
    if (settleErr) throw new Error(`seed settlement: ${settleErr.message}`);

    const before = await committedSeconds(db, businessId);
    const { data: settled, error: finErr } = await db.rpc("voice_try_finalize_settlement", {
      p_call_control_id: callControlId,
      p_allow_one_sided: false
    });
    if (finErr) throw new Error(`finalize: ${finErr.message}`);
    expect(settled).toMatchObject({
      ok: true,
      billable_seconds: 0,
      committed_included_seconds: 0,
      committed_bonus_seconds: 0,
      no_turns_zero_billed: true,
      never_answered: true
    });
    expect(await committedSeconds(db, businessId)).toBe(before);

    const { data: row } = await db
      .from("voice_settlements")
      .select("billable_seconds, finalized_at, no_turns_zero_billed")
      .eq("call_control_id", callControlId)
      .single();
    expect(row).toMatchObject({ billable_seconds: 0, no_turns_zero_billed: true });
    expect((row as { finalized_at: string | null }).finalized_at).not.toBeNull();
  });

  it("still refuses a released reservation that did connect", async () => {
    const callControlId = `itest:released-connected:${randomUUID()}`;
    const { error: reserveErr } = await db.rpc("voice_reserve_for_call", {
      p_business_id: businessId,
      p_call_control_id: callControlId,
      p_tier: "standard",
      p_max_concurrent: 3,
      p_stripe_period_start: periodStart,
      p_tier_cap_seconds: TIER_CAP_SECONDS
    });
    if (reserveErr) throw new Error(`reserve: ${reserveErr.message}`);

    const connectedAt = new Date().toISOString();
    const { error: actErr } = await db
      .from("voice_reservations")
      .update({
        state: "released",
        answer_issued_at: connectedAt,
        ws_connected_at: connectedAt
      })
      .eq("call_control_id", callControlId);
    if (actErr) throw new Error(`mark released+connected: ${actErr.message}`);

    const { error: settleErr } = await db.from("voice_settlements").upsert(
      {
        call_control_id: callControlId,
        business_id: businessId,
        telnyx_ended_at: connectedAt,
        bridge_media_ended_at: connectedAt,
        first_signal_at: connectedAt
      },
      { onConflict: "call_control_id" }
    );
    if (settleErr) throw new Error(`seed settlement: ${settleErr.message}`);

    const { data: settled, error: finErr } = await db.rpc("voice_try_finalize_settlement", {
      p_call_control_id: callControlId
    });
    if (finErr) throw new Error(`finalize: ${finErr.message}`);
    expect(settled).toMatchObject({ ok: false, reason: "reservation_released" });

    const { data: row } = await db
      .from("voice_settlements")
      .select("finalized_at")
      .eq("call_control_id", callControlId)
      .single();
    expect((row as { finalized_at: string | null }).finalized_at).toBeNull();
  });
});
