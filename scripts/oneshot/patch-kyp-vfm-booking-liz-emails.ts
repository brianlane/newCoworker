#!/usr/bin/env tsx
/**
 * One-shot: land the three KYP/VFM fixes the owner directed on 2026-08-19
 * after the Aug 18 dashboard-chat review (thread "are we sending text to
 * the vfm folks?"):
 *
 * 1. The "VFM Calendly booking follow-up" the owner asked for three times
 *    exists only as a DISABLED draft saved from the chat hand-off, named
 *    "Adapted automation", with a trigger that can never fire: it matches
 *    `calendly.com/elizabethastone/30min`, but calendar trigger text
 *    (calendarEventText in trigger-eval.ts) carries title/location/
 *    organizer/attendees/description and never the scheduling link. This
 *    patch retargets the condition to the event-type TITLE ("30 Minute
 *    Meeting", the only discriminator between Liz's Calendly events and
 *    the KYP ones, which are all titled "KYP Ads | ..."), renames the flow
 *    so the AiFlows page says what it is, and enables it. Renaming an
 *    event type breaks title-scoped flows silently; that sharp edge is
 *    already documented in the dossier for the pre-call reminder, and this
 *    flow now shares it.
 * 2. The earlier superseded draft (also "Adapted automation") stays OFF by
 *    the owner's explicit direction ("just disable the old one, don't
 *    delete it"); it is renamed so nobody enables the wrong one.
 * 3. The live "VFM lead follow-up (Vantage Flow Media)" flow emails Liz at
 *    two different addresses: the new-lead notification, bad-phone alert,
 *    and pre-call outcome go to her Calendly login address while the
 *    went-quiet flag goes to the address the owner gave in chat. The owner
 *    directed all of them to the chat-provided address. Addresses arrive
 *    via argv so this file stays PII-free.
 * 4. Tenant memory (business_configs.memory_md) still carries two identity
 *    lines pointing at the retired outbound address next to the owner's
 *    "Do not use ... anymore" instruction. The two identity lines are
 *    repointed at the platform mailbox address (verified against
 *    tenant_mailboxes.local_part before writing); the prohibition line is
 *    kept verbatim.
 *
 * Safety: the lead-flow change only rewrites `to:` values on send_email
 * steps, so no step id or index shifts and parked runs resume untouched.
 * The booking flow has zero runs (it has never been enabled). Both patched
 * definitions re-validate through parseAiFlowDefinition before writing.
 * Dry-run by default; idempotent (a second --apply converges to the same
 * shape and reports "already applied"); previous definitions and memory
 * lines are printed for rollback; the apply is recorded in
 * applied_oneshots.
 *
 * Usage (ids/addresses from the dossier's One-shots section):
 *   npx tsx scripts/oneshot/patch-kyp-vfm-booking-liz-emails.ts \
 *     --business <uuid> --booking-flow <uuid> --old-draft-flow <uuid> \
 *     --liz-email <addr> --old-liz-email <addr> \
 *     --platform-email <addr> --retired-email <addr>            # dry run
 *   ... --apply                                                 # write
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad arg or
 * invalid patched definition.
 */
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

/** The saved draft's unreachable trigger value (the scheduling link). */
export const INERT_BOOKING_CONDITION = "calendly.com/elizabethastone/30min";
/** Liz's Calendly event-type title: the only Liz-vs-KYP discriminator. */
export const BOOKING_CONDITION_TITLE = "30 Minute Meeting";
/** What the AiFlows page should call the live booking flow. */
export const BOOKING_FLOW_NAME = "VFM Calendly booking follow-up (SMS + email)";
/** What the superseded draft is renamed to, kept off on owner direction. */
export const OLD_DRAFT_NAME = "VFM Calendly booking follow-up (old draft, superseded, keep off)";
/** The live VFM nurture flow whose Liz emails get repointed. */
export const VFM_LEAD_FLOW_NAME = "VFM lead follow-up (Vantage Flow Media)";

type Step = Record<string, unknown> & { id?: string; type?: string; to?: string };
type TriggerCondition = { type?: string; value?: string; caseInsensitive?: boolean };
type Trigger = Record<string, unknown> & { conditions?: TriggerCondition[] };
type Definition = { steps?: Step[]; trigger?: Trigger; triggers?: Trigger[] };

