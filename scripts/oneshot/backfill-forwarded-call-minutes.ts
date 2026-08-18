/**
 * Re-meter forwarded / transferred call minutes that the live meter missed.
 *
 * Why this exists: `parseCallDurationSeconds` read only `call_duration`, a
 * field Telnyx's hangup webhooks never send, so `meterForwardedCallSeconds`
 * bailed with `no_duration` on EVERY forwarded leg since the meter shipped.
 * `voice_forwarded_call_metered` had zero telemetry rows fleet-wide. The live
 * path is fixed (`supabase/functions/_shared/telnyx_call_duration.ts`), which
 * stops the gap growing; this walks the history the fix cannot reach, because
 * those webhooks were delivered and will not arrive again.
 *
 * Duration comes from the call's own `voice_call_transcripts` row
 * (`ended_at - started_at`), which the forwarded-call logger wrote from the
 * same webhooks. The RPC applies the usual per-minute rounding.
 *
 * Idempotency is exact, not approximate: `voice_call_transcripts.call_control_id`
 * for a forwarded row IS the leg id the live meter uses as its key (both are
 * written from `legId` at the warm-transfer hangup, and from `callControlId`
 * on the handoff-chain terminal), and `voice_meter_forwarded_call` claims on
 * `on conflict (call_control_id) do nothing`. So a call already metered by the
 * live path is skipped, and re-running this script is a no-op.
 *
 * Usage:
 *   npx tsx scripts/oneshot/backfill-forwarded-call-minutes.ts            # dry run, fleet
 *   npx tsx scripts/oneshot/backfill-forwarded-call-minutes.ts --apply
 *   npx tsx scripts/oneshot/backfill-forwarded-call-minutes.ts --business <uuid> --apply
 *
 * Scope note: reads centrally. Every tenant is `data_residency_mode = supabase`
 * as of Aug 2026; if one is ever moved to `vps`, its rows live on its box and
 * this script would silently see none of them. Re-check before assuming a
 * clean run covered the fleet.
 */
import { createClient } from "@supabase/supabase-js";
import { recordOneshotApplied } from "./_ledger";
import { tierCapSecondsFor } from "../../supabase/functions/_shared/forwarded_call_meter";
import { deriveMonthlyQuotaWindow } from "../../supabase/functions/_shared/billing_period_window";

/** Ledger tag written to `voice_forwarded_call_meter.context`. */
export const BACKFILL_CONTEXT = "forwarded_backfill";

export type ForwardedCallRow = {
  call_control_id: string;
  business_id: string;
  started_at: string | null;
  ended_at: string | null;
  status: string;
};

export type BusinessBilling = {
  tier: string;
  enterpriseLimits: unknown;
  /** `subscriptions.stripe_current_period_start`, or null when absent. */
  periodStartIso: string | null;
};

export type Classification =
  | {
      action: "meter";
      reportedSeconds: number;
      /** Month-window key the call belongs to, NOT today's window. */
      stripePeriodStart: string;
      tierCapSeconds: number;
    }
  | {
      action: "skip";
      reason:
        | "not_answered"
        | "no_timestamps"
        | "negative_span"
        | "zero_seconds"
        | "no_subscription"
        | "closed_period";
    };

/**
 * Decide what to do with one forwarded call. Pure, so the billing judgement is
 * testable without a database.
 *
 * The `closed_period` branch is the one worth understanding. The live meter
 * keys usage by `deriveMonthlyQuotaWindow(periodStart, Date.now())`. Passing
 * `Date.now()` here would file every historical call into the CURRENT month,
 * inflating this month's usage with minutes from months already invoiced. So
 * we pass the call's own timestamp instead, and a call that predates the
 * tenant's current Stripe period start cannot be keyed at all (that period's
 * anchor is gone from `subscriptions`, and re-opening an invoiced period is
 * not this script's call to make). Those are reported, never metered.
 *
 * Which of the call's timestamps? `ended_at`, not `started_at`. The live meter
 * runs from the hangup webhook, so its `Date.now()` is effectively the call's
 * end. For a call that straddles a month-window boundary the two differ, and
 * keying off `started_at` would file it in the window BEFORE the one the live
 * meter would have used, a silent disagreement between backfilled and live
 * rows for exactly the calls hardest to reconcile by hand.
 */
