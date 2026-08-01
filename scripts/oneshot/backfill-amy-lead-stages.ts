/**
 * backfill-amy-lead-stages.ts: put a tenant's EXISTING leads onto the Tasks
 * pipeline board, and stamp where each one came from.
 *
 * Background (Amy Laidlaw Real Estate, Jul 31 2026). A pipeline stage IS a
 * contact tag, so the board is a view over `contacts.tags`. That design
 * assumed each tenant would author `update_contact` steps to write those
 * tags, and this tenant has 21 flows with exactly one tag-writing step. Her
 * whole tag vocabulary was `Clever` (23 contacts), `Needs Human` (5) and
 * `Voice Capture` (1), none of which is a stage name, so every lead rendered
 * as "No contact yet" and the board was empty. Separately, 28 contacts had
 * been CLAIMED by a teammate and carried no tags at all, so they were
 * missing from the Data view entirely.
 *
 * The platform now writes stage tags itself at four lifecycle moments (lead
 * filed, claimed, replied, booked) via
 * supabase/functions/_shared/pipelines/lifecycle.ts, so no flow needs
 * editing and this never has to be re-solved. That only covers leads from
 * here on. This script covers the ones already in the table.
 *
 * WHAT IT DECIDES, per contact, highest wins and never downgrading:
 *   - already on a stage of the pipeline      -> left alone (re-run safe)
 *   - owner_employee_id is set                -> "Contacted" (a teammate took it)
 *   - has any tag, or a known lead_source     -> "New Lead"
 *   - otherwise                               -> skipped, not a lead in motion
 * "Needs Human" is an escalation state, not a lead stage, so it never
 * promotes a contact past this ladder on its own.
 *
 * IT FIRES NO HOOKS. No goal events, no `tag_changed` contact events. Same
 * policy and same reason as `retagContacts` in src/lib/pipelines/db.ts: bulk
 * retagging is administration, not a per-lead transition. Firing ~50
 * tag_changed events at once against this tenant's 19 enabled flows could
 * text real leads.
 *
 * IT TOUCHES NO FLOWS. The dossier's standing warning is that editing a live
 * flow by hand is how flows get broken on this account, and the whole point
 * of the platform-side change is that her flows need no stage steps.
 *
 * Per scripts/oneshot/README.md every tenant-specific value rides argv/env,
 * so --business is REQUIRED and no UUID is hard-coded here.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   # dry run (default): prints the per-contact plan and the totals
 *   npx tsx scripts/oneshot/backfill-amy-lead-stages.ts --business <uuid>
 *   # label leads that carry a source tag but have no flow run to read
 *   npx tsx scripts/oneshot/backfill-amy-lead-stages.ts --business <uuid> \
 *     --source-from-tag Clever=Clever
 *   # land it
 *   npx tsx scripts/oneshot/backfill-amy-lead-stages.ts --business <uuid> \
 *     --source-from-tag Clever=Clever --apply
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Every `--source-from-tag <Tag>=<Label>` occurrence, in order. */
function argValues(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

const BUSINESS_ID = argValue("--business") ?? "";
if (!/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid>");
  process.exit(1);
}

/** tag (lowercased) -> source label. */
const SOURCE_FROM_TAG = new Map<string, string>();
for (const pair of argValues("--source-from-tag")) {
  const at = pair.indexOf("=");
  if (at <= 0 || at === pair.length - 1) {
    console.error(`[oneshot] --source-from-tag ${pair} must look like Tag=Label`);
    process.exit(1);
  }
  SOURCE_FROM_TAG.set(pair.slice(0, at).trim().toLowerCase(), pair.slice(at + 1).trim());
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");
const { stageForTags, computeStageMove } = await import(
  "../../supabase/functions/_shared/pipelines/stages.ts"
);
const { leadSourceLabel } = await import(
  "../../supabase/functions/_shared/leads/source_label.ts"
);

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const NEW_LEAD = "New Lead";
const CONTACTED = "Contacted";

// ---------------------------------------------------------------------------
// 1) Preflight: the board must already exist.
//
// Creating it is a product action (the Tasks page's "Create the default lead
// pipeline" button), not a one-shot's job, and guessing at stage names for a
// tenant would be worse than stopping.
// ---------------------------------------------------------------------------
const { data: stageData, error: stageErr } = await db
  .from("pipeline_stages")
  .select("id, pipeline_id, name, position")
  .eq("business_id", BUSINESS_ID)
  .order("position", { ascending: true });
if (stageErr) {
  console.error(`[oneshot] pipeline_stages read failed: ${stageErr.message}`);
  process.exit(1);
}
type StageRow = { id: string; pipeline_id: string; name: string; position: number };
const allStages = (stageData as StageRow[] | null) ?? [];
const byPipeline = new Map<string, StageRow[]>();
for (const row of allStages) {
  byPipeline.set(row.pipeline_id, [...(byPipeline.get(row.pipeline_id) ?? []), row]);
}
const target = [...byPipeline.entries()].find(([, stages]) => {
  const names = stages.map((s) => s.name.trim().toLowerCase());
  return names.includes(NEW_LEAD.toLowerCase()) && names.includes(CONTACTED.toLowerCase());
});
if (!target) {
  console.error(
    `[oneshot] no pipeline for this business carries both "${NEW_LEAD}" and "${CONTACTED}" stages.\n` +
      "          Create the default lead pipeline from /dashboard/tasks first."
  );
  process.exit(1);
}
const [pipelineId, stages] = target;
const stageNames = stages.map((s) => s.name);
const stageName = (canonical: string) =>
  stages.find((s) => s.name.trim().toLowerCase() === canonical.toLowerCase())!.name;
console.log(
  `[oneshot] pipeline ${pipelineId}: ${stageNames.join(" -> ")}${APPLY ? "" : "  (DRY RUN)"}`
);

// ---------------------------------------------------------------------------
// 2) Roster, so a teammate is never filed as a lead.
// ---------------------------------------------------------------------------
const { data: rosterData, error: rosterErr } = await db
  .from("ai_flow_team_members")
  .select("phone_e164")
  .eq("business_id", BUSINESS_ID);
if (rosterErr) {
  console.error(`[oneshot] roster read failed: ${rosterErr.message}`);
  process.exit(1);
}
const rosterPhones = new Set(
  ((rosterData as Array<{ phone_e164: string | null }> | null) ?? [])
    .map((r) => (r.phone_e164 ?? "").trim())
    .filter((p) => p.length > 0)
);

// ---------------------------------------------------------------------------
// 3) phone -> newest flow name that touched them, for the lead_source stamp.
//
// Mapped through the SAME leadSourceLabel the platform path uses, so a
// backfilled label and a future one agree ("Clever Lead - Accept" -> Clever).
// ---------------------------------------------------------------------------
const { data: flowData } = await db
  .from("ai_flows")
  .select("id, name")
  .eq("business_id", BUSINESS_ID);
const flowNameById = new Map(
  ((flowData as Array<{ id: string; name: string | null }> | null) ?? []).map((f) => [
    f.id,
    f.name ?? ""
  ])
);

const RUN_PAGE = 1000;
/** phone -> label, from the OLDEST matching run (the first flow to file wins). */
const sourceByPhone = new Map<string, string>();
for (let offset = 0; ; offset += RUN_PAGE) {
  const { data, error } = await db
    .from("ai_flow_runs")
    .select("flow_id, context, created_at")
    .eq("business_id", BUSINESS_ID)
    .order("created_at", { ascending: true })
    .range(offset, offset + RUN_PAGE - 1);
  if (error) {
    console.error(`[oneshot] ai_flow_runs read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as Array<{
    flow_id: string;
    context: { vars?: Record<string, unknown>; trigger?: Record<string, unknown> } | null;
  }>;
  for (const run of rows) {
    const label = leadSourceLabel({ flowName: flowNameById.get(run.flow_id) ?? "" });
    if (!label) continue;
    const candidates = [run.context?.vars?.lead_phone, run.context?.trigger?.from];
    for (const raw of candidates) {
      const phone = typeof raw === "string" ? raw.trim() : "";
      if (!/^\+\d{8,15}$/.test(phone)) continue;
      if (!sourceByPhone.has(phone)) sourceByPhone.set(phone, label);
    }
  }
  if (rows.length < RUN_PAGE) break;
}

// ---------------------------------------------------------------------------
// 4) Walk the contacts and decide.
// ---------------------------------------------------------------------------
type ContactRow = {
  id: string;
  customer_e164: string;
  display_name: string | null;
  type: string;
  tags: string[] | null;
  alias_e164s: string[] | null;
  owner_employee_id: string | null;
  lead_source: string | null;
};

const CONTACT_PAGE = 1000;
let scanned = 0;
let stagesWritten = 0;
let sourcesStamped = 0;
let skippedStaff = 0;
let skippedAlreadyStaged = 0;
let skippedNotALead = 0;
let droppedAtCap = 0;
let failed = 0;
let lastId = "";

for (;;) {
  let q = db
    .from("contacts")
    .select("id, customer_e164, display_name, type, tags, alias_e164s, owner_employee_id, lead_source")
    .eq("business_id", BUSINESS_ID)
    .order("id", { ascending: true })
    .limit(CONTACT_PAGE);
  if (lastId) q = q.gt("id", lastId);
  const { data, error } = await q;
  if (error) {
    console.error(`[oneshot] contacts read failed: ${error.message}`);
    if (/lead_source/.test(error.message)) {
      console.error(
        "          contacts.lead_source is missing, so the migration that adds it\n" +
          "          has not reached this database yet. Merge first and let the\n" +
          "          push-to-main run apply migrations, then re-run this."
      );
    }
    process.exit(1);
  }
  const rows = (data as ContactRow[] | null) ?? [];
  if (rows.length === 0) break;
  lastId = rows[rows.length - 1].id;

  for (const c of rows) {
    scanned++;
    const numbers = [c.customer_e164, ...(c.alias_e164s ?? [])].filter(Boolean);

    // A teammate is never a lead (README, and the dossier's Sharp edges).
    if (c.type !== "customer" || numbers.some((n) => rosterPhones.has(n))) {
      skippedStaff++;
      continue;
    }

    const tags = (c.tags ?? []).filter((t) => typeof t === "string" && t.trim().length > 0);

    // Never downgrade: an existing stage is the tenant's own state. This is
    // what makes a re-run a no-op.
    if (stageForTags(stages, tags)) {
      skippedAlreadyStaged++;
      continue;
    }

    // The source label, for both the stamp and the "is this a lead" test.
    const sourceLabel =
      c.lead_source ??
      numbers.map((n) => sourceByPhone.get(n)).find((s) => s) ??
      tags.map((t) => SOURCE_FROM_TAG.get(t.trim().toLowerCase())).find((s) => s) ??
      null;

    const wanted = c.owner_employee_id
      ? stageName(CONTACTED)
      : tags.length > 0 || sourceLabel
        ? stageName(NEW_LEAD)
        : null;
    if (!wanted) {
      skippedNotALead++;
      continue;
    }

    const delta = computeStageMove(tags, stageNames, wanted);
    if (delta.droppedAtCap) {
      droppedAtCap++;
      console.log(`  ! ${c.customer_e164} at the 25-tag limit, stage not added`);
      continue;
    }

    const stampSource = sourceLabel && !c.lead_source ? sourceLabel : null;
    const label = c.display_name?.trim() || c.customer_e164;
    console.log(
      `  ${APPLY ? "+" : "~"} ${label} (${c.customer_e164}) -> ${wanted}` +
        (stampSource ? `, source ${stampSource}` : "")
    );

    if (!APPLY) {
      stagesWritten++;
      if (stampSource) sourcesStamped++;
      continue;
    }

    const patch: Record<string, unknown> = {
      tags: delta.nextTags,
      updated_at: new Date().toISOString()
    };
    // Fill-only, matching the platform path: never relabel a lead whose
    // source someone already recorded.
    if (stampSource) patch.lead_source = stampSource;
    const { error: updErr } = await db.from("contacts").update(patch).eq("id", c.id);
    if (updErr) {
      failed++;
      console.error(`  x ${c.customer_e164}: ${updErr.message}`);
      continue;
    }
    stagesWritten++;
    if (stampSource) sourcesStamped++;
  }

  if (rows.length < CONTACT_PAGE) break;
}

console.log(
  `\n[oneshot] scanned ${scanned} contacts: ${stagesWritten} staged, ` +
    `${sourcesStamped} sources stamped, ${skippedAlreadyStaged} already on the board, ` +
    `${skippedStaff} staff/non-customer, ${skippedNotALead} not leads in motion, ` +
    `${droppedAtCap} at the tag cap, ${failed} failed.`
);
if (!APPLY) {
  console.log("[oneshot] DRY RUN, nothing written. Re-run with --apply to land it.");
  process.exit(0);
}
if (failed > 0) {
  console.error("[oneshot] some rows failed; not recording a clean apply in the ledger.");
  process.exit(1);
}
await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    pipelineId,
    stagesWritten,
    sourcesStamped,
    skippedAlreadyStaged,
    skippedStaff,
    skippedNotALead,
    droppedAtCap
  }
});
console.log("[oneshot] recorded in applied_oneshots.");
