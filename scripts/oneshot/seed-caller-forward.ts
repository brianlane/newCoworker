#!/usr/bin/env tsx
/**
 * One-shot: label an inbound caller AND forward their calls straight to a human.
 *
 * Two writes, both keyed by (business_id, from_e164), both idempotent upserts:
 *   1. contact_overrides — gives the caller a display name everywhere their
 *      number appears in the dashboard (calls, texts, contacts).
 *   2. voice_caller_transfer_rules — when that number calls the business DID,
 *      telnyx-voice-inbound answers and bridges the caller straight to `--to`
 *      with no AI conversation and without billing voice minutes (runs before
 *      the kill switch / reserve / Stripe / bridge checks). An optional
 *      `--whisper` greeting is spoken to the caller before the transfer.
 *
 * Per scripts/oneshot/README.md, this file hard-codes NO customer values: the
 * business id, both numbers, and the label are all read from argv/env. Numbers
 * may be passed in any common format ("(305) 613-3412", "305-613-3412",
 * "+1…"); US/NANP is assumed when no country code is present.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/seed-caller-forward.ts \
 *     --business-id <uuid> --from "<caller>" --to "<destination>" \
 *     --name "<label>" [--whisper "<greeting>"]            # dry run
 *   npx tsx scripts/oneshot/seed-caller-forward.ts ... --apply
 *
 * Env equivalents: AIFLOW_SEED_BUSINESS_ID, CALLER_FORWARD_FROM,
 * CALLER_FORWARD_TO, CALLER_FORWARD_NAME, CALLER_FORWARD_WHISPER.
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "@supabase/supabase-js";

type Args = {
  apply: boolean;
  businessId: string | null;
  from: string | null;
  to: string | null;
  name: string | null;
  whisper: string | null;
};

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    apply: false,
    businessId: null,
    from: null,
    to: null,
    name: null,
    whisper: null
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else if (a === "--from") args.from = argv[++i] ?? null;
    else if (a === "--to") args.to = argv[++i] ?? null;
    else if (a === "--name") args.name = argv[++i] ?? null;
    else if (a === "--whisper") args.whisper = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const E164 = /^\+[1-9][0-9]{6,14}$/;

/**
 * Coerce free-text phone input to E.164, assuming US/NANP when no country code
 * is present. Mirrors src/lib/telnyx/format.ts#normalizeContactNumber, inlined
 * so this standalone script needs no app imports. Returns null on bad input.
 */
function toE164(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const hasCountryCode = trimmed.startsWith("+") || trimmed.startsWith("00");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  let candidate: string;
  if (hasCountryCode) {
    candidate = `+${trimmed.startsWith("00") ? digits.slice(2) : digits}`;
  } else if (digits.length === 10) {
    candidate = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    candidate = `+${digits}`;
  } else {
    return null;
  }
  return E164.test(candidate) ? candidate : null;
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

function requireValue(label: string, value: string | null): string {
  if (!value || !value.trim()) {
    console.error(`Missing required ${label} (pass via argv or env).`);
    process.exit(2);
  }
  return value.trim();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  const businessId = requireValue(
    "business id (--business-id / AIFLOW_SEED_BUSINESS_ID)",
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? null
  );
  const fromRaw = requireValue(
    "caller (--from / CALLER_FORWARD_FROM)",
    args.from ?? process.env.CALLER_FORWARD_FROM ?? null
  );
  const toRaw = requireValue(
    "destination (--to / CALLER_FORWARD_TO)",
    args.to ?? process.env.CALLER_FORWARD_TO ?? null
  );
  const name = requireValue(
    "contact name (--name / CALLER_FORWARD_NAME)",
    args.name ?? process.env.CALLER_FORWARD_NAME ?? null
  );
  const whisper =
    (args.whisper ?? process.env.CALLER_FORWARD_WHISPER ?? "").trim() || null;

  const fromE164 = toE164(fromRaw);
  const toDest = toE164(toRaw);
  if (!fromE164) {
    console.error(`--from is not a valid phone number: ${fromRaw}`);
    process.exit(2);
  }
  if (!toDest) {
    console.error(`--to is not a valid phone number: ${toRaw}`);
    process.exit(2);
  }
  if (name.length > 120) {
    console.error("--name must be 1-120 characters");
    process.exit(2);
  }

  console.log(`Business : ${businessId}`);
  console.log(`Contact  : ${fromE164} → "${name}"`);
  console.log(
    `Forward  : ${fromE164} → ${toDest}${whisper ? ` (whisper: "${whisper}")` : " (no whisper)"}`
  );

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to upsert both rows.");
    return;
  }

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const { error: contactErr } = await db.from("contact_overrides").upsert(
    {
      business_id: businessId,
      e164: fromE164,
      name,
      updated_at: new Date().toISOString()
    },
    { onConflict: "business_id,e164" }
  );
  if (contactErr) {
    console.error(`contact_overrides upsert failed: ${contactErr.message}`);
    process.exit(1);
  }
  console.log(`Upserted contact override ${fromE164} → "${name}".`);

  const { error: ruleErr } = await db
    .from("voice_caller_transfer_rules")
    .upsert(
      { business_id: businessId, from_e164: fromE164, to_e164: toDest, whisper },
      { onConflict: "business_id,from_e164" }
    );
  if (ruleErr) {
    console.error(`voice_caller_transfer_rules upsert failed: ${ruleErr.message}`);
    process.exit(1);
  }
  console.log(`Upserted voice transfer rule ${fromE164} → ${toDest}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
