/**
 * reconcile-migrated-vps-inventory.ts: write the `vps_inventory` bookkeeping
 * that `debug/migrate-vps-size.ts --adopt-vm` cannot.
 *
 * That script's adopt mode passes `vpsPool: null` on purpose, so the
 * orchestrator's adopt-first claim cannot land the tenant on some pool box
 * instead of the specific paid one it was told to use. The cost is that
 * nothing then records the move in `vps_inventory`: the new box stays
 * untracked (the daily billing-posture cron reports it as `untracked_vm`,
 * ACTION REQUIRED, every day) and the old box keeps an `assigned` row
 * pointing at a business that has already left it (`stale_assigned_row`).
 *
 * This closes both, mirroring exactly what the server-side port
 * `src/lib/vps/migrate-size.ts` does at teardown:
 *
 *   new box -> `assigned` to the business, carrying its Hostinger billing
 *              subscription and paid-through
 *   old box -> pooled (`available`) + `never_renew`, matching the
 *              auto-renew-off the migration already applied upstream
 *
 * Written for KIN Integrated Child Health, 2026-08-28: the term-renewal
 * sweep's purchase SUCCEEDED and was charged, but the client could not read
 * Hostinger's reply (`{ order, virtual_machine }`, not the
 * `{ order_id, virtual_machines }` we asked for), so the migration reported
 * failure and stranded a paid, correctly-built box. Generic across tenants:
 * any adopt-mode migration needs the same two rows.
 *
 * Safety:
 *   - REFUSES unless `businesses.hostinger_vps_id` already points at the new
 *     box. The cutover repoints it as its last provisioning step, so a run
 *     before the migration finished would pool a box that is still serving.
 *   - REFUSES to pool an old box whose Hostinger auto-renew is still ON:
 *     `never_renew` would then be a lie, and the pool posture check trusts
 *     it.
 *   - Reads both rows back and asserts their landed state. A PostgREST write
 *     matching zero rows returns no error.
 *
 * Per scripts/oneshot/README.md every tenant-specific value rides argv.
 * Idempotent (re-running converges the same two rows), dry-run by default,
 * ledger-recorded.
 *
 * Usage:
 *   npx tsx scripts/oneshot/reconcile-migrated-vps-inventory.ts \
 *     --business <uuid> --old-vm <vmId> --new-vm <vmId> [--apply]
 */
import { loadEnv, makeHostingerClient } from "../../debug/_shared.ts";

loadEnv();

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const BUSINESS_ID = argValue("--business") ?? "";
const OLD_VM_ID = Number(argValue("--old-vm"));
const NEW_VM_ID = Number(argValue("--new-vm"));
const APPLY = process.argv.includes("--apply");

if (
  !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID) ||
  !Number.isInteger(OLD_VM_ID) ||
  OLD_VM_ID <= 0 ||
  !Number.isInteger(NEW_VM_ID) ||
  NEW_VM_ID <= 0 ||
  OLD_VM_ID === NEW_VM_ID
) {
  console.error(
    "usage: reconcile-migrated-vps-inventory.ts --business <uuid> --old-vm <vmId> --new-vm <vmId> [--apply]"
  );
  process.exit(1);
}

const { createSupabaseServiceClient } = await import("../../src/lib/supabase/server.ts");
const {
  recordVpsAssigned,
  releaseVpsToPool,
  markVpsNeverRenew,
  getVpsInventoryByVmId,
  paidThroughFromBillingSub
} = await import("../../src/lib/db/vps-inventory.ts");
const { normalizeHostingerPlan } = await import("../../src/lib/provisioning/reconcile-orphans.ts");
const { recordOneshotApplied } = await import("./_ledger.ts");

const hostinger = makeHostingerClient();
const db = await createSupabaseServiceClient();

const { data: biz, error: bizErr } = await db
  .from("businesses")
  .select("id, name, hostinger_vps_id")
  .eq("id", BUSINESS_ID)
  .single();
if (bizErr || !biz) {
  console.error(`business ${BUSINESS_ID} lookup failed: ${bizErr?.message ?? "not found"}`);
  process.exit(1);
}

// The cutover repoints hostinger_vps_id as its last provisioning step. If it
// still names the old box, the migration has not landed and pooling the old
// box would pull the tenant's live hardware out from under them.
if (String(biz.hostinger_vps_id) !== String(NEW_VM_ID)) {
  console.error(
    `REFUSING: businesses.hostinger_vps_id is ${biz.hostinger_vps_id}, not the new box ${NEW_VM_ID}.`
  );
  console.error(`The migration has not repointed the tenant yet. Finish it before reconciling.`);
  process.exit(1);
}

const [newVm, subs] = await Promise.all([
  hostinger.getVirtualMachine(NEW_VM_ID),
  hostinger.listBillingSubscriptions()
]);
const newPlan = normalizeHostingerPlan(newVm.plan);
if (!newPlan) {
  console.error(`new box ${NEW_VM_ID} has unrecognized plan ${newVm.plan ?? "none"}; refusing.`);
  process.exit(1);
}
const newSub = subs.find((s) => s.id === newVm.subscription_id) ?? null;

