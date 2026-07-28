/**
 * recover-amy-biennial-switch.ts: complete a change-plan (contract switch)
 * whose Hostinger purchase "failed but charged", by adopting the paid box.
 *
 * Background (Amy Laidlaw Real Estate, Jul 28 2026): the owner paid the
 * Stripe checkout for a Standard biennial contract. The change-plan
 * orchestrator's term-alignment migration then bought a 2-year KVM 2, but
 * Hostinger's purchase endpoint returned HTTP 402 ("Card payment could not
 * be completed") while STILL completing the charge server-side about a
 * minute later. The orphan reconciler scanned before the VM materialized,
 * found nothing, and the orchestrator aborted: it canceled the brand-new
 * Stripe subscription OBJECT (the customer's payment itself stays captured)
 * and left the tenant on their old monthly plan. Result: a paid, never-set-
 * up box in "Pending setup", a paid-but-canceled Stripe subscription, and a
 * tenant still billing monthly.
 *
 * This script finishes what the orchestrator started, using the exact
 * pieces it would have used:
 *
 *   1. Locate the paid change-plan Checkout Session for the business on
 *      Stripe (metadata.lifecycleAction === "changePlan") and re-derive
 *      tier / billingPeriod / previousSubscriptionId from its metadata.
 *   2. Snapshot + SSH-tarball backup of the old box (fail-closed).
 *   3. Adopt the paid VM via adoptVpsForBusiness injected as the
 *      orchestrator's vpsProvisioner (vpsPool: null so the adopt-first
 *      claim cannot swap in a different box), which bootstraps, deploys,
 *      and swings the tenant tunnel exactly like a purchase.
 *   4. Restore the tarball onto the new box (fail-closed).
 *   5. DB + Stripe bookkeeping, mirroring change-plan steps 5-8: create
 *      the new active subscriptions row (pointing at the CANCELED Stripe
 *      sub: the payment is real, the object just cannot renew), cancel the
 *      old monthly Stripe subscription, mark the old row canceled
 *      (upgrade_switch), and pool the old box with auto-renew off.
 *
 * Known caveat, documented in the tenant dossier: because the new Stripe
 * subscription object is canceled, ensureCommitmentSchedule and the
 * contract auto-renew toggle are inert for this term. At the 24-month mark
 * the plan card's "Start a new contract" CTA takes over, which creates a
 * fresh Stripe subscription anyway.
 *
 * Idempotent: re-running skips completed steps (existing new sub row,
 * already-adopted box, already-canceled old sub). Dry-run by default.
 *
 * Per scripts/oneshot/README.md every tenant-specific value rides argv;
 * nothing tenant-identifying is hard-coded.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/recover-amy-biennial-switch.ts \
 *     --business <uuid> --adopt-vm <hostingerVmId>            # dry run
 *   npx tsx scripts/oneshot/recover-amy-biennial-switch.ts \
 *     --business <uuid> --adopt-vm <hostingerVmId> --apply    # act
 */
import { randomUUID } from "node:crypto";
import { loadEnv, makeHostingerClient } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const BUSINESS_ID = argValue("--business") ?? "";
const adoptRaw = argValue("--adopt-vm");
const ADOPT_VM_ID = adoptRaw !== null ? Number(adoptRaw) : NaN;

if (!/^[0-9a-f-]{36}$/i.test(BUSINESS_ID) || !Number.isInteger(ADOPT_VM_ID) || ADOPT_VM_ID <= 0) {
  console.error(
    "usage: recover-amy-biennial-switch.ts --business <uuid> --adopt-vm <vmId> [--apply]"
  );
  process.exit(1);
}

const { createSupabaseServiceClient } = await import("../../src/lib/supabase/server.ts");
const { getStripe } = await import("../../src/lib/stripe/client.ts");
const { cancelStripeSubscriptionSafely } = await import(
  "../../src/lib/billing/change-plan-orchestrator.ts"
);
const { adoptVpsForBusiness } = await import("../../src/lib/hostinger/adopt.ts");
const { orchestrateProvisioning } = await import("../../src/lib/provisioning/orchestrate.ts");
const { backupBusinessData, restoreBusinessData } = await import(
  "../../src/lib/hostinger/data-migration.ts"
);
const { getActiveVpsSshKey } = await import("../../src/lib/db/vps-ssh-keys.ts");
const { recordVpsAssigned, releaseVpsToPool } = await import(
  "../../src/lib/db/vps-inventory.ts"
);
const { setBusinessCustomerProfile } = await import("../../src/lib/db/businesses.ts");
const {
  createSubscription,
  stripeSubscriptionPeriodCache
} = await import("../../src/lib/db/subscriptions.ts");
const { getCommitmentMonths, renewalDateAfterMonths } = await import(
  "../../src/lib/plans/tier.ts"
);
const { resolveDeployedVpsSize } = await import("../../src/lib/vps/size.ts");
const { normalizeHostingerPlan } = await import(
  "../../src/lib/provisioning/reconcile-orphans.ts"
);
const { sharedHardwareForVm, sharedHardwareWarning } = await import(
  "../../src/lib/vps/shared-hardware.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");