export function classifyForwardedCall(
  row: ForwardedCallRow,
  billing: BusinessBilling
): Classification {
  // The live meter only bills legs a human answered; the carrier does not
  // charge for a leg that rang out. 'completed' is the forwarded logger's
  // mapping of outcome 'answered'.
  if (row.status !== "completed") return { action: "skip", reason: "not_answered" };
  if (!row.started_at || !row.ended_at) return { action: "skip", reason: "no_timestamps" };

  const startMs = Date.parse(row.started_at);
  const endMs = Date.parse(row.ended_at);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { action: "skip", reason: "no_timestamps" };
  }
  const seconds = Math.floor((endMs - startMs) / 1000);
  if (seconds < 0) return { action: "skip", reason: "negative_span" };
  // The RPC would insert a claim row billing 0, permanently blocking a later
  // correct meter for this call. Skip instead so the key stays available.
  if (seconds === 0) return { action: "skip", reason: "zero_seconds" };

  if (!billing.periodStartIso) return { action: "skip", reason: "no_subscription" };
  const periodStartMs = Date.parse(billing.periodStartIso);
  // Compared on `endMs` for the same reason the window below is derived from
  // it: match the live meter, which runs at hangup.
  if (!Number.isFinite(periodStartMs) || endMs < periodStartMs) {
    return { action: "skip", reason: "closed_period" };
  }

  const window = deriveMonthlyQuotaWindow(billing.periodStartIso, endMs);
  return {
    action: "meter",
    reportedSeconds: seconds,
    // Normalized through Date exactly like voice_reserve / the live meter, so
    // the key matches the row the reserve gate reads byte for byte.
    stripePeriodStart: new Date(window.startIso).toISOString(),
    tierCapSeconds: tierCapSecondsFor(
      billing.tier,
      billing.tier === "enterprise" ? billing.enterpriseLimits : null
    )
  };
}

/** Per-minute rounding, mirroring the RPC, for dry-run reporting only. */
export function roundToBillableSeconds(reportedSeconds: number): number {
  if (reportedSeconds <= 0) return 0;
  return Math.ceil(reportedSeconds / 60) * 60;
}

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const idx = argv.indexOf("--business");
  const businessId = idx >= 0 ? argv[idx + 1] ?? null : null;
  return { apply, businessId };
}

