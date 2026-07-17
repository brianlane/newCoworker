/**
 * Check (and optionally enable) Hostinger billing auto-renewal for a VPS.
 * Prints the VM state and its billing subscription (status, next billing
 * date, renewal price); with --apply, enables auto-renewal if it is off.
 *
 * Requires HOSTINGER_API_TOKEN in the repo-root .env.
 *
 * Read-only by default; ⚠️ --apply commits the Hostinger account to renewal
 * charges for that box.
 *
 * Usage: tsx debug/vps-auto-renew.ts --vm <virtualMachineId> [--apply]
 */
import { loadEnv, makeHostingerClient } from "./_shared.ts";

loadEnv();

const vmIdx = process.argv.indexOf("--vm");
const VM_ID = Number(
  (vmIdx >= 0 ? process.argv[vmIdx + 1] : process.argv.find((a) => a.startsWith("--vm="))?.slice(5)) ?? ""
);
if (!Number.isFinite(VM_ID) || VM_ID <= 0) throw new Error("usage: --vm <virtualMachineId> [--apply]");
const APPLY = process.argv.includes("--apply");

const hostinger = makeHostingerClient();

const vm = await hostinger.getVirtualMachine(VM_ID);
console.log("vm", {
  id: vm.id,
  hostname: vm.hostname,
  state: vm.state,
  plan: vm.plan,
  subscription_id: (vm as { subscription_id?: string }).subscription_id ?? null
});

const subs = await hostinger.listBillingSubscriptions();
const subId = (vm as { subscription_id?: string }).subscription_id ?? null;
const sub = subs.find((s) => s.id === subId) ?? null;
if (!sub) {
  console.log(
    "no billing subscription matched the VM; all subscriptions:",
    subs.map((s) => ({
      id: s.id,
      status: s.status,
      is_auto_renewed: s.is_auto_renewed,
      next_billing_at: s.next_billing_at,
      renewal_price: s.renewal_price
    }))
  );
  process.exit(1);
}
console.log("billing subscription", {
  id: sub.id,
  status: sub.status,
  is_auto_renewed: sub.is_auto_renewed,
  next_billing_at: sub.next_billing_at,
  renewal_price: sub.renewal_price,
  billing_period: sub.billing_period,
  billing_period_unit: sub.billing_period_unit
});

if (!APPLY) {
  console.log("dry-run: pass --apply to enable auto-renewal");
  process.exit(0);
}

if (sub.is_auto_renewed) {
  console.log("auto-renewal already enabled — nothing to do");
} else {
  await hostinger.enableBillingAutoRenewal(sub.id);
  console.log("auto-renewal ENABLED for", sub.id);
}
