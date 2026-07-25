#!/usr/bin/env tsx
/**
 * One-shot: frame the HomeLight live-transfer flow's alert texts in asterisks.
 *
 * Amy's HomeLight live transfer rings Dave, then her, then hands the seller to
 * the AI. The texts that chain already sends are how she learns a transfer is
 * coming: the "Dave Lane +1602... missed a warm transfer for Homelight Live
 * Transfer +1415..." owner copy lands on her phone the instant before her own
 * leg rings. Plain, it reads like every other notification and she misses the
 * call; framed in a row of '*' (the same framing the $1M+ keep-for-owner alert
 * uses) it is unmissable.
 *
 * This sets `options.starAlerts = true` on ONE voice flow, matched by its
 * trigger caller id. Nothing else about the flow changes: no new sends, no new
 * timing, and the message bodies stay byte-identical. The engine only adds the
 * frame (supabase/functions/_shared/star_block.ts).
 *
 * Requires the star-alert engine support (same PR) deployed on the
 * ai-flow/voice edge functions AND a voice-bridge redeploy on the tenant's box
 * (the AI intake summary is framed there):
 *   tsx debug/redeploy-voice-bridge.ts --business-id <uuid>
 * Running this first is harmless: an old engine simply ignores the flag.
 *
 * Validates the patched definition through parseAiFlowDefinition before
 * writing; dry-run by default; idempotent; records the apply in
 * applied_oneshots.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/set-homelight-star-alerts.ts            # dry run
 *   npx tsx scripts/oneshot/set-homelight-star-alerts.ts --apply    # write
 *   npx tsx scripts/oneshot/set-homelight-star-alerts.ts --apply --off
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> or AIFLOW_SEED_BUSINESS_ID (defaults to Amy's).
 * Caller id:   --from <e164> or HOMELIGHT_VOICE_FROM (default +14159851909).
 *
 * Exit codes: 0 patched/no-op/dry-run · 1 Supabase error · 2 bad env/arg, flow
 * not found, or invalid definition.
 */
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { parseAiFlowDefinition, AiFlowValidationError } from "@/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

type Args = { apply: boolean; off: boolean; businessId: string | null; from: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, off: false, businessId: null, from: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--off") args.off = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else if (a === "--from") args.from = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
/** HomeLight's live-transfer line: the flow's trigger caller id. */
const DEFAULT_FROM_E164 = "+14159851909";

type Definition = {
  trigger?: { channel?: string; fromE164?: string } & Record<string, unknown>;
  options?: Record<string, unknown>;
} & Record<string, unknown>;

/**
 * Set (or clear) `options.starAlerts`. Pure and idempotent: returns false when
 * the definition already carries the requested state, and clearing DELETES the
 * key rather than storing false, so an opted-out flow reads exactly as it did
 * before star alerts existed.
 */
export function setStarAlerts(def: Definition, on: boolean): boolean {
  const current = def.options?.starAlerts === true;
  if (current === on) return false;
  if (on) {
    def.options = { ...def.options, starAlerts: true };
  } else {
    const { starAlerts: _drop, ...rest } = def.options ?? {};
    def.options = rest;
  }
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
  const fromE164 = args.from ?? process.env.HOMELIGHT_VOICE_FROM ?? DEFAULT_FROM_E164;
  const on = !args.off;

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Match on the trigger caller id, not the flow name: the migrated flow's
  // name carries the caller's label ("Voice routing ... Homelight Live
  // Transfer"), and an owner rename must not make this silently patch nothing.
  const { data: rows, error } = await db
    .from("ai_flows")
    .select("id, name, definition")
    .eq("business_id", businessId)
    .eq("definition->trigger->>channel", "voice")
    .eq("definition->trigger->>fromE164", fromE164);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const flows = (rows ?? []) as Array<{ id: string; name: string; definition: Definition }>;
  if (flows.length === 0) {
    console.error(
      `No voice flow for business ${businessId} triggered by ${fromE164}. ` +
        "Check --business-id / --from (the caller id must match the trigger exactly)."
    );
    process.exit(2);
  }

  console.log(`Business : ${businessId}`);
  console.log(`Caller   : ${fromE164}`);
  console.log(`starAlerts -> ${on}\n`);

  // Patch + validate EVERY match in memory before writing ANY, so an invalid
  // later flow can never leave the tenant half-patched.
  const pending: Array<{ id: string; name: string; def: Definition }> = [];
  for (const row of flows) {
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    if (!setStarAlerts(def, on)) {
      console.log(`=== ${row.name} (${row.id}) === already ${on ? "on" : "off"}, skipping.`);
      continue;
    }
    try {
      parseAiFlowDefinition(def);
    } catch (err) {
      console.error(
        `\nFlow "${row.name}" (${row.id}) would become INVALID, aborting before any write:`
      );
      if (err instanceof AiFlowValidationError) for (const i of err.issues) console.error(`  - ${i}`);
      else console.error(err);
      process.exit(2);
    }
    console.log(`=== ${row.name} (${row.id}) ===`);
    console.log(`  AFTER options: ${JSON.stringify(def.options ?? {})}`);
    pending.push({ id: row.id, name: row.name, def });
  }

  if (pending.length === 0) {
    console.log("\nNothing to change (already applied).");
    return;
  }
  if (!args.apply) {
    console.log(`\n[dry-run] ${pending.length} flow(s) would change. Re-run with --apply to write.`);
    return;
  }

  const patched: Array<{ id: string; name: string }> = [];
  for (const p of pending) {
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: p.def })
      .eq("id", p.id);
    if (upErr) {
      console.error(`Update failed for ${p.id}: ${upErr.message}`);
      console.error(
        patched.length > 0
          ? `Already written before the failure: ${patched.map((x) => x.name).join(", ")}. Re-run after fixing; the patcher is idempotent.`
          : "Nothing had been written yet."
      );
      process.exit(1);
    }
    console.log(`  -> updated ${p.name}.`);
    patched.push({ id: p.id, name: p.name });
  }

  console.log(`\nPatched ${patched.length} flow(s).`);
  console.log(
    on
      ? "Redeploy the tenant's voice bridge so the AI intake summary is framed too:\n" +
          `  tsx debug/redeploy-voice-bridge.ts --business-id ${businessId}`
      : "The warm-transfer notices go back to plain text on the next call."
  );
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "set-homelight-star-alerts.ts",
    businessId,
    details: { from_e164: fromE164, star_alerts: on, patched }
  });
}

// Run only when executed directly (not when imported by unit tests, which
// exercise the exported pure helper above).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
