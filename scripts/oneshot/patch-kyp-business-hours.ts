/**
 * patch-kyp-business-hours.ts — flow-level business-hours window for KYP Ads.
 *
 * James's white-glove build notes (PRDs/white-glove-build-kyp-ads.md §1) set
 * business hours at 11am–6pm; businesses.timezone = America/Toronto. After
 * nudges landed at 2:12 AM (Jul 19 2026), every KYP flow gets gated:
 *
 *   - "Lead follow-up (white-glove build)" is handled by
 *     patch-kyp-offer-branch.ts (per-step send_sms quietHours on the nudges;
 *     the greeting must keep its 60-second promise) — this script SKIPS it.
 *   - Every OTHER flow gets `definition.timeWindow` (11:00–18:00
 *     America/Toronto): the worker defers any communication step outside the
 *     window to the next open slot (send_sms / send_email / notify_owner /
 *     route_to_team / place_ai_call / send_whatsapp / share_document).
 *
 * Known tradeoff, flagged to James: an evening Calendly booking's
 * confirmation text arrives at 11 AM the next day. If he wants
 * confirmations immediate, remove the window from that one flow.
 *
 * Idempotent: flows already carrying this exact window are left untouched.
 *
 * Usage (business id from --business or KYP_BUSINESS_ID — never hard-coded,
 * per scripts/oneshot/README.md):
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-kyp-business-hours.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/patch-kyp-business-hours.ts --business <uuid> --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";
import { KYP_FLOW_NAME, KYP_TIME_WINDOW } from "./kyp-offer-definition.ts";

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
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: rows, error: listErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", BUSINESS_ID)
  .order("created_at", { ascending: true });

if (listErr) {
  console.error("[oneshot] flow listing failed:", listErr.message);
  process.exit(1);
}

type FlowRow = {
  id: string;
  name: string;
  enabled: boolean;
  definition: Record<string, unknown>;
};

const flows = (rows ?? []) as FlowRow[];
if (flows.length === 0) {
  console.error("[oneshot] business has no flows");
  process.exit(1);
}

const patched: Array<{ id: string; name: string; definition: unknown }> = [];
for (const flow of flows) {
  if (flow.name === KYP_FLOW_NAME) {
    console.log(`[oneshot] skip   "${flow.name}" — gated per-step by patch-kyp-offer-branch.ts`);
    continue;
  }
  const existing = (flow.definition as { timeWindow?: unknown }).timeWindow;
  if (JSON.stringify(existing) === JSON.stringify(KYP_TIME_WINDOW)) {
    console.log(`[oneshot] noop   "${flow.name}" — window already set`);
    continue;
  }
  let definition;
  try {
    definition = parseAiFlowDefinition({ ...flow.definition, timeWindow: { ...KYP_TIME_WINDOW } });
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`[oneshot] "${flow.name}" failed validation with the window:`, err.issues);
    } else {
      console.error(`[oneshot] "${flow.name}" failed validation with the window:`, err);
    }
    process.exit(1);
  }
  console.log(
    `[oneshot] patch  "${flow.name}" (enabled=${flow.enabled}) → timeWindow ${KYP_TIME_WINDOW.start}–${KYP_TIME_WINDOW.end} ${KYP_TIME_WINDOW.timezone}`
  );
  patched.push({ id: flow.id, name: flow.name, definition });
}

if (patched.length === 0) {
  console.log("[oneshot] nothing to patch.");
  process.exit(0);
}

if (!APPLY) {
  console.log(`[oneshot] dry run complete (${patched.length} flow(s) would change). Re-run with --apply to write.`);
  process.exit(0);
}

for (const p of patched) {
  const { error: updateErr } = await db
    .from("ai_flows")
    .update({ definition: p.definition, updated_at: new Date().toISOString() })
    .eq("id", p.id)
    .eq("business_id", BUSINESS_ID);
  if (updateErr) {
    console.error(`[oneshot] update failed for "${p.name}":`, updateErr.message);
    process.exit(1);
  }
  console.log(`[oneshot] wrote  "${p.name}"`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    time_window: KYP_TIME_WINDOW,
    flow_ids: patched.map((p) => p.id),
    flow_names: patched.map((p) => p.name)
  }
});

console.log("[oneshot] applied.");
