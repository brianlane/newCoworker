#!/usr/bin/env tsx
/**
 * One-shot: re-enqueue Amy's weekly Clever sweep off its most recent run's
 * trigger, so a week whose sweep under-delivered gets finished instead of
 * waiting for next week's reminder.
 *
 * WHY THIS EXISTS. The 2026-08-19 reminder stated 41 active deals; the
 * pre-chaining engine covered one capped pass (2 updates landed) and texted
 * the owner about the rest. Chaining shipped the same day, but a flow only
 * runs when Clever texts, and Clever texts weekly. This replays the LAST
 * reminder's trigger as a fresh queued run: the sweep re-lists the portal's
 * "Needs Action" list and works whatever is still owed, which makes the
 * replay idempotent at the portal level (updated cards are no longer listed).
 *
 * WHAT THIS CANNOT DO, learned by running it (2026-08-19). Clever's magic
 * link is SINGLE-USE: once the scheduled run has consumed it, replaying the
 * same trigger lands on "Magic link has expired", a page with no list rows
 * and no error, so the sweep posts nothing. There is no fallback, because
 * Clever's password login fails for this account too (probe the portal with
 * `debug/portal-dom-probe.ts --label Clever` and it redirects to
 * login.listwithclever.com and returns `login_failed`).
 *
 * So this is only useful for a reminder whose link is still UNSPENT, i.e. the
 * scheduled run never ran or died before the browse step. Replaying a
 * reminder the sweep already worked will do nothing; it is at least no longer
 * SILENT about it, since the flow's `posted_nothing` alert arm fires when the
 * sweep posts zero (see `amy-clever-sweep-measured-alert-definition.ts`).
 *
 * SAFE BY REFUSAL: refuses when the flow already has a queued/running/parked
 * run (never stack two sweeps), and refuses a replay when the source run is
 * older than `--max-age-hours` (default 48) so a stale link is not replayed
 * silently months later. Ledger-recorded; the created run id is in details.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-clever-sweep-rerun.ts            # dry run
 *   npx tsx scripts/oneshot/amy-clever-sweep-rerun.ts --apply
 *   npx tsx scripts/oneshot/amy-clever-sweep-rerun.ts --apply --max-age-hours 12
 *
 * Exit codes: 0 enqueued / dry-run, 1 Supabase error, 2 refused (bad env,
 * missing flow, active run, or stale source).
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3"; // Amy Laidlaw Real Estate
const WEEKLY_FLOW_NAME = "Clever Update Leads";
/** Run states that mean the flow is already doing (or about to do) the work. */
const ACTIVE_STATUSES = ["queued", "running", "awaiting_agent", "awaiting_reply", "awaiting_call"];

function requireEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback ?? "";
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
  return value;
}

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const businessId = argValue("business-id", DEFAULT_BUSINESS_ID);
  const maxAgeHours = Number(argValue("max-age-hours", "48"));
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    console.error("--max-age-hours must be a positive number");
    process.exit(2);
  }

  const db = createClient(
    requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL),
    requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false } }
  );

  const { data: flows, error: flowErr } = await db
    .from("ai_flows")
    .select("id,name,enabled")
    .eq("business_id", businessId)
    .ilike("name", WEEKLY_FLOW_NAME);
  if (flowErr) {
    console.error(`Flow read failed: ${flowErr.message}`);
    process.exit(1);
  }
  const flow = (flows ?? []).find((f) => f.name.trim().toLowerCase() === WEEKLY_FLOW_NAME.toLowerCase());
  if (!flow) {
    console.error(`No flow named "${WEEKLY_FLOW_NAME}" for business ${businessId}.`);
    process.exit(2);
  }
  if (!flow.enabled) {
    console.error(`"${flow.name}" (${flow.id}) is DISABLED; enable it before replaying.`);
    process.exit(2);
  }

  const { data: active, error: activeErr } = await db
    .from("ai_flow_runs")
    .select("id,status")
    .eq("flow_id", flow.id)
    .in("status", ACTIVE_STATUSES)
    .limit(5);
  if (activeErr) {
    console.error(`Active-run check failed: ${activeErr.message}`);
    process.exit(1);
  }
  if ((active ?? []).length > 0) {
    console.error(
      `Refusing: the flow already has ${active!.length} active run(s): ` +
        active!.map((r) => `${r.id} (${r.status})`).join(", ")
    );
    process.exit(2);
  }

  const { data: lastRuns, error: lastErr } = await db
    .from("ai_flow_runs")
    .select("id,created_at,context,dedupe_key")
    .eq("flow_id", flow.id)
    .order("created_at", { ascending: false })
    .limit(1);
  if (lastErr) {
    console.error(`Last-run read failed: ${lastErr.message}`);
    process.exit(1);
  }
  const source = (lastRuns ?? [])[0];
  if (!source) {
    console.error("Refusing: the flow has no prior run to replay.");
    process.exit(2);
  }
  const trigger = (source.context as { trigger?: Record<string, unknown> } | null)?.trigger;
  if (!trigger || typeof trigger !== "object") {
    console.error(`Refusing: run ${source.id} carries no trigger context.`);
    process.exit(2);
  }
  const ageHours = (Date.now() - new Date(source.created_at as string).getTime()) / 3_600_000;
  if (ageHours > maxAgeHours) {
    console.error(
      `Refusing: last run ${source.id} is ${ageHours.toFixed(1)}h old (max ${maxAgeHours}h); ` +
        "its portal link is stale. Wait for the next weekly reminder instead."
    );
    process.exit(2);
  }

  const dedupeKey = `${source.dedupe_key ?? source.id}-rerun-${Date.now()}`;
  console.log(`Replaying run ${source.id} (${ageHours.toFixed(1)}h old) of "${flow.name}":`);
  console.log(`  business ${businessId}`);
  console.log(`  new dedupe_key ${dedupeKey}`);
  console.log(
    `  trigger text: ${String((trigger as { windowText?: string }).windowText ?? "").slice(0, 120)}...`
  );

  if (!apply) {
    console.log("\n[dry-run] Nothing written. Re-run with --apply.");
    return;
  }

  const { data: created, error: insErr } = await db
    .from("ai_flow_runs")
    .insert({
      flow_id: flow.id,
      business_id: businessId,
      status: "queued",
      current_step: 0,
      attempt_count: 0,
      context: { trigger, vars: {} },
      dedupe_key: dedupeKey
    })
    .select("id");
  if (insErr || (created ?? []).length !== 1) {
    console.error(`Insert failed: ${insErr?.message ?? "no row returned"}`);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "amy-clever-sweep-rerun.ts",
    businessId,
    details: { replayed_run: source.id, created_run: created![0].id, dedupe_key: dedupeKey }
  });
  console.log(`\nEnqueued run ${created![0].id}. The worker claims it within a minute.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
