/**
 * cancel-vps-billing.ts — stop a VPS and disable its Hostinger billing
 * subscription's auto-renewal, the same teardown production uses (see
 * src/lib/billing/change-plan-orchestrator.ts steps 1+7 and the lifecycle
 * executor's `disable_billing_auto_renewal` op).
 *
 * Why this is two resources: a Hostinger VPS purchase creates a virtual
 * machine AND a billing subscription. Stopping the VM does NOT stop the
 * charges. Hostinger REMOVED the public cancel-subscription API (DELETE
 * /api/billing/v1/subscriptions/{id} now 404s — verified Jul 2026), so the
 * strongest automated stop-payment is disabling auto-renewal; the VM then
 * lapses at the end of the paid period. Actually deleting the VM early is a
 * manual hPanel action (https://hpanel.hostinger.com/paid-invoices).
 * Production order of operations:
 *   1. (optional) POST /virtual-machines/{id}/snapshot      — fast restore point
 *   2. POST /virtual-machines/{id}/stop                     — best-effort poweroff
 *   3. DELETE /billing/v1/subscriptions/{id}/auto-renewal/disable — stop renewal
 *   4. ops email → manual hPanel deletion
 *
 * Targets one of:
 *   --state                 read debug/.kvm2-smoke.json (the KVM2 experiment box)
 *   --vm <virtualMachineId> resolve the subscription via GET /billing/v1/subscriptions
 *   --subscription <id>     disable renewal on that subscription id directly
 *
 * Dry-run by default; --apply to actually disable. With --state it also marks
 * the clone business row offline and deletes the state file afterwards.
 *
 * Usage:
 *   npx tsx debug/cancel-vps-billing.ts --state           # inspect
 *   npx tsx debug/cancel-vps-billing.ts --state --apply   # tear down
 *   npx tsx debug/cancel-vps-billing.ts --vm 1234567 --apply
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv, makeHostingerClient } from "./_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const USE_STATE = process.argv.includes("--state");
const vmIdx = process.argv.indexOf("--vm");
const subIdx = process.argv.indexOf("--subscription");
const STATE_FILE = path.resolve(process.cwd(), "debug/.kvm2-smoke.json");

type SmokeState = {
  cloneBusinessId?: string;
  virtualMachineId?: number;
  publicKeyId?: number;
  postInstallScriptId?: number | null;
  hostingerBillingSubscriptionId?: string | null;
};

let vmId: number | null = vmIdx > -1 ? Number(process.argv[vmIdx + 1]) : null;
let subscriptionId: string | null = subIdx > -1 ? process.argv[subIdx + 1] : null;
let state: SmokeState | null = null;

if (USE_STATE) {
  if (!fs.existsSync(STATE_FILE)) {
    console.error(`no state file at ${STATE_FILE}`);
    process.exit(1);
  }
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as SmokeState;
  vmId = state.virtualMachineId ?? null;
  subscriptionId = state.hostingerBillingSubscriptionId ?? null;
}

if (vmId === null && !subscriptionId) {
  console.error("usage: cancel-vps-billing.ts (--state | --vm <id> | --subscription <id>) [--apply]");
  process.exit(1);
}

const hostinger = makeHostingerClient();

// Resolve the billing subscription from the VM id when not supplied. The VM
// detail's subscription_id is the reliable mapping — the subscriptions LIST
// stopped returning resource_id (verified Jul 2026).
if (!subscriptionId && vmId !== null) {
  try {
    const vm = await hostinger.getVirtualMachine(vmId);
    if (typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
      subscriptionId = vm.subscription_id;
    }
  } catch {
    /* fall through to the list lookup */
  }
}
if (!subscriptionId && vmId !== null) {
  const subs = await hostinger.listBillingSubscriptions();
  const match = subs.find((s) => s.resource_id === String(vmId));
  if (!match) {
    console.error(`no billing subscription found for vm=${vmId}.`);
    console.error(`subscriptions on the account:`);
    for (const s of subs) {
      console.error(`  ${s.id}  status=${s.status} resource=${s.resource_id} item=${s.item_id} next=${s.next_billing_at}`);
    }
    process.exit(1);
  }
  subscriptionId = match.id;
}

if (vmId !== null) {
  try {
    const vm = await hostinger.getVirtualMachine(vmId);
    console.log(`vm ${vmId}: state=${vm.state} plan=${vm.plan ?? "?"} ip=${vm.ipv4?.[0]?.address ?? "?"} hostname=${vm.hostname ?? "?"}`);
  } catch (e) {
    console.log(`vm ${vmId}: lookup failed (${e instanceof Error ? e.message : e}) — may already be destroyed`);
  }
}
console.log(`billing subscription to stop renewing: ${subscriptionId}`);

if (!APPLY) {
  console.log(`\n[dry-run] Would stop the VM (best-effort) and disable the billing subscription's`);
  console.log(`[dry-run] auto-renewal (VM lapses at period end; early deletion is manual in hPanel).`);
  console.log(`[dry-run] --apply to proceed.`);
  process.exit(0);
}

if (vmId !== null) {
  try {
    await hostinger.stopVirtualMachine(vmId);
    console.log(`vm ${vmId}: stop requested`);
  } catch (e) {
    console.log(`vm ${vmId}: stop failed (continuing): ${e instanceof Error ? e.message : e}`);
  }
}

await hostinger.disableBillingAutoRenewal(subscriptionId!);
console.log(`billing subscription ${subscriptionId}: auto-renewal disabled (lapses at period end).`);
console.log(`To delete the VM early, do it manually at https://hpanel.hostinger.com/paid-invoices`);

// Best-effort cleanup of the Hostinger account resources the provision created.
if (state?.publicKeyId) {
  try {
    await hostinger.deletePublicKey(state.publicKeyId);
    console.log(`public key ${state.publicKeyId} deleted`);
  } catch (e) {
    console.log(`public key delete failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}
if (state?.postInstallScriptId) {
  try {
    await hostinger.deletePostInstallScript(state.postInstallScriptId);
    console.log(`post-install script ${state.postInstallScriptId} deleted`);
  } catch (e) {
    console.log(`post-install script delete failed (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}

if (state?.cloneBusinessId) {
  const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
  const db = await createSupabaseServiceClient();
  const { error } = await db
    .from("businesses")
    .update({ status: "offline", hostinger_vps_id: null, hostinger_subscription_id: null })
    .eq("id", state.cloneBusinessId);
  console.log(
    error
      ? `clone business offline-mark failed: ${error.message}`
      : `clone business ${state.cloneBusinessId} marked offline`
  );
}

if (USE_STATE) {
  fs.unlinkSync(STATE_FILE);
  console.log(`state file removed (${STATE_FILE})`);
}
