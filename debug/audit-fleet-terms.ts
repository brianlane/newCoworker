/**
 * audit-fleet-terms.ts — read-only fleet audit: for every Hostinger billing
 * subscription + VM, show the billing cycle we're paying vs the customer's
 * contract (tier / billing_period / commitment) so we can see where term
 * buying would save money. No writes.
 *
 * Usage: npx tsx debug/audit-fleet-terms.ts
 */
import { loadEnv, makeHostingerClient } from "./_shared.ts";

loadEnv();
const hostinger = makeHostingerClient();
const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const db = await createSupabaseServiceClient();

const [billingSubs, vms] = await Promise.all([
  hostinger.listBillingSubscriptions(),
  hostinger.listVirtualMachines()
]);

const { data: subs, error: subErr } = await db
  .from("subscriptions")
  .select("business_id, tier, status, billing_period, commitment_months, hostinger_billing_subscription_id, renewal_at")
  .in("status", ["active", "pending"]);
if (subErr) throw new Error(subErr.message);

const { data: bizRows, error: bizErr } = await db
  .from("businesses")
  .select("id, name, vps_size");
if (bizErr) throw new Error(bizErr.message);
const bizById = new Map((bizRows ?? []).map((b) => [b.id as string, b]));

const { data: pool, error: poolErr } = await db.from("vps_inventory").select("*");
if (poolErr) throw new Error(poolErr.message);

const vmById = new Map(vms.map((v) => [String(v.id), v]));
const subByHostingerId = new Map(
  (subs ?? []).map((s) => [s.hostinger_billing_subscription_id as string | null, s])
);

console.log("=== Hostinger billing subscriptions ===");
for (const bs of billingSubs) {
  const vm = bs.resource_id ? vmById.get(String(bs.resource_id)) : undefined;
  const sub = subByHostingerId.get(bs.id);
  const biz = sub ? bizById.get(sub.business_id as string) : undefined;
  console.log(
    [
      `sub=${bs.id}`,
      `status=${bs.status}`,
      `cycle=${bs.period ?? "?"}${bs.period_unit ?? "?"}`,
      `item=${bs.item_id ?? "?"}`,
      `next_billing=${bs.next_billing_at ?? "?"}`,
      `vm=${bs.resource_id ?? "?"}${vm ? ` (${vm.plan ?? "?"}, ${vm.hostname ?? "?"}, ${vm.state})` : ""}`,
      sub
        ? `tenant=${biz?.name ?? sub.business_id} tier=${sub.tier} contract=${sub.billing_period} (${sub.commitment_months}mo, renews ${String(sub.renewal_at ?? "?").slice(0, 10)})`
        : "tenant=UNLINKED"
    ].join("  ")
  );
}

console.log("\n=== VMs with no billing subscription match ===");
const billedVmIds = new Set(billingSubs.map((b) => String(b.resource_id ?? "")));
for (const vm of vms) {
  if (!billedVmIds.has(String(vm.id))) {
    console.log(`vm=${vm.id} plan=${vm.plan ?? "?"} host=${vm.hostname ?? "?"} state=${vm.state}`);
  }
}

console.log("\n=== Active subscriptions with no Hostinger billing id ===");
for (const s of subs ?? []) {
  if (!s.hostinger_billing_subscription_id) {
    const biz = bizById.get(s.business_id as string);
    console.log(`tenant=${biz?.name ?? s.business_id} tier=${s.tier} contract=${s.billing_period} status=${s.status}`);
  }
}

console.log("\n=== vps_inventory pool ===");
for (const row of pool ?? []) {
  console.log(
    `vm=${row.vm_id} plan=${row.plan} state=${row.state} biz=${row.assigned_business_id ?? "-"} hostingerSub=${row.hostinger_billing_subscription_id ?? "-"} notes=${row.notes ?? ""}`
  );
}
