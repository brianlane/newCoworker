#!/usr/bin/env tsx
/**
 * One-shot: set `subscriptions.contract_auto_renew = false` on an active term
 * row whose Stripe subscription is NOT live, so the record stops claiming a
 * renewal that cannot happen.
 *
 * Why this exists (Amy Laidlaw Real Estate, Jul 28 2026). A Hostinger order
 * "failed but charged" (HTTP 402 while the order completed server-side), so
 * the change-plan orchestrator aborted and canceled the brand-new Stripe
 * subscription OBJECT. The $2,376 payment was captured and kept, and
 * `recover-amy-biennial-switch.ts` finished the switch by adopting the paid
 * box and creating the active row pointing AT that canceled subscription:
 * correct, because the payment is real and only the object cannot renew (see
 * docs/tenants/amy-laidlaw-real-estate.md).
 *
 * What was left wrong is one flag. `contract_auto_renew` stayed `true`, which
 * is impossible without a live subscription, and it had two consequences:
 * the dashboard plan card promised an auto-renew the tenant will never get,
 * and the pre-term rollover nudge treated the contract as self-renewing and
 * planned to send nothing before the term lapsed.
 *
 * Neither flag value describes a canceled-sub term exactly (`false` nominally
 * means "commitment schedule in place", and there is no schedule either), but
 * `false` produces the behaviour that matches reality: nothing auto-renews,
 * and the owner gets the 5-business-day warning pointing at the plan card's
 * "Start a new contract" CTA, which is the documented path back onto a
 * contract rate.
 *
 * Why a script and not the API: `/api/billing/auto-renew` calls
 * `ensureCommitmentSchedule(stripe_subscription_id)` BEFORE writing the flag,
 * and that call fails against a canceled subscription. This writes the column
 * directly and touches nothing else.
 *
 * REFUSES to apply unless Stripe confirms the subscription is genuinely not
 * live, so it can never silently disable a real auto-renewal. Idempotent
 * (a row already `false` is reported and skipped). Dry-run by default.
 * Records to applied_oneshots on --apply.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/clear-stale-contract-auto-renew.ts --business <uuid>
 *   npx tsx scripts/oneshot/clear-stale-contract-auto-renew.ts --business <uuid> --apply
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const BUSINESS_ID = argValue("--business") ?? "";
if (!/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error(
    "usage: clear-stale-contract-auto-renew.ts --business <uuid> [--apply]"
  );
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const stripeSecret = process.env.STRIPE_SECRET_KEY ?? "";
if (!url || !key || !stripeSecret) {
  console.error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / STRIPE_SECRET_KEY");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: sub, error } = await db
  .from("subscriptions")
  .select(
    "id,status,tier,billing_period,contract_auto_renew,stripe_subscription_id,stripe_current_period_end"
  )
  .eq("business_id", BUSINESS_ID)
  .eq("status", "active")
  .order("created_at", { ascending: false })
  .limit(1)
  .maybeSingle();
if (error) {
  console.error(`subscriptions read failed: ${error.message}`);
  process.exit(1);
}
if (!sub) {
  console.error(`no active subscription for business ${BUSINESS_ID}`);
  process.exit(1);
}

const row = sub as {
  id: string;
  tier: string;
  billing_period: string | null;
  contract_auto_renew: boolean;
  stripe_subscription_id: string | null;
  stripe_current_period_end: string | null;
};

console.log(
  `sub=${row.id} tier=${row.tier} period=${row.billing_period} ` +
    `auto_renew=${row.contract_auto_renew} period_end=${row.stripe_current_period_end}`
);

if (row.billing_period !== "annual" && row.billing_period !== "biennial") {
  console.error(`refusing: ${row.billing_period} is not a term plan; the flag is meaningless here`);
  process.exit(1);
}
if (!row.contract_auto_renew) {
  console.log("already false; nothing to do");
  process.exit(0);
}

// Prove the subscription really cannot renew before clearing the flag.
let stripeStatus = "missing";
if (row.stripe_subscription_id) {
  const res = await fetch(
    `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(row.stripe_subscription_id)}`,
    { headers: { Authorization: `Bearer ${stripeSecret}` } }
  );
  if (res.ok) {
    stripeStatus = String(((await res.json()) as { status?: unknown }).status ?? "unknown");
  } else if (res.status !== 404) {
    console.error(`Stripe read failed (HTTP ${res.status}); refusing to guess`);
    process.exit(1);
  }
}
console.log(`stripe subscription ${row.stripe_subscription_id ?? "(none)"} status=${stripeStatus}`);

if (stripeStatus !== "canceled" && stripeStatus !== "missing") {
  console.error(
    `refusing: Stripe reports status=${stripeStatus}, so this contract CAN renew and the flag is correct`
  );
  process.exit(1);
}

if (!APPLY) {
  console.log("DRY RUN: would set contract_auto_renew=false. Re-run with --apply.");
  process.exit(0);
}

const { data: updated, error: upErr } = await db
  .from("subscriptions")
  .update({ contract_auto_renew: false })
  .eq("id", row.id)
  .eq("contract_auto_renew", true)
  .select("id,contract_auto_renew")
  .maybeSingle();
if (upErr) {
  console.error(`update failed: ${upErr.message}`);
  process.exit(1);
}
if (!updated) {
  console.error("update matched zero rows (concurrent change?); nothing written");
  process.exit(1);
}
console.log(`applied: sub=${updated.id} contract_auto_renew=${updated.contract_auto_renew}`);

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    subscription_id: row.id,
    billing_period: row.billing_period,
    stripe_subscription_id: row.stripe_subscription_id,
    stripe_status: stripeStatus,
    contract_auto_renew: false
  }
});
