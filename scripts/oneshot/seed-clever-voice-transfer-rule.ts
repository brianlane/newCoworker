#!/usr/bin/env tsx
/**
 * One-shot: seed the Clever live-transfer voice rule for a single tenant.
 *
 * When Clever's live-transfer line (833-225-3837) calls the business DID,
 * telnyx-voice-inbound should bridge the caller straight to the assigned agent
 * (Dave, +16025245719) with no AI conversation and without billing voice
 * minutes. This inserts that row into voice_caller_transfer_rules.
 *
 * Idempotent: upserts on (business_id, from_e164). Dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-clever-voice-transfer-rule.ts            # dry run
 *   npx tsx scripts/oneshot/seed-clever-voice-transfer-rule.ts --apply
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 * Optional overrides:
 *   AIFLOW_CLEVER_VOICE_FROM     (default "+18332253837")
 *   AIFLOW_CLEVER_VOICE_TO       (default "+16025245719" — Dave)
 *   AIFLOW_CLEVER_VOICE_WHISPER  (default none; set a short greeting to play first)
 */
import { createClient } from "@supabase/supabase-js";

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
const E164 = /^\+[1-9][0-9]{6,14}$/;

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

  const fromE164 = process.env.AIFLOW_CLEVER_VOICE_FROM ?? "+18332253837";
  const toE164 = process.env.AIFLOW_CLEVER_VOICE_TO ?? "+16025245719";
  const whisper = (process.env.AIFLOW_CLEVER_VOICE_WHISPER ?? "").trim() || null;

  if (!E164.test(fromE164) || !E164.test(toE164)) {
    console.error(`from/to must be E.164. from=${fromE164} to=${toE164}`);
    process.exit(2);
  }

  const row = {
    business_id: businessId,
    from_e164: fromE164,
    to_e164: toE164,
    whisper
  };

  console.log(`Business : ${businessId}`);
  console.log(`Rule     : ${fromE164} -> ${toE164}${whisper ? ` (whisper: "${whisper}")` : " (no whisper)"}`);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to upsert.");
    return;
  }

  const { error } = await db
    .from("voice_caller_transfer_rules")
    .upsert(row, { onConflict: "business_id,from_e164" });
  if (error) {
    console.error(`Upsert failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`\nUpserted voice transfer rule ${fromE164} -> ${toE164}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
