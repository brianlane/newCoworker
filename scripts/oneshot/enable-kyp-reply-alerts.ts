#!/usr/bin/env tsx
/**
 * One-shot: enable customer_reply_alerts for KYP Ads.
 *
 * KYP feedback (Jul 20 2026): James — "You need to let me know when clients
 * text back i didnt see his texts". The platform-wide feature (PR for the
 * `sms_customer_reply` alert: opt-in `notification_preferences.
 * customer_reply_alerts`, deterministic dispatch from the sms-inbound-worker,
 * per-contact coalescing) defaults OFF for every tenant; this script flips
 * it ON for the tenant who asked.
 *
 * Idempotent: re-running against an already-enabled row is a no-op write.
 * Dry-run by default; --apply writes and records the applied_oneshots ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/enable-kyp-reply-alerts.ts            # dry run
 *   npx tsx scripts/oneshot/enable-kyp-reply-alerts.ts --apply    # write
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: --business-id <uuid> (defaults to KYP Ads).
 *
 * Exit codes: 0 applied/no-op/dry-run · 1 Supabase error · 2 bad env/arg.
 */
import { createClient } from "@supabase/supabase-js";
import { recordOneshotApplied } from "./_ledger";

const KYP_BUSINESS_ID = "056034a7-e84c-444d-8d15-747eeb1fa899";

type Args = { apply: boolean; businessId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: KYP_BUSINESS_ID };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") {
      // Validate the value so `--business-id --apply` reports a missing
      // value instead of storing "--apply" as the id (Bugbot Low, PR #802).
      const value = argv[++i] ?? "";
      if (!UUID_RE.test(value)) {
        console.error(`--business-id requires a UUID, got: ${value || "(nothing)"}`);
        process.exit(2);
      }
      args.businessId = value;
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL/SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: biz, error: bizErr } = await db
    .from("businesses")
    .select("id, name")
    .eq("id", args.businessId)
    .maybeSingle();
  if (bizErr) {
    console.error(`business lookup failed: ${bizErr.message}`);
    process.exit(1);
  }
  if (!biz) {
    console.error(`business ${args.businessId} not found`);
    process.exit(2);
  }

  const { data: prefs, error: prefsErr } = await db
    .from("notification_preferences")
    .select("business_id, customer_reply_alerts")
    .eq("business_id", args.businessId)
    .maybeSingle();
  if (prefsErr) {
    console.error(`prefs lookup failed: ${prefsErr.message}`);
    process.exit(1);
  }

  const current = (prefs as { customer_reply_alerts?: boolean } | null)?.customer_reply_alerts;
  console.log(
    `${(biz as { name?: string }).name} (${args.businessId}): prefs row ${prefs ? "exists" : "MISSING"}, customer_reply_alerts=${String(current ?? "n/a")}`
  );

  if (!args.apply) {
    console.log("Dry run — re-run with --apply to enable client reply alerts.");
    return;
  }

  if (prefs) {
    const { error } = await db
      .from("notification_preferences")
      .update({ customer_reply_alerts: true, updated_at: new Date().toISOString() })
      .eq("business_id", args.businessId);
    if (error) {
      console.error(`update failed: ${error.message}`);
      process.exit(1);
    }
  } else {
    // No prefs row yet: insert one carrying only the opt-in — every other
    // column takes its DB default (identical to the app's first-save shape).
    const { error } = await db
      .from("notification_preferences")
      .insert({ business_id: args.businessId, customer_reply_alerts: true });
    if (error) {
      console.error(`insert failed: ${error.message}`);
      process.exit(1);
    }
  }

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1] ?? "enable-kyp-reply-alerts.ts",
    businessId: args.businessId,
    details: { customer_reply_alerts: true, previous: current ?? null }
  });
  console.log("customer_reply_alerts enabled.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
