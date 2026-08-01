#!/usr/bin/env tsx
/**
 * One-shot: teach Amy's Clever group-reply Intro flow the second intro template.
 *
 * Incident (Jul 31 2026): Clever's fixed group line texted "Hi Donna, meet
 * your top-rated local Clever agent! ... Amy, when is the soonest you can
 * give Donna a quick call?" and no flow matched. The live "Clever Lead -
 * Group Reply Intro Notify me" trigger requires BOTH "Clever Real Estate"
 * AND "introduce you to Amy" in the window text, and the new template
 * contains neither phrase, so nothing enqueued, suppressDefaultReply never
 * applied, the default assistant answered inside the group thread, and its
 * escalation paged the owner with the thread label ("Clever Group Intro")
 * instead of the branded greeting going out. Three occurrences since Jul 1
 * 2026 (Jul 8, then Kevin and Donna on Jul 31), none matched, verified in
 * sms_inbound_jobs.
 *
 * The fix appends ONE extra OR trigger (definition.triggers) to the Intro
 * flow, keyed on Clever's fixed group line plus two stable fragments of the
 * new wording ("meet your", "Clever agent"). Classic intros contain neither
 * fragment, so the two triggers cannot both fire on the same message. The
 * sibling "Clever Lead - Group Reply Connected" flow is deliberately left
 * unchanged (owner decision, Aug 1 2026: greet only), and the disabled
 * "... (OLD)" copy is never touched (this script targets the enabled flow
 * by id).
 *
 * Read-modify-write; idempotent (a re-run detects the fragment and no-ops).
 * Validates the patched definition through the SAME parseAiFlowDefinition
 * the dashboard uses before writing. Prints the PREVIOUS definition
 * verbatim so the run's own output is the rollback artifact. Dry-run by
 * default; --apply records the change in the applied_oneshots ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-clever-group-reply-second-intro.ts            # dry run
 *   npx tsx scripts/oneshot/patch-clever-group-reply-second-intro.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg,
 * flow missing/renamed/disabled, or invalid patched definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

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

/**
 * Live row verified 2026-08-01. The disabled "Clever Lead - Group Reply
 * Intro Notify me (OLD)" copy has a different id and must never be edited;
 * targeting by id makes that structural, and main() still asserts the name
 * and enabled flag so a renamed or disabled row aborts loudly.
 */
export const INTRO_FLOW_ID = "b7739092-4aba-4b54-9901-29b54a519ba2";
export const INTRO_FLOW_NAME = "Clever Lead - Group Reply Intro Notify me";

/** Clever's fixed group-intro line, already pinned by the flow's main trigger. */
export const CLEVER_GROUP_FROM = "3144708990";

type Condition = { type?: string; value?: string; caseInsensitive?: boolean };
type Trigger = {
  channel?: string;
  correlationWindowMinutes?: number;
  conditions?: Condition[];
} & Record<string, unknown>;
type Definition = {
  trigger?: Trigger;
  triggers?: Trigger[];
} & Record<string, unknown>;

/**
 * The extra OR trigger for the second template. Anchors: the fixed sender
 * line plus two fragments chosen to survive minor rewording of the observed
 * head "meet your top-rated local Clever agent!". The classic intro ("this
 * is Team from Clever Real Estate! ... I'd like to introduce you to Amy
 * Laidlaw") contains neither fragment, so this adds coverage without
 * overlapping the main trigger.
 */
export const SECOND_INTRO_TRIGGER: Trigger = {
  channel: "sms",
  correlationWindowMinutes: 3,
  conditions: [
    { type: "from_matches", value: CLEVER_GROUP_FROM },
    { type: "contains", value: "meet your", caseInsensitive: true },
    { type: "contains", value: "Clever agent", caseInsensitive: true }
  ]
};

/** Idempotency key: no live Clever trigger carries this fragment today. */
const SECOND_INTRO_FRAGMENT = "meet your";

/**
 * Append SECOND_INTRO_TRIGGER to definition.triggers (the OR set). Pure and
 * idempotent: when any trigger already carries a contains condition with the
 * "meet your" fragment, the definition is returned untouched (second run is
 * a byte-identical no-op).
 */
export function addSecondIntroTrigger(def: Definition): boolean {
  const all: Trigger[] = [def.trigger ?? {}, ...(def.triggers ?? [])];
  const already = all.some(
    (t) =>
      Array.isArray(t.conditions) &&
      t.conditions.some((c) => c.type === "contains" && c.value === SECOND_INTRO_FRAGMENT)
  );
  if (already) return false;
  def.triggers = [...(def.triggers ?? []), structuredClone(SECOND_INTRO_TRIGGER)];
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

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", businessId)
    .eq("id", INTRO_FLOW_ID)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(
      `No flow with id ${INTRO_FLOW_ID} for business ${businessId}. Nothing written.`
    );
    process.exit(2);
  }
  if (row.name !== INTRO_FLOW_NAME || row.enabled !== true) {
    console.error(
      `Flow ${row.id} differs from planning time (name="${row.name}", enabled=${row.enabled}); ` +
        `expected name="${INTRO_FLOW_NAME}", enabled=true. Re-verify the live row. Nothing written.`
    );
    process.exit(2);
  }

  console.log(`[oneshot] PREVIOUS definition of "${row.name}" (keep this for rollback):`);
  console.log(JSON.stringify(row.definition, null, 2));

  const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
  if (!addSecondIntroTrigger(def)) {
    console.log(`\n"${row.name}" already carries the second-intro trigger. Nothing to do.`);
    return;
  }

  try {
    parseAiFlowDefinition(def);
  } catch (err) {
    console.error(`\nPatched "${row.name}" would be INVALID; aborting before any write:`);
    if (err instanceof AiFlowValidationError) {
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error(err);
    }
    process.exit(2);
  }

  console.log(`\n[oneshot] AFTER definition.triggers: ${JSON.stringify(def.triggers)}`);

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to update the flow.");
    return;
  }

  const { error: updErr } = await db
    .from("ai_flows")
    .update({ definition: def })
    .eq("id", row.id);
  if (updErr) {
    console.error(`Update failed: ${updErr.message}`);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "patch-clever-group-reply-second-intro.ts",
    businessId,
    details: { flows: [{ id: row.id, name: row.name }], added: "second-intro OR trigger" }
  });
  console.log(`\nDone. "${row.name}" now also fires on the second intro template.`);
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helpers above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