const oldRowBefore = await getVpsInventoryByVmId(OLD_VM_ID);
const oldPlan = (oldRowBefore?.plan as typeof newPlan | undefined) ?? newPlan;
let oldSub = null as (typeof subs)[number] | null;
try {
  const oldVm = await hostinger.getVirtualMachine(OLD_VM_ID);
  oldSub = subs.find((s) => s.id === oldVm.subscription_id) ?? null;
} catch {
  // A torn-down box can already be gone from the VM API; fall back to the
  // subscription id the inventory row recorded.
  oldSub = subs.find((s) => s.id === oldRowBefore?.hostinger_billing_subscription_id) ?? null;
}

console.log(`== migrated VPS inventory reconcile ==`);
console.log(`business : ${biz.name} (${biz.id})`);
console.log(`new box  : ${NEW_VM_ID} plan=${newPlan} state=${newVm.state} sub=${newSub?.id ?? "unknown"}`);
console.log(`           auto_renew=${newSub?.is_auto_renewed ?? "?"} next=${newSub?.next_billing_at ?? "?"}`);
console.log(`old box  : ${OLD_VM_ID} plan=${oldPlan} sub=${oldSub?.id ?? "unknown"}`);
console.log(`           auto_renew=${oldSub?.is_auto_renewed ?? "?"} next=${oldSub?.next_billing_at ?? "?"}`);
console.log(`old row  : ${oldRowBefore ? `${oldRowBefore.state} (assigned=${oldRowBefore.assigned_business_id ?? "none"})` : "none"}`);

// never_renew is what the pool posture check trusts to say "this box lapses".
// Setting it while Hostinger is still set to renew makes the row lie.
if (oldSub && oldSub.is_auto_renewed === true) {
  console.error(`\nREFUSING: old box ${OLD_VM_ID}'s subscription ${oldSub.id} still has auto-renew ON.`);
  console.error(`Disable it (the migration's teardown step does this) before pooling the box,`);
  console.error(`or the never_renew flag claims a lapse that will not happen.`);
  process.exit(1);
}

if (!APPLY) {
  console.log(`\n[dry-run] Would set vm ${NEW_VM_ID} -> assigned to ${BUSINESS_ID}`);
  console.log(`[dry-run] Would set vm ${OLD_VM_ID} -> available + never_renew`);
  console.log(`[dry-run] Re-run with --apply to write.`);
  process.exit(0);
}

await recordVpsAssigned({
  vmId: NEW_VM_ID,
  plan: newPlan,
  businessId: BUSINESS_ID,
  hostname: newVm.hostname ?? null,
  hostingerBillingSubscriptionId: newVm.subscription_id ?? null,
  ...(newSub ? { expiresAt: paidThroughFromBillingSub(newSub) } : {}),
  notes: `adopted by reconcile-migrated-vps-inventory.ts after an --adopt-vm migration from ${OLD_VM_ID}`
});
console.log(`[new] vm ${NEW_VM_ID} recorded assigned`);

await releaseVpsToPool({
  vmId: OLD_VM_ID,
  plan: oldPlan,
  ...(oldSub ? { expiresAt: paidThroughFromBillingSub(oldSub) } : {}),
  notes: `released after ${BUSINESS_ID} cut over to ${NEW_VM_ID}; auto-renew off, lapses at period end`
});
await markVpsNeverRenew(OLD_VM_ID);
console.log(`[old] vm ${OLD_VM_ID} pooled + never_renew`);

// Read back: a write that matched zero rows returns no error.
const [newRow, oldRow] = await Promise.all([
  getVpsInventoryByVmId(NEW_VM_ID),
  getVpsInventoryByVmId(OLD_VM_ID)
]);
console.log(
  `\n[verify] new ${NEW_VM_ID}: state=${newRow?.state} assigned=${newRow?.assigned_business_id ?? "none"} ` +
    `sub=${newRow?.hostinger_billing_subscription_id ?? "none"} expires=${newRow?.expires_at ?? "none"}`
);
console.log(
  `[verify] old ${OLD_VM_ID}: state=${oldRow?.state} assigned=${oldRow?.assigned_business_id ?? "none"} ` +
    `never_renew=${oldRow?.never_renew} expires=${oldRow?.expires_at ?? "none"}`
);
if (newRow?.state !== "assigned" || newRow.assigned_business_id !== BUSINESS_ID) {
  throw new Error(`new box row did not land as assigned to ${BUSINESS_ID}`);
}
if (oldRow?.state !== "available" || oldRow.never_renew !== true) {
  throw new Error(`old box row did not land as available + never_renew`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "reconcile-migrated-vps-inventory.ts",
  businessId: BUSINESS_ID,
  details: {
    newVmId: NEW_VM_ID,
    newBillingSubscriptionId: newVm.subscription_id ?? null,
    oldVmId: OLD_VM_ID,
    oldBillingSubscriptionId: oldSub?.id ?? null
  }
});

console.log(`\ninventory reconciled`);