export type PatchResult = { changed: boolean; notes: string[] };

/**
 * Repoint every send_email step addressed to `from` at `to`, in place.
 * Touches nothing else: no ids, no order, no bodies.
 */
export function repointLizEmails(definition: Definition, from: string, to: string): PatchResult {
  const notes: string[] = [];
  let changed = false;
  for (const step of definition.steps ?? []) {
    if (step.type !== "send_email") continue;
    if (step.to === from) {
      step.to = to;
      changed = true;
      notes.push(`${step.id ?? "(unnamed step)"}: to ${from} -> ${to}`);
    }
  }
  if (!changed) notes.push(`no send_email steps addressed to ${from} (already repointed)`);
  return { changed, notes };
}

/**
 * Swap the booking flow's inert scheduling-link condition for the event
 * TITLE condition, wherever it sits (trigger or the extra triggers list).
 */
export function retargetBookingTrigger(definition: Definition): PatchResult {
  const notes: string[] = [];
  let changed = false;
  const triggers = [definition.trigger, ...(definition.triggers ?? [])];
  for (const trigger of triggers) {
    for (const condition of trigger?.conditions ?? []) {
      if (condition.value === INERT_BOOKING_CONDITION) {
        condition.value = BOOKING_CONDITION_TITLE;
        changed = true;
        notes.push(
          `trigger condition: "${INERT_BOOKING_CONDITION}" -> "${BOOKING_CONDITION_TITLE}"`
        );
      } else if (condition.value === BOOKING_CONDITION_TITLE) {
        notes.push("trigger condition already targets the event title");
      }
    }
  }
  if (!changed && notes.length === 0) notes.push("no matching trigger condition found");
  return { changed, notes };
}

/**
 * Repoint the retired outbound address in the memory identity lines at the
 * platform mailbox, keeping any "do not use" prohibition line verbatim so
 * the owner's instruction survives. Pure so tests can drive it.
 */
export function repointMemoryEmailLines(
  memoryMd: string,
  retiredEmail: string,
  platformEmail: string
): { next: string; replaced: string[] } {
  const replaced: string[] = [];
  const next = memoryMd
    .split("\n")
    .map((line) => {
      if (!line.includes(retiredEmail)) return line;
      if (/do not use/i.test(line)) return line;
      replaced.push(line);
      return line.split(retiredEmail).join(platformEmail);
    })
    .join("\n");
  return { next, replaced };
}

type Args = {
  apply: boolean;
  businessId: string;
  bookingFlowId: string;
  oldDraftFlowId: string;
  lizEmail: string;
  oldLizEmail: string;
  platformEmail: string;
  retiredEmail: string;
};

function argValue(argv: string[], flag: string): string {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? (argv[idx + 1] ?? "") : "";
}

function parseArgs(argv: string[]): Args {
  return {
    apply: argv.includes("--apply"),
    businessId:
      argValue(argv, "--business") ||
      process.env.AIFLOW_KYP_BUSINESS_ID ||
      process.env.KYP_BUSINESS_ID ||
      "",
    bookingFlowId: argValue(argv, "--booking-flow"),
    oldDraftFlowId: argValue(argv, "--old-draft-flow"),
    lizEmail: argValue(argv, "--liz-email"),
    oldLizEmail: argValue(argv, "--old-liz-email"),
    platformEmail: argValue(argv, "--platform-email"),
    retiredEmail: argValue(argv, "--retired-email")
  };
}

const UUID_RE = /^[0-9a-f-]{36}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateDefinition(patched: Definition, label: string): Definition {
  try {
    return parseAiFlowDefinition(patched) as Definition;
  } catch (err) {
    console.error(`${label}: patched definition failed validation:`);
    if (err instanceof AiFlowValidationError) {
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error(err);
    }
    process.exit(2);
  }
}

