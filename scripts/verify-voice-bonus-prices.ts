#!/usr/bin/env tsx
/**
 * Voice-bonus price parity check — CI guardrail for the env ⇄ Stripe contract.
 *
 * ## Why this exists
 *
 * `src/lib/billing/voice-bonus-packs.ts` computes the pack's displayed USD
 * amount from `VOICE_BONUS_USD_PER_MINUTE × pack.minutes` and hands Stripe the
 * `STRIPE_VOICE_BONUS_<N>MIN_PRICE_ID` at checkout. Stripe then charges the
 * Price's immutable `unit_amount` — which is NOT derived from our env. If an
 * operator ever ships a `VOICE_BONUS_USD_PER_MINUTE` change without rotating
 * the Price IDs to fresh Prices whose `unit_amount = minutes × rate × 100`,
 * the UI will advertise one price and Stripe will charge a different one.
 *
 * This script is the operator guardrail: run it in CI (and before every
 * pricing-related deploy) against the environment that will ship, and fail
 * the build on mismatch. See the "Pricing contract" block in
 * `src/lib/billing/voice-bonus-packs.ts` for the full rationale.
 *
 * ## What it checks
 *
 * For every pack whose Price ID env var is set, asserts:
 *   stripe.prices.retrieve(id).unit_amount === minutes × rate × 100 (cents)
 *   stripe.prices.retrieve(id).currency   === "usd"
 *   stripe.prices.retrieve(id).active     === true
 *   stripe.prices.retrieve(id).type       === "one_time"
 *
 * Missing Price ID env vars are *not* failures — they fail-closed at runtime
 * (the pack is hidden from the UI and rejected by the API). Pass `--require-all`
 * to treat missing IDs as an error for stricter prod gating.
 *
 * ## Usage
 *
 *   STRIPE_SECRET_KEY=… \
 *   VOICE_BONUS_USD_PER_MINUTE=0.43 \
 *   STRIPE_VOICE_BONUS_30MIN_PRICE_ID=price_… \
 *   STRIPE_VOICE_BONUS_120MIN_PRICE_ID=price_… \
 *   STRIPE_VOICE_BONUS_600MIN_PRICE_ID=price_… \
 *   npx tsx scripts/verify-voice-bonus-prices.ts [--require-all] [--json]
 *
 * ## Exit codes
 *   0  — every configured pack's Stripe Price matches the env-derived amount
 *   1  — at least one mismatch (or missing ID with --require-all)
 *   2  — required env missing (STRIPE_SECRET_KEY) or bad CLI args
 */
import Stripe from "stripe";
import {
  listVoiceBonusPacks,
  getVoiceBonusUsdPerMinute,
  VOICE_BONUS_PACK_IDS
} from "../src/lib/billing/voice-bonus-packs";

type CliArgs = { requireAll: boolean; json: boolean };

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { requireAll: false, json: false };
  for (const arg of argv) {
    if (arg === "--require-all") out.requireAll = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: verify-voice-bonus-prices.ts [--require-all] [--json]\n" +
          "  --require-all  Treat missing STRIPE_VOICE_BONUS_*MIN_PRICE_ID as a failure\n" +
          "  --json         Emit machine-readable result to stdout"
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return out;
}

type PackResult = {
  packId: string;
  priceId: string;
  minutes: number;
  expectedCents: number;
  actualCents: number | null;
  currency: string | null;
  active: boolean | null;
  type: string | null;
  ok: boolean;
  reason?: string;
};

type MissingResult = { packId: string; priceEnv: string };

