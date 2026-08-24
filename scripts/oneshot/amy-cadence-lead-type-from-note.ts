#!/usr/bin/env tsx
/**
 * One-shot: let "Needs Follow Up (AI cadence)" learn whether a lead is a
 * BUYER, instead of calling all of them sellers.
 *
 * The bug (Sandy Baldwin, Aug 23 2026). The cadence triggers on the
 * "Needs Follow Up" tag, so the only text it ever reads is the contact-event
 * text: name / phone / email / tags / source / tag / change / note. Nothing in
 * that shape says whether the person is buying or selling, so the flow's
 * `lead_type` field fell to its written default. Across the flow's first 42
 * runs it answered "seller" 42 times. Consequences, all silent:
 *
 *   - `r1_route_buyer` / `r2_route_buyer` / `r3_route_buyer` were unreachable.
 *     A ready-to-talk buyer was handed to the seller broadcast trio instead of
 *     the buyer rotation.
 *   - `notify_lead_owner`'s `teamTagTemplate: "{{vars.lead_type}}"` always
 *     asked for the seller team, so Jason Lane, whose roster tag is buyer
 *     only, could not be reached by this flow at all.
 *   - Sandy was a ReferralExchange BUYER (her routing run says so) and her
 *     parked cadence run says seller.
 *
 * The upstream flows already know. ReferralExchange Lead, Realtor.com Lead and
 * New Lead Intake each extract `lead_type` well before they tag the lead
 * (verified against the live definitions: every tag writer runs after the
 * extraction that declares it). So this script makes the tag CARRY it, and
 * teaches the cadence to read it.
 *
 * What it changes, in two parts:
 *
 *   1. Every `update_contact` step that adds "Needs Follow Up", in any enabled
 *      flow of this business that declares a `lead_type` extraction field,
 *      gets `lead_type: {{vars.lead_type}}` appended to its `noteTemplate`
 *      (`withLeadTypeNote`). Appended, never replacing: round 1's call gate
 *      reads the note for the exact phrase `auto_first_contact`, and a note
 *      that has it must keep it while a note that lacks it must not gain it.
 *   2. The cadence's `read_lead` field descriptions for `lead_type` and
 *      `lead_site` are replaced with the canonical ones from
 *      `amy-needs-follow-up-definition.ts`, which now prefer the note's
 *      `lead_type:` value and the event's `source:` line.
 *
 * Flows WITHOUT a `lead_type` field are skipped by that rule, not by a
 * hand-written list: Clever Lead - Accept never establishes a type (a Clever
 * lead is a group text, not a record), and "Follow Up Requested" has only
 * `route_lead_type`, which can be "none". Those keep today's behavior exactly,
 * which is the seller default. Changing THAT is Amy's policy call, not this
 * script's.
 *
 * Ordering note: part 2's `lead_site` wording depends on the event text
 * carrying a `source:` line, which ships with the same PR
 * (contact_events.ts). Run this AFTER that merge deploys, not before.
 *
 * Drift note: the flow builders (`amy-team-unclaimed-ai-followup.ts`,
 * `amy-under-500k-ai-owned.ts`, `referralexchange-ai-first-contact-definition.ts`,
 * `_amy-email-followup-block.ts`) still emit the BASE note. Re-seeding one of
 * those flows drops the type marker again, so re-run this script after any
 * re-seed. It is idempotent, so re-running it is always safe.
 *
 * Read-modify-write, validated through parseAiFlowDefinition, idempotent, and
 * it refuses to write when a flow it expects to patch is missing. Dry-run by
 * default. Records to applied_oneshots on --apply. Enqueues nothing and sends
 * nothing.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-cadence-lead-type-from-note.ts --business <uuid>
 *   npx tsx scripts/oneshot/amy-cadence-lead-type-from-note.ts --business <uuid> --apply
 *   npx tsx scripts/oneshot/amy-cadence-lead-type-from-note.ts --business <uuid> --revert --apply
 */
import { FOLLOW_UP_TAG, READ_FIELDS, withLeadTypeNote } from "./amy-needs-follow-up-definition";

/** The cadence flow whose reading of the event this script corrects. */
export const CADENCE_FLOW_NAME = "Needs Follow Up (AI cadence)";

/** The two `read_lead` fields whose descriptions this script rewrites. */
export const REREAD_FIELDS = ["lead_type", "lead_site"] as const;

