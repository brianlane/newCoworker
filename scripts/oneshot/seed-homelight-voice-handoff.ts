#!/usr/bin/env tsx
/**
 * One-shot: seed the HomeLight live-transfer warm-handoff chain for a tenant.
 *
 * When HomeLight's live-transfer line (+14159851909) calls the business DID,
 * telnyx-voice-inbound should:
 *   1. Ring Dave (+16025245719) for ~20s. If he answers he is bridged to the
 *      live line and presses 1 himself to reach the client.
 *   2. If Dave misses, ring Amy (+16026951142) for ~20s, same behavior.
 *   3. If neither answers, the AI worker takes the call, presses 1 (DTMF) so
 *      HomeLight connects the client, captures the lead, and texts Amy
 *      (+16026951142) a summary + the call transcript after the call ends.
 *
 * Inserts/updates one row in voice_handoff_chains. Disabled by default: pass
 * --enable to flip it on (do this only after a live test confirms the Telnyx
 * transfer no-answer semantics on this account).
 *
 * Idempotent: upserts on (business_id, from_e164). Dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-homelight-voice-handoff.ts            # dry run
 *   npx tsx scripts/oneshot/seed-homelight-voice-handoff.ts --apply    # write (disabled)
 *   npx tsx scripts/oneshot/seed-homelight-voice-handoff.ts --apply --enable
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional overrides:
 *   HOMELIGHT_VOICE_FROM      (default "+14159851909" — HomeLight live transfer)
 *   HOMELIGHT_VOICE_DAVE      (default "+16025245719" — Dave)
 *   HOMELIGHT_VOICE_AMY       (default "+16026951142" — Amy)
 *   HOMELIGHT_VOICE_RING_SECS (default 20)
 */
import { createClient } from "@supabase/supabase-js";

type Args = { apply: boolean; enable: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, enable: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--enable") args.enable = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const E164 = /^\+[1-9][0-9]{6,14}$/;

const INTAKE_PERSONA =
  "Hi, this is Amy Laidlaw's office. Amy's tied up right now but I'd love to grab your details so she can call you right back about selling your home.";
const CAPTURE_FIELDS = ["name", "phone", "address", "timeframe", "notes"];

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

  const fromE164 = process.env.HOMELIGHT_VOICE_FROM ?? "+14159851909";
  const daveE164 = process.env.HOMELIGHT_VOICE_DAVE ?? "+16025245719";
  const amyE164 = process.env.HOMELIGHT_VOICE_AMY ?? "+16026951142";
  const ringSecs = Number(process.env.HOMELIGHT_VOICE_RING_SECS ?? "20");

  for (const [label, val] of [
    ["from", fromE164],
    ["dave", daveE164],
    ["amy", amyE164]
  ] as const) {
    if (!E164.test(val)) {
      console.error(`${label} must be E.164: ${val}`);
      process.exit(2);
    }
  }
  if (!Number.isFinite(ringSecs) || ringSecs < 5 || ringSecs > 120) {
    console.error(`ring_secs must be 5..120: ${ringSecs}`);
    process.exit(2);
  }

  const row = {
    business_id: businessId,
    from_e164: fromE164,
    steps: [
      { to_e164: daveE164, ring_secs: ringSecs },
      { to_e164: amyE164, ring_secs: ringSecs }
    ],
    ai_takeover: {
      notify_e164: amyE164,
      persona: INTAKE_PERSONA,
      capture_fields: CAPTURE_FIELDS
    },
    enabled: args.enable
  };

  console.log(`Business : ${businessId}`);
  console.log(`Chain    : ${fromE164}`);
  console.log(`  step 1 : ring Dave ${daveE164} for ${ringSecs}s`);
  console.log(`  step 2 : ring Amy  ${amyE164} for ${ringSecs}s`);
  console.log(`  AI      : take over, capture lead, text ${amyE164}`);
  console.log(`Enabled  : ${args.enable}`);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply (add --enable to turn it on).");
    return;
  }

  const { error } = await db
    .from("voice_handoff_chains")
    .upsert(row, { onConflict: "business_id,from_e164" });
  if (error) {
    console.error(`Upsert failed: ${error.message}`);
    process.exit(1);
  }
  console.log(
    `\nUpserted voice handoff chain ${fromE164} (enabled=${args.enable}).` +
      (args.enable ? "" : "\nRe-run with --enable after a live test to activate.")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
