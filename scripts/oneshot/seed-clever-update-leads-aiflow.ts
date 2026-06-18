#!/usr/bin/env tsx
/**
 * One-shot: seed the "Clever Update Leads" AiFlow for a single tenant.
 *
 * A weekly reminder text arrives on a dedicated number (314-270-7635) with a
 * link to the Clever portal's Active Connections ("Needs Action (N)") list. This
 * flow opens that link in a credentialed browser session and, for EVERY lead row
 * under Needs Action (browse_action.forEachLink), runs the Provide Update
 * sequence:
 *   Provide Update -> We Spoke -> "No" (scheduled a meeting?) -> notes -> Submit.
 *
 * Selectors below were verified LIVE against the Clever portal (Jun 2026):
 *   - Needs Action list: the first `InfiniteList` section on /active holds
 *     exactly the "Needs Action (N)" lead cards; "Recently Updated" is a second
 *     section. We scope forEachLink to that first section's lead links so a run
 *     touches only the leads that actually need an update.
 *   - Per-lead form: Provide Update -> We Spoke reveals a meeting <select>
 *     (id = the question text, empty name) and a notes <textarea>. Picking "No"
 *     reveals a required react-datepicker ("When do you plan to follow up
 *     again?"): clicking the input opens a calendar whose day cells are
 *     role="option" named e.g. "Choose Wednesday, June 24th, 2026". Choosing the
 *     day (default 12:00 AM) sets the value and enables Submit — no time pick
 *     needed. We template that label with {{now.in7Days.*}} (7 days out).
 * Both the list selector and the action list stay env-overridable (no code edit)
 * via AIFLOW_CLEVER_NEEDS_ACTION_SELECTOR / AIFLOW_CLEVER_UPDATE_ACTIONS_JSON.
 * Seed DISABLED by default; enable only after the live selector check.
 *
 * Validated through the SAME parseAiFlowDefinition the dashboard + CRUD API use.
 * Dry-run by default; idempotent unless --force.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-clever-update-leads-aiflow.ts            # dry run
 *   npx tsx scripts/oneshot/seed-clever-update-leads-aiflow.ts --apply    # insert (disabled)
 *   npx tsx scripts/oneshot/seed-clever-update-leads-aiflow.ts --apply --enable
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional overrides:
 *   AIFLOW_CLEVER_UPDATE_FROM            (default "3142707635")
 *   AIFLOW_CLEVER_INTEGRATION_LABEL      (default "Clever")
 *   AIFLOW_CLEVER_NEEDS_ACTION_SELECTOR  (default scopes to the first/"Needs
 *                                         Action" InfiniteList section's cards)
 *   AIFLOW_CLEVER_UPDATE_ACTIONS_JSON    (default sequence below)
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

// Verified live on a Clever connection page (Provide Update form). The meeting
// <select> carries an empty `name`, so it's targeted by its `id` (the question
// text). The follow-up date is a react-datepicker: open it (click the input by
// placeholder), then click the calendar day cell whose accessible name encodes
// the 7-days-out date. Day-only selection defaults the time to 12:00 AM and is
// enough to enable Submit.
const MEETING_SELECT = 'select[id="Did you schedule a time to meet in person?"]';
const NOTES_PLACEHOLDER = "Type additional details about this update";
const DATE_INPUT = 'input[placeholder="Select a date and time"]';
// Calendar day cell label, e.g. "Choose Wednesday, June 24th, 2026".
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
  from: string;
  integrationLabel: string;
  needsActionSelector: string;
  updateActions: unknown;
}): unknown {
  return {
    version: 1,
    trigger: {
      channel: "sms",
      correlationWindowMinutes: 15,
      conditions: [
        { type: "from_matches", value: opts.from },
        { type: "has_url" }
      ]
    },
    steps: [
      { id: "url", type: "extract_url", saveAs: "portal_url" },
      {
        id: "update_each",
        type: "browse_action",
        urlVar: "portal_url",
        auth: { integrationLabel: opts.integrationLabel },
        forEachLink: opts.needsActionSelector,
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

  const name = process.env.AIFLOW_SEED_NAME ?? "Clever Update Leads";
  const definitionInput = buildDefinition({
    from: process.env.AIFLOW_CLEVER_UPDATE_FROM ?? "3142707635",
    integrationLabel: process.env.AIFLOW_CLEVER_INTEGRATION_LABEL ?? "Clever",
    needsActionSelector:
      process.env.AIFLOW_CLEVER_NEEDS_ACTION_SELECTOR ??
      'section[data-sentry-component="InfiniteList"]:first-of-type a.clickable-card',
    updateActions: parseActionsEnv("AIFLOW_CLEVER_UPDATE_ACTIONS_JSON", DEFAULT_UPDATE_ACTIONS)
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