type AnyStep = Record<string, unknown> & { id?: unknown; type?: unknown };
type AnyDef = { steps?: unknown } & Record<string, unknown>;

/**
 * Every step in a definition, branches and else-arms included, in execution
 * order. A local walk rather than the engine's `flattenSteps`: this script
 * reads definitions straight off the database as plain JSON, before any
 * parse, so it cannot lean on the typed shape.
 */
export function walkSteps(steps: unknown): AnyStep[] {
  const out: AnyStep[] = [];
  if (!Array.isArray(steps)) return out;
  for (const raw of steps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const step = raw as AnyStep;
    out.push(step);
    for (const key of ["steps", "else"]) out.push(...walkSteps(step[key]));
    const branches = step.branches;
    if (Array.isArray(branches)) {
      for (const b of branches) {
        if (b && typeof b === "object" && !Array.isArray(b)) {
          out.push(...walkSteps((b as Record<string, unknown>).steps));
        }
      }
    }
  }
  return out;
}

/** Does this flow establish a `lead_type` of its own before it tags anything? */
export function declaresLeadType(def: AnyDef): boolean {
  return walkSteps(def.steps).some((step) => {
    const fields = step.fields;
    if (!Array.isArray(fields)) return false;
    return fields.some(
      (f) => f && typeof f === "object" && (f as Record<string, unknown>).name === "lead_type"
    );
  });
}

/** The `update_contact` steps that start the cadence by adding its tag. */
export function followUpTagWriters(def: AnyDef): AnyStep[] {
  return walkSteps(def.steps).filter((step) => {
    if (step.type !== "update_contact") return false;
    const tags = step.addTags;
    return Array.isArray(tags) && tags.some((t) => t === FOLLOW_UP_TAG);
  });
}

/**
 * Part 1, in place: carry the lead type on every tag this flow writes.
 * Returns a description per step actually changed, so a no-op re-run prints
 * nothing rather than claiming work.
 */
export function applyLeadTypeNotes(def: AnyDef): string[] {
  if (!declaresLeadType(def)) return [];
  const changed: string[] = [];
  for (const step of followUpTagWriters(def)) {
    const before = typeof step.noteTemplate === "string" ? step.noteTemplate : "";
    const after = withLeadTypeNote(before);
    if (after === before) continue;
    step.noteTemplate = after;
    changed.push(`${String(step.id)}: noteTemplate -> ${JSON.stringify(after)}`);
  }
  return changed;
}

/** The inverse of part 1: drop the marker, restore a note that was empty. */
export function revertLeadTypeNotes(def: AnyDef): string[] {
  const changed: string[] = [];
  for (const step of followUpTagWriters(def)) {
    const before = typeof step.noteTemplate === "string" ? step.noteTemplate : "";
    const after = before
      .replace(/;?\s*lead_type:\s*\{\{vars\.[a-z_]+\}\}/i, "")
      .trim();
    if (after === before) continue;
    if (after) step.noteTemplate = after;
    else delete step.noteTemplate;
    changed.push(`${String(step.id)}: noteTemplate -> ${after ? JSON.stringify(after) : "(none)"}`);
  }
  return changed;
}

/**
 * Part 2, in place: point the cadence's extraction at the note and the source
 * line. `wanted` is the canonical wording, so the script and the builder can
 * never disagree about what the fixed flow says.
 */
export function applyReadFieldWording(def: AnyDef, fieldNames: readonly string[]): string[] {
  const changed: string[] = [];
  const read = walkSteps(def.steps).find((s) => s.id === "read_lead");
  if (!read || !Array.isArray(read.fields)) return changed;
  for (const raw of read.fields) {
    if (!raw || typeof raw !== "object") continue;
    const field = raw as Record<string, unknown>;
    const name = typeof field.name === "string" ? field.name : "";
    if (!fieldNames.includes(name)) continue;
    const wanted = READ_FIELDS.find((f) => f.name === name)?.description;
    if (!wanted || field.description === wanted) continue;
    field.description = wanted;
    changed.push(`read_lead.${name}: description updated`);
  }
  return changed;
}

