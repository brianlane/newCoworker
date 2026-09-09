import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { seedBusiness, serviceDb } from "./harness";

/**
 * Weighted voice-allowance units against the REAL stack.
 *
 * Zone 1 LRN and missing LRN stay 1x. Payson Zone 5 LRN is 14x on the
 * already-ceiled Telnyx minute (33s → 60 unweighted → 840 weighted). The
 * 5-minute reconciler must not undo that extra.
 */

const TIER_CAP_SECONDS = 15_000;
const RAW_SECONDS = 33;
const UNWEIGHTED = 60;
const ZONE5_WEIGHT = 14;
const ZONE5_WEIGHTED = 840;

async function seedVoiceCall(
  db: SupabaseClient,
  opts: { label: string; zoneWeight?: number; terminatingLrn?: string | null }
): Promise<{ businessId: string; callControlId: string; periodStart: string }> {
  const businessId = await seedBusiness(db, opts.label);
  const periodStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  {
    const { error } = await db.from("subscriptions").insert({
      id: randomUUID(),
      business_id: businessId,
      tier: "standard",
      status: "active",
      stripe_current_period_start: periodStart
    });
    if (error) throw new Error(`seed subscription: ${error.message}`);
  }

  const callControlId = `itest:cc:${randomUUID()}`;
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

  const startedAt = new Date(Date.now() - 60 * 60 * 1000);
  const endedAt = new Date(startedAt.getTime() + RAW_SECONDS * 1000);
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
      business_id: businessId,
      call_control_id: callControlId,
      caller_e164: "+19289512316",
      model: "[REDACTED]",
      status: "completed",
      direction: "outbound",
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString()
    })
    .select("id")
    .single();
  if (transcriptErr) throw new Error(`seed transcript: ${transcriptErr.message}`);

  const { error: turnsErr } = await db.from("voice_call_transcript_turns").insert([
    {
      transcript_id: (transcript as { id: string }).id,
      role: "caller",
      content: "Hello",
      turn_index: 0
    },
    {
      transcript_id: (transcript as { id: string }).id,
      role: "assistant",
      content: "Hi, how can I help?",
      turn_index: 1
    }
  ]);
  if (turnsErr) throw new Error(`seed turns: ${turnsErr.message}`);

  const settlement: Record<string, unknown> = {
    call_control_id: callControlId,
    business_id: businessId,
    telnyx_ended_at: endedAt.toISOString(),
    bridge_media_ended_at: endedAt.toISOString(),
    first_signal_at: endedAt.toISOString(),
    telnyx_reported_duration_seconds: RAW_SECONDS
  };
  if (opts.terminatingLrn) settlement.terminating_lrn = opts.terminatingLrn;
  if (opts.zoneWeight != null) settlement.zone_weight = opts.zoneWeight;

  const { error: settleWriteErr } = await db
    .from("voice_settlements")
    .upsert(settlement, { onConflict: "call_control_id" });
  if (settleWriteErr) throw new Error(`seed settlement: ${settleWriteErr.message}`);

  return { businessId, callControlId, periodStart };
}

async function committedSeconds(db: SupabaseClient, businessId: string): Promise<number> {
  const { data, error } = await db
    .from("voice_billing_period_usage")
    .select("committed_included_seconds")
    .eq("business_id", businessId)
    .single();
  if (error) throw new Error(`committedSeconds: ${error.message}`);
  return (data as { committed_included_seconds: number }).committed_included_seconds;
}

