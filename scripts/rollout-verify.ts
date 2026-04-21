#!/usr/bin/env tsx
/**
 * Rollout verification for the Telnyx + Gemini Live voice path.
 *
 * Queries `telemetry_events` over a time window and reports — in plain
 * English — whether the voice stack is behaving as expected. Designed to be
 * run by a human RIGHT AFTER making a test call (or a batch of them) during
 * the staged rollout described in `docs/VOICE-ROLLOUT.md`.
 *
 * What it checks (all over the same window):
 *   1. `voice_inbound_stream_answered` exists for the provided business/DID →
 *      proves `telnyx-voice-inbound` accepted the call and minted a signed
 *      stream URL. If this is missing, the Edge function is wedged or
 *      `VOICE_AI_STREAM_ENABLED=false` silently short-circuited.
 *   2. `voice_rollout_stream_disabled` count → counts times the Edge
 *      rollout guard fired. Nonzero means the Edge-side flag is OFF.
 *   3. `voice_call_settlement_finalized` count > 0 → the call billed. If
 *      the bridge crashed mid-call this will be zero.
 *   4. `voice_bridge_health_check.stale_bridges == 0` (latest row) →
 *      the bridge heartbeat is live.
 *   5. No `voice_answer_fail` / `edge_webhook_rejected` / `voice_maintenance_sweep`
 *      with anomalous counts in the window.
 *
 * Usage:
 *   npx tsx scripts/rollout-verify.ts --business 00000000-…   (checks last 15 min)
 *   npx tsx scripts/rollout-verify.ts --business … --since 5m
 *   npx tsx scripts/rollout-verify.ts --business … --json
 *   npx tsx scripts/rollout-verify.ts --to-e164 +15551234567   (route-only diag)
 *
 * Required env:
 *   NEXT_PUBLIC_SUPABASE_URL  (or SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Exit codes:
 *   0 — all required checks green
 *   1 — at least one check red (see output)
 *   2 — bad args / missing env
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type RolloutArgs = {
  businessId: string | null;
  toE164: string | null;
  since: string; // e.g. "15m" | "1h"
  json: boolean;
};

export function parseRolloutArgs(argv: string[]): RolloutArgs {
  const out: RolloutArgs = { businessId: null, toE164: null, since: "15m", json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--business") out.businessId = argv[++i] ?? null;
    else if (a === "--to-e164") out.toE164 = argv[++i] ?? null;
    else if (a === "--since") out.since = argv[++i] ?? "15m";
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "Usage: tsx scripts/rollout-verify.ts [--business <uuid>] [--to-e164 +1…] [--since 15m] [--json]\n"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!out.businessId && !out.toE164) {
    throw new Error("at least one of --business or --to-e164 is required");
  }
  return out;
}

/** Convert a "15m" / "2h" / "30s" shorthand into milliseconds. */
export function parseSince(value: string): number {
  const m = /^(\d+)([smhd])$/.exec(value.trim());
  if (!m) throw new Error(`--since must look like 10m / 2h / 30s (got ${value})`);
  const n = Number(m[1]);
  const unit = m[2];
  const mult = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return n * mult;
}

type TelemetryRow = { event_type: string; payload: Record<string, unknown>; created_at: string };

type CheckResult = {
  name: string;
  ok: boolean;
  detail: string;
};

type MinimalClient = Pick<SupabaseClient, "from">;

export async function fetchWindow(
  supabase: MinimalClient,
  sinceIso: string
): Promise<TelemetryRow[]> {
  // Pull every voice-relevant event type in one shot. We over-fetch slightly
  // (10 types) rather than issuing 10 queries; PostgREST handles the IN filter
  // efficiently against `idx_telemetry_events_type_created`.
  const types = [
    "voice_inbound_stream_answered",
    "voice_rollout_stream_disabled",
    "voice_call_settlement_finalized",
    "voice_answer_fail",
    "voice_mark_answer_issued_fail",
    "voice_concurrent_limit_spoken",
    "voice_maintenance_sweep",
    "voice_bridge_health_check",
    "voice_bridge_health_error",
    "voice_low_balance_alerts",
    "edge_webhook_rejected",
    "telnyx_webhook_signature_reject"
  ];
  const { data, error } = await supabase
    .from("telemetry_events")
    .select("event_type, payload, created_at")
    .in("event_type", types)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (error) throw new Error(`telemetry_events select failed: ${error.message}`);
  return (data ?? []) as TelemetryRow[];
}

/** Does any row in `rows` match every predicate in `match`? */
function matchesAny(
  rows: TelemetryRow[],
  eventType: string,
  match: (p: Record<string, unknown>) => boolean
): TelemetryRow | undefined {
  return rows.find((r) => r.event_type === eventType && match(r.payload));
}

function countByType(rows: TelemetryRow[], eventType: string): number {
  return rows.reduce((acc, r) => (r.event_type === eventType ? acc + 1 : acc), 0);
}

