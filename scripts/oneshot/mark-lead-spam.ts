/**
 * mark-lead-spam.ts — owner declared a lead spam; make the platform actually
 * honor it: suppress the number, cancel their pending AiFlow runs, and mark
 * the contact.
 *
 * Background (Jul 23 2026, KYP Ads): a junk Facebook lead ("Hhh",
 * +12038097763) enrolled in "Lead follow-up (white-glove build)". James
 * texted "hes spam" and the owner-operator turn REPLIED "I'll flag Hhh as
 * spam and stop all follow-ups" — but that surface has no tool that can do
 * either, so the run stayed parked in awaiting_reply with three nudges
 * still ahead of it. This script is the hot fix; the permanent fix is the
 * flag_contact_spam coworker tool that gives the promise real machinery.
 *
 * What --apply does, in order (each step idempotent):
 *   1. sms_set_opt_out RPC — the same STOP-list every send path already
 *      checks (ai-flow-worker, sms-inbound-worker, scheduled sends, Node
 *      send sites), so nothing can text this number again for this business.
 *   2. Cancel every pending AiFlow run for the lead (queued, awaiting_reply,
 *      awaiting_call, awaiting_approval, awaiting_agent) with the owner-stop
 *      shape (status: canceled + context.canceled audit entry) so the runs
 *      page renders it natively. Unlike stop-on-response, human-parked runs
 *      are canceled too: spam means zero further activity of any kind.
 *   3. Tag the contact "spam" and append a pinned note (dedupe-safe).
 *      Deliberately a direct write: no tag_changed contact-event hook — a
 *      spam declaration must never start MORE automation.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/mark-lead-spam.ts --business <uuid> --phone +1XXXXXXXXXX          # dry-run
 *   npx tsx scripts/oneshot/mark-lead-spam.ts --business <uuid> --phone +1XXXXXXXXXX --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business") ?? "";
const PHONE = argValue("--phone") ?? "";

if (!/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid>");
  process.exit(1);
}
if (!/^\+\d{8,15}$/.test(PHONE)) {
  console.error("[oneshot] pass --phone <E.164, e.g. +12038097763>");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const SPAM_TAG = "spam";
/**
 * Statuses a spam declaration cancels — every non-terminal state, matching
 * the dashboard owner-stop's CANCELABLE_RUN_STATUSES (src/lib/ai-flows/db.ts).
 * `running` cancels cooperatively: the worker re-reads status at each step
 * boundary and quits when it sees canceled.
 */
const PENDING_STATUSES = [
  "queued",
  "running",
  "awaiting_reply",
  "awaiting_call",
  "awaiting_approval",
  "awaiting_agent"
];

// ---------------------------------------------------------------------------
// Current state: contact row, opt-out status, pending runs for this lead.
// ---------------------------------------------------------------------------
// Match the primary number OR a merged alias (alias_e164s) — the same
// resolution the interaction writes use, so a merged contact still gets
// tagged.
const { data: contactRows, error: contactErr } = await db
  .from("contacts")
  .select("id, display_name, customer_e164, tags, pinned_md")
  .eq("business_id", BUSINESS_ID)
  .or(`customer_e164.eq.${PHONE},alias_e164s.cs.{${PHONE}}`)
  .limit(1);
if (contactErr) {
  console.error("[oneshot] contact read failed:", contactErr.message);
  process.exit(1);
}
const contact = (contactRows ?? [])[0] ?? null;

const { data: optedOut, error: optErr } = await db.rpc("sms_is_opted_out", {
  p_business_id: BUSINESS_ID,
  p_sender_e164: PHONE
});
if (optErr) {
  console.error("[oneshot] opt-out check failed:", optErr.message);
  process.exit(1);
}

// Same lead-identity keys the goal jumps / stop-on-response use: the
// triggering sender, the extracted lead phone, or the number a wait/call is
// parked on.
const { data: runRows, error: runsErr } = await db
  .from("ai_flow_runs")
  .select("id, flow_id, status, context, revision")
  .eq("business_id", BUSINESS_ID)
  .in("status", PENDING_STATUSES)
  .or(
    `context->trigger->>from.eq.${PHONE},context->vars->>lead_phone.eq.${PHONE},context->waiting_reply->>from.eq.${PHONE},context->waiting_call->>to.eq.${PHONE}`
  );
