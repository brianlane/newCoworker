import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { seedBusiness, serviceDb } from "./harness";

/**
 * Weighted voice-allowance units against the REAL stack.
 *
 * Zone 1 LRN and missing LRN stay 1x. Payson Zone 5 LRN is 14x on the
 * already-ceiled Telnyx minute (33s → 60 unweighted → 840 weighted). Zone 6
 * / N11 cap at 20x when billable_seconds is 60, and use the full raw
 * multiplier when billable_seconds is 120. The 5-minute reconciler must
 * not undo that extra.
 */

const TIER_CAP_SECONDS = 15_000;
const RAW_SECONDS = 33;
const UNWEIGHTED = 60;
const LONG_RAW_SECONDS = 90;
const LONG_UNWEIGHTED = 120;
const ZONE5_WEIGHT = 14;
const ZONE5_WEIGHTED = 840;
const ZONE6_RAW_WEIGHT = 36.2;
const ZONE6_SHORT_WEIGHTED = 1_200;
const ZONE6_LONG_WEIGHTED = 4_344;
const N11_RAW_WEIGHT = 150;
const N11_LONG_WEIGHTED = 18_000;

async function seedVoiceCall(
  db: SupabaseClient,
  opts: {
    label: string;
    zoneWeight?: number;
    terminatingLrn?: string | null;
    rawSeconds?: number;
  }
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

  const rawSeconds = opts.rawSeconds ?? RAW_SECONDS;
  const startedAt = new Date(Date.now() - 60 * 60 * 1000);
  const endedAt = new Date(startedAt.getTime() + rawSeconds * 1000);
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
    telnyx_reported_duration_seconds: rawSeconds
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

    const { data: rawN11, error: rawErr } = await db.rpc("voice_apply_settlement_lrn", {
      p_call_control_id: callControlId,
      p_terminating_lrn: "9283630020",
      p_zone_weight: N11_RAW_WEIGHT
    });
    if (rawErr) throw new Error(`apply raw n11: ${rawErr.message}`);
    expect(rawN11).toMatchObject({
      ok: true,
      pending: true,
      zone_weight: N11_RAW_WEIGHT
    });

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

  it("caps Zone 6 at 20x on a one-minute settlement and uses full 36.2x past 60s", async () => {
    const shortCall = await seedVoiceCall(db, {
      label: "Voice weight itest (Zone 6 short)",
      terminatingLrn: "1308286",
      zoneWeight: ZONE6_RAW_WEIGHT
    });
    const { data: shortData, error: shortErr } = await db.rpc(
      "voice_try_finalize_settlement",
      { p_call_control_id: shortCall.callControlId }
    );
    if (shortErr) throw new Error(`finalize short z6: ${shortErr.message}`);
    expect(shortData).toMatchObject({
      ok: true,
      billable_seconds: UNWEIGHTED,
      weighted_billable_seconds: ZONE6_SHORT_WEIGHTED,
      zone_weight: 20
    });
    expect(await committedSeconds(db, shortCall.businessId)).toBe(ZONE6_SHORT_WEIGHTED);

    const longCall = await seedVoiceCall(db, {
      label: "Voice weight itest (Zone 6 long)",
      terminatingLrn: "1308286",
      zoneWeight: ZONE6_RAW_WEIGHT,
      rawSeconds: LONG_RAW_SECONDS
    });
    const { data: longData, error: longErr } = await db.rpc(
      "voice_try_finalize_settlement",
      { p_call_control_id: longCall.callControlId }
    );
    if (longErr) throw new Error(`finalize long z6: ${longErr.message}`);
    expect(longData).toMatchObject({
      ok: true,
      billable_seconds: LONG_UNWEIGHTED,
      weighted_billable_seconds: ZONE6_LONG_WEIGHTED,
      zone_weight: ZONE6_RAW_WEIGHT
    });
    expect(await committedSeconds(db, longCall.businessId)).toBe(ZONE6_LONG_WEIGHTED);

    const { data: repaired, error: reconErr } = await db.rpc(
      "voice_reconcile_period_usage_row",
      {
        p_business_id: longCall.businessId,
        p_stripe_period_start: longCall.periodStart
      }
    );
    if (reconErr) throw new Error(`reconcile z6: ${reconErr.message}`);
    expect(repaired).toBe(0);
    expect(await committedSeconds(db, longCall.businessId)).toBe(ZONE6_LONG_WEIGHTED);
  });

  it("keeps Zone 5 at 14x on a long call and N11 at 150x past 60s", async () => {
    const zone5 = await seedVoiceCall(db, {
      label: "Voice weight itest (Zone 5 long)",
      terminatingLrn: "9283630020",
      zoneWeight: ZONE5_WEIGHT,
      rawSeconds: LONG_RAW_SECONDS
    });
    const { data: z5, error: z5Err } = await db.rpc("voice_try_finalize_settlement", {
      p_call_control_id: zone5.callControlId
    });
    if (z5Err) throw new Error(`finalize long z5: ${z5Err.message}`);
    expect(z5).toMatchObject({
      ok: true,
      billable_seconds: LONG_UNWEIGHTED,
      weighted_billable_seconds: LONG_UNWEIGHTED * ZONE5_WEIGHT,
      zone_weight: ZONE5_WEIGHT
    });

    const n11 = await seedVoiceCall(db, {
      label: "Voice weight itest (N11 long)",
      terminatingLrn: "4163110000",
      zoneWeight: N11_RAW_WEIGHT,
      rawSeconds: LONG_RAW_SECONDS
    });
    const { data: n11Data, error: n11Err } = await db.rpc(
      "voice_try_finalize_settlement",
      { p_call_control_id: n11.callControlId }
    );
    if (n11Err) throw new Error(`finalize long n11: ${n11Err.message}`);
    expect(n11Data).toMatchObject({
      ok: true,
      billable_seconds: LONG_UNWEIGHTED,
      weighted_billable_seconds: N11_LONG_WEIGHTED,
      zone_weight: N11_RAW_WEIGHT
    });

    const n11Short = await seedVoiceCall(db, {
      label: "Voice weight itest (N11 short)",
      terminatingLrn: "4163110000",
      zoneWeight: N11_RAW_WEIGHT
    });
    const { data: n11ShortData, error: n11ShortErr } = await db.rpc(
      "voice_try_finalize_settlement",
      { p_call_control_id: n11Short.callControlId }
    );
    if (n11ShortErr) throw new Error(`finalize short n11: ${n11ShortErr.message}`);
    expect(n11ShortData).toMatchObject({
      ok: true,
      billable_seconds: UNWEIGHTED,
      weighted_billable_seconds: UNWEIGHTED * 20,
      zone_weight: 20
    });
  });

  it("MDR apply after finalize uses that settlement's billable_seconds for the cap", async () => {
    const shortCall = await seedVoiceCall(db, {
      label: "Voice weight itest (MDR duration short)"
    });
    const { error: shortFinErr } = await db.rpc("voice_try_finalize_settlement", {
      p_call_control_id: shortCall.callControlId
    });
    if (shortFinErr) throw new Error(`finalize mdr short: ${shortFinErr.message}`);
    expect(await committedSeconds(db, shortCall.businessId)).toBe(UNWEIGHTED);

    const { data: shortApply, error: shortApplyErr } = await db.rpc(
      "voice_apply_settlement_lrn",
      {
        p_call_control_id: shortCall.callControlId,
        p_terminating_lrn: "1308286",
        p_zone_weight: ZONE6_RAW_WEIGHT
      }
    );
    if (shortApplyErr) throw new Error(`apply mdr short: ${shortApplyErr.message}`);
    expect(shortApply).toMatchObject({
      ok: true,
      zone_weight: 20,
      weighted_billable_seconds: ZONE6_SHORT_WEIGHTED,
      delta_included_seconds: ZONE6_SHORT_WEIGHTED - UNWEIGHTED
    });
    expect(await committedSeconds(db, shortCall.businessId)).toBe(ZONE6_SHORT_WEIGHTED);

    const longCall = await seedVoiceCall(db, {
      label: "Voice weight itest (MDR duration long)",
      rawSeconds: LONG_RAW_SECONDS
    });
    const { error: longFinErr } = await db.rpc("voice_try_finalize_settlement", {
      p_call_control_id: longCall.callControlId
    });
    if (longFinErr) throw new Error(`finalize mdr long: ${longFinErr.message}`);
    expect(await committedSeconds(db, longCall.businessId)).toBe(LONG_UNWEIGHTED);

    const { data: longApply, error: longApplyErr } = await db.rpc(
      "voice_apply_settlement_lrn",
      {
        p_call_control_id: longCall.callControlId,
        p_terminating_lrn: "1308286",
        p_zone_weight: ZONE6_RAW_WEIGHT
      }
    );
    if (longApplyErr) throw new Error(`apply mdr long: ${longApplyErr.message}`);
    expect(longApply).toMatchObject({
      ok: true,
      zone_weight: ZONE6_RAW_WEIGHT,
      weighted_billable_seconds: ZONE6_LONG_WEIGHTED,
      delta_included_seconds: ZONE6_LONG_WEIGHTED - LONG_UNWEIGHTED
    });
    expect(await committedSeconds(db, longCall.businessId)).toBe(ZONE6_LONG_WEIGHTED);

    const { data: again, error: againErr } = await db.rpc("voice_apply_settlement_lrn", {
      p_call_control_id: longCall.callControlId,
      p_terminating_lrn: "1308286",
      p_zone_weight: ZONE6_RAW_WEIGHT
    });
    if (againErr) throw new Error(`apply mdr long again: ${againErr.message}`);
    expect(again).toMatchObject({ ok: true, unchanged: true, zone_weight: ZONE6_RAW_WEIGHT });
    expect(await committedSeconds(db, longCall.businessId)).toBe(ZONE6_LONG_WEIGHTED);
  });

  it("exposes the duration formula on the live stack", async () => {
    const { data: short, error: shortErr } = await db.rpc(
      "voice_effective_allowance_weight",
      { p_raw: ZONE6_RAW_WEIGHT, p_billable_seconds: 60 }
    );
    if (shortErr) throw new Error(`effective short: ${shortErr.message}`);
    expect(Number(short)).toBe(20);

    const { data: long, error: longErr } = await db.rpc(
      "voice_effective_allowance_weight",
      { p_raw: ZONE6_RAW_WEIGHT, p_billable_seconds: 120 }
    );
    if (longErr) throw new Error(`effective long: ${longErr.message}`);
    expect(Number(long)).toBe(ZONE6_RAW_WEIGHT);

    const { data: n11, error: n11Err } = await db.rpc(
      "voice_effective_allowance_weight",
      { p_raw: N11_RAW_WEIGHT, p_billable_seconds: 120 }
    );
    if (n11Err) throw new Error(`effective n11: ${n11Err.message}`);
    expect(Number(n11)).toBe(N11_RAW_WEIGHT);

    const { data: z5, error: z5Err } = await db.rpc(
      "voice_effective_allowance_weight",
      { p_raw: ZONE5_WEIGHT, p_billable_seconds: 33 }
    );
    if (z5Err) throw new Error(`effective z5: ${z5Err.message}`);
    expect(Number(z5)).toBe(ZONE5_WEIGHT);
  });
});