async function checkPack(stripe: Stripe, packId: string, priceId: string, minutes: number, rate: number): Promise<PackResult> {
  // minutes × rate is fraction-safe because both are finite; × 100 then round
  // mirrors `buildPack` in voice-bonus-packs.ts so the comparison is
  // bit-exact against what Stripe Checkout will bill.
  const expectedCents = Math.round(minutes * rate * 100);
  try {
    const price = await stripe.prices.retrieve(priceId);
    const actualCents = price.unit_amount;
    const reasons: string[] = [];
    if (actualCents !== expectedCents) {
      reasons.push(`unit_amount=${actualCents} expected=${expectedCents}`);
    }
    if (price.currency !== "usd") reasons.push(`currency=${price.currency} expected=usd`);
    if (!price.active) reasons.push("price is archived (active=false)");
    if (price.type !== "one_time") reasons.push(`type=${price.type} expected=one_time`);
    return {
      packId,
      priceId,
      minutes,
      expectedCents,
      actualCents,
      currency: price.currency,
      active: price.active,
      type: price.type,
      ok: reasons.length === 0,
      reason: reasons.length > 0 ? reasons.join("; ") : undefined
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      packId,
      priceId,
      minutes,
      expectedCents,
      actualCents: null,
      currency: null,
      active: null,
      type: null,
      ok: false,
      reason: `stripe.prices.retrieve failed: ${msg}`
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const stripeKey = process.env.STRIPE_SECRET_KEY ?? "";
  if (!stripeKey) {
    console.error("Missing env: STRIPE_SECRET_KEY");
    process.exit(2);
  }

  const rate = getVoiceBonusUsdPerMinute();
  const configured = listVoiceBonusPacks();
  const configuredIds = new Set(configured.map((p) => p.id));
  const missing: MissingResult[] = VOICE_BONUS_PACK_IDS.filter((id) => !configuredIds.has(id)).map((id) => ({
    packId: id,
    // Match the naming convention used in voice-bonus-packs.ts so operators can
    // grep the same string in env files / Vercel UI.
    priceEnv: `STRIPE_VOICE_BONUS_${id.replace("min_", "")}MIN_PRICE_ID`
  }));

  if (!args.json) {
    console.log(`[verify-voice-bonus-prices] rate=$${rate.toFixed(4)}/min packs=${configured.length}/${VOICE_BONUS_PACK_IDS.length}`);
  }

  const stripe = new Stripe(stripeKey, { apiVersion: "2026-02-25.clover" });

  // Fire checks in parallel — three calls max, well under Stripe's rate limit.
  const results = await Promise.all(
    configured.map((pack) => checkPack(stripe, pack.id, pack.priceId, pack.minutes, rate))
  );

  const failures = results.filter((r) => !r.ok);
  const missingIsFailure = args.requireAll && missing.length > 0;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          ok: failures.length === 0 && !missingIsFailure,
          rate,
          checked: results,
          missing,
          requireAll: args.requireAll
        },
        null,
        2
      )
    );
  } else {
    for (const r of results) {
      const tag = r.ok ? "PASS" : "FAIL";
      const amount = r.actualCents == null ? "—" : `$${(r.actualCents / 100).toFixed(2)}`;
      const expected = `$${(r.expectedCents / 100).toFixed(2)}`;
      console.log(`  [${tag}] ${r.packId} (${r.minutes}m) price=${r.priceId} stripe=${amount} expected=${expected}${r.reason ? ` — ${r.reason}` : ""}`);
    }
    for (const m of missing) {
      const tag = args.requireAll ? "FAIL" : "SKIP";
      console.log(`  [${tag}] ${m.packId} — ${m.priceEnv} is unset`);
    }
  }

  if (failures.length > 0 || missingIsFailure) {
    if (!args.json) {
      console.error(
        `\n[verify-voice-bonus-prices] FAILED: ${failures.length} mismatched, ${missing.length} missing${args.requireAll ? " (counted)" : ""}`
      );
    }
    process.exit(1);
  }

  if (!args.json) {
    console.log("\n[verify-voice-bonus-prices] OK — UI price ≡ Stripe charge for every configured pack");
  }
}

main().catch((err) => {
  console.error("[verify-voice-bonus-prices] unexpected error:", err);
  process.exit(1);
});
