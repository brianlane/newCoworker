#!/usr/bin/env tsx
/**
 * One-shot: give HomeLight's announcement more time before the blind press.
 *
 * After accept-on-prompt shipped, Amy's live-transfer still forfeited a referral
 * when the 12s blind fallback fired during the long lead announcement (before
 * "press 1"), Telnyx returned OK, and the bridge refused every later press while
 * HomeLight kept looping. The bridge now re-presses pre-human; this oneshot
 * also moves the first blind backstop from 12s to 20s so that first tone is
 * less likely to land mid-announcement.
 *
 * Idempotent: a flow already at 20 (or higher) is a no-op. Dry-run by default;
 * records the apply in applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/homelight-accept-fallback-20.ts            # dry run
 *   npx tsx scripts/oneshot/homelight-accept-fallback-20.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Optional: AIFLOW_HOMELIGHT_VOICE_FLOW_NAME (default "HomeLight Live Transfer (AI takes the call)")
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg, flow
 * not found, unexpected flow shape, or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

type Args = { apply: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
/** Blind backstop seconds after Gemini setup; model-on-cue remains primary. */
export const TARGET_FALLBACK_SECONDS = 20;

export type Step = Record<string, unknown> & { id?: string; type?: string };
export type Definition = { steps?: Step[] } & Record<string, unknown>;

/**
 * Raise acceptOnPrompt.fallbackSeconds to TARGET_FALLBACK_SECONDS when lower.
 * Pure and idempotent. Throws when the flow is not in accept-on-prompt mode.
 */
export function raiseAcceptFallbackSeconds(
  def: Definition,
  targetSeconds: number = TARGET_FALLBACK_SECONDS
): boolean {
  const intake = (def.steps ?? []).find((s) => s.type === "voice_ai_intake");
  if (!intake) throw new Error("no voice_ai_intake step in this flow");
  const gate = intake.acceptOnPrompt as
    | { digit?: string; fallbackSeconds?: number }
    | undefined;
  if (!gate || typeof gate.digit !== "string" || !gate.digit.trim()) {
    throw new Error("the intake has no acceptOnPrompt gate to raise");
  }
  const current =
    typeof gate.fallbackSeconds === "number" && Number.isFinite(gate.fallbackSeconds)
      ? gate.fallbackSeconds
      : 0;
  if (current >= targetSeconds) return false;
  intake.acceptOnPrompt = { ...gate, digit: gate.digit, fallbackSeconds: targetSeconds };
  return true;
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
  const flowName =
    process.env.AIFLOW_HOMELIGHT_VOICE_FLOW_NAME ?? "HomeLight Live Transfer (AI takes the call)";

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .eq("name", flowName)
    .maybeSingle();
  if (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (!row) {
    console.error(`flow not found: ${flowName}`);
    process.exit(2);
  }

  const def = structuredClone(row.definition as Definition);
  let changed = false;
  try {
    changed = raiseAcceptFallbackSeconds(def);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const intake = (def.steps ?? []).find((s) => s.type === "voice_ai_intake");
  const gate = intake?.acceptOnPrompt as { fallbackSeconds?: number } | undefined;
  console.log(`=== ${row.name} (${row.id}) ===`);
  console.log(`  acceptOnPrompt.fallbackSeconds: ${gate?.fallbackSeconds ?? "(none)"}`);

  if (!changed) {
    console.log("  already at target; nothing to do.");
    process.exit(0);
  }

  try {
    parseAiFlowDefinition(def);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("patched definition failed validation:", err.issues.join("; "));
    } else {
      console.error(err);
    }
    process.exit(2);
  }

  if (!args.apply) {
    console.log("  dry-run: would raise fallbackSeconds to", TARGET_FALLBACK_SECONDS);
    process.exit(0);
  }

  const { error: upErr } = await db
    .from("ai_flows")
    .update({ definition: def })
    .eq("id", row.id)
    .eq("business_id", businessId);
  if (upErr) {
    console.error(upErr.message);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "homelight-accept-fallback-20.ts",
    businessId,
    details: {
      flow_id: row.id,
      flow_name: row.name,
      fallback_seconds: TARGET_FALLBACK_SECONDS
    }
  });
  console.log("  -> updated.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
