#!/usr/bin/env tsx
/**
 * One-shot: seed the "Follow Up Requested (Unclaimed Leads)" AiFlow on Amy
 * Laidlaw's account (asked 2026-08-10).
 *
 * Why: a Clever seller asked on Friday Aug 7 for comparables and a Monday
 * conversation, nobody on the team claimed the lead, and Monday arrived with
 * nothing scheduled to honor either promise. The spoke check's unclaimed
 * track only enrolls leads accepted after its Aug 10 patch and runs on a
 * 3-day grace, so a day-of commitment has no home. This flow is that home:
 *
 *   trigger  tag_changed on "Follow Up Requested" (added) - tag the contact
 *            on the day the follow-up is due (or when they ask for one), from
 *            the dashboard or a future update_contact step. Manual "Run now"
 *            with input text works too, for leads whose context should ride
 *            along (every flow accepts manual runs).
 *   step 1   extract_text: lead_name / lead_phone / route_lead_type /
 *            followup_note (all with non-empty fallbacks: route templates do
 *            not collapse empty vars).
 *   step 2   route_to_team (buyer): Dave Lane + Gabrielle Mota + Jason Lane
 *            race, one shared 15-minute deadline, first "1" claims.
 *   step 3   route_to_team (seller or both): Dave Lane + Gabrielle Mota.
 *   fallback everyone passes / times out -> Amy (business owner) is texted
 *            that the follow-up is back with her.
 *
 * The offer SMS carries the requested *asterisk* emphasis. Claims auto-assign
 * the contact's owner, which also enrolls Clever-tagged leads in the spoke
 * check's weekly track via its owner_assigned trigger: intended.
 *
 * Broadcast lists match roster names IN FULL ("Gabrielle Mota"; "Gabby"
 * reaches nobody), so this script refuses to seed unless every listed name
 * has an ACTIVE roster row.
 *
 * Validated through the SAME parseAiFlowDefinition the dashboard + CRUD API
 * use. Dry-run by default; idempotent (won't create a 2nd flow with the same
 * name unless --force). --apply records to the applied_oneshots ledger.
 *
 * Usage:
 *   npx tsx scripts/oneshot/seed-amy-followup-request-aiflow.ts            # dry run
 *   npx tsx scripts/oneshot/seed-amy-followup-request-aiflow.ts --apply --enable
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional: AIFLOW_SEED_NAME (default "Follow Up Requested (Unclaimed Leads)"),
 *           AIFLOW_FOLLOWUP_TAG (default "Follow Up Requested").
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, summarizeDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");
const { buildFollowupRequestDefinition, BUYER_BROADCAST, FLOW_NAME, FOLLOWUP_TAG } = await import(
  "./amy-followup-request-definition.ts"
);

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
  const name = process.env.AIFLOW_SEED_NAME ?? FLOW_NAME;
  const tag = process.env.AIFLOW_FOLLOWUP_TAG ?? FOLLOWUP_TAG;

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Broadcast matching is by full roster name; a missing or renamed member
  // would silently shrink the race, so refuse to seed until the roster fits.
  // BUYER_BROADCAST is the superset (seller's list minus Jason).
  const { data: members, error: rosterErr } = await db
    .from("ai_flow_team_members")
    .select("name,active,phone_e164")
    .eq("business_id", businessId);
  if (rosterErr) {
    console.error(`roster read failed: ${rosterErr.message}`);
    process.exit(1);
  }
  const activeNames = new Set(
    (members ?? []).filter((m) => m.active).map((m) => m.name as string)
  );
  const missing = BUYER_BROADCAST.filter((n) => !activeNames.has(n));
  if (missing.length > 0) {
    console.error(
      `Roster is missing active member(s): ${missing.join(", ")} - ` +
        "add or reactivate them on the Team page first."
    );
    process.exit(2);
  }

  const definitionInput = buildFollowupRequestDefinition({ tag });
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
    return;
  }

  console.log(`Business : ${businessId}`);
  console.log(`Name     : ${name}`);
  console.log(`Tag      : ${tag} (added)`);
  console.log(`Enabled  : ${args.enable}`);
  console.log(`Summary  : ${summarizeDefinition(definition)}`);
  console.log(`Definition:\n${JSON.stringify(definition, null, 2)}`);

  const { data: existing, error: readErr } = await db
    .from("ai_flows")
    .select("id,enabled")
    .eq("business_id", businessId)
    .eq("name", name)
    .is("deleted_at", null)
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
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "seed-amy-followup-request-aiflow.ts",
    businessId,
    details: { flow_id: data.id, flow_name: name, tag, enabled: args.enable }
  });
  console.log(`\nSeeded AiFlow id=${data.id} (enabled=${args.enable}).`);
  console.log(
    `Entry: add the "${tag}" tag to a contact on the day their follow-up is due, ` +
      "or Run now with input text carrying name/phone/type/context."
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
