#!/usr/bin/env tsx
/**
 * One-shot: give KYP's "Lead follow-up (white-glove build)" flow a real
 * bad-phone intake arm, modeled on Amy's bad-phone-report path (owner is
 * told, lead is emailed a booking link and asked for a working number).
 *
 * Aug 1 2026: a Facebook lead typed +16133439985030 (a real Ottawa number
 * plus 3 stray digits) into the lead form. The undialable value passed every
 * isE164 short-circuit, Telnyx rejected it (400/40310), and the run died at
 * the greeting with the owner-notify step still behind it. The engine-side
 * fix (coerceDialableE164 plus the sanitizeExtractedPhone NANP rule) now
 * turns that lead_phone into "none" and the sends into graceful skips, but
 * the flow itself then claims "I sent them the greeting" while the lead
 * silently ages out of the reply ladder. This patch makes the no-phone case
 * a designed path instead of a fib:
 *
 *   - s_bad_phone_notify (notify_owner, when lead_phone equals "none"):
 *     names the lead and their email, says the number was untextable.
 *   - s_bad_phone_email (send_email, when lead_phone equals "none"): emails
 *     the lead the booking link and asks for a working number. A lead with
 *     no email takes the planner's no_recipient_email skip.
 *   - s_notify and s_wait_1 gain `when lead_phone notEquals "none"`, so the
 *     "I sent them the greeting" wording stays true and the reply ladder
 *     collapses immediately (every later step keys on reply_* vars that are
 *     then never set).
 *
 * Known edge, accepted: an extraction that yields the empty string (a
 * payload with no digits at all) rather than "none" keeps today's behavior
 * (greet skips, s_notify still fires).
 *
 * Transforms the LIVE definition in place rather than overwriting it with a
 * builder (the Jul 2026 builder drift is why: an unledgered live reshape
 * made the old kyp-offer-definition.ts stale, and re-applying it would have
 * reverted the tenant). The step copy is imported from
 * kyp-lead-flow-definition.ts, the reconciled canonical builder, and
 * tests/oneshot-kyp-definitions.test.ts pins this transform's output to
 * that builder exactly, so the two cannot disagree.
 *
 * Idempotent: already-present steps and guards are reported and skipped. A
 * custom `when` already sitting on s_notify or s_wait_1 is never clobbered
 * (reported instead). Validates through parseAiFlowDefinition before
 * writing, prints the previous definition for rollback, dry-run by default,
 * and records the apply in applied_oneshots.
 *
 * Runs in flight are safe: inserting steps shifts flat indices, but the
 * engine re-anchors every parked run through its __resume_step_id marker
 * (resolveResumeIndex in _shared/ai_flows/branching.ts), and this patch
 * never removes a step id. The apply refuses only when an in-flight run
 * LACKS that marker (a legacy run would resume at a shifted raw index and
 * re-execute steps); --force overrides.
 *
 * Deploy the engine fix BEFORE running this: without it a bad phone keeps
 * its junk value instead of "none" and neither arm fires. Safe either way.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-kyp-bad-phone-intake.ts --business <uuid>           # dry run
 *   npx tsx scripts/oneshot/patch-kyp-bad-phone-intake.ts --business <uuid> --apply   # write
 *
 * Business id comes from --business, AIFLOW_KYP_BUSINESS_ID, or
 * KYP_BUSINESS_ID; it is never hard-coded here.
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg or
 * invalid definition · 3 runs in flight (re-run later or --force).
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";
import {
  BAD_PHONE_EMAIL_ID,
  BAD_PHONE_NOTIFY_ID,
  KYP_FLOW_NAME,
  kypBadPhoneSteps,
  WHEN_HAS_PHONE
} from "./kyp-lead-flow-definition";

const EXTRACT_ID = "s_extract";
const NOTIFY_ID = "s_notify";
const FIRST_WAIT_ID = "s_wait_1";

type Step = Record<string, unknown> & { id?: string; type?: string; when?: { var?: string } };

export type PatchResult = { changed: boolean; notes: string[] };

/**
 * Apply the bad-phone arm to a LIVE definition, in place. Pure and
 * idempotent so tests can drive it against a fixture; every piece is checked
 * before it is added, and an unexpected shape is a note, never a clobber.
 */
