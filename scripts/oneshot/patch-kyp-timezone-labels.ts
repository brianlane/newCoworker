#!/usr/bin/env tsx
/**
 * One-shot: stop KYP's two calendar flows from stating a timezone they had
 * to guess.
 *
 * Aug 5 2026, Reem (Europe/London): the pre-call reminder texted her that a
 * 13:00Z call was "coming up today at 2:00 PM Eastern time (your local
 * time)". It was 2:00 PM UK. When she corrected it the assistant doubled
 * down, and 47 minutes later told her no call was starting while hers was
 * seven minutes away. She canceled.
 *
 * The trigger payload was right the whole time. It carried
 * `invitee timezone: Europe/London` AND
 * `starts (invitee local time): Wednesday, August 5, 2026 at 2:00 PM`. The
 * extraction contract was wrong: `invitee_tz_plain` offered a closed
 * five-item NORTH AMERICAN list and said to return 'Eastern' when unclear,
 * so a London invitee had no correct answer available.
 *
 * What this applies, to BOTH "Pre-call reminder (1hr before)" and "Booking
 * confirmation (SMS + email)":
 *
 *   - drops the `invitee_tz_plain` extract field entirely;
 *   - rewrites customer copy to "{{vars.invitee_local_time}} your time",
 *     naming no zone at all. That value already IS the invitee's own wall
 *     clock, so the sentence is true for every invitee and there is nothing
 *     left to get wrong;
 *   - keeps a zone in the OWNER notify only, because it goes to James and a
 *     bare "2:00 PM" is exactly the ambiguity that started this. It renders
 *     the new `invitee_timezone_iana`, copied verbatim off the payload's
 *     `invitee timezone:` line, so it cannot be invented;
 *   - retargets `invitee_local_time` at copying rather than converting.
 *
 * Transforms the LIVE definition in place rather than overwriting it with a
 * builder. That is the Jul 2026 lesson on this exact tenant: an unledgered
 * live reshape made the old kyp-offer-definition.ts stale, and re-applying
 * it would have reverted the account. As a second guard the transformed
 * result is compared against kyp-reminder-flow-definition.ts and the apply
 * REFUSES on any mismatch, so a live shape that has drifted since the
 * builder was reconciled cannot be silently overwritten (--force overrides).
 *
 * Idempotent: a flow already carrying the fix is reported and skipped.
 * Validates through parseAiFlowDefinition before writing, prints the previous
 * definition for rollback, dry-run by default, and records in
 * applied_oneshots.
 *
 * Runs in flight are safe: this never adds or removes a STEP, only fields and
 * copy, so flat step indices are unchanged and parked runs resume where they
 * were. A run parked mid-flight simply renders the new copy.
 *
 * Usage:
 *   npx tsx scripts/oneshot/patch-kyp-timezone-labels.ts --business <uuid>
 *   npx tsx scripts/oneshot/patch-kyp-timezone-labels.ts --business <uuid> --apply
 */
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { parseAiFlowDefinition } from "../../src/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";
import {
  buildKypBookingConfirmationDefinition,
  buildKypPreCallReminderDefinition,
  INVITEE_LOCAL_TIME_FIELD,
  INVITEE_TIMEZONE_IANA_FIELD,
  KYP_BOOKING_CONFIRMATION_FLOW_NAME,
  KYP_REMINDER_FLOW_NAME
} from "./kyp-reminder-flow-definition";

/** The field this patch exists to delete. */
const TZ_PLAIN = "invitee_tz_plain";
const TZ_PLAIN_VAR = `{{vars.${TZ_PLAIN}}}`;

/**
 * Customer copy: " {{vars.invitee_tz_plain}} time (your local time)" becomes
 * " your time". Matched as a whole phrase so a partial edit of that sentence
 * is reported as drift rather than half-rewritten.
 */
const CUSTOMER_ZONE_PHRASE = ` ${TZ_PLAIN_VAR} time (your local time)`;
const CUSTOMER_ZONE_REPLACEMENT = " your time";

/** Owner copy keeps a zone, as a verbatim IANA id. */
const OWNER_ZONE_REPLACEMENT = ` invitee local time ({{vars.${INVITEE_TIMEZONE_IANA_FIELD.name}}})`;

type FieldJson = { name?: string; description?: string };
type StepJson = {
  id?: string;
  type?: string;
  fields?: FieldJson[];
  body?: string;
  message?: string;
};
type DefinitionJson = { steps?: StepJson[] };

export type TransformResult = {
  definition: DefinitionJson;
  changed: boolean;
  notes: string[];
};

/**
 * Rewrite ONE live definition. Pure and exported so
 * tests/oneshot-kyp-definitions.test.ts can pin its output against the
 * canonical builder, the same way the bad-phone patch is pinned.
 */
