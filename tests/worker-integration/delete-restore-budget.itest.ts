import { beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { SUPABASE_URL, seedBusiness, serviceDb } from "./harness";

/**
 * Delete/restore ↔ voice-budget invariant, end to end against the REAL
 * stack (every migration, the real RPCs, the real voice-settlement-sweep
 * edge function), reproducing the 2026-07-17 New Coworker HQ incident:
 * the owner soft-deleted a settled call, and the dashboard's voice budget
 * read "0 / 250 min" even though the settlement ledger held a finalized
 * 300s call.
 *
 * Contracts pinned here:
 *   1. Owner delete of a call NEVER moves the voice budget — the billing
 *      ledger (voice_billing_period_usage) is independent of content
 *      visibility.
 *   2. Admin restore is a COMPLETE reverse cascade — the call is back in
 *      Call history, Recent Activity, and its transcript turns — and the
 *      budget still hasn't moved.
 *   3. The budget row is self-healing: if ANY stray write desyncs
 *      committed_included_seconds from the immutable settlement ledger
 *      (the incident), the 5-minute maintenance sweep reconciles it back.
 *
 * The suite drives the exact production surfaces: the reserve/finalize
 * RPCs the Edge webhooks call, the src/lib db helpers the dashboard
 * routes call (soft delete, admin restore, activity feed, plan-card
 * budget snapshot), and the voice-settlement-sweep function over HTTP
 * exactly like pg_cron.
 */

const CRON_SECRET = process.env.ITEST_CRON_SECRET ?? "itest-cron-secret";

// The dashboard-side src/lib helpers construct their own service client
// from the app env vars; point them at the itest stack BEFORE the lazy
// createSupabaseServiceClient() call inside each helper runs.
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY =
  process.env.ITEST_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

import { softDeleteTranscript, listTranscriptsForBusiness, listTurns } from "@/lib/db/voice-transcripts";
import { restoreDeletedItem, listDeletedItems } from "@/lib/admin/deleted-items";
import { getRecentActivity } from "@/lib/db/activity";
import { getVoiceBillingSnapshotForBusiness } from "@/lib/db/voice-usage";

const CALLER = "+14165550149";
const TIER_CAP_SECONDS = 15_000; // standard: 250 included minutes

/** 4m45s call — per-minute rounding settles it at 300 billable seconds. */
const CALL_SECONDS = 285;
const SETTLED_SECONDS = 300;

async function committedSeconds(db: SupabaseClient, businessId: string): Promise<number> {
  const { data, error } = await db
    .from("voice_billing_period_usage")
    .select("committed_included_seconds")
    .eq("business_id", businessId)
    .single();
  if (error) throw new Error(`committedSeconds: ${error.message}`);
  return (data as { committed_included_seconds: number }).committed_included_seconds;
}

/** One voice-settlement-sweep tick — the exact POST pg_cron makes every 5 min. */
async function tickMaintenanceSweep(): Promise<Record<string, unknown>> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/voice-settlement-sweep`, {
    method: "POST",
    headers: { Authorization: `Bearer ${CRON_SECRET}`, "Content-Type": "application/json" },
    body: "{}"
  });
  if (!res.ok) {
    throw new Error(`sweep tick ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

describe("owner delete / admin restore never move the voice budget (self-healing ledger)", () => {
  const db = serviceDb();
  const callControlId = `itest:cc:${randomUUID()}`;
  let businessId = "";
  let transcriptId = "";
  let periodStart = "";

  beforeAll(async () => {
    businessId = await seedBusiness(db, "Delete/restore budget itest");

    // Subscription anchor: the plan-card snapshot derives the current
    // monthly quota window from stripe_current_period_start. 10 days ago
    // keeps the whole test inside the first month window.
    periodStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
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

    // ── The call, exactly as production runs it ─────────────────────────
    // 1. Reserve (telnyx-voice-inbound's RPC): bootstraps the budget row.
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
    const endedAt = new Date(startedAt.getTime() + CALL_SECONDS * 1000);

    // 2. Bridge answers: settlement wall-clock starts at ws_connected_at.
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

    // 3. The bridge writes the transcript + turns during the call.
    {
      const { data, error } = await db
        .from("voice_call_transcripts")
        .insert({
          business_id: businessId,
          call_control_id: callControlId,
          caller_e164: CALLER,
          model: "gemini-3.1-flash-live-preview",
          status: "completed",
          direction: "inbound",
          started_at: startedAt.toISOString(),
          ended_at: endedAt.toISOString(),
          summary: "Caller asked about hours; assistant answered."
        })
        .select("id")
        .single();
      if (error) throw new Error(`seed transcript: ${error.message}`);
      transcriptId = (data as { id: string }).id;

      const { error: turnsErr } = await db.from("voice_call_transcript_turns").insert([
        { transcript_id: transcriptId, role: "caller", content: "What are your hours?", turn_index: 0 },
        { transcript_id: transcriptId, role: "assistant", content: "We're open 9-5.", turn_index: 1 }
      ]);
      if (turnsErr) throw new Error(`seed turns: ${turnsErr.message}`);
    }

    // 4. Both end signals land (telnyx-voice-call-end's upsert)…
    {
      const { error } = await db.from("voice_settlements").upsert(
        {
          call_control_id: callControlId,
          business_id: businessId,
          telnyx_ended_at: endedAt.toISOString(),
          bridge_media_ended_at: endedAt.toISOString(),
          first_signal_at: endedAt.toISOString()
        },
        { onConflict: "call_control_id" }
      );
      if (error) throw new Error(`seed settlement: ${error.message}`);
    }

    // 5. …and the settlement finalizes, committing the seconds atomically.
    const { data: settled, error: settleErr } = await db.rpc("voice_try_finalize_settlement", {
      p_call_control_id: callControlId
    });
    if (settleErr) throw new Error(`finalize: ${settleErr.message}`);
    expect((settled as { ok: boolean; billable_seconds: number }).ok).toBe(true);
    expect((settled as { billable_seconds: number }).billable_seconds).toBe(SETTLED_SECONDS);
  });

  it("settles the call into the plan-card budget (baseline)", async () => {
    expect(await committedSeconds(db, businessId)).toBe(SETTLED_SECONDS);

    // The exact snapshot the dashboard plan card renders.
    const snapshot = await getVoiceBillingSnapshotForBusiness(businessId);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.committedIncludedSeconds).toBe(SETTLED_SECONDS);
    expect(snapshot!.tierCapSeconds).toBe(TIER_CAP_SECONDS);
  });

  it("owner delete hides the call everywhere but NEVER moves the budget", async () => {
    const stamped = await softDeleteTranscript(businessId, transcriptId, randomUUID());
    expect(stamped).toBe(1);

    // Hidden from Call history and the dashboard Recent Activity feed.
    const calls = await listTranscriptsForBusiness(businessId);
    expect(calls.find((c) => c.id === transcriptId)).toBeUndefined();
    const activity = await getRecentActivity(businessId, 20, undefined, "standard");
    expect(activity.filter((a) => a.kind === "call")).toHaveLength(0);

    // Budget invariant: the billing ledger does not care about visibility.
    expect(await committedSeconds(db, businessId)).toBe(SETTLED_SECONDS);
    const snapshot = await getVoiceBillingSnapshotForBusiness(businessId);
    expect(snapshot!.committedIncludedSeconds).toBe(SETTLED_SECONDS);
  });

  it("admin restore is a complete reverse cascade — call, turns, activity — budget still unmoved", async () => {
    // The admin panel lists the deleted call…
    const deleted = await listDeletedItems(businessId);
    const entry = deleted.find((d) => d.type === "call" && d.id === transcriptId);
    expect(entry).toBeDefined();

    // …and restore puts everything back.
    const { restored } = await restoreDeletedItem(businessId, "call", transcriptId);
    expect(restored).toBe(1);

    const calls = await listTranscriptsForBusiness(businessId);
    const call = calls.find((c) => c.id === transcriptId);
    expect(call).toBeDefined();
    expect(call!.summary).toBe("Caller asked about hours; assistant answered.");

    const turns = await listTurns(transcriptId, { businessId });
    expect(turns).toHaveLength(2);

    const activity = await getRecentActivity(businessId, 20, undefined, "standard");
    const callItems = activity.filter((a) => a.kind === "call");
    expect(callItems).toHaveLength(1);
    expect(callItems[0].label).toContain("completed");

    expect(await committedSeconds(db, businessId)).toBe(SETTLED_SECONDS);
    const snapshot = await getVoiceBillingSnapshotForBusiness(businessId);
    expect(snapshot!.committedIncludedSeconds).toBe(SETTLED_SECONDS);
  });

  it("a stray budget write (the incident) self-heals from the settlement ledger on the sweep", async () => {
    // Reproduce the production incident: something outside the platform
    // zeroes the mutable aggregate while the immutable ledger still holds
    // the finalized 300s settlement.
    {
      const { error } = await db
        .from("voice_billing_period_usage")
        .update({ committed_included_seconds: 0 })
        .eq("business_id", businessId);
      if (error) throw new Error(`tamper: ${error.message}`);
    }
    expect(await committedSeconds(db, businessId)).toBe(0);

    // One maintenance sweep — the POST pg_cron fires every 5 minutes.
    const summary = await tickMaintenanceSweep();
    expect(Number(summary.budget_rows_reconciled ?? 0)).toBeGreaterThanOrEqual(1);

    // The plan card is right again without any human intervention.
    expect(await committedSeconds(db, businessId)).toBe(SETTLED_SECONDS);
    const snapshot = await getVoiceBillingSnapshotForBusiness(businessId);
    expect(snapshot!.committedIncludedSeconds).toBe(SETTLED_SECONDS);
  });

  it("the reconciler is a no-op on an in-sync budget row", async () => {
    const before = await committedSeconds(db, businessId);
    const summary = await tickMaintenanceSweep();
    expect(Number(summary.budget_rows_reconciled ?? -1)).toBe(0);
    expect(await committedSeconds(db, businessId)).toBe(before);
  });
});