export function addBadPhoneIntakeArm(definition: { steps?: Step[] }): PatchResult {
  const notes: string[] = [];
  let changed = false;
  const steps = definition.steps;
  if (!Array.isArray(steps)) return { changed, notes: ["definition has no steps array"] };

  const extractIdx = steps.findIndex((s) => s.id === EXTRACT_ID && s.type === "extract_text");
  if (extractIdx === -1) {
    return { changed, notes: [`no ${EXTRACT_ID} extract_text step; wrong flow shape`] };
  }

  if (steps.some((s) => s.id === BAD_PHONE_NOTIFY_ID || s.id === BAD_PHONE_EMAIL_ID)) {
    notes.push("bad-phone steps already present");
  } else {
    steps.splice(extractIdx + 1, 0, ...(kypBadPhoneSteps() as Step[]));
    notes.push(`inserted ${BAD_PHONE_NOTIFY_ID} + ${BAD_PHONE_EMAIL_ID} after ${EXTRACT_ID}`);
    changed = true;
  }

  for (const id of [NOTIFY_ID, FIRST_WAIT_ID]) {
    const step = steps.find((s) => s.id === id);
    if (!step) {
      notes.push(`no ${id} step; guard not applied`);
      continue;
    }
    const when = step.when as Record<string, unknown> | undefined;
    if (!when) {
      step.when = { ...WHEN_HAS_PHONE };
      notes.push(`guarded ${id} with lead_phone notEquals none`);
      changed = true;
    } else if (
      when.var === WHEN_HAS_PHONE.var &&
      when.notEquals === WHEN_HAS_PHONE.notEquals
    ) {
      notes.push(`${id} already guarded`);
    } else {
      notes.push(`${id} carries an unexpected when (${JSON.stringify(when)}); left untouched`);
    }
  }

  return { changed, notes };
}

type Args = { apply: boolean; force: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, force: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--force") args.force = true;
    else if (a === "--business") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const businessId =
    args.businessId ?? process.env.AIFLOW_KYP_BUSINESS_ID ?? process.env.KYP_BUSINESS_ID ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(businessId)) {
    console.error("Pass --business <uuid> (or set AIFLOW_KYP_BUSINESS_ID / KYP_BUSINESS_ID)");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", businessId)
    .eq("name", KYP_FLOW_NAME)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`No "${KYP_FLOW_NAME}" flow for ${businessId}`);
    process.exit(1);
  }

  console.log(`=== ${KYP_FLOW_NAME} (${row.id}, enabled=${row.enabled}) ===`);
  console.log(`Previous definition (for rollback):\n${JSON.stringify(row.definition)}`);

  // Inserting steps shifts flat indices, which is fine for parked runs that
  // carry the __resume_step_id marker (the engine re-anchors them by id).
  // A legacy run WITHOUT the marker would resume at a shifted raw index and
  // re-execute steps, so only that case blocks the apply.
  const { data: liveRuns, error: runsErr } = await db
    .from("ai_flow_runs")
    .select("id, status, context")
    .eq("flow_id", row.id)
    .not("status", "in", "(done,failed,canceled)");
  if (runsErr) {
    console.error(`Run check failed: ${runsErr.message}`);
    process.exit(1);
  }
  const inFlight = (liveRuns ?? []) as Array<{
    id: string;
    status: string;
    context: { vars?: Record<string, unknown> } | null;
  }>;
  const unmarked = inFlight.filter((r) => {
    const marker = r.context?.vars?.["__resume_step_id"];
    return typeof marker !== "string" || marker.length === 0;
  });
  if (inFlight.length > 0) {
    console.log(
      `${inFlight.length} run(s) in flight (${unmarked.length} without a resume marker).`
    );
  }

  const patched = structuredClone(row.definition) as { steps?: Step[] };
  const result = addBadPhoneIntakeArm(patched);
  for (const note of result.notes) console.log(`- ${note}`);
  if (!result.changed) {
    console.log("Nothing to change. Already applied.");
    return;
  }

  let validated;
  try {
    validated = parseAiFlowDefinition(patched);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("Patched definition failed validation:");
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error("Patched definition failed validation:", err);
    }
    process.exit(2);
  }

  console.log(
    `Step order: ${(patched.steps ?? []).map((s) => s.id).join(" -> ")}`
  );

  if (!args.apply) {
    console.log("[dry-run] Not writing. Re-run with --apply.");
    return;
  }

  if (unmarked.length > 0 && !args.force) {
    console.error(
      `Refusing to apply: ${unmarked.length} in-flight run(s) lack the __resume_step_id ` +
        `marker and would resume at a shifted index: ${unmarked
          .map((r) => `${r.id} (${r.status})`)
          .join(", ")}. Re-run after they settle, or --force.`
    );
    process.exit(3);
  }

  const { error: upErr } = await db
    .from("ai_flows")
    .update({ definition: validated, updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("business_id", businessId);
  if (upErr) {
    console.error(`Update failed: ${upErr.message}`);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1],
    businessId,
    details: {
      flow_id: row.id,
      flow_name: KYP_FLOW_NAME,
      inserted: [BAD_PHONE_NOTIFY_ID, BAD_PHONE_EMAIL_ID],
      guarded: [NOTIFY_ID, FIRST_WAIT_ID]
    }
  });
  console.log("Updated.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
