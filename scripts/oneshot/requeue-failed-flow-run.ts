#!/usr/bin/env tsx
/**
 * One-shot: re-enqueue a FAILED AiFlow run as a fresh run of the same flow,
 * carrying the original trigger verbatim.
 *
 * Incident (KYP Ads, Aug 6 2026): the Canada-whitelist outage rejected the
 * lead flow's first customer text with Telnyx 40309, so run 4e9fdf3c died at
 * its send_sms step and lead H Eve never received ANY message; the nurture
 * sequence behind it never ran either. The whitelist is fixed, and the
 * engine's own lead-dedupe rule states the recovery path: "a FAILED prior
 * run never blocks; the repeat inquiry is the recovery path." This script IS
 * that repeat inquiry, minted from the original trigger so extraction and
 * every downstream step re-derive the same values.
 *
 * Generic on purpose: any tenant's failed run can be requeued this way, and
 * the next carrier outage will want it again.
 *
 * Shape:
 *   - Verifies the source run exists, belongs to the expected business when
 *     --business-id is given, and is status=failed. Refuses anything else:
 *     requeueing a done run double-sends, and a queued/claimed one races the
 *     worker.
 *   - Idempotent: the new run's trigger carries `requeued_from: <source id>`,
 *     and an existing run with that marker (any status) makes a second
 *     --apply a no-op. The flow's own dedupe/quiet-hours/business-hours
 *     gates all still apply to the new run; this script bypasses nothing.
 *   - Vars start EMPTY: the flow's extract step re-derives them from the
 *     copied trigger payload, exactly like a genuine re-trigger. Pre-seeding
 *     the old vars would skip nothing (extraction runs regardless) and could
 *     fight fillOnlyEmpty semantics.
 *   - Dry-run by default; prints the source run, its failure, and the
 *     planned insert. Ledgered via applied_oneshots on --apply.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/requeue-failed-flow-run.ts --run-id <uuid>            # dry run
 *   npx tsx scripts/oneshot/requeue-failed-flow-run.ts --run-id <uuid> --apply    # land it
 *
 * Optional: --business-id <uuid> asserts the run belongs to that tenant.
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Exit codes: 0 requeued/no-op/dry-run · 1 Supabase error · 2 bad arg or refused.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { recordOneshotApplied } from "./_ledger";

type Args = { apply: boolean; runId: string | null; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, runId: null, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--run-id") args.runId = argv[++i] ?? null;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args.runId) {
    console.error("Required: --run-id <uuid> (the FAILED run to requeue)");
    process.exit(2);
  }
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: source, error } = await db
    .from("ai_flow_runs")
    .select("id, flow_id, business_id, status, last_error, created_at, context")
    .eq("id", args.runId)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!source) {
    console.error(`Run ${args.runId} not found.`);
    process.exit(2);
  }
  const run = source as {
    id: string;
    flow_id: string;
    business_id: string;
    status: string;
    last_error: string | null;
    created_at: string;
    context: { trigger?: Record<string, unknown> } | null;
  };
  if (args.businessId && run.business_id !== args.businessId) {
    console.error(
      `Run ${run.id} belongs to business ${run.business_id}, not ${args.businessId}. Refusing.`
    );
    process.exit(2);
  }
  if (run.status !== "failed") {
    console.error(
      `Run ${run.id} is "${run.status}", not "failed". Refusing: requeueing a ` +
        "non-failed run double-sends or races the worker."
    );
    process.exit(2);
  }
  const trigger = run.context?.trigger ?? null;
  if (!trigger || typeof trigger !== "object") {
    console.error(`Run ${run.id} has no trigger in context; cannot re-derive the run.`);
    process.exit(2);
  }

  // Idempotency: one requeue per source run, whatever became of it.
  const { data: prior, error: priorErr } = await db
    .from("ai_flow_runs")
    .select("id, status")
    .eq("flow_id", run.flow_id)
    .eq("context->trigger->>requeued_from", run.id)
    .limit(1);
  if (priorErr) {
    console.error(`Requeue-marker lookup failed: ${priorErr.message}`);
    process.exit(1);
  }
  if ((prior ?? []).length > 0) {
    const p = (prior as Array<{ id: string; status: string }>)[0];
    console.log(`Already requeued as ${p.id} (${p.status}). Nothing to do.`);
    return;
  }

  const { data: flowRow } = await db
    .from("ai_flows")
    .select("name, enabled")
    .eq("id", run.flow_id)
    .maybeSingle();

  console.log(`Source run : ${run.id} (failed ${run.created_at})`);
  console.log(`Business   : ${run.business_id}`);
  console.log(
    `Flow       : ${(flowRow as { name?: string } | null)?.name ?? run.flow_id} ` +
      `(enabled: ${(flowRow as { enabled?: boolean } | null)?.enabled ?? "?"})`
  );
  console.log(`Failure    : ${(run.last_error ?? "").slice(0, 200)}`);
  console.log(`Trigger    : ${JSON.stringify(trigger).slice(0, 300)}`);

  if (!args.apply) {
    console.log("\n[dry-run] Would insert a fresh queued run with this trigger");
    console.log("(plus requeued_from marker) and empty vars. Re-run with --apply.");
    return;
  }

  const { data: inserted, error: insErr } = await db
    .from("ai_flow_runs")
    .insert({
      flow_id: run.flow_id,
      business_id: run.business_id,
      status: "queued",
      context: { trigger: { ...trigger, requeued_from: run.id }, vars: {} }
    })
    .select("id")
    .single();
  if (insErr) {
    console.error(`Insert failed: ${insErr.message}`);
    process.exit(1);
  }
  const newId = (inserted as { id: string }).id;
  console.log(`\n  -> requeued as ${newId} (the worker picks it up on its next tick).`);
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "requeue-failed-flow-run.ts",
    businessId: run.business_id,
    details: {
      source_run_id: run.id,
      new_run_id: newId,
      flow_id: run.flow_id,
      source_error: (run.last_error ?? "").slice(0, 200)
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
