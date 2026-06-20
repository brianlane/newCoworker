#!/usr/bin/env tsx
/**
 * One-shot: seed the "Clever Lead - Accept" AiFlow for a single tenant.
 *
 * This is Flow A of the two-flow Clever design (see the Clever lead AI flow
 * plan). It fires on the inbound "Clever referral" alert that carries the
 * listwithclever lead link, then in ONE credentialed browser pass it:
 *   1. accepts the lead (clicks "Next" until the multi-step wizard is done),
 *   2. extracts the lead's name/phone/email from the accepted page, and
 *   3. screenshots the page (the "QT" Amy forwards),
 * using the engine capabilities shipped in the Clever engine PR
 * (`click_text_while_present` + `browse_action.fields`).
 *
 * Then it:
 *   - emails the QT to amy@amylaidlaw.com (subject "<lead> QT, Clever"),
 *   - hands the lead to Dave Lane via route_to_team (mirrors the
 *     ReferralExchange seller routing: 10-min offer window, owner fallback,
 *     screenshot MMS), and
 *   - leaves a status update back on Clever (second credentialed browse_action).
 *
 * IMPORTANT — prerequisites before --apply / --enable:
 *   - The ai-flow-worker Edge function AND the tenant's render VPS must be on
 *     the Clever-engine build (older builds reject `click_text_while_present`
 *     and won't return page text in ACTION mode).
 *   - Amy must store the "Clever" custom integration (username/password) so the
 *     credentialed browse can log in. Without it the accept browse_action fails
 *     with auth_config_error.
 *   - The accept/update SELECTORS below are best-effort defaults; capture the
 *     exact Clever button/field text during the live test and override them via
 *     the AIFLOW_CLEVER_* env vars (no code edit needed).
 *
 * Validated through the SAME `parseAiFlowDefinition` the dashboard + CRUD API
 * use. Dry-run by default; idempotent (won't create a 2nd flow with the same
 * name unless --force).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-clever-lead-accept-aiflow.ts            # dry run
 *   npx tsx scripts/oneshot/seed-clever-lead-accept-aiflow.ts --apply    # insert (disabled)
 *   npx tsx scripts/oneshot/seed-clever-lead-accept-aiflow.ts --apply --enable
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid>
 *   (defaults to Amy's business).
 * Optional overrides (capture during live test):
 *   AIFLOW_CLEVER_INTEGRATION_LABEL   (default "Clever")
 *   AIFLOW_CLEVER_MATCH_TEXT          (default "Clever referral")
 *   AIFLOW_CLEVER_ACCEPT_ACTIONS_JSON (default: click "Next" while present)
 *   AIFLOW_CLEVER_UPDATE_ACTIONS_JSON (default: leave-an-update click+fill)
 *   AIFLOW_CLEVER_QT_EMAIL_TO         (default "amy@amylaidlaw.com")
 *   AIFLOW_CLEVER_AGENT_NAME          (default "Dave Lane")
 */
import { createClient } from "@supabase/supabase-js";
import {
  parseAiFlowDefinition,
  summarizeDefinition,
  AiFlowValidationError
} from "@/lib/ai-flows/schema";

type Args = { apply: boolean; enable: boolean; force: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, enable: false, force: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--enable") args.enable = true;
    else if (a === "--force") args.force = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

// The accept wizard: click "Accept", then keep clicking "Next" until the button
// is gone (the count varies per lead). If the final confirm button is a fixed
// label, append a click_text for it via AIFLOW_CLEVER_ACCEPT_ACTIONS_JSON
// during the live test.
const DEFAULT_ACCEPT_ACTIONS = [
  { kind: "click_text", target: "Accept" },
  { kind: "click_text_while_present", target: "Next" }
];

// Leaving a Clever status update on the just-accepted lead page, using the SAME
// live-verified Provide Update sequence proven in the Clever Update Leads flow
// (Provide Update -> We Spoke -> meeting "No" -> follow-up 7 days out -> notes
// -> Submit). Exact labels/placeholders stay env-overridable for the live test.
const MEETING_SELECT = 'select[id="Did you schedule a time to meet in person?"]';
const NOTES_PLACEHOLDER = "Type additional details about this update";
const DATE_INPUT = 'input[placeholder="Select a date and time"]';
const FOLLOWUP_DAY_LABEL =
  "Choose {{now.in7Days.weekday}}, {{now.in7Days.month}} {{now.in7Days.dayOrdinal}}, {{now.in7Days.year}}";
const DEFAULT_UPDATE_ACTIONS = [
  { kind: "click_text", target: "Provide Update" },
  { kind: "click_text", target: "We Spoke" },
  { kind: "select_option", target: MEETING_SELECT, valueTemplate: "No" },
  { kind: "click_selector", target: DATE_INPUT },
  { kind: "click_role", target: "option", valueTemplate: FOLLOWUP_DAY_LABEL },
  { kind: "fill_placeholder", target: NOTES_PLACEHOLDER, valueTemplate: "call, texted, and emailed" },
  { kind: "click_text", target: "Submit Update" }
];

function parseActionsEnv(name: string, fallback: unknown): unknown {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    console.error(`Invalid JSON in ${name}`);
    process.exit(2);
  }
}