/* c8 ignore start -- the IO shell; the pure patch functions above are tested */

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import("../../debug/_shared.ts");
  loadEnv();

  const { createClient } = await import("@supabase/supabase-js");
  const { parseAiFlowDefinition, summarizeDefinition } = await import(
    "../../src/lib/ai-flows/schema.ts"
  );
  const { recordOneshotApplied } = await import("./_ledger.ts");

  const argOf = (name: string): string | null => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : null;
  };
  const APPLY = process.argv.includes("--apply");
  const REVERT = process.argv.includes("--revert");
  const BUSINESS_ID = argOf("business");
  if (!BUSINESS_ID) {
    console.error(
      "Usage: tsx scripts/oneshot/amy-cadence-lead-type-from-note.ts --business <uuid> [--apply] [--revert]"
    );
    process.exit(2);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: rows, error } = await db
    .from("ai_flows")
    .select("id,name,enabled,definition")
    .eq("business_id", BUSINESS_ID)
    .is("deleted_at", null)
    .eq("enabled", true);
  if (error) {
    console.error(`flow read failed: ${error.message}`);
    process.exit(1);
  }
  const flows = (rows ?? []) as Array<{
    id: string;
    name: string;
    enabled: boolean;
    definition: AnyDef;
  }>;
  if (flows.length === 0) {
    console.error(`no enabled flows for business ${BUSINESS_ID}`);
    process.exit(1);
  }
  if (!flows.some((f) => f.name === CADENCE_FLOW_NAME)) {
    console.error(
      `"${CADENCE_FLOW_NAME}" is not an enabled flow on this business, so nothing was written.`
    );
    process.exit(2);
  }

  type Validated = ReturnType<typeof parseAiFlowDefinition>;
  const targets: Array<{ id: string; name: string; next: Validated; changed: string[] }> = [];
  for (const flow of flows) {
    const next = JSON.parse(JSON.stringify(flow.definition)) as AnyDef;
    const changed = REVERT
      ? revertLeadTypeNotes(next)
      : [
          ...applyLeadTypeNotes(next),
          ...(flow.name === CADENCE_FLOW_NAME
            ? applyReadFieldWording(next, REREAD_FIELDS)
            : [])
        ];
    if (changed.length === 0) continue;
    // Validate before anything is written, and write the PARSED shape, the
    // same contract every other flow-editing one-shot here follows.
    let validated: Validated;
    try {
      validated = parseAiFlowDefinition(next);
    } catch (e) {
      console.error(`"${flow.name}" would not validate after patching: ${String(e)}`);
      process.exit(1);
    }
    targets.push({ id: flow.id, name: flow.name, next: validated, changed });
  }

  console.log(`Business ${BUSINESS_ID}: ${flows.length} enabled flows scanned.`);
  if (targets.length === 0) {
    console.log(REVERT ? "Nothing to revert." : "Already patched, no changes.");
    process.exit(0);
  }
  for (const t of targets) {
    console.log(`\n=== ${t.name} (id=${t.id}) ===`);
    for (const c of t.changed) console.log(`  - ${c}`);
    console.log(`  after: ${summarizeDefinition(t.next)}`);
  }

  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply.");
    process.exit(0);
  }

  const failures: string[] = [];
  const patched: string[] = [];
  for (const t of targets) {
    const { data: updated, error: upErr } = await db
      .from("ai_flows")
      .update({ definition: t.next })
      .eq("id", t.id)
      .eq("business_id", BUSINESS_ID)
      .select("id");
    if (upErr) {
      console.error(`update "${t.name}" failed: ${upErr.message}`);
      failures.push(t.name);
      continue;
    }
    // A PostgREST update matching zero rows is not an error, so confirm.
    if ((updated ?? []).length !== 1) {
      console.error(`update "${t.name}" matched ${(updated ?? []).length} rows; NOT written.`);
      failures.push(t.name);
      continue;
    }
    patched.push(t.id);
    console.log(`Updated "${t.name}" (id=${t.id}).`);
  }
  if (patched.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "amy-cadence-lead-type-from-note.ts",
      businessId: BUSINESS_ID,
      details: { flow_ids: patched, reverted: REVERT }
    });
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} flow(s) failed: ${failures.join(", ")}.`);
    process.exit(1);
  }
  console.log(
    REVERT
      ? "\nReverted. The cadence is back to defaulting every lead to seller."
      : "\nDone. The next lead each of these flows tags carries its type, and the cadence reads it."
  );
}

/* c8 ignore stop */