describe("weighted voice allowance units (local stack)", () => {
  const db = serviceDb();

  it("bills 1x when LRN is missing", async () => {
    const { businessId, callControlId } = await seedVoiceCall(db, {
      label: "Voice weight itest (missing LRN)"
    });
    const { data, error } = await db.rpc("voice_try_finalize_settlement", {
      p_call_control_id: callControlId
    });
    if (error) throw new Error(`finalize: ${error.message}`);
    expect(data).toMatchObject({
      ok: true,
      billable_seconds: UNWEIGHTED,
      weighted_billable_seconds: UNWEIGHTED,
      committed_included_seconds: UNWEIGHTED
    });
    expect(await committedSeconds(db, businessId)).toBe(UNWEIGHTED);
  });

  it("bills 1x for a Zone 1 LRN", async () => {
    const { businessId, callControlId } = await seedVoiceCall(db, {
      label: "Voice weight itest (Zone 1 LRN)",
      terminatingLrn: "6028384497",
      zoneWeight: 1
    });
    const { data, error } = await db.rpc("voice_try_finalize_settlement", {
      p_call_control_id: callControlId
    });
    if (error) throw new Error(`finalize: ${error.message}`);
    expect(data).toMatchObject({
      ok: true,
      billable_seconds: UNWEIGHTED,
      weighted_billable_seconds: UNWEIGHTED
    });
    expect(await committedSeconds(db, businessId)).toBe(UNWEIGHTED);
  });

  it("bills 14x for Payson Zone 5 without a second ceil, and reconcile keeps it", async () => {
    const { businessId, callControlId, periodStart } = await seedVoiceCall(db, {
      label: "Voice weight itest (Zone 5 Payson)",
      terminatingLrn: "9283630020",
      zoneWeight: ZONE5_WEIGHT
    });
    const { data, error } = await db.rpc("voice_try_finalize_settlement", {
      p_call_control_id: callControlId
    });
    if (error) throw new Error(`finalize: ${error.message}`);
    expect(data).toMatchObject({
      ok: true,
      billable_seconds: UNWEIGHTED,
      weighted_billable_seconds: ZONE5_WEIGHTED,
      committed_included_seconds: ZONE5_WEIGHTED,
      zone_weight: ZONE5_WEIGHT
    });
    // 33s ceiled once to 60, then * 14. ceil(33*14)=462 would be the bug.
    expect((data as { billable_seconds: number }).billable_seconds).not.toBe(462);
    expect(await committedSeconds(db, businessId)).toBe(ZONE5_WEIGHTED);

    const { data: repaired, error: reconErr } = await db.rpc(
      "voice_reconcile_period_usage_row",
      { p_business_id: businessId, p_stripe_period_start: periodStart }
    );
    if (reconErr) throw new Error(`reconcile: ${reconErr.message}`);
    expect(repaired).toBe(0);
    expect(await committedSeconds(db, businessId)).toBe(ZONE5_WEIGHTED);
  });

  it("backfills LRN after a 1x finalize and adds the extra included seconds", async () => {
    const { businessId, callControlId } = await seedVoiceCall(db, {
      label: "Voice weight itest (MDR backfill)"
    });
    const { error: finErr } = await db.rpc("voice_try_finalize_settlement", {
      p_call_control_id: callControlId
    });
    if (finErr) throw new Error(`finalize: ${finErr.message}`);
    expect(await committedSeconds(db, businessId)).toBe(UNWEIGHTED);

    const { data, error } = await db.rpc("voice_apply_settlement_lrn", {
      p_call_control_id: callControlId,
      p_terminating_lrn: "9283630020",
      p_zone_weight: ZONE5_WEIGHT
    });
    if (error) throw new Error(`apply lrn: ${error.message}`);
    expect(data).toMatchObject({
      ok: true,
      delta_included_seconds: ZONE5_WEIGHTED - UNWEIGHTED,
      weighted_billable_seconds: ZONE5_WEIGHTED
    });
    expect(await committedSeconds(db, businessId)).toBe(ZONE5_WEIGHTED);

    const { data: again, error: againErr } = await db.rpc("voice_apply_settlement_lrn", {
      p_call_control_id: callControlId,
      p_terminating_lrn: "9283630020",
      p_zone_weight: ZONE5_WEIGHT
    });
    if (againErr) throw new Error(`apply lrn again: ${againErr.message}`);
    expect(again).toMatchObject({ ok: true, unchanged: true });
    expect(await committedSeconds(db, businessId)).toBe(ZONE5_WEIGHTED);
  });

  it("stamps pending settlements and refuses a missing row", async () => {
    const businessId = await seedBusiness(db, "Voice weight itest (pending apply)");
    const callControlId = `itest:cc:${randomUUID()}`;
    const { error: writeErr } = await db.from("voice_settlements").insert({
      call_control_id: callControlId,
      business_id: businessId,
      first_signal_at: new Date().toISOString(),
      zone_weight: 1
    });
    if (writeErr) throw new Error(`seed pending settlement: ${writeErr.message}`);

    const { data: pending, error: pendingErr } = await db.rpc("voice_apply_settlement_lrn", {
      p_call_control_id: callControlId,
      p_terminating_lrn: "9283630020",
      p_zone_weight: ZONE5_WEIGHT
    });
    if (pendingErr) throw new Error(`apply pending: ${pendingErr.message}`);
    expect(pending).toMatchObject({ ok: true, pending: true, zone_weight: ZONE5_WEIGHT });

    const { data: capped, error: capErr } = await db.rpc("voice_apply_settlement_lrn", {
      p_call_control_id: callControlId,
      p_terminating_lrn: "9283630020",
      p_zone_weight: 150
    });
    if (capErr) throw new Error(`apply cap: ${capErr.message}`);
    expect(capped).toMatchObject({ ok: true, pending: true, zone_weight: 20 });

    const { data: floor, error: floorErr } = await db.rpc("voice_apply_settlement_lrn", {
      p_call_control_id: callControlId,
      p_terminating_lrn: "   ",
      p_zone_weight: 0
    });
    if (floorErr) throw new Error(`apply floor: ${floorErr.message}`);
    expect(floor).toMatchObject({ ok: true, pending: true, zone_weight: 1 });

    const { data: missing, error: missingErr } = await db.rpc("voice_apply_settlement_lrn", {
      p_call_control_id: "itest:cc:does-not-exist",
      p_terminating_lrn: "9283630020",
      p_zone_weight: ZONE5_WEIGHT
    });
    if (missingErr) throw new Error(`apply missing: ${missingErr.message}`);
    expect(missing).toMatchObject({ ok: false, reason: "no_settlement_row" });

    const { data: blank, error: blankErr } = await db.rpc("voice_apply_settlement_lrn", {
      p_call_control_id: "  ",
      p_terminating_lrn: "9283630020",
      p_zone_weight: 0
    });
    if (blankErr) throw new Error(`apply blank: ${blankErr.message}`);
    expect(blank).toMatchObject({ ok: false, reason: "missing_call_control_id" });
  });
});
