/**
 * patch-kyp-calendar-contact-filing.ts — make KYP Ads' two calendar flows
 * FILE the Calendly booker as a contact before texting them.
 *
 * Incident (Kav, Jul 24 2026): the "Pre-call reminder (1hr before)" flow
 * texted a Calendly booker by name, but nothing filed them — the Texts
 * thread showed a bare number with "Set contact" while the lead's name sat
 * on a junk-number orphan row from the original Facebook form. Two patches,
 * both idempotent:
 *
 *   1. Pre-call reminder flow (matched by name prefix, calendar/event_start):
 *      surgical patch of the LIVE definition — add an `invitee_email`
 *      extraction field and insert a guarded `upsert_customer` step
 *      (phoneVar invitee_phone, nameVar invitee_first_name) right after the
 *      extraction, leaving every other step byte-identical.
 *   2. No-show recovery flow: re-apply the canonical definition
 *      (kyp-noshow-definition.ts, which now carries the same filing step —
 *      pinned by tests/oneshot-kyp-noshow-definition.test.ts).
 *
 * Both flows' ENABLED state is deliberately untouched.
 *
 * Usage (business id from --business or KYP_BUSINESS_ID — never hard-coded,
 * per scripts/oneshot/README.md):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-kyp-calendar-contact-filing.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/patch-kyp-calendar-contact-filing.ts --business <uuid> --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";
import { buildKypNoShowDefinition, KYP_NOSHOW_FLOW_NAME } from "./kyp-noshow-definition.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.KYP_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set KYP_BUSINESS_ID)");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

/** Prefix that identifies the live reminder flow (its full name is tenant-authored). */
const PRECALL_NAME_PREFIX = "Pre-call reminder";

type StepJson = Record<string, unknown>;
type DefinitionJson = { steps?: StepJson[] } & Record<string, unknown>;

function validateOrExit(candidate: unknown, label: string) {
  try {
    return parseAiFlowDefinition(candidate);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`[oneshot] ${label}: validation failed:`, err.issues);
    } else {
      console.error(`[oneshot] ${label}: validation failed:`, err);
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 1. Pre-call reminder flow: surgical patch of the live definition.
// ---------------------------------------------------------------------------
const { data: precallRows, error: precallErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", BUSINESS_ID)
  .ilike("name", `${PRECALL_NAME_PREFIX}%`);
if (precallErr) {
  console.error("[oneshot] pre-call flow lookup failed:", precallErr.message);
  process.exit(1);
}
if ((precallRows ?? []).length !== 1) {
  console.error(
    `[oneshot] expected exactly one "${PRECALL_NAME_PREFIX}…" flow, found ${(precallRows ?? []).length} — refusing to guess`
  );
  process.exit(1);
}
const precall = precallRows![0] as {
  id: string;
  name: string;
  enabled: boolean;
  definition: DefinitionJson;
};

const patched: DefinitionJson = structuredClone(precall.definition);
const steps = Array.isArray(patched.steps) ? patched.steps : [];
const extractIdx = steps.findIndex((s) => s.type === "extract_text");
if (extractIdx === -1) {
  console.error("[oneshot] pre-call flow has no extract_text step — shape changed, refusing");
  process.exit(1);
}
const extract = steps[extractIdx] as { fields?: Array<{ name?: string }> };
const fieldNames = (extract.fields ?? []).map((f) => f.name);
if (!fieldNames.includes("invitee_phone") || !fieldNames.includes("invitee_first_name")) {
  console.error(
    "[oneshot] pre-call extraction no longer produces invitee_phone/invitee_first_name — refusing"
  );
  process.exit(1);
}

let addedEmailField = false;
if (!fieldNames.includes("invitee_email")) {
  (extract.fields as StepJson[]).push({
    name: "invitee_email",
    description: "The invitee's email address from the 'invitee email:' line. 'none' when absent."
  });
  addedEmailField = true;
}

let addedUpsert = false;
if (!steps.some((s) => s.type === "upsert_customer")) {
  steps.splice(extractIdx + 1, 0, {
    id: "file_invitee",
    type: "upsert_customer",
    phoneVar: "invitee_phone",
    nameVar: "invitee_first_name",
    emailVar: "invitee_email",
    when: { var: "invitee_phone", notEquals: "none" }
  });
  addedUpsert = true;
}

const precallDefinition = validateOrExit(patched, "pre-call reminder");
const precallDirty = addedEmailField || addedUpsert;

console.log(
  `[oneshot] pre-call flow ${precall.id} ("${precall.name}", enabled=${precall.enabled}): ` +
    (precallDirty
      ? `will add ${[addedEmailField ? "invitee_email field" : null, addedUpsert ? "file_invitee upsert step" : null]
          .filter(Boolean)
          .join(" + ")}`
      : "already files the invitee — no change")
);
if (precallDirty) {
  console.log("[oneshot] pre-call patched summary:", summarizeDefinition(precallDefinition));
}

// ---------------------------------------------------------------------------
// 2. No-show flow: re-apply the canonical definition (now carries the step).
// ---------------------------------------------------------------------------
const { data: noshowRow, error: noshowErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", BUSINESS_ID)
  .eq("name", KYP_NOSHOW_FLOW_NAME)
  .maybeSingle();
if (noshowErr || !noshowRow) {
  console.error("[oneshot] no-show flow not found:", noshowErr?.message ?? KYP_NOSHOW_FLOW_NAME);
  process.exit(1);
}
const noshowDefinition = validateOrExit(buildKypNoShowDefinition(), "no-show recovery");
const noshowAlreadyFiled = Array.isArray((noshowRow.definition as DefinitionJson)?.steps)
  ? ((noshowRow.definition as DefinitionJson).steps as StepJson[]).some(
      (s) => s.type === "upsert_customer"
    )
  : false;

console.log(
  `[oneshot] no-show flow ${noshowRow.id} (enabled=${noshowRow.enabled}): ` +
    (noshowAlreadyFiled
      ? "already files the invitee — canonical re-apply is a no-op refresh"
      : "will re-apply the canonical definition with the file_invitee step")
);
console.log("[oneshot] no-show canonical summary:", summarizeDefinition(noshowDefinition));
console.log("[oneshot] enabled states untouched on both flows");

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

if (precallDirty) {
  const { error: updErr } = await db
    .from("ai_flows")
    .update({ definition: precallDefinition, updated_at: new Date().toISOString() })
    .eq("id", precall.id)
    .eq("business_id", BUSINESS_ID);
  if (updErr) {
    console.error("[oneshot] pre-call update failed:", updErr.message);
    process.exit(1);
  }
  console.log("[oneshot] pre-call flow patched.");
}

const { error: noshowUpdErr } = await db
  .from("ai_flows")
  .update({ definition: noshowDefinition, updated_at: new Date().toISOString() })
  .eq("id", noshowRow.id)
  .eq("business_id", BUSINESS_ID);
if (noshowUpdErr) {
  console.error("[oneshot] no-show update failed:", noshowUpdErr.message);
  process.exit(1);
}
console.log("[oneshot] no-show flow re-applied.");

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    precall_flow_id: precall.id,
    precall_changed: precallDirty,
    precall_added: {
      invitee_email_field: addedEmailField,
      file_invitee_step: addedUpsert
    },
    noshow_flow_id: noshowRow.id,
    noshow_reapplied_with_filing: true
  }
});
console.log("[oneshot] applied.");
