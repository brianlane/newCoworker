#!/usr/bin/env tsx
/**
 * One-shot: stop KYP's two calendar flows from quoting the literal word
 * 'none' at a customer when the Calendly payload was missing a detail.
 *
 * Fleet fallback-composition audit, Aug 27 2026. The booking confirmation's
 * email and SMS compose "your free strategy call on
 * {{vars.invitee_day_date}} at {{vars.invitee_local_time}} your time", and
 * the pre-call reminder composes "coming up today at
 * {{vars.invitee_local_time}} your time". `invitee_day_date` and `zoom_link`
 * fall back to the literal 'none', so a payload missing its usual lines
 * would have a LEAD reading "call on none at none your time" and a link line
 * of "Here's your link: none". Zero misses have happened across 57 runs, but
 * the send steps carried no guard at all, so the first malformed payload
 * would have garbled straight at a customer. Same bug class as Amy's cadence
 * fix (PR #1673), where the fallback case turned out to be the COMMON case.
 *
 * WHAT THIS APPLIES, to BOTH "Pre-call reminder (1hr before)" and "Booking
 * confirmation (SMS + email)":
 *
 *   - a details-known gate field per flow (`booking_details_known` /
 *     `reminder_details_known`): one yes/no fact covering every detail the
 *     specific copy quotes, because a `when` guard can test one var only;
 *   - every customer send becomes a guarded PAIR: the existing specific copy
 *     runs on gate 'yes', and a new generic sibling that points at the
 *     calendar invite runs otherwise (equals/notEquals on the same value is
 *     exhaustive, so exactly one fires; a run parked from before the gate
 *     existed has no var and takes the safe generic copy);
 *   - the booking SMS needs lead_reachable AND the gate, and a step carries
 *     ONE `when`, so `confirm_sms` is wrapped in a `confirm_sms_gate` branch
 *     conditioned on lead_reachable with the pair nested inside;
 *   - the owner notify labels each fact ("Day: none" reads as a fact where
 *     "for none" read as gibberish). James keeps the verbatim IANA zone.
 *
 * UNLIKE the timezone patch, this one ADDS steps, which shifts flat step
 * indices. Parked runs address their position by flat index, so the apply
 * REFUSES when any non-terminal run sits at or past the first differing flat
 * index (both flows complete within seconds of their trigger, so in practice
 * the check passes or a minute's wait clears it). --force overrides.
 *
 * Transforms the LIVE definition in place (live is source of truth on this
 * tenant), then refuses to write unless the result equals the canonical
 * builder in kyp-reminder-flow-definition.ts, so an unledgered live edit
 * stops the apply instead of being silently reverted.
 *
 * Idempotent: a flow already carrying the fix is reported and skipped.
 * Validates through parseAiFlowDefinition before writing, prints the previous
 * definition for rollback, dry-run by default, and records in
 * applied_oneshots.
 *
 * Usage:
 *   npx tsx scripts/oneshot/patch-kyp-booking-missing-details.ts --business <uuid>
 *   npx tsx scripts/oneshot/patch-kyp-booking-missing-details.ts --business <uuid> --apply
 */
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { parseAiFlowDefinition } from "../../src/lib/ai-flows/schema";
import { flattenSteps } from "../../supabase/functions/_shared/ai_flows/branching";
import { recordOneshotApplied } from "./_ledger";
import {
  BOOKING_DETAILS_KNOWN_FIELD,
  buildKypBookingConfirmationDefinition,
  buildKypPreCallReminderDefinition,
  KYP_BOOKING_CONFIRMATION_EMAIL_BODY_MISSING,
  KYP_BOOKING_CONFIRMATION_FLOW_NAME,
  KYP_BOOKING_CONFIRMATION_NOTIFY,
  KYP_BOOKING_CONFIRMATION_SMS_BODY,
  KYP_BOOKING_CONFIRMATION_SMS_BODY_MISSING,
  KYP_BOOKING_CONFIRMATION_SUBJECT_MISSING,
  KYP_BOOKING_EMAIL_CONNECTION_ID,
  KYP_REMINDER_FLOW_NAME,
  KYP_REMINDER_SMS_BODY,
  KYP_REMINDER_SMS_BODY_MISSING,
  REMINDER_DETAILS_KNOWN_FIELD
} from "./kyp-reminder-flow-definition";

