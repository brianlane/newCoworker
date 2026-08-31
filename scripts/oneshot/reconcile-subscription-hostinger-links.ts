#!/usr/bin/env tsx
/**
 * reconcile-subscription-hostinger-links.ts, one-shot: fill
 * `subscriptions.hostinger_billing_subscription_id` from assigned inventory
 * when the live row is missing it, and cancel unpaid `pending` carts that
 * sit next to a live sibling.
 *
 * Why this exists (Aug 31 2026). `debug/audit-fleet-terms.ts` joins Hostinger
 * billing subscriptions through that column, so two true states looked like
 * problems:
 *
 *   - HQ (`8f3a5c21-...`) prepaid vm 1806097 through 2027-09-05 on Hostinger
 *     sub `16BcBrVOTACBI8WdU`. Inventory had the id. The synthetic
 *     Stripe-less subscription row did not, so the audit printed
 *     tenant=UNLINKED.
 *   - KIN Integrated Child Health kept an Aug 21 abandoned `pending`
 *     checkout next to the Aug 24 paid row. The audit listed KIN twice.
 *
 * Going forward, `orchestrateProvisioning` stamps the live row after every
 * successful provision, and checkout / skip-payment cancel unpaid pending
 * siblings. This script backfills rows written before those call sites.
 *
 * Stamp is fill-only (`onlyIfMissing`): a live row that already has a
 * different Hostinger id is a partial cutover and is skipped, not overwritten.
 * The planner stamps at most once per business, from `businesses.hostinger_vps_id`
 * when that VM is assigned, and refuses when leftover `assigned` inventory
 * rows disagree (a stale_assigned_row must not supply the id).
 * Cancel uses `cancelSubscriptionIfStripeless` so a checkout that attaches a
 * Stripe id between the plan and the write cannot be cancelled.
 *
 * Usage:
 *   npx tsx scripts/oneshot/reconcile-subscription-hostinger-links.ts
 *   npx tsx scripts/oneshot/reconcile-subscription-hostinger-links.ts --apply
 *   npx tsx scripts/oneshot/reconcile-subscription-hostinger-links.ts --business <uuid> --apply
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const BUSINESS_ID = argValue("--business");
if (BUSINESS_ID && !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error(
    "usage: reconcile-subscription-hostinger-links.ts [--business <uuid>] [--apply]"
  );
  process.exit(1);
}

const { createSupabaseServiceClient } = await import("../../src/lib/supabase/server.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");
const { planSubscriptionHostingerReconcile } = await import(
  "../../src/lib/vps/hostinger-tenant-link.ts"
);
const {
  persistHostingerBillingIdOnLiveSubscription,
  cancelSubscriptionIfStripeless
} = await import("../../src/lib/db/subscriptions.ts");

const db = await createSupabaseServiceClient();

const { data: subs, error: subErr } = await db
  .from("subscriptions")
  .select(
    "id, business_id, status, stripe_subscription_id, hostinger_billing_subscription_id, created_at"
  );
if (subErr) throw new Error(`read subscriptions: ${subErr.message}`);

const { data: inventory, error: invErr } = await db
  .from("vps_inventory")
  .select("vm_id, state, assigned_business_id, hostinger_billing_subscription_id");
if (invErr) throw new Error(`read vps_inventory: ${invErr.message}`);

const { data: businesses, error: bizErr } = await db
  .from("businesses")
  .select("id, hostinger_vps_id");
if (bizErr) throw new Error(`read businesses: ${bizErr.message}`);

const currentVmByBusiness = new Map<string, number>();
for (const row of (businesses ?? []) as Array<{ id: string; hostinger_vps_id: string | null }>) {
  const vmId = Number.parseInt(row.hostinger_vps_id ?? "", 10);
  if (Number.isFinite(vmId) && vmId > 0) currentVmByBusiness.set(row.id, vmId);
}

const { plans, skips } = planSubscriptionHostingerReconcile({
  subscriptions: (subs ?? []) as Array<{
    id: string;
    business_id: string;
    status: string;
    stripe_subscription_id: string | null;
    hostinger_billing_subscription_id: string | null;
    created_at: string;
  }>,
  inventory: (inventory ?? []) as Array<{
    vm_id: number;
    state: string;
    assigned_business_id: string | null;
    hostinger_billing_subscription_id: string | null;
  }>,
  businessIds: BUSINESS_ID ? new Set([BUSINESS_ID]) : null,
  currentVmByBusiness
});

console.log(`plans=${plans.length} skips=${skips.length}`);
for (const skip of skips) {
  console.log(`  skip business=${skip.businessId ?? "-"} ${skip.reason}`);
}
for (const plan of plans) {
  if (plan.kind === "stamp") {
    console.log(
      `  stamp business=${plan.businessId} sub=${plan.subscriptionId} ` +
        `hostinger=${plan.hostingerBillingSubscriptionId} vm=${plan.vmId}`
    );
  } else {
    console.log(`  cancel_pending business=${plan.businessId} sub=${plan.subscriptionId}`);
  }
}

if (!APPLY) {
  console.log("dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

if (plans.length === 0) {
  console.log("nothing to apply.");
  process.exit(0);
}

const stamped: string[] = [];
const canceled: string[] = [];
const stampErrors: string[] = [];
for (const plan of plans) {
  if (plan.kind !== "stamp") continue;
  try {
    const wrote = await persistHostingerBillingIdOnLiveSubscription(
      plan.businessId,
      plan.hostingerBillingSubscriptionId,
      { onlyIfMissing: true }
    );
    const { data: readback, error } = await db
      .from("subscriptions")
      .select("id, hostinger_billing_subscription_id")
      .eq("id", plan.subscriptionId)
      .maybeSingle();
    if (error) throw new Error(`readback stamp ${plan.subscriptionId}: ${error.message}`);
    if (readback?.hostinger_billing_subscription_id !== plan.hostingerBillingSubscriptionId) {
      throw new Error(
        `stamp of ${plan.subscriptionId} did not land ` +
          `(wrote=${wrote} now=${readback?.hostinger_billing_subscription_id ?? "null"})`
      );
    }
    stamped.push(plan.subscriptionId);
  } catch (err) {
    stampErrors.push(err instanceof Error ? err.message : String(err));
  }
}
for (const plan of plans) {
  if (plan.kind !== "cancel_pending") continue;
  const flipped = await cancelSubscriptionIfStripeless(plan.subscriptionId);
  const { data: readback, error } = await db
    .from("subscriptions")
    .select("id, status, stripe_subscription_id")
    .eq("id", plan.subscriptionId)
    .maybeSingle();
  if (error) throw new Error(`readback cancel ${plan.subscriptionId}: ${error.message}`);
  if (flipped && readback?.status !== "canceled") {
    throw new Error(`cancel of ${plan.subscriptionId} did not land (status=${readback?.status})`);
  }
  if (flipped) canceled.push(plan.subscriptionId);
  else {
    console.log(
      `  cancel_pending ${plan.subscriptionId} CAS lost ` +
        `(status=${readback?.status} stripe=${readback?.stripe_subscription_id ?? "null"})`
    );
  }
}
if (stampErrors.length > 0) {
  throw new Error(`stamp failed after pending cancels ran: ${stampErrors.join("; ")}`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "reconcile-subscription-hostinger-links.ts",
  businessId: BUSINESS_ID,
  details: { stamped, canceled, skipCount: skips.length }
});
console.log(`applied stamped=${stamped.length} canceled=${canceled.length}`);