export function stripGuessedTimezone(input: unknown): TransformResult {
  const definition = structuredClone(input) as DefinitionJson;
  const notes: string[] = [];
  let changed = false;

  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  if (steps.length === 0) {
    return { definition, changed: false, notes: ["wrong flow shape: no steps"] };
  }

  // Does anything in this flow speak to the OWNER? Only then is a zone worth
  // extracting at all; the reminder flow has no notify_owner and therefore
  // needs no zone variable whatsoever.
  const hasOwnerNotify = steps.some((s) => s.type === "notify_owner");

  for (const step of steps) {
    if (step.type === "extract_text" && Array.isArray(step.fields)) {
      const before = step.fields.length;
      step.fields = step.fields.filter((f) => f.name !== TZ_PLAIN);
      if (step.fields.length !== before) {
        changed = true;
        notes.push(`${step.id}: dropped the ${TZ_PLAIN} field`);
      }

      const localTime = step.fields.find((f) => f.name === INVITEE_LOCAL_TIME_FIELD.name);
      if (localTime && localTime.description !== INVITEE_LOCAL_TIME_FIELD.description) {
        localTime.description = INVITEE_LOCAL_TIME_FIELD.description;
        changed = true;
        notes.push(`${step.id}: ${INVITEE_LOCAL_TIME_FIELD.name} now copies instead of converting`);
      }

      const hasIana = step.fields.some((f) => f.name === INVITEE_TIMEZONE_IANA_FIELD.name);
      if (hasOwnerNotify && !hasIana) {
        // Same slot the dropped field occupied: after invitee_local_time, so
        // the builder and this transform agree on field ORDER too.
        const at = step.fields.findIndex((f) => f.name === INVITEE_LOCAL_TIME_FIELD.name);
        step.fields.splice(at + 1, 0, { ...INVITEE_TIMEZONE_IANA_FIELD });
        changed = true;
        notes.push(`${step.id}: added ${INVITEE_TIMEZONE_IANA_FIELD.name} for the owner notify`);
      }
      continue;
    }

    if (step.type === "notify_owner" && typeof step.message === "string") {
      if (step.message.includes(TZ_PLAIN_VAR)) {
        step.message = step.message.replace(` ${TZ_PLAIN_VAR}`, OWNER_ZONE_REPLACEMENT);
        changed = true;
        notes.push(`${step.id}: owner notify now names the invitee's zone verbatim`);
      }
      continue;
    }

    for (const key of ["body", "message"] as const) {
      const text = step[key];
      if (typeof text !== "string" || !text.includes(TZ_PLAIN_VAR)) continue;
      if (!text.includes(CUSTOMER_ZONE_PHRASE)) {
        notes.push(
          `${step.id}: ${key} references ${TZ_PLAIN} but not in the expected phrase; ` +
            "left untouched, resolve by hand"
        );
        continue;
      }
      step[key] = text.split(CUSTOMER_ZONE_PHRASE).join(CUSTOMER_ZONE_REPLACEMENT);
      changed = true;
      notes.push(`${step.id}: ${key} now says "your time" and names no zone`);
    }
  }

  if (!changed) notes.push("already patched (nothing referenced the guessed zone)");
  return { definition, changed, notes };
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

/** Stable key ordering, so a builder/live comparison ignores key order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])])
    );
  }
  return value;
}

const TARGETS: Array<{ name: string; build: () => Record<string, unknown> }> = [
  { name: KYP_REMINDER_FLOW_NAME, build: buildKypPreCallReminderDefinition },
  { name: KYP_BOOKING_CONFIRMATION_FLOW_NAME, build: buildKypBookingConfirmationDefinition }
];

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

  const patched: string[] = [];

  for (const target of TARGETS) {
    const { data: row, error } = await db
      .from("ai_flows")
      .select("id, name, enabled, definition")
      .eq("business_id", businessId)
      .eq("name", target.name)
      .maybeSingle();
    if (error) {
      console.error(`Read failed for "${target.name}": ${error.message}`);
      process.exit(1);
    }
    if (!row) {
      console.error(`No "${target.name}" flow for ${businessId}`);
      process.exit(1);
    }

    console.log(`\n=== ${target.name} (${row.id}, enabled=${row.enabled}) ===`);
    console.log(`Previous definition (for rollback):\n${JSON.stringify(row.definition)}`);

    const result = stripGuessedTimezone(row.definition);
    for (const note of result.notes) console.log(`  - ${note}`);
    if (!result.changed) continue;

    // Drift guard: the transformed live shape must equal the canonical
    // builder. If it does not, the flow was edited outside the ledger since
    // the builder was reconciled, and blindly writing would revert that edit.
    const expected = JSON.stringify(canonical(target.build()));
    const actual = JSON.stringify(canonical(result.definition));
    if (actual !== expected) {
      console.error(
        `  ! DRIFT: the patched live shape does not match ` +
          `kyp-reminder-flow-definition.ts. The flow was changed outside the ledger. ` +
          `Reconcile the builder to live FIRST (live is source of truth), then re-run.` +
          (args.force ? " Continuing anyway (--force)." : " Refusing to write.")
      );
      console.error(`  expected: ${expected}`);
      console.error(`  actual:   ${actual}`);
      if (!args.force) process.exit(1);
    }

    try {
      parseAiFlowDefinition(result.definition);
    } catch (e) {
      console.error(`  ! Patched definition is invalid: ${(e as Error).message}`);
      process.exit(1);
    }

    if (!args.apply) {
      console.log("  [dry-run] Not writing. Re-run with --apply.");
      continue;
    }

    const { error: writeErr } = await db
      .from("ai_flows")
      .update({ definition: result.definition })
      .eq("id", row.id);
    if (writeErr) {
      console.error(`  ! Write failed: ${writeErr.message}`);
      process.exit(1);
    }
    console.log("  Written.");
    patched.push(`${target.name} (${row.id})`);
  }

  if (args.apply && patched.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1],
      businessId,
      details: { flows: patched, removedField: TZ_PLAIN }
    });
  }
  console.log(`\nDone. ${patched.length} flow(s) written.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
