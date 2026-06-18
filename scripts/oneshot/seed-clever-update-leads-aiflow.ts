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
 * NOTE — selectors to confirm in the live test (then override via env, no code
 * edit): the Needs Action row link selector (AIFLOW_CLEVER_NEEDS_ACTION_SELECTOR)
 * and the per-lead action sequence (AIFLOW_CLEVER_UPDATE_ACTIONS_JSON). The
 * default action list is the sequence verified live on a single connection page;
 * the "follow up in 7 days" date field (revealed after picking "No") is widget-
 * dependent — add it to the override using {{now.in7Days.*}} once its DOM is
 * confirmed. Seed DISABLED; enable only after the live selector check.
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
 *   AIFLOW_CLEVER_NEEDS_ACTION_SELECTOR  (default 'a[href*="/connection/"]')
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

// Verified live on a single Clever connection page (Provide Update form). The
// meeting <select> name + notes placeholder are the real labels. The optional
// "follow up in 7 days" date step is added live (see header) via the override.
const MEETING_SELECT = 'select[name="Did you schedule a time to meet in person?"]';
const NOTES_PLACEHOLDER = "Type additional details about this update";
const DEFAULT_UPDATE_ACTIONS = [
  { kind: "click_text", target: "Provide Update" },
  { kind: "click_text", target: "We Spoke" },
  { kind: "select_option", target: MEETING_SELECT, valueTemplate: "No" },
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
      process.env.AIFLOW_CLEVER_NEEDS_ACTION_SELECTOR ?? 'a[href*="/connection/"]',
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
