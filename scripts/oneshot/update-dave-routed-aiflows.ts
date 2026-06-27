#!/usr/bin/env tsx
/**
 * One-shot: patch a tenant's LIVE AiFlows for two changes, in place (idempotent).
 *
 * 1. "Accept WITH a timeframe" option on every route step pinned to ONE agent
 *    (default "Dave Lane"): append a new numbered option to the offer SMS —
 *    `Reply <n> with a timeframe to claim and tell us when you'll reach out
 *    (e.g. "<n>, 20 min")` where <n> is one greater than the highest single-digit
 *    option already shown (86 is ignored). The engine (telnyx-sms-inbound +
 *    ai-flow-worker, this PR) parses the comma'd reply as a claim and surfaces the
 *    ETA to the owner. Skips a step whose offer already advertises it.
 *
 * 2. HomeLight email FALLBACK: insert the `email_extract` step ("email_card")
 *    after the portal contact-card browse so a delayed/empty portal card is
 *    backfilled (phone/email/address) from the HomeLight alert email. Skips when
 *    the flow already has an "email_card" step.
 *
 * Patches the existing rows (no re-seed) so any manual edits are preserved, and
 * re-validates each modified definition through the SAME parseAiFlowDefinition the
 * dashboard uses before writing. Dry-run by default; prints the before/after
 * definition of each changed flow for rollback.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/update-dave-routed-aiflows.ts            # dry run
 *   npx tsx scripts/oneshot/update-dave-routed-aiflows.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_DAVE_AGENT_NAME (default "Dave Lane"),
 *   AIFLOW_HOMELIGHT_EMAIL_CONNECTION_ID (default Amy's Outlook),
 *   AIFLOW_HOMELIGHT_EMAIL_FROM_CONTAINS (default "homelight.com"),
 *   AIFLOW_HOMELIGHT_EMAIL_LOOKBACK_MIN (default 60).
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  parseAiFlowDefinition,
  AiFlowValidationError
} from "@/lib/ai-flows/schema";

type Args = { apply: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const DEFAULT_EMAIL_CONNECTION_ID = "9ddd5344-14f2-46df-a89d-dddc2d50e944";

/** Idempotency marker: this exact phrase appears only in the appended option. */
const TIMEFRAME_OPTION_MARKER = "with a timeframe to claim";

type Step = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: Step[] } & Record<string, unknown>;

/** Highest single-digit option already shown in the offer (86 excluded), or 1. */
export function highestOptionDigit(offerTemplate: string): number {
  const digits = [...offerTemplate.matchAll(/\b([1-9])\b/g)].map((m) => Number(m[1]));
  return digits.length > 0 ? Math.max(...digits) : 1;
}

/** The appended option line for option number `n`. */
export function timeframeOptionLine(n: number): string {
  return (
    `\nReply ${n} with a timeframe to claim and tell us when you'll reach out ` +
    `(e.g. "${n}, 20 min").`
  );
}

/**
 * Append the timeframe option to every route_to_team step pinned to `agentName`
 * that doesn't already have it. Returns whether anything changed.
 */
export function addTimeframeOption(def: Definition, agentName: string): boolean {
  let changed = false;
  for (const step of def.steps ?? []) {
    if (step.type !== "route_to_team") continue;
    if (typeof step.agentName !== "string" || step.agentName.trim() !== agentName) continue;
    const offer = typeof step.offerTemplate === "string" ? step.offerTemplate : "";
    if (!offer || offer.includes(TIMEFRAME_OPTION_MARKER)) continue;
    const n = highestOptionDigit(offer) + 1;
    step.offerTemplate = offer + timeframeOptionLine(n);
    // Stamp the digit so the engine treats "<n>, <eta>" (and a bare <n>) as the
    // accept-with-timeframe option — never as a pass.
    step.claimTimeframeOption = n;
    changed = true;
  }
  return changed;
}

/**
 * Insert the HomeLight email-fallback step after the portal contact-card step
 * ("card") when the flow doesn't already have an "email_card". Returns whether
 * anything changed.
 */
export function addHomeLightEmailFallback(
  def: Definition,
  cfg: { connectionId: string; fromContains: string; lookbackMinutes: number }
): boolean {
  const steps = def.steps ?? [];
  if (steps.some((s) => s.id === "email_card")) return false;
  const cardIdx = steps.findIndex((s) => s.id === "card" && s.type === "browse_extract");
  if (cardIdx < 0) return false;
  const emailCard: Step = {
    id: "email_card",
    type: "email_extract",
    connectionId: cfg.connectionId,
    fromContains: cfg.fromContains,
    matchTemplates: ["{{vars.lead_first_name}}", "{{vars.city}}"],
    lookbackMinutes: cfg.lookbackMinutes,
    fillOnlyEmpty: true,
    when: { var: "claimed_agent", notEquals: "none" },
    fields: [
      {
        name: "lead_phone",
        description: "The lead's phone number, labeled 'Phone' in the HomeLight email"
      },
      {
        name: "lead_email",
        description: "The lead's email, labeled 'Email' in the HomeLight email, or 'none'"
      },
      {
        name: "lead_address",
        description: "The property street address, labeled 'Address' in the HomeLight email"
      }
    ]
  };
  steps.splice(cardIdx + 1, 0, emailCard);
  def.steps = steps;
  return true;
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
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;
  const agentName = process.env.AIFLOW_DAVE_AGENT_NAME ?? "Dave Lane";
  const emailCfg = {
    connectionId:
      process.env.AIFLOW_HOMELIGHT_EMAIL_CONNECTION_ID ?? DEFAULT_EMAIL_CONNECTION_ID,
    fromContains: process.env.AIFLOW_HOMELIGHT_EMAIL_FROM_CONTAINS ?? "homelight.com",
    lookbackMinutes: Number(process.env.AIFLOW_HOMELIGHT_EMAIL_LOOKBACK_MIN ?? "60")
  };

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: rows, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .order("name");
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }

  let changedCount = 0;
  for (const row of (rows ?? []) as Array<{ id: string; name: string; definition: Definition }>) {
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const before = JSON.stringify(row.definition);

    const tf = addTimeframeOption(def, agentName);
    // The email fallback only applies to the HomeLight flow (the one with the
    // portal contact-card step); addHomeLightEmailFallback no-ops otherwise.
    const email = addHomeLightEmailFallback(def, emailCfg);
    if (!tf && !email) continue;

    // Re-validate the patched definition exactly like the dashboard/CRUD path.
    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      console.error(`\nFlow "${row.name}" (${row.id}) would become INVALID — skipping:`);
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }

    changedCount += 1;
    console.log(`\n=== ${row.name} (${row.id}) ===`);
    console.log(`  timeframe option: ${tf ? "added" : "unchanged"}`);
    console.log(`  homelight email fallback: ${email ? "added" : "n/a"}`);
    console.log(`  BEFORE: ${before}`);
    console.log(`  AFTER : ${JSON.stringify(def)}`);

    if (args.apply) {
      const { error: upErr } = await db
        .from("ai_flows")
        .update({ definition: def })
        .eq("id", row.id);
      if (upErr) {
        console.error(`Update failed for ${row.id}: ${upErr.message}`);
        process.exit(1);
      }
      console.log("  -> updated.");
    }
  }

  if (changedCount === 0) {
    console.log("\nNo flows needed changes (already patched).");
  } else if (!args.apply) {
    console.log(`\n[dry-run] ${changedCount} flow(s) would change. Re-run with --apply to write.`);
  } else {
    console.log(`\nPatched ${changedCount} flow(s).`);
  }
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helpers above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