/** The pre-fix owner notify, matched exactly so drifted copy is never clobbered. */
export const NOTIFY_PRE_FIX =
  "New booking: {{vars.invitee_name}} for {{vars.invitee_day_date}} at {{vars.invitee_local_time}} invitee local time ({{vars.invitee_timezone_iana}}). Email: {{vars.invitee_email}}. Phone: {{vars.invitee_phone}}.";

type FieldJson = { name?: string; description?: string };
type StepJson = {
  id?: string;
  type?: string;
  fields?: FieldJson[];
  when?: unknown;
  body?: string;
  message?: string;
  [key: string]: unknown;
};
type DefinitionJson = { steps?: StepJson[] };

export type TransformResult = {
  definition: DefinitionJson;
  changed: boolean;
  notes: string[];
};

const HAND_WORK = "left untouched; resolve by hand";

function sameWhen(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function finishNotes(changed: boolean, notes: string[]): void {
  if (changed) return;
  notes.push(
    notes.some((n) => n.includes(HAND_WORK))
      ? "NOT patched: copy this patch does not recognize needs a hand rewrite first"
      : "already patched"
  );
}

/** Pre-call reminder: gate field + guarded reminder pair. */
export function addReminderMissingDetails(input: unknown): TransformResult {
  const definition = structuredClone(input) as DefinitionJson;
  const notes: string[] = [];
  let changed = false;

  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  const extract = steps.find((s) => s.type === "extract_text" && Array.isArray(s.fields));
  const smsIdx = steps.findIndex((s) => s.id === "reminder_sms" && s.type === "send_sms");
  if (!extract || smsIdx === -1) {
    return { definition, changed: false, notes: ["wrong flow shape: no extract_text / reminder_sms"] };
  }

  if (!extract.fields!.some((f) => f.name === REMINDER_DETAILS_KNOWN_FIELD.name)) {
    extract.fields!.push({ ...REMINDER_DETAILS_KNOWN_FIELD });
    changed = true;
    notes.push(`${extract.id}: added the ${REMINDER_DETAILS_KNOWN_FIELD.name} gate field`);
  }

  const sms = steps[smsIdx];
  const wantWhen = { var: REMINDER_DETAILS_KNOWN_FIELD.name, equals: "yes" };
  if (sms.when === undefined) {
    if (sms.body !== KYP_REMINDER_SMS_BODY) {
      notes.push(`reminder_sms: body differs from the canonical copy, ${HAND_WORK}`);
    } else {
      sms.when = wantWhen;
      changed = true;
      notes.push("reminder_sms: now guarded on the details gate");
    }
  } else if (!sameWhen(sms.when, wantWhen)) {
    notes.push(`reminder_sms: unexpected when, ${HAND_WORK}`);
  }

  if (!steps.some((s) => s.id === "reminder_sms_missing")) {
    if (sameWhen(steps[smsIdx].when, wantWhen)) {
      steps.splice(smsIdx + 1, 0, {
        id: "reminder_sms_missing",
        to: "{{vars.invitee_phone}}",
        body: KYP_REMINDER_SMS_BODY_MISSING,
        type: "send_sms",
        when: { var: REMINDER_DETAILS_KNOWN_FIELD.name, notEquals: "yes" }
      });
      changed = true;
      notes.push("added reminder_sms_missing (generic copy, calendar invite has the link)");
    } else {
      notes.push(`reminder_sms_missing not added while reminder_sms is unguarded, ${HAND_WORK}`);
    }
  }

  finishNotes(changed, notes);
  return { definition, changed, notes };
}

/** Booking confirmation: gate field + guarded email pair + SMS branch + labelled notify. */
export function addBookingMissingDetails(input: unknown): TransformResult {
  const definition = structuredClone(input) as DefinitionJson;
  const notes: string[] = [];
  let changed = false;

  const steps = Array.isArray(definition.steps) ? definition.steps : [];
  const extract = steps.find((s) => s.type === "extract_text" && Array.isArray(s.fields));
  const emailIdx = steps.findIndex((s) => s.id === "confirm_email" && s.type === "send_email");
  if (!extract || emailIdx === -1) {
    return { definition, changed: false, notes: ["wrong flow shape: no extract_text / confirm_email"] };
  }

  if (!extract.fields!.some((f) => f.name === BOOKING_DETAILS_KNOWN_FIELD.name)) {
    extract.fields!.push({ ...BOOKING_DETAILS_KNOWN_FIELD });
    changed = true;
    notes.push(`${extract.id}: added the ${BOOKING_DETAILS_KNOWN_FIELD.name} gate field`);
  }

  const gateYes = { var: BOOKING_DETAILS_KNOWN_FIELD.name, equals: "yes" };
  const gateNo = { var: BOOKING_DETAILS_KNOWN_FIELD.name, notEquals: "yes" };

  const email = steps[emailIdx];
  if (email.when === undefined) {
    email.when = gateYes;
    changed = true;
    notes.push("confirm_email: now guarded on the details gate");
  } else if (!sameWhen(email.when, gateYes)) {
    notes.push(`confirm_email: unexpected when, ${HAND_WORK}`);
  }

  if (!steps.some((s) => s.id === "confirm_email_missing")) {
    steps.splice(emailIdx + 1, 0, {
      id: "confirm_email_missing",
      to: "{{vars.invitee_email}}",
      body: KYP_BOOKING_CONFIRMATION_EMAIL_BODY_MISSING,
      type: "send_email",
      subject: KYP_BOOKING_CONFIRMATION_SUBJECT_MISSING,
      fromConnectionId: KYP_BOOKING_EMAIL_CONNECTION_ID,
      when: gateNo
    });
    changed = true;
    notes.push("added confirm_email_missing after confirm_email");
  }

  const smsIdx = steps.findIndex((s) => s.id === "confirm_sms" && s.type === "send_sms");
  if (smsIdx !== -1) {
    const sms = steps[smsIdx];
    const reachableWhen = { var: "lead_reachable", equals: "yes" };
    if (!sameWhen(sms.when, reachableWhen)) {
      notes.push(`confirm_sms: unexpected when, ${HAND_WORK}`);
    } else if (sms.body !== KYP_BOOKING_CONFIRMATION_SMS_BODY) {
      notes.push(`confirm_sms: body differs from the canonical copy, ${HAND_WORK}`);
    } else {
      steps[smsIdx] = {
        id: "confirm_sms_gate",
        type: "branch",
        question: "Does the invitee have a real phone to text?",
        branches: [
          {
            id: "confirm_sms_reachable",
            label: "Has a real phone",
            condition: reachableWhen,
            steps: [
              {
                id: "confirm_sms",
                to: "{{vars.invitee_phone}}",
                body: KYP_BOOKING_CONFIRMATION_SMS_BODY,
                type: "send_sms",
                when: gateYes
              },
              {
                id: "confirm_sms_missing",
                to: "{{vars.invitee_phone}}",
                body: KYP_BOOKING_CONFIRMATION_SMS_BODY_MISSING,
                type: "send_sms",
                when: gateNo
              }
            ]
          }
        ],
        else: []
      };
      changed = true;
      notes.push("confirm_sms: wrapped in confirm_sms_gate with a generic sibling");
    }
  } else if (!steps.some((s) => s.id === "confirm_sms_gate")) {
    notes.push(`neither confirm_sms nor confirm_sms_gate found, ${HAND_WORK}`);
  }

  const notify = steps.find((s) => s.id === "notify_james" && s.type === "notify_owner");
  if (notify) {
    if (notify.message === NOTIFY_PRE_FIX) {
      notify.message = KYP_BOOKING_CONFIRMATION_NOTIFY;
      changed = true;
      notes.push("notify_james: facts are labelled now (Day/Time/Email/Phone)");
    } else if (notify.message !== KYP_BOOKING_CONFIRMATION_NOTIFY) {
      notes.push(`notify_james: unexpected copy, ${HAND_WORK}`);
    }
  } else {
    notes.push(`notify_james not found, ${HAND_WORK}`);
  }

  finishNotes(changed, notes);
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

/** Flat step ids in engine order; parked runs address this sequence by index. */
function flatIds(definition: unknown): string[] {
  const steps = (definition as { steps?: unknown }).steps;
  return flattenSteps(steps as never).map((e: { step: unknown }) =>
    String((e.step as { id?: string }).id ?? "")
  );
}

const TARGETS: Array<{
  name: string;
  build: () => Record<string, unknown>;
  transform: (input: unknown) => TransformResult;
}> = [
  {
    name: KYP_REMINDER_FLOW_NAME,
    build: buildKypPreCallReminderDefinition,
    transform: addReminderMissingDetails
  },
  {
    name: KYP_BOOKING_CONFIRMATION_FLOW_NAME,
    build: buildKypBookingConfirmationDefinition,
    transform: addBookingMissingDetails
  }
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

    const result = target.transform(row.definition);
    for (const note of result.notes) console.log(`  - ${note}`);
    if (!result.changed) continue;

    // Drift guard: the transformed live shape must equal the canonical
    // builder, or the flow was edited outside the ledger since the builder
    // was reconciled and writing would revert that edit.
    const expected = JSON.stringify(canonical(target.build()));
    const actual = JSON.stringify(canonical(result.definition));
    if (actual !== expected) {
      console.error(
        `  ! DRIFT: the patched live shape does not match ` +
          `kyp-reminder-flow-definition.ts. Reconcile the builder to live FIRST ` +
          `(live is source of truth), then re-run.` +
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

    // Step-index safety: this patch ADDS steps. A parked run resumes at a
    // FLAT index, so any non-terminal run at or past the first index where
    // the sequences differ would resume inside the wrong step.
    const liveFlat = flatIds(row.definition);
    const newFlat = flatIds(result.definition);
    let firstDiff = -1;
    for (let i = 0; i < Math.max(liveFlat.length, newFlat.length); i++) {
      if (liveFlat[i] !== newFlat[i]) {
        firstDiff = i;
        break;
      }
    }
    if (firstDiff !== -1) {
      const { data: runs, error: runErr } = await db
        .from("ai_flow_runs")
        .select("id, status, current_step")
        .eq("flow_id", row.id)
        .in("status", ["awaiting_reply", "queued", "running"]);
      if (runErr) {
        console.error(`  ! Run check failed: ${runErr.message}`);
        process.exit(1);
      }
      const blocking = (runs ?? []).filter(
        (r) => Number((r as { current_step?: number }).current_step ?? 0) >= firstDiff
      );
      console.log(
        `  flat steps ${liveFlat.length} -> ${newFlat.length}, first differing index ${firstDiff}; ` +
          `non-terminal runs: ${(runs ?? []).length}, at/past the diff: ${blocking.length}`
      );
      if (blocking.length > 0) {
        console.error(
          `  ! ${blocking.length} non-terminal run(s) sit at or past index ${firstDiff}: ` +
            blocking.map((r) => (r as { id?: string }).id).join(", ") +
            (args.force
              ? ". Continuing anyway (--force)."
              : ". Both flows finish within seconds; wait for them and re-run. Refusing to write.")
        );
        if (!args.force) process.exit(1);
      }
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
      details: { flows: patched, fix: "guarded missing-details copy (fleet fallback audit Aug 27 2026)" }
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