const hostinger = makeHostingerClient();
const db = await createSupabaseServiceClient();
const stripe = getStripe();

// ---------------------------------------------------------------- load state
const { data: biz, error: bizErr } = await db
  .from("businesses")
  .select("id, name, tier, hostinger_vps_id, vps_size, vps_provider, owner_email")
  .eq("id", BUSINESS_ID)
  .single();
if (bizErr || !biz) {
  console.error(`[oneshot] business ${BUSINESS_ID} not found: ${bizErr?.message}`);
  process.exit(1);
}
if (biz.tier !== "starter" && biz.tier !== "standard") {
  console.error(`[oneshot] tier=${biz.tier} is not recoverable by this script`);
  process.exit(1);
}
if ((biz.vps_provider ?? "hostinger") !== "hostinger") {
  console.error(`[oneshot] vps_provider=${biz.vps_provider}: Hostinger-only recovery`);
  process.exit(1);
}

const { data: subRows, error: subErr } = await db
  .from("subscriptions")
  .select("*")
  .eq("business_id", BUSINESS_ID)
  .order("created_at", { ascending: false })
  .limit(3);
if (subErr) {
  console.error(`[oneshot] subscriptions read failed: ${subErr.message}`);
  process.exit(1);
}
const subs = subRows ?? [];

// ------------------------------------------- locate the paid change-plan session
// The change-plan checkout stamps lifecycleAction=changePlan + businessId on
// the session; the newest complete+paid one for this business is the switch
// the customer paid for and never received.
const sessions = await stripe.checkout.sessions.list({ limit: 20 });
const session = sessions.data.find(
  (s) =>
    s.metadata?.lifecycleAction === "changePlan" &&
    s.metadata?.businessId === BUSINESS_ID &&
    s.status === "complete" &&
    s.payment_status === "paid"
);
if (!session) {
  console.error(
    "[oneshot] no paid changePlan Checkout Session found for this business in the last 20 sessions"
  );
  process.exit(1);
}
const meta = session.metadata ?? {};
const tier = meta.tier;
const billingPeriod = meta.billingPeriod;
const previousSubscriptionId = meta.previousSubscriptionId ?? null;
const customerProfileId = meta.customerProfileId ?? null;
const newStripeSubId =
  typeof session.subscription === "string" ? session.subscription : (session.subscription?.id ?? null);
const stripeCustomerId =
  typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
if (
  (tier !== "starter" && tier !== "standard") ||
  (billingPeriod !== "monthly" && billingPeriod !== "annual" && billingPeriod !== "biennial") ||
  !previousSubscriptionId ||
  !newStripeSubId
) {
  console.error(`[oneshot] session ${session.id} metadata is incomplete; refusing to guess`);
  process.exit(1);
}
if (tier !== biz.tier) {
  console.error(
    `[oneshot] session tier=${tier} differs from business tier=${biz.tier}. This script only ` +
      "handles same-tier contract switches (the paid box is the same size as the live one)."
  );
  process.exit(1);
}

// The new Stripe sub must be CANCELED (the orchestrator's abort path). If it
// is anything else the webhook actually completed and this recovery is the
// wrong tool.
const newStripeSub = await stripe.subscriptions.retrieve(newStripeSubId);
if (newStripeSub.status !== "canceled") {
  console.error(
    `[oneshot] Stripe sub ${newStripeSubId} is ${newStripeSub.status}, not canceled. ` +
      "The change-plan may have completed; investigate before running this."
  );
  process.exit(1);
}

// Idempotency: the new sub row existing means a previous --apply finished the
// bookkeeping. Nothing to do.
const alreadyDone = subs.find((s) => s.stripe_subscription_id === newStripeSubId);
if (alreadyDone) {
  console.log(
    `[oneshot] subscriptions row ${alreadyDone.id} already points at ${newStripeSubId} ` +
      `(status=${alreadyDone.status}); recovery already applied. Nothing to do.`
  );
  process.exit(0);
}