async function main() {
  const { apply, businessId } = parseArgs(process.argv.slice(2));
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required");
    process.exit(1);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  // Deliberately no `deleted_at is null` filter: an owner hiding a call from
  // Call history does not un-spend the carrier time behind it, and billing
  // must not be reducible by deleting rows from a view.
  let query = db
    .from("voice_call_transcripts")
    .select("call_control_id, business_id, started_at, ended_at, status")
    .eq("call_kind", "forwarded")
    .order("started_at", { ascending: true });
  if (businessId) query = query.eq("business_id", businessId);
  const { data: calls, error: callsErr } = await query;
  if (callsErr) throw new Error(`voice_call_transcripts: ${callsErr.message}`);
  const rows = (calls ?? []) as ForwardedCallRow[];

  // Already-metered keys, so the dry run reports the same set the apply would
  // actually touch rather than counting calls the RPC will silently no-op.
  const { data: metered, error: meteredErr } = await db
    .from("voice_forwarded_call_meter")
    .select("call_control_id");
  if (meteredErr) throw new Error(`voice_forwarded_call_meter: ${meteredErr.message}`);
  const alreadyMetered = new Set(
    ((metered ?? []) as Array<{ call_control_id: string }>).map((r) => r.call_control_id)
  );

  const billingByBusiness = new Map<string, BusinessBilling>();
  async function billingFor(id: string): Promise<BusinessBilling> {
    const cached = billingByBusiness.get(id);
    if (cached) return cached;
    const { data: biz } = await db
      .from("businesses")
      .select("tier, enterprise_limits")
      .eq("id", id)
      .maybeSingle();
    const { data: sub } = await db
      .from("subscriptions")
      .select("stripe_current_period_start")
      .eq("business_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const resolved: BusinessBilling = {
      tier: String((biz as { tier?: unknown } | null)?.tier ?? "starter"),
      enterpriseLimits: (biz as { enterprise_limits?: unknown } | null)?.enterprise_limits ?? null,
      periodStartIso:
        ((sub as { stripe_current_period_start?: string } | null)
          ?.stripe_current_period_start as string | null) ?? null
    };
    billingByBusiness.set(id, resolved);
    return resolved;
  }

  const planned: Array<{
    row: ForwardedCallRow;
    reportedSeconds: number;
    billableSeconds: number;
    stripePeriodStart: string;
    tierCapSeconds: number;
  }> = [];
  const skipped = new Map<string, number>();
  const closedPeriodCalls: ForwardedCallRow[] = [];

  for (const row of rows) {
    if (alreadyMetered.has(row.call_control_id)) {
      skipped.set("already_metered", (skipped.get("already_metered") ?? 0) + 1);
      continue;
    }
    const decision = classifyForwardedCall(row, await billingFor(row.business_id));
    if (decision.action === "skip") {
      skipped.set(decision.reason, (skipped.get(decision.reason) ?? 0) + 1);
      if (decision.reason === "closed_period") closedPeriodCalls.push(row);
      continue;
    }
    planned.push({
      row,
      reportedSeconds: decision.reportedSeconds,
      billableSeconds: roundToBillableSeconds(decision.reportedSeconds),
      stripePeriodStart: decision.stripePeriodStart,
      tierCapSeconds: decision.tierCapSeconds
    });
  }

  console.log(`Forwarded calls found: ${rows.length}`);
  console.log(`To meter: ${planned.length}`);
  for (const [reason, count] of [...skipped].sort()) {
    console.log(`  skipped (${reason}): ${count}`);
  }

  const byBusiness = new Map<string, { calls: number; billable: number; periods: Set<string> }>();
  for (const p of planned) {
    const agg = byBusiness.get(p.row.business_id) ?? {
      calls: 0,
      billable: 0,
      periods: new Set<string>()
    };
    agg.calls += 1;
    agg.billable += p.billableSeconds;
    agg.periods.add(p.stripePeriodStart);
    byBusiness.set(p.row.business_id, agg);
  }
  console.log("\nPer tenant:");
  for (const [id, agg] of byBusiness) {
    const minutes = (agg.billable / 60).toFixed(0);
    console.log(
      `  ${id}: ${agg.calls} call(s), +${agg.billable}s (${minutes} min) ` +
        `across period(s) ${[...agg.periods].sort().join(", ")}`
    );
  }

  // Surfaced separately, never metered: these predate the tenant's current
  // Stripe period, so their minutes belong to an already-invoiced window.
  if (closedPeriodCalls.length > 0) {
    console.log(
      `\nNOT metered, in already-invoiced periods (${closedPeriodCalls.length}). ` +
        `Reopening an invoiced period is a billing decision, not this script's:`
    );
    for (const row of closedPeriodCalls) {
      console.log(`  ${row.business_id} ${row.started_at} ${row.call_control_id}`);
    }
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to commit.");
    return;
  }

  let metrics = { metered: 0, duplicate: 0, failed: 0, seconds: 0 };
  for (const p of planned) {
    const { data, error } = await db.rpc("voice_meter_forwarded_call", {
      p_business_id: p.row.business_id,
      p_call_control_id: p.row.call_control_id,
      p_reported_seconds: p.reportedSeconds,
      p_stripe_period_start: p.stripePeriodStart,
      p_tier_cap_seconds: p.tierCapSeconds,
      p_context: BACKFILL_CONTEXT
    });
    if (error) {
      console.error(`  FAILED ${p.row.call_control_id}: ${error.message}`);
      metrics.failed += 1;
      continue;
    }
    const res = data as { duplicate?: boolean; billable_seconds?: number } | null;
    if (res?.duplicate) {
      metrics.duplicate += 1;
      continue;
    }
    metrics.metered += 1;
    metrics.seconds += Number(res?.billable_seconds ?? 0);
  }

  console.log(
    `\nApplied: metered ${metrics.metered}, duplicate ${metrics.duplicate}, ` +
      `failed ${metrics.failed}, +${metrics.seconds}s committed.`
  );

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1],
    businessId,
    details: {
      forwarded_calls_scanned: rows.length,
      metered: metrics.metered,
      duplicate: metrics.duplicate,
      failed: metrics.failed,
      committed_seconds: metrics.seconds,
      closed_period_skipped: closedPeriodCalls.length
    }
  });

  if (metrics.failed > 0) process.exit(1);
}

// Guarded so the pure helpers above can be imported by tests without the
// script trying to reach a database.
if (process.argv[1] && process.argv[1].includes("backfill-forwarded-call-minutes")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