async function readFlow(
  db: SupabaseClient,
  businessId: string,
  id: string
): Promise<{ id: string; name: string; enabled: boolean; definition: Definition }> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (error) {
    console.error(`Read of flow ${id} failed: ${error.message}`);
    process.exit(1);
  }
  if (!data) {
    console.error(`Flow ${id} not found on business ${businessId}`);
    process.exit(1);
  }
  return data as { id: string; name: string; enabled: boolean; definition: Definition };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  if (!UUID_RE.test(args.businessId)) {
    console.error("Pass --business <uuid> (or set AIFLOW_KYP_BUSINESS_ID / KYP_BUSINESS_ID)");
    process.exit(2);
  }
  if (!UUID_RE.test(args.bookingFlowId) || !UUID_RE.test(args.oldDraftFlowId)) {
    console.error("Pass --booking-flow <uuid> and --old-draft-flow <uuid> (see the KYP dossier)");
    process.exit(2);
  }
  for (const [flag, value] of [
    ["--liz-email", args.lizEmail],
    ["--old-liz-email", args.oldLizEmail],
    ["--platform-email", args.platformEmail],
    ["--retired-email", args.retiredEmail]
  ] as const) {
    if (!EMAIL_RE.test(value)) {
      console.error(`Pass ${flag} <address> (addresses are argv-only, never hard-coded here)`);
      process.exit(2);
    }
  }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const nowIso = new Date().toISOString();
  const details: Record<string, unknown> = {};

  // Guard: the platform address must be the tenant's real mailbox, not a
  // guess relayed from chat (the chat AI once asserted it unverified).
  {
    const { data, error } = await db
      .from("tenant_mailboxes")
      .select("local_part")
      .eq("business_id", args.businessId)
      .maybeSingle();
    if (error) {
      console.error(`tenant_mailboxes read failed: ${error.message}`);
      process.exit(1);
    }
    const expected = `${data?.local_part ?? ""}@newcoworker.com`;
    if (!data || expected.toLowerCase() !== args.platformEmail.toLowerCase()) {
      console.error(
        `--platform-email ${args.platformEmail} does not match the tenant mailbox` +
          ` (${data ? expected : "no tenant_mailboxes row"}). Refusing.`
      );
      process.exit(2);
    }
    console.log(`Platform mailbox verified: ${expected}`);
  }

  // ── 1. VFM lead flow: repoint Liz's emails ────────────────────────────
  const leadFlow = await (async () => {
    const { data, error } = await db
      .from("ai_flows")
      .select("id, name, enabled, definition")
      .eq("business_id", args.businessId)
      .eq("name", VFM_LEAD_FLOW_NAME)
      .maybeSingle();
    if (error) {
      console.error(`Read failed: ${error.message}`);
      process.exit(1);
    }
    if (!data) {
      console.error(`No "${VFM_LEAD_FLOW_NAME}" flow for ${args.businessId}`);
      process.exit(1);
    }
    return data as { id: string; name: string; enabled: boolean; definition: Definition };
  })();
  console.log(`\n=== ${leadFlow.name} (${leadFlow.id}, enabled=${leadFlow.enabled}) ===`);
  console.log(`Previous definition (for rollback):\n${JSON.stringify(leadFlow.definition)}`);
  const leadPatched = structuredClone(leadFlow.definition);
  const leadResult = repointLizEmails(leadPatched, args.oldLizEmail, args.lizEmail);
  for (const note of leadResult.notes) console.log(`- ${note}`);
  const leadValidated = leadResult.changed
    ? validateDefinition(leadPatched, VFM_LEAD_FLOW_NAME)
    : null;

  // ── 2. Booking flow: retarget trigger, rename, enable ────────────────
  const booking = await readFlow(db, args.businessId, args.bookingFlowId);
  console.log(`\n=== booking flow (${booking.id}, enabled=${booking.enabled}, name=${JSON.stringify(booking.name)}) ===`);
  console.log(`Previous definition (for rollback):\n${JSON.stringify(booking.definition)}`);
  const bookingPatched = structuredClone(booking.definition);
  const bookingTrigger = retargetBookingTrigger(bookingPatched);
  for (const note of bookingTrigger.notes) console.log(`- ${note}`);
  const bookingRename = booking.name !== BOOKING_FLOW_NAME;
  if (bookingRename) console.log(`- rename: ${JSON.stringify(booking.name)} -> ${JSON.stringify(BOOKING_FLOW_NAME)}`);
  const bookingEnable = !booking.enabled;
  if (bookingEnable) console.log("- enable: false -> true");
  const bookingChanged = bookingTrigger.changed || bookingRename || bookingEnable;
  const bookingValidated = bookingChanged
    ? validateDefinition(bookingPatched, BOOKING_FLOW_NAME)
    : null;

  // ── 3. Old draft: keep off, rename so nobody enables the wrong one ───
  const oldDraft = await readFlow(db, args.businessId, args.oldDraftFlowId);
  console.log(`\n=== old draft (${oldDraft.id}, enabled=${oldDraft.enabled}, name=${JSON.stringify(oldDraft.name)}) ===`);
  const oldRename = oldDraft.name !== OLD_DRAFT_NAME;
  if (oldRename) console.log(`- rename: ${JSON.stringify(oldDraft.name)} -> ${JSON.stringify(OLD_DRAFT_NAME)}`);
  const oldDisable = oldDraft.enabled;
  if (oldDisable) console.log("- disable: true -> false (owner: keep it, keep it off)");
  const oldChanged = oldRename || oldDisable;
  if (!oldChanged) console.log("- already renamed and off");

  // ── 4. Tenant memory: retire the old outbound address ────────────────
  const { data: configRow, error: configErr } = await db
    .from("business_configs")
    .select("memory_md")
    .eq("business_id", args.businessId)
    .maybeSingle();
  if (configErr || !configRow) {
    console.error(`business_configs read failed: ${configErr?.message ?? "no row"}`);
    process.exit(1);
  }
  const memory = repointMemoryEmailLines(
    String(configRow.memory_md ?? ""),
    args.retiredEmail,
    args.platformEmail
  );
  console.log(`\n=== memory_md ===`);
  if (memory.replaced.length === 0) {
    console.log(`- no identity lines carry ${args.retiredEmail} (already repointed)`);
  }
  for (const line of memory.replaced) console.log(`- replacing line (for rollback): ${line}`);

  const anythingChanged =
    leadResult.changed || bookingChanged || oldChanged || memory.replaced.length > 0;
  if (!anythingChanged) {
    console.log("\nNothing to change. Already applied.");
    return;
  }
  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply.");
    return;
  }

  if (leadValidated) {
    const { error } = await db
      .from("ai_flows")
      .update({ definition: leadValidated, updated_at: nowIso })
      .eq("id", leadFlow.id)
      .eq("business_id", args.businessId);
    if (error) {
      console.error(`Lead flow update failed: ${error.message}`);
      process.exit(1);
    }
    details.lead_flow = { id: leadFlow.id, repointed: leadResult.notes };
    console.log("Lead flow updated.");
  }
  if (bookingChanged) {
    const { error } = await db
      .from("ai_flows")
      .update({
        ...(bookingValidated ? { definition: bookingValidated } : {}),
        name: BOOKING_FLOW_NAME,
        enabled: true,
        ...(bookingEnable ? { enabled_changed_at: nowIso } : {}),
        updated_at: nowIso
      })
      .eq("id", booking.id)
      .eq("business_id", args.businessId);
    if (error) {
      console.error(`Booking flow update failed: ${error.message}`);
      process.exit(1);
    }
    details.booking_flow = {
      id: booking.id,
      enabled: true,
      renamed: bookingRename,
      trigger_retargeted: bookingTrigger.changed
    };
    console.log("Booking flow updated and enabled.");
  }
  if (oldChanged) {
    const { error } = await db
      .from("ai_flows")
      .update({
        name: OLD_DRAFT_NAME,
        enabled: false,
        ...(oldDisable ? { enabled_changed_at: nowIso } : {}),
        updated_at: nowIso
      })
      .eq("id", oldDraft.id)
      .eq("business_id", args.businessId);
    if (error) {
      console.error(`Old draft update failed: ${error.message}`);
      process.exit(1);
    }
    details.old_draft = { id: oldDraft.id, enabled: false, renamed: oldRename };
    console.log("Old draft renamed, kept off.");
  }
  if (memory.replaced.length > 0) {
    const { error } = await db
      .from("business_configs")
      .update({ memory_md: memory.next, updated_at: nowIso })
      .eq("business_id", args.businessId);
    if (error) {
      console.error(`memory_md update failed: ${error.message}`);
      process.exit(1);
    }
    details.memory_lines_repointed = memory.replaced.length;
    console.log("Tenant memory updated.");
  }

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1],
    businessId: args.businessId,
    details
  });
  console.log("Done.");
}

/* c8 ignore next 6 -- CLI entrypoint; tests drive the exported transforms */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