const oldSub = subs.find((s) => s.id === previousSubscriptionId);
if (!oldSub || oldSub.status !== "active") {
  console.error(
    `[oneshot] previous subscription ${previousSubscriptionId} is missing or not active ` +
      `(status=${oldSub?.status ?? "absent"}); the state has drifted, refusing to act`
  );
  process.exit(1);
}

// ---------------------------------------------------------------- adopt target
const adoptVm = await hostinger.getVirtualMachine(ADOPT_VM_ID).catch((err: unknown) => {
  console.error(
    `[oneshot] --adopt-vm ${ADOPT_VM_ID} lookup failed: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
});
const oldVmIdRaw = biz.hostinger_vps_id;
const oldVmId = oldVmIdRaw && /^\d+$/.test(oldVmIdRaw) ? Number.parseInt(oldVmIdRaw, 10) : null;
if (ADOPT_VM_ID === oldVmId) {
  console.error(`[oneshot] --adopt-vm ${ADOPT_VM_ID} is the business's CURRENT box`);
  process.exit(1);
}
const expectedSize = resolveDeployedVpsSize(biz.tier, biz.vps_size ?? null);
const adoptPlan = normalizeHostingerPlan(adoptVm.plan);
if (adoptPlan !== expectedSize) {
  console.error(
    `[oneshot] --adopt-vm ${ADOPT_VM_ID} is ${adoptVm.plan} but the tenant runs on ${expectedSize}`
  );
  process.exit(1);
}
// The adopt path re-images the target; a co-tenanted box would take a second
// product down with it.
const shared = sharedHardwareForVm(ADOPT_VM_ID);
if (shared) {
  console.error(`\n${sharedHardwareWarning(shared)}\n[oneshot] REFUSING shared hardware.`);
  process.exit(1);
}

// New box billing id: VM detail first (the subscriptions LIST stopped
// returning resource_id, Jul 2026), then the list as a fallback.
let newBillingId: string | null =
  typeof adoptVm.subscription_id === "string" && adoptVm.subscription_id.length > 0
    ? adoptVm.subscription_id
    : null;
if (!newBillingId) {
  try {
    const billingSubs = await hostinger.listBillingSubscriptions();
    newBillingId = billingSubs.find((s) => s.resource_id === String(ADOPT_VM_ID))?.id ?? null;
  } catch {
    /* stays null; reported below and resolvable later via hPanel */
  }
}

let oldVmIp: string | null = null;
let oldBillingId: string | null = oldSub.hostinger_billing_subscription_id ?? null;
if (oldVmId !== null) {
  try {
    const oldVm = await hostinger.getVirtualMachine(oldVmId);
    oldVmIp = oldVm.ipv4?.[0]?.address ?? null;
    if (!oldBillingId && typeof oldVm.subscription_id === "string" && oldVm.subscription_id.length > 0) {
      oldBillingId = oldVm.subscription_id;
    }
  } catch (err) {
    console.log(
      `[oneshot] old VM ${oldVmId} lookup failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

const paidAt = new Date(session.created * 1000);
const commitmentMonths = getCommitmentMonths(billingPeriod);
const renewalAt = renewalDateAfterMonths(paidAt, commitmentMonths);

console.log(`== change-plan recovery (fail-but-charge adopt) ==`);
console.log(`business        : ${biz.name} (${biz.id})`);
console.log(`switch          : ${oldSub.billing_period ?? "?"} -> ${billingPeriod} (${tier})`);
console.log(`paid session    : ${session.id} ($${((session.amount_total ?? 0) / 100).toFixed(2)} on ${paidAt.toISOString()})`);
console.log(`new Stripe sub  : ${newStripeSubId} (canceled object, payment captured)`);
console.log(`old Stripe sub  : ${oldSub.stripe_subscription_id ?? "none"} (will be canceled)`);
console.log(`adopt target    : vm=${ADOPT_VM_ID} state=${adoptVm.state} plan=${adoptVm.plan} billing=${newBillingId ?? "UNKNOWN"}`);
console.log(`old box         : vm=${oldVmId ?? "none"} ip=${oldVmIp ?? "none"} billing=${oldBillingId ?? "UNKNOWN"}`);
console.log(`renewal_at      : ${renewalAt.toISOString()} (${commitmentMonths} months from payment)`);

if (!APPLY) {
  console.log(`\n[dry-run] Would: snapshot + backup old box -> adopt + bootstrap vm ${ADOPT_VM_ID}`);
  console.log(`[dry-run] -> restore data -> create biennial sub row -> cancel old Stripe sub`);
  console.log(`[dry-run] -> mark old row canceled (upgrade_switch) -> stop old box, auto-renew off, pool it.`);
  console.log(`[dry-run] Re-run with --apply to act.`);
  process.exit(0);
}

// ------------------------------------------------------------- 1. snapshot
if (oldVmId !== null) {
  try {
    await hostinger.createSnapshot(oldVmId);
    console.log(`[snapshot] requested on old VM ${oldVmId}`);
  } catch (err) {
    console.log(
      `[snapshot] failed (continuing; the tarball is the durable artefact): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ------------------------------------------------------------- 2. backup
// Fail-closed, key pinned to the OLD box: the per-business "newest key"
// lookup breaks once the adopt inserts a key row for the NEW box.
if (oldVmId === null || !oldVmIp) {
  console.error(`[backup] ABORT: old VM has no resolvable IP; cannot take the durable backup.`);
  process.exit(1);
}
const oldBoxKey = await getActiveVpsSshKey(String(oldVmId));
if (!oldBoxKey || !oldBoxKey.private_key_pem) {
  console.error(`[backup] ABORT: no active SSH key for old VM ${oldVmId}.`);
  process.exit(1);
}
console.log(`[backup] tarballing /opt/rowboat/{vault,memory} from ${oldVmIp}...`);
const backup = await backupBusinessData(
  { businessId: BUSINESS_ID, vpsHost: oldVmIp },
  { sshKeyLookup: async () => oldBoxKey }
);
console.log(`[backup] ok: ${backup.storagePath} (${backup.sizeBytes} bytes)`);

// ------------------------------------------------------------- 3. adopt
// adoptVpsForBusiness injected as the vpsProvisioner: the orchestrator runs
// bootstrap, deploy, and the tunnel swing identically to a purchase.
// vpsPool: null so the adopt-first claim cannot substitute a different box
// (and so the pool's retry idempotency cannot hand back the CURRENT box).
console.log(`[adopt] adopting paid VM ${ADOPT_VM_ID} + bootstrapping (~10-20 min)...`);
const newProv = await orchestrateProvisioning(
  {
    businessId: BUSINESS_ID,
    tier: biz.tier,
    vpsSize: expectedSize,
    // ownerEmail deliberately omitted: the owner already has a live coworker;
    // the provisioning-complete notification goes to ADMIN_EMAIL only.
    billingPeriod
  },
  {
    vpsPool: null,
    vpsProvisioner: () =>
      adoptVpsForBusiness(
        {
          businessId: BUSINESS_ID,
          tier: biz.tier as "starter" | "standard",
          vpsSize: expectedSize,
          virtualMachineId: ADOPT_VM_ID
        },
        { client: hostinger }
      )
  }
);
console.log(`[adopt] done: vm ${newProv.vpsId}, tunnel ${newProv.tunnelUrl}`);
newBillingId = newProv.hostingerBillingSubscriptionId ?? newBillingId;

// Inventory bookkeeping the pool would normally do on purchase (vpsPool was
// nulled above, so record the assignment ourselves).
try {
  await recordVpsAssigned({
    vmId: ADOPT_VM_ID,
    plan: expectedSize,
    businessId: BUSINESS_ID,
    hostingerBillingSubscriptionId: newBillingId,
    notes: `adopted by recover-amy-biennial-switch.ts (fail-but-charge recovery, term-bought box)`
  });
} catch (err) {
  console.log(
    `[inventory] recordVpsAssigned failed (continuing): ${err instanceof Error ? err.message : String(err)}`
  );
}

// ------------------------------------------------------------- 4. restore
const newVmIdNum = Number.parseInt(newProv.vpsId, 10);
let newVmIp: string | null = null;
try {
  const vm = await hostinger.getVirtualMachine(newVmIdNum);
  newVmIp = vm.ipv4?.[0]?.address ?? null;
} catch {
  /* handled below */
}
if (!newVmIp) {
  console.error(`[restore] ABORT: cannot resolve the new VM's IP. Tarball safe at ${backup.storagePath}.`);
  console.error(`[restore] Old box left running; re-run once the new box is reachable.`);
  process.exit(1);
}
try {
  await restoreBusinessData({ businessId: BUSINESS_ID, vpsHost: newVmIp });
  console.log(`[restore] durable data restored onto ${newVmIp}`);
} catch (err) {
  console.error(`[restore] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`[restore] New box is on TEMPLATE state; tarball safe at ${backup.storagePath}.`);
  console.error(`[restore] Old box left running (it still has the live data). Fix + re-run.`);
  process.exit(1);
}

// ------------------------------------------------- 5. new subscriptions row
// Mirrors change-plan step 5. The Stripe sub object is canceled, so
// ensureCommitmentSchedule is deliberately skipped (nothing to schedule on a
// canceled sub); renewal handling at term end goes through re-contract.
const periodCache = stripeSubscriptionPeriodCache(newStripeSub);
const newRow = await createSubscription({
  id: randomUUID(),
  business_id: BUSINESS_ID,
  stripe_customer_id: stripeCustomerId,
  stripe_subscription_id: newStripeSubId,
  tier,
  status: "active",
  billing_period: billingPeriod,
  renewal_at: renewalAt.toISOString(),
  commitment_months: commitmentMonths,
  customer_profile_id: customerProfileId,
  hostinger_billing_subscription_id: newBillingId,
  ...periodCache
});
console.log(`[db] new subscriptions row ${newRow.id} (active, ${billingPeriod})`);

if (customerProfileId) {
  try {
    await setBusinessCustomerProfile(BUSINESS_ID, customerProfileId);
  } catch (err) {
    console.log(
      `[db] setBusinessCustomerProfile failed (continuing): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ------------------------------------------------- 6. cancel old Stripe sub
if (oldSub.stripe_subscription_id) {
  await cancelStripeSubscriptionSafely(oldSub.stripe_subscription_id, BUSINESS_ID);
  console.log(`[stripe] old monthly sub ${oldSub.stripe_subscription_id} canceled (no proration)`);
}

// ------------------------------------------------- 7. mark old row canceled
const nowIso = new Date().toISOString();
const { error: cancelErr } = await db
  .from("subscriptions")
  .update({
    status: "canceled",
    canceled_at: nowIso,
    cancel_reason: "upgrade_switch",
    grace_ends_at: null,
    stripe_current_period_start: null,
    stripe_current_period_end: null,
    stripe_subscription_cached_at: nowIso
  })
  .eq("id", oldSub.id);
if (cancelErr) {
  console.error(`[db] old row cancel FAILED (fix manually): ${cancelErr.message}`);
} else {
  console.log(`[db] old subscriptions row ${oldSub.id} marked canceled (upgrade_switch)`);
}

// ------------------------------------------------- 8. old box teardown + pool
try {
  await hostinger.stopVirtualMachine(oldVmId);
  console.log(`[old-box] VM ${oldVmId} stop requested`);
} catch (err) {
  console.log(
    `[old-box] stop failed (may already be stopped): ${err instanceof Error ? err.message : String(err)}`
  );
}
if (oldBillingId) {
  try {
    await hostinger.disableBillingAutoRenewal(oldBillingId);
    console.log(`[old-box] billing ${oldBillingId} auto-renew disabled (lapses at period end)`);
  } catch (err) {
    console.log(
      `[old-box] auto-renew disable FAILED (do it in hPanel): ${err instanceof Error ? err.message : String(err)}`
    );
  }
} else {
  console.log(`[old-box] WARNING: no billing id for the old box; disable auto-renew in hPanel`);
}
try {
  await releaseVpsToPool({
    vmId: oldVmId,
    plan: expectedSize,
    hostingerBillingSubscriptionId: oldBillingId,
    notes: `returned by change-plan recovery of business ${BUSINESS_ID}; auto-renew off, lapses at period end unless adopted`
  });
  console.log(`[old-box] VM ${oldVmId} returned to the reuse pool`);
} catch (err) {
  console.log(
    `[old-box] pool return failed (continuing): ${err instanceof Error ? err.message : String(err)}`
  );
}

// ---------------------------------------------------------------- ledger
await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "recover-amy-biennial-switch.ts",
  businessId: BUSINESS_ID,
  details: {
    checkoutSession: session.id,
    newStripeSubscriptionId: newStripeSubId,
    oldStripeSubscriptionId: oldSub.stripe_subscription_id,
    oldSubscriptionRowId: oldSub.id,
    newSubscriptionRowId: newRow.id,
    adoptedVmId: ADOPT_VM_ID,
    oldVmId,
    newHostingerBillingSubscriptionId: newBillingId,
    oldHostingerBillingSubscriptionId: oldBillingId,
    billingPeriod,
    renewalAt: renewalAt.toISOString(),
    backupPath: backup.storagePath
  }
});

console.log(`\nRecovery complete: ${biz.name} is on ${tier}/${billingPeriod} (VM ${newProv.vpsId}, ${newVmIp}).`);
console.log(`Post-checks:`);
console.log(`  npx tsx debug/vps-exec.ts ${BUSINESS_ID} "docker ps --format '{{.Names}} {{.Status}}'"`);
console.log(`  npx tsx debug/smoke-owner-chat.ts ${BUSINESS_ID} "Are you there?"`);
console.log(`  Verify in Stripe: old monthly sub canceled BEFORE its next invoice (refund it if one fired).`);
