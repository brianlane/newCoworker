/**
 * setup-hq-inbox-triage-flow.ts — one-shot: author the HQ tenant's team-inbox
 * triage AiFlow (dogfooding plan, email phase).
 *
 * Watches the connected newcoworkerteam@gmail.com mailbox (the inbox behind
 * team@ / contact@newcoworker.com) via the `email` trigger channel, classifies
 * each inbound message, and texts Brian for the three human-attention
 * categories (sales lead / support / billing). Automated platform notices,
 * contact-form copies (already triaged by the webhook flow), newsletters, and
 * unclassifiable mail stay silent.
 *
 * Idempotent upsert-by-name, validated with parseAiFlowDefinition first.
 *
 * Usage:
 *   npx tsx scripts/oneshot/setup-hq-inbox-triage-flow.ts          # dry-run
 *   npx tsx scripts/oneshot/setup-hq-inbox-triage-flow.ts --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const FLOW_NAME = "Team inbox triage (HQ)";
/** workspace_oauth_connections.id of the HQ Google (Gmail) connection. */
const GMAIL_CONNECTION_ROW_ID = "16cff2b9-b4d3-421c-b25d-b40edd80c9a8";

const { parseAiFlowDefinition } = await import("../../src/lib/ai-flows/schema.ts");
const { createSupabaseServiceClient } = await import("../../src/lib/supabase/server.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

const definition = {
  version: 1,
  trigger: {
    channel: "email",
    connectionId: GMAIL_CONNECTION_ROW_ID,
    conditions: []
  },
  steps: [
    {
      id: "s_extract",
      type: "extract_text",
      fields: [
        {
          name: "email_subject",
          description: "The email's subject line, verbatim"
        },
        {
          name: "email_gist",
          description: "One sentence: what the sender wants"
        }
      ]
    },
    {
      id: "s_classify",
      type: "classify",
      question: "What kind of email did the business just receive?",
      categories: [
        {
          value: "sales_lead",
          description:
            "A prospect asking about New Coworker: pricing, features, a demo, setup, or buying interest"
        },
        {
          value: "support",
          description:
            "An existing customer or user needing help, reporting a problem, or asking an account question"
        },
        {
          value: "billing",
          description:
            "Billing that needs a human: an invoice we must pay, a failed or declined payment, a dispute or chargeback, or a subscription problem. NOT routine receipts or confirmations of successful payments."
        },
        {
          value: "automated_notice",
          description:
            "Automated notifications, our own platform's alert/contact-form copies, calendar invites, newsletters, or marketing blasts — including receipts and payment confirmations for successful charges"
        }
      ],
      saveAs: "email_kind"
    },
    {
      id: "s_notify_sales",
      type: "notify_owner",
      when: { var: "email_kind", equals: "sales_lead" },
      message:
        "Sales email in the team inbox from {{trigger.from}}: {{vars.email_subject}} — {{vars.email_gist}}"
    },
    {
      id: "s_notify_support",
      type: "notify_owner",
      when: { var: "email_kind", equals: "support" },
      message:
        "Support email in the team inbox from {{trigger.from}}: {{vars.email_subject}} — {{vars.email_gist}}"
    },
    {
      id: "s_notify_billing",
      type: "notify_owner",
      when: { var: "email_kind", equals: "billing" },
      message:
        "Billing email in the team inbox from {{trigger.from}}: {{vars.email_subject}} — {{vars.email_gist}}"
    }
  ]
};

parseAiFlowDefinition(definition);
console.log(`[inbox-triage] "${FLOW_NAME}" definition valid`);

const db = await createSupabaseServiceClient();

// The email poller resolves the trigger's connection row at poll time —
// verify it exists and is an email-capable provider before authoring.
const { data: conn, error: connErr } = await db
  .from("workspace_oauth_connections")
  .select("id, provider_config_key, metadata")
  .eq("business_id", HQ_BUSINESS_ID)
  .eq("id", GMAIL_CONNECTION_ROW_ID)
  .maybeSingle();
if (connErr || !conn) {
  console.error("[inbox-triage] Gmail connection row not found — aborting", connErr?.message ?? "");
  process.exit(1);
}
console.log("[inbox-triage] mailbox connection:", conn.provider_config_key, (conn.metadata as { provider_account_email?: string } | null)?.provider_account_email);

const { data: existing, error: listErr } = await db
  .from("ai_flows")
  .select("id, enabled")
  .eq("business_id", HQ_BUSINESS_ID)
  .eq("name", FLOW_NAME)
  .maybeSingle();
if (listErr) {
  console.error("[inbox-triage] existing-flow lookup failed:", listErr.message);
  process.exit(1);
}
console.log(
  `[inbox-triage] "${FLOW_NAME}": ${existing ? `exists (id=${(existing as { id: string }).id}) — will refresh` : "will create (enabled)"}`
);

if (!APPLY) {
  console.log("[inbox-triage] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

let flowId: string;
if (existing) {
  flowId = (existing as { id: string }).id;
  const { error } = await db
    .from("ai_flows")
    .update({ definition, updated_at: new Date().toISOString() })
    .eq("id", flowId);
  if (error) throw new Error(`flow update: ${error.message}`);
  console.log(`[inbox-triage] refreshed (id=${flowId})`);
} else {
  const { data, error } = await db
    .from("ai_flows")
    .insert({
      business_id: HQ_BUSINESS_ID,
      name: FLOW_NAME,
      enabled: true,
      definition
    })
    .select("id")
    .single();
  if (error) throw new Error(`flow insert: ${error.message}`);
  flowId = (data as { id: string }).id;
  console.log(`[inbox-triage] created (id=${flowId})`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "setup-hq-inbox-triage-flow.ts",
  businessId: HQ_BUSINESS_ID,
  details: { flowId, flowName: FLOW_NAME, connectionRowId: GMAIL_CONNECTION_ROW_ID }
});
console.log("[inbox-triage] ledger recorded. Done.");
process.exit(0);