export function evaluate(rows: TelemetryRow[], args: RolloutArgs): CheckResult[] {
  const out: CheckResult[] = [];

  const matchesBusiness = (p: Record<string, unknown>): boolean => {
    if (!args.businessId) return true;
    return typeof p.business_id === "string" && p.business_id === args.businessId;
  };
  const matchesE164 = (p: Record<string, unknown>): boolean => {
    if (!args.toE164) return true;
    return typeof p.to_e164 === "string" && p.to_e164 === args.toE164;
  };
  const matchesBoth = (p: Record<string, unknown>): boolean =>
    matchesBusiness(p) && matchesE164(p);

  // --- 1. Inbound call was accepted and a stream URL was minted. -----------
  const answered = matchesAny(rows, "voice_inbound_stream_answered", matchesBoth);
  out.push({
    name: "voice_inbound_stream_answered",
    ok: answered != null,
    detail: answered
      ? `found at ${answered.created_at}`
      : "no matching row — Edge never minted a stream URL"
  });

  // --- 2. Rollout guard didn't silently block streaming. -------------------
  const streamDisabled = rows.filter(
    (r) => r.event_type === "voice_rollout_stream_disabled" && matchesBoth(r.payload)
  ).length;
  out.push({
    name: "voice_rollout_stream_disabled == 0",
    ok: streamDisabled === 0,
    detail:
      streamDisabled === 0
        ? "rollout flag is on (or not fired)"
        : `fired ${streamDisabled}× — VOICE_AI_STREAM_ENABLED is likely off`
  });

  // --- 3. At least one settlement finalized in the window. -----------------
  const finalized = rows.filter(
    (r) =>
      r.event_type === "voice_call_settlement_finalized" && matchesBusiness(r.payload)
  ).length;
  out.push({
    name: "voice_call_settlement_finalized > 0",
    ok: finalized > 0,
    detail:
      finalized > 0
        ? `${finalized} finalized`
        : "no settlements finalized — call may still be live or bridge is stuck"
  });

  // --- 4. Bridge health is green (latest report in window). ----------------
  const healthRows = rows.filter((r) => r.event_type === "voice_bridge_health_check");
  const latestHealth = healthRows[0]; // rows are sorted desc above
  if (latestHealth) {
    const stale = Number(latestHealth.payload.stale_bridges ?? 0);
    const stuck = Number(latestHealth.payload.stuck_settlements ?? 0);
    out.push({
      name: "voice_bridge_health_check is green",
      ok: stale === 0 && stuck === 0,
      detail: `stale_bridges=${stale}, stuck_settlements=${stuck} @ ${latestHealth.created_at}`
    });
  } else {
    out.push({
      name: "voice_bridge_health_check is green",
      ok: false,
      detail:
        "no voice_bridge_health_check in window — alerts cron not running yet? schedule migration applied?"
    });
  }

  // --- 5. No anomalous answer / webhook rejections in the window. ----------
  const answerFails = rows.filter(
    (r) => r.event_type === "voice_answer_fail" && matchesBusiness(r.payload)
  ).length;
  out.push({
    name: "voice_answer_fail == 0",
    ok: answerFails === 0,
    detail:
      answerFails === 0
        ? "no answer failures"
        : `${answerFails} answer failures — check telnyx_call_actions logs`
  });

  const rejections = countByType(rows, "edge_webhook_rejected");
  const sigRejections = countByType(rows, "telnyx_webhook_signature_reject");
  // Rejections aren't business-scoped (they can fire before we even know
  // which tenant the event is for), so we just surface the count.
  out.push({
    name: "edge_webhook_rejected baseline",
    ok: rejections + sigRejections <= 5,
    detail: `edge_webhook_rejected=${rejections}, telnyx_webhook_signature_reject=${sigRejections}`
  });

  return out;
}

export type RolloutReport = {
  ok: boolean;
  args: RolloutArgs;
  sinceIso: string;
  now: string;
  checks: CheckResult[];
  /** Events, oldest-first, for diagnostic spelunking. */
  recentEvents: Array<{ event_type: string; created_at: string; payload: Record<string, unknown> }>;
};

export async function runRolloutVerify(
  args: RolloutArgs,
  deps: { supabase: MinimalClient; now?: () => Date }
): Promise<RolloutReport> {
  const sinceMs = parseSince(args.since);
  const now = deps.now ?? (() => new Date());
  const sinceIso = new Date(now().getTime() - sinceMs).toISOString();
  const rows = await fetchWindow(deps.supabase, sinceIso);
  const checks = evaluate(rows, args);
  return {
    ok: checks.every((c) => c.ok),
    args,
    sinceIso,
    now: now().toISOString(),
    checks,
    recentEvents: rows.slice(0, 50).reverse()
  };
}

/* c8 ignore start -- CLI entrypoint */
async function main(): Promise<void> {
  let args: RolloutArgs;
  try {
    args = parseRolloutArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!supabaseUrl || !serviceKey) {
    console.error(
      "Missing env: require NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY"
    );
    process.exit(2);
  }

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const report = await runRolloutVerify(args, { supabase });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const passed = report.checks.filter((c) => c.ok).length;
    console.log(
      `[rollout-verify] window ${report.sinceIso} → ${report.now} (${passed}/${report.checks.length} checks green)`
    );
    for (const c of report.checks) {
      console.log(`  ${c.ok ? "[ok]  " : "[FAIL]"} ${c.name} — ${c.detail}`);
    }
  }
  process.exit(report.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[rollout-verify] fatal:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
/* c8 ignore stop */