function buildDefinition(opts: {
  integrationLabel: string;
  matchText: string;
  acceptActions: unknown;
  updateActions: unknown;
  qtEmailTo: string;
  agentName: string;
}): unknown {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 15,
      conditions: [
        { type: "has_url" },
        { type: "contains", value: opts.matchText, caseInsensitive: true }
      ]
    },
    steps: [
      { id: "url", type: "extract_url", saveAs: "lead_url" },
      // ONE credentialed pass: accept (click Next while present), then extract
      // the lead fields from the accepted page, and screenshot it (the QT).
      {
        id: "accept",
        type: "browse_action",
        urlVar: "lead_url",
        auth: { integrationLabel: opts.integrationLabel },
        actions: opts.acceptActions,
        fields: [
          { name: "lead_first_name", description: "The lead's first name" },
          { name: "lead_last_name", description: "The lead's last name" },
          { name: "lead_name", description: "The lead's full name" },
          { name: "lead_phone", description: "The lead's phone number in E.164 if possible" },
          { name: "lead_email", description: "The lead's email address, or 'none'" }
        ],
        screenshot: true
      },
      // Email the QT (screenshot) to Amy. Include the extracted lead fields AND
      // the full original lead text ({{trigger.windowText}}) plus the source so
      // she has everything Clever sent, not just name/phone/email.
      {
        id: "qt_email",
        type: "send_email",
        to: opts.qtEmailTo,
        subject: "{{vars.lead_name}} QT, Clever",
        body:
          "New Clever lead accepted: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
          "Lead source: Clever (listwithclever.com)\n\n" +
          "Full lead details:\n{{trigger.windowText}}\n\nQT attached.",
        attachScreenshot: true
      },
      // Hand the lead to Dave Lane (mirrors the ReferralExchange seller routing).
      // Team/owner messages carry the extracted fields, the source label, and the
      // full original lead text so whoever claims it has the complete context.
      {
        id: "route",
        type: "route_to_team",
        agentName: opts.agentName,
        offerTemplate:
          "New Clever lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
          "Lead source: Clever (listwithclever.com)\n" +
          "Details: {{trigger.windowText}}\n" +
          "Reply 1 to claim or 2 to pass by {{offer.deadline}}, or it goes to the next agent.",
        responseMinutes: 10,
        offerWindow: {
          timezone: "America/Phoenix",
          quietStart: "21:00",
          quietEnd: "08:30",
          graceMinutes: 10
        },
        ownerFallbackTemplate:
          "No agent claimed the Clever lead {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
          "Lead source: Clever (listwithclever.com)\n" +
          "Details: {{trigger.windowText}}\nIt's back to you.",
        claimedNotifyTemplate:
          "{{agent.name}} claimed the Clever lead {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\n" +
          "Lead source: Clever (listwithclever.com)",
        attachScreenshot: true
      },
      // Leave a status update back on Clever.
      {
        id: "update",
        type: "browse_action",
        urlVar: "lead_url",
        auth: { integrationLabel: opts.integrationLabel },
        actions: opts.updateActions
      }
    ],
    options: { suppressDefaultReply: true }
  };
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;

  const name = process.env.AIFLOW_SEED_NAME ?? "Clever Lead - Accept";
  const definitionInput = buildDefinition({
    integrationLabel: process.env.AIFLOW_CLEVER_INTEGRATION_LABEL ?? "Clever",
    matchText: process.env.AIFLOW_CLEVER_MATCH_TEXT ?? "Clever referral",
    acceptActions: parseActionsEnv("AIFLOW_CLEVER_ACCEPT_ACTIONS_JSON", DEFAULT_ACCEPT_ACTIONS),
    updateActions: parseActionsEnv("AIFLOW_CLEVER_UPDATE_ACTIONS_JSON", DEFAULT_UPDATE_ACTIONS),
    qtEmailTo: process.env.AIFLOW_CLEVER_QT_EMAIL_TO ?? "amy@amylaidlaw.com",
    agentName: process.env.AIFLOW_CLEVER_AGENT_NAME ?? "Dave Lane"
  });

  let definition;
  try {
    definition = parseAiFlowDefinition(definitionInput);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("Definition failed validation:");
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error("Definition failed validation:", err);
    }
    process.exit(2);
  }

  console.log(`Business : ${businessId}`);
  console.log(`Name     : ${name}`);
  console.log(`Enabled  : ${args.enable}`);
  console.log(`Summary  : ${summarizeDefinition(definition)}`);
  console.log(`Definition:\n${JSON.stringify(definition, null, 2)}`);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { data: existing, error: readErr } = await db
    .from("ai_flows")
    .select("id,enabled")
    .eq("business_id", businessId)
    .eq("name", name)
    .maybeSingle();
  if (readErr) {
    console.error(`Read failed: ${readErr.message}`);
    process.exit(1);
  }
  if (existing && !args.force) {
    console.log(
      `\nFlow "${name}" already exists (id=${existing.id}, enabled=${existing.enabled}). ` +
        "Nothing to do. Pass --force to create a duplicate."
    );
    return;
  }

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to insert.");
    return;
  }

  const { data, error } = await db
    .from("ai_flows")
    .insert({ business_id: businessId, name, enabled: args.enable, definition })
    .select("id")
    .single();
  if (error) {
    console.error(`Insert failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`\nSeeded AiFlow id=${data.id} (enabled=${args.enable}).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
