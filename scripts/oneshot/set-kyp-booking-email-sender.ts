/**
 * set-kyp-booking-email-sender.ts — point a flow's send_email step at the
 * owner's connected mailbox (KYP Ads booking-confirmation sender fix).
 *
 * Background (Jul 22 2026): James connected his sam@ Outlook mailbox and ran
 * sender-check test bookings; the flow was briefly pointed at a mailbox
 * connection id that doesn't exist for the business, so runs failed with
 * `send_email: owner-mailbox send failed (connection_not_found)`, and a later
 * edit dropped `fromConnectionId` entirely — booking emails went back to the
 * AI coworker's platform address. This script sets the step's
 * `fromConnectionId` to the REAL connection row (resolved by the mailbox
 * email, never a hard-coded uuid) and can enqueue a synthetic verification
 * booking so the fix is proven end-to-end from production.
 *
 * Idempotent: a flow already pointing at the resolved connection is a no-op.
 *
 * Usage (ids/emails from argv per scripts/oneshot/README.md — no PII here):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/set-kyp-booking-email-sender.ts \
 *     --business <uuid> --sender-email <mailbox email>            # dry-run
 *   ... --apply                                                   # write
 *   ... --apply --verify <recipient email>                        # write + enqueue a
 *       synthetic calendly_booking run addressed to <recipient email> and poll
 *       the run + email_log until the send is observed (or times out).
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business") ?? process.env.KYP_BUSINESS_ID;
const SENDER_EMAIL = argValue("--sender-email");
const VERIFY_RECIPIENT = argValue("--verify");
const FLOW_NAME = argValue("--flow-name") ?? "Booking confirmation (SMS + email) — live";
const STEP_ID = argValue("--step-id") ?? "confirm_email";

if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set KYP_BUSINESS_ID)");
  process.exit(1);
}
if (!SENDER_EMAIL || !SENDER_EMAIL.includes("@")) {
  console.error("[oneshot] pass --sender-email <connected mailbox email>");
  process.exit(1);
}
if (VERIFY_RECIPIENT && !VERIFY_RECIPIENT.includes("@")) {
  console.error("[oneshot] --verify takes the recipient email for the synthetic booking");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { isEmailProviderConfigKey } = await import("../../src/lib/voice-tools/connections.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

// ---------------------------------------------------------------------------
// Resolve the mailbox connection ROW ID by its account email. The runtime
// send path looks connections up by row id (`getWorkspaceOAuthConnection`),
// so this is the value the step must carry — resolving by email here is what
// makes a stale/foreign uuid impossible.
// ---------------------------------------------------------------------------
type ConnRow = {
  id: string;
  provider_config_key: string;
  metadata: Record<string, unknown> | null;
};

const { data: connRows, error: connErr } = await db
  .from("workspace_oauth_connections")
  .select("id, provider_config_key, metadata")
  .eq("business_id", BUSINESS_ID);
if (connErr) {
  console.error("[oneshot] connection listing failed:", connErr.message);
  process.exit(1);
}

const wanted = SENDER_EMAIL.toLowerCase();
const matches = ((connRows ?? []) as ConnRow[]).filter((row) => {
  if (!isEmailProviderConfigKey(row.provider_config_key)) return false;
  const md = row.metadata ?? {};
  const emails = [md.provider_account_email, md.end_user_email].filter(
    (v): v is string => typeof v === "string"
  );
  return emails.some((e) => e.toLowerCase() === wanted);
});

// end_user_email is the dashboard login and can be shared across mailboxes;
// prefer the row whose PROVIDER account email is the requested sender.
const exact = matches.filter(
  (row) =>
    typeof row.metadata?.provider_account_email === "string" &&
    (row.metadata.provider_account_email as string).toLowerCase() === wanted
);
const pool = exact.length > 0 ? exact : matches;
if (pool.length === 0) {
  console.error(`[oneshot] no email connection for ${SENDER_EMAIL} on this business`);
  process.exit(1);
}
if (pool.length > 1) {
  console.error(
    `[oneshot] ambiguous: ${pool.length} connections match ${SENDER_EMAIL}:`,
    pool.map((r) => `${r.id} (${r.provider_config_key})`).join(", ")
  );
  process.exit(1);
}
const connection = pool[0];
console.log(
  `[oneshot] sender mailbox: ${SENDER_EMAIL} → connection ${connection.id} (${connection.provider_config_key})`
);

// ---------------------------------------------------------------------------
// Patch the flow's send_email step.
// ---------------------------------------------------------------------------
const { data: flowRow, error: flowErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", BUSINESS_ID)
  .eq("name", FLOW_NAME)
  .maybeSingle();
if (flowErr) {
  console.error("[oneshot] flow read failed:", flowErr.message);
  process.exit(1);
}
if (!flowRow) {
  console.error(`[oneshot] flow "${FLOW_NAME}" not found for this business`);
  process.exit(1);
}

type StepShape = { id?: string; type?: string; fromConnectionId?: string };
const definition = flowRow.definition as { steps?: StepShape[] };
const step = (definition.steps ?? []).find((s) => s.id === STEP_ID);
if (!step || step.type !== "send_email") {
  console.error(`[oneshot] step "${STEP_ID}" not found or not a send_email step`);
  process.exit(1);
}

let patchedDefinition: unknown = null;
if (step.fromConnectionId === connection.id) {
  console.log(`[oneshot] noop   step "${STEP_ID}" already sends from ${SENDER_EMAIL}`);
} else {
  console.log(
    `[oneshot] patch  step "${STEP_ID}": fromConnectionId ${step.fromConnectionId ?? "(AI coworker mailbox)"} → ${connection.id}`
  );
  step.fromConnectionId = connection.id;
  try {
    patchedDefinition = parseAiFlowDefinition(definition);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("[oneshot] patched definition failed validation:", err.issues);
    } else {
      console.error("[oneshot] patched definition failed validation:", err);
    }
    process.exit(1);
  }
}

if (!APPLY) {
  console.log(
    patchedDefinition
      ? "[oneshot] dry run complete (1 flow would change). Re-run with --apply to write."
      : "[oneshot] dry run complete (nothing to change)."
  );
  process.exit(0);
}

if (patchedDefinition) {
  const { error: updateErr } = await db
    .from("ai_flows")
    .update({ definition: patchedDefinition, updated_at: new Date().toISOString() })
    .eq("id", flowRow.id)
    .eq("business_id", BUSINESS_ID);
  if (updateErr) {
    console.error("[oneshot] update failed:", updateErr.message);
    process.exit(1);
  }
  console.log(`[oneshot] wrote  "${flowRow.name}"`);

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1],
    businessId: BUSINESS_ID,
    details: {
      flow_id: flowRow.id,
      flow_name: flowRow.name,
      step_id: STEP_ID,
      from_connection_id: connection.id
    }
  });
  console.log("[oneshot] applied.");
}

// ---------------------------------------------------------------------------
// Optional end-to-end verification: enqueue a synthetic calendly_booking run
// (same trigger shape the flow's real events carry) addressed to the ops
// recipient, then poll until the run finishes and the email_log row shows the
// owner-mailbox sender. Clearly labeled so the owner-notify step reads as a
// platform check, not a lead.
// ---------------------------------------------------------------------------
if (!VERIFY_RECIPIENT) process.exit(0);

const eventId = `sender-verify-${Date.now()}`;
const windowText = [
  "source: calendly_booking",
  "invitee_name: Platform Sender Verification",
  `invitee_email: ${VERIFY_RECIPIENT}`,
  "invitee_phone: none",
  "invitee_tz: EDT",
  "invitee_local_time: 3:00 PM",
  "invitee_day_date: Wednesday, July 22",
  "zoom_link: https://us06web.zoom.us/j/85350262535?pwd=senderverify",
  "notes: Automated platform check that booking emails send from the connected mailbox. Safe to ignore."
].join("\n");

const { data: runRow, error: runErr } = await db
  .from("ai_flow_runs")
  .insert({
    flow_id: flowRow.id,
    business_id: BUSINESS_ID,
    status: "queued",
    context: {
      trigger: {
        channel: "webhook",
        from: "calendly_booking",
        windowText,
        url: "https://us06web.zoom.us/j/85350262535?pwd=senderverify",
        event_id: eventId
      }
    },
    current_step: 0,
    dedupe_key: `webhook:${eventId}`
  })
  .select("id")
  .single();
if (runErr || !runRow) {
  console.error("[oneshot] verification enqueue failed:", runErr?.message);
  process.exit(1);
}
console.log(`[oneshot] verification run ${runRow.id} queued (event ${eventId}); polling…`);

const deadline = Date.now() + 4 * 60_000;
let finalStatus = "queued";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 10_000));
  const { data: row } = await db
    .from("ai_flow_runs")
    .select("status, last_error")
    .eq("id", runRow.id)
    .maybeSingle();
  const status = (row as { status?: string; last_error?: string | null } | null)?.status;
  if (!status) continue;
  finalStatus = status;
  if (status === "queued" || status === "running") {
    process.stdout.write(".");
    continue;
  }
  console.log(`\n[oneshot] run finished: ${status}`);
  if (status === "failed") {
    console.error("[oneshot] last_error:", (row as { last_error?: string | null }).last_error);
    process.exit(1);
  }
  break;
}
if (finalStatus === "queued" || finalStatus === "running") {
  console.error("\n[oneshot] verification timed out — check the run manually:", runRow.id);
  process.exit(1);
}

// Owner-mailbox sends log `source: "owner_mailbox"` with from_email set to
// the PROVIDER label (the Nango send API doesn't echo the address back) —
// that source value, not the from address, is the proof the send went
// through the connected mailbox rather than the platform Resend path.
const { data: emailRows } = await db
  .from("email_log")
  .select("from_email, to_email, subject, source, created_at")
  .eq("business_id", BUSINESS_ID)
  .eq("run_id", runRow.id)
  .order("created_at", { ascending: false })
  .limit(1);
const sent = (emailRows ?? [])[0] as
  | { from_email: string; to_email: string; subject: string; source: string }
  | undefined;
if (!sent) {
  console.error("[oneshot] run completed but no email_log row found for it");
  process.exit(1);
}
console.log(
  `[oneshot] email sent: source=${sent.source} from=${sent.from_email} → ${sent.to_email} ("${sent.subject}")`
);
const fromOk = sent.source === "owner_mailbox";
console.log(
  fromOk
    ? `[oneshot] VERIFIED — sent through the connected mailbox (check ${VERIFY_RECIPIENT}'s inbox to confirm the visible sender is ${SENDER_EMAIL}).`
    : "[oneshot] MISMATCH — email did NOT go through the connected mailbox; investigate before telling the owner."
);
process.exit(fromOk ? 0 : 1);