if (runsErr) {
  console.error("[oneshot] pending-run listing failed:", runsErr.message);
  process.exit(1);
}
type RunRow = {
  id: string;
  flow_id: string;
  status: string;
  context: Record<string, unknown> | null;
  revision: number;
};
const pendingRuns = (runRows ?? []) as RunRow[];

const label = contact?.display_name ? `${contact.display_name} (${PHONE})` : PHONE;
console.log(`[oneshot] lead: ${label}`);
console.log(`[oneshot] contact row: ${contact ? contact.id : "none"}`);
console.log(`[oneshot] already opted out: ${optedOut === true}`);
console.log(`[oneshot] pending run(s): ${pendingRuns.length}`);
for (const r of pendingRuns) {
  console.log(`[oneshot]   run ${r.id} — ${r.status} (flow ${r.flow_id})`);
}

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Opt-out suppression (idempotent RPC — same store STOP writes).
// ---------------------------------------------------------------------------
const { data: optOutResult, error: setErr } = await db.rpc("sms_set_opt_out", {
  p_business_id: BUSINESS_ID,
  p_sender_e164: PHONE
});
if (setErr) {
  console.error("[oneshot] sms_set_opt_out failed:", setErr.message);
  process.exit(1);
}
console.log(`[oneshot] opt-out set: ${JSON.stringify(optOutResult)}`);

// ---------------------------------------------------------------------------
// 2. Cancel pending runs (owner-stop shape, revision-gated like response_stop).
// ---------------------------------------------------------------------------
const canceled: string[] = [];
for (const run of pendingRuns) {
  const nextContext = {
    ...(run.context ?? {}),
    canceled: {
      by: "owner_declared_spam",
      at: new Date().toISOString(),
      from_status: run.status
    }
  };
  const { data: updated, error: updErr } = await db
    .from("ai_flow_runs")
    .update({
      status: "canceled",
      context: nextContext,
      claimed_at: null,
      respond_by_at: null,
      updated_at: new Date().toISOString()
    })
    .eq("id", run.id)
    .eq("revision", run.revision)
    .in("status", PENDING_STATUSES)
    .select("id");
  if (updErr) {
    console.error(`[oneshot] cancel failed for run ${run.id}:`, updErr.message);
    process.exit(1);
  }
  if (((updated ?? []) as unknown[]).length > 0) {
    canceled.push(run.id);
    console.log(`[oneshot] canceled run ${run.id}`);
  } else {
    console.log(`[oneshot] run ${run.id} moved on (revision race) — re-run to re-check`);
  }
}

// ---------------------------------------------------------------------------
// 3. Contact tag + pinned note (direct write; no contact-event hooks).
// ---------------------------------------------------------------------------
if (contact) {
  const tags: string[] = Array.isArray(contact.tags) ? [...(contact.tags as string[])] : [];
  const noteLine = `Owner declared this contact SPAM (${new Date().toISOString().slice(0, 10)}). Do not contact; all follow-ups stopped.`;
  const pinned = typeof contact.pinned_md === "string" ? contact.pinned_md : "";
  const updates: Record<string, unknown> = {};
  if (!tags.includes(SPAM_TAG)) updates.tags = [...tags, SPAM_TAG];
  if (!pinned.includes("SPAM")) {
    updates.pinned_md = pinned ? `${pinned.trimEnd()}\n- ${noteLine}` : `- ${noteLine}`;
  }
  if (Object.keys(updates).length > 0) {
    updates.updated_at = new Date().toISOString();
    const { error: tagErr } = await db.from("contacts").update(updates).eq("id", contact.id);
    if (tagErr) {
      console.error("[oneshot] contact update failed:", tagErr.message);
      process.exit(1);
    }
    console.log(`[oneshot] contact updated: ${Object.keys(updates).join(", ")}`);
  } else {
    console.log("[oneshot] contact already tagged + noted — no write needed");
  }
} else {
  console.log("[oneshot] no contact row for this number — tag/note skipped");
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: { phone: PHONE, canceled_runs: canceled, opted_out: true }
});
console.log("[oneshot] applied.");
