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
const { incrementLifetimeSubscriptionCount } = await import(
  "../../src/lib/db/customer-profiles.ts"
);
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
  .select("id, name, tier, hostinger_vps_id, vps_size, vps_provider, owner_email, customer_profile_id")
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

// ------------------------------------------- locate the paid change-plan session
// Scope the Stripe list to this tenant's customer (or paginate filtered by
// business metadata). An account-wide `limit: 20` can miss the paid session
// when checkout volume is high.
const { data: recentSubs } = await db
  .from("subscriptions")
  .select("stripe_customer_id")
  .eq("business_id", BUSINESS_ID)
  .not("stripe_customer_id", "is", null)
  .order("created_at", { ascending: false })
  .limit(5);
const knownCustomerIds = [
  ...new Set(
    (recentSubs ?? [])
      .map((r) => r.stripe_customer_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  )
];

async function findPaidChangePlanSession() {
  const matches = (s: {
    metadata?: Record<string, string> | null;
    status: string | null;
    payment_status: string | null;
  }) =>
    s.metadata?.lifecycleAction === "changePlan" &&
    s.metadata?.businessId === BUSINESS_ID &&
    s.status === "complete" &&
    s.payment_status === "paid";

  for (const customerId of knownCustomerIds) {
    const listed = await stripe.checkout.sessions.list({
      customer: customerId,
      limit: 100
    });
    const hit = listed.data.find(matches);
    if (hit) return hit;
  }

  // Fallback: paginate account-wide sessions until we find this business's
  // paid changePlan (or exhaust a hard page budget).
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page++) {
    const listed = await stripe.checkout.sessions.list({
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {})
    });
    const hit = listed.data.find(matches);
    if (hit) return hit;
    if (!listed.has_more || listed.data.length === 0) break;
    startingAfter = listed.data[listed.data.length - 1]?.id;
  }
  return null;
}

const session = await findPaidChangePlanSession();
if (!session) {
  console.error(
    "[oneshot] no paid changePlan Checkout Session found for this business " +
      `(scoped ${knownCustomerIds.length} customer id(s), then paginated account-wide)`
  );
  process.exit(1);
}
const meta = session.metadata ?? {};
const tier = meta.tier;
const billingPeriod = meta.billingPeriod;
const previousSubscriptionId = meta.previousSubscriptionId ?? null;
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

// Load the previous subscription BY ID (not "newest 3") so a business with
// more than three historical rows still resolves the checkout metadata.
const { data: oldSubRow, error: oldSubErr } = await db
  .from("subscriptions")
  .select("*")
  .eq("id", previousSubscriptionId)
  .eq("business_id", BUSINESS_ID)
  .maybeSingle();
if (oldSubErr) {
  console.error(`[oneshot] previous subscription read failed: ${oldSubErr.message}`);
  process.exit(1);
}
const oldSub = oldSubRow;

// Match change-plan: metadata profile first, then old sub, then business.
const customerProfileId =
  meta.customerProfileId ??
  (typeof oldSub?.customer_profile_id === "string" ? oldSub.customer_profile_id : null) ??
  (typeof biz.customer_profile_id === "string" ? biz.customer_profile_id : null);

const { data: existingNewRows, error: existingNewErr } = await db
  .from("subscriptions")
  .select("*")
  .eq("business_id", BUSINESS_ID)
  .eq("stripe_subscription_id", newStripeSubId)
  .limit(1);
if (existingNewErr) {
  console.error(`[oneshot] new subscription lookup failed: ${existingNewErr.message}`);
  process.exit(1);
}
const existingNew = existingNewRows?.[0] ?? null;

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

// Full-done idempotency: new row active AND old row canceled as upgrade_switch.
// A partial prior --apply (new row inserted, old still active) must resume.
const recoveryComplete =
  existingNew?.status === "active" &&
  oldSub?.status === "canceled" &&
  oldSub.cancel_reason === "upgrade_switch";
if (recoveryComplete) {
  console.log(
    `[oneshot] recovery already complete (new row ${existingNew.id} active, old row ` +
      `${oldSub.id} canceled upgrade_switch). Nothing to do.`
  );
  process.exit(0);
}

if (!oldSub) {
  console.error(
    `[oneshot] previous subscription ${previousSubscriptionId} not found; refusing to act`
  );
  process.exit(1);
}
// After a partial apply the old row may already be canceled; resume is still
// allowed when the new row is missing. Refuse only when the old row is wiped
// or otherwise unusable AND we still need to cancel an active Stripe sub.
if (oldSub.status !== "active" && oldSub.status !== "canceled") {
  console.error(
    `[oneshot] previous subscription ${previousSubscriptionId} has status=${oldSub.status}; refusing to act`
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
const currentVmIdRaw = biz.hostinger_vps_id;
const currentVmId =
  currentVmIdRaw && /^\d+$/.test(currentVmIdRaw) ? Number.parseInt(currentVmIdRaw, 10) : null;
// A prior --apply may have already swung hostinger_vps_id onto the adopt
// target. That is RESUME, not an error: skip snapshot/backup/adopt/restore
// and continue with DB + Stripe bookkeeping.
const adoptAlreadyDone = currentVmId === ADOPT_VM_ID;
const oldVmId: number | null = adoptAlreadyDone ? null : currentVmId;
if (adoptAlreadyDone) {
  console.log(
    `[oneshot] hostinger_vps_id already points at adopt target ${ADOPT_VM_ID}; ` +
      "skipping adopt/migrate and resuming bookkeeping."
  );
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
// product down with it. Skip when adopt already landed (no re-image).
if (!adoptAlreadyDone) {
  const shared = sharedHardwareForVm(ADOPT_VM_ID);
  if (shared) {
    console.error(`\n${sharedHardwareWarning(shared)}\n[oneshot] REFUSING shared hardware.`);
    process.exit(1);
  }
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
console.log(
  `old box         : vm=${oldVmId ?? (adoptAlreadyDone ? "already-cutover" : "none")} ip=${oldVmIp ?? "none"} billing=${oldBillingId ?? "UNKNOWN"}`
);
console.log(`renewal_at      : ${renewalAt.toISOString()} (${commitmentMonths} months from payment)`);
console.log(`resume          : adoptAlreadyDone=${adoptAlreadyDone} existingNewRow=${existingNew?.id ?? "none"}`);

if (!APPLY) {
  console.log(
    adoptAlreadyDone
      ? `\n[dry-run] Would: skip adopt (already on ${ADOPT_VM_ID}) -> create/confirm biennial sub row -> cancel old Stripe sub -> pool old box.`
      : `\n[dry-run] Would: snapshot + backup old box -> adopt + bootstrap vm ${ADOPT_VM_ID}`
  );
  if (!adoptAlreadyDone) {
    console.log(`[dry-run] -> restore data -> create biennial sub row -> cancel old Stripe sub`);
    console.log(`[dry-run] -> mark old row canceled (upgrade_switch) -> stop old box, auto-renew off, pool it.`);
  }
  console.log(`[dry-run] Re-run with --apply to act.`);
  process.exit(0);
}

let backupPath: string | null = null;

if (!adoptAlreadyDone) {
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
backupPath = backup.storagePath;
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
    // Background recovery: do not text/email the owner "Your New Coworker is live!".
    suppressOwnerNotify: true,
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
} else {
  // Resume path: adopt already swung traffic; resolve new box IP for the summary.
  try {
    const vm = await hostinger.getVirtualMachine(ADOPT_VM_ID);
    console.log(`[resume] serving on ${vm.ipv4?.[0]?.address ?? "ip?"} (adopt already done)`);
  } catch {
    /* summary-only */
  }
}

// ------------------------------------------------- 5. new subscriptions row
// Mirrors change-plan step 5. The Stripe sub object is canceled, so
// ensureCommitmentSchedule is deliberately skipped (nothing to schedule on a
// canceled sub); renewal handling at term end goes through re-contract.
let newRowId = existingNew?.id ?? null;
if (!existingNew) {
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
  newRowId = newRow.id;
  console.log(`[db] new subscriptions row ${newRow.id} (active, ${billingPeriod})`);
  if (customerProfileId) {
    try {
      await incrementLifetimeSubscriptionCount(customerProfileId);
      console.log(`[db] lifetime subscription count incremented for profile ${customerProfileId}`);
    } catch (err) {
      console.log(
        `[db] incrementLifetimeSubscriptionCount failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
} else {
  console.log(`[db] new subscriptions row ${existingNew.id} already exists; skipping insert`);
  // Resume after insert: attempt the lifetime bump if it may have been skipped.
  // Full-done recoveries exit earlier (upgrade_switch), so this only runs while
  // the switch is still in flight. A second bump after a successful increment
  // is accepted for this one-shot over leaving the profile under-counted.
  if (customerProfileId) {
    try {
      await incrementLifetimeSubscriptionCount(customerProfileId);
      console.log(
        `[db] lifetime subscription count incremented on resume for profile ${customerProfileId}`
      );
    } catch (err) {
      console.log(
        `[db] resume incrementLifetimeSubscriptionCount failed (continuing): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
}

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
if (oldSub.status !== "canceled" || oldSub.cancel_reason !== "upgrade_switch") {
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
} else {
  console.log(`[db] old subscriptions row ${oldSub.id} already canceled upgrade_switch`);
}

// ------------------------------------------------- 8. old box teardown + pool
// On resume (adopt already done) oldVmId is null, resolve the retired box
// from its Hostinger billing subscription id when we still have one.
let teardownVmId = oldVmId;
if (teardownVmId === null && oldBillingId) {
  try {
    const vms = await hostinger.listVirtualMachines();
    const match = vms.find((v) => v.subscription_id === oldBillingId);
    if (match) teardownVmId = match.id;
  } catch (err) {
    console.log(
      `[old-box] could not resolve old VM from billing ${oldBillingId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
if (teardownVmId !== null) {
  try {
    await hostinger.stopVirtualMachine(teardownVmId);
    console.log(`[old-box] VM ${teardownVmId} stop requested`);
  } catch (err) {
    console.log(
      `[old-box] stop failed (may already be stopped): ${err instanceof Error ? err.message : String(err)}`
    );
  }
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
if (teardownVmId !== null) {
  try {
    await releaseVpsToPool({
      vmId: teardownVmId,
      plan: expectedSize,
      hostingerBillingSubscriptionId: oldBillingId,
      notes: `returned by change-plan recovery of business ${BUSINESS_ID}; auto-renew off, lapses at period end unless adopted`
    });
    console.log(`[old-box] VM ${teardownVmId} returned to the reuse pool`);
  } catch (err) {
    console.log(
      `[old-box] pool return failed (continuing): ${err instanceof Error ? err.message : String(err)}`
    );
  }
} else {
  console.log(`[old-box] no old VM id to pool (already torn down or unknown)`);
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
    newSubscriptionRowId: newRowId,
    adoptedVmId: ADOPT_VM_ID,
    oldVmId: teardownVmId,
    adoptAlreadyDone,
    newHostingerBillingSubscriptionId: newBillingId,
    oldHostingerBillingSubscriptionId: oldBillingId,
    billingPeriod,
    renewalAt: renewalAt.toISOString(),
    backupPath
  }
});

console.log(
  `\nRecovery complete: ${biz.name} is on ${tier}/${billingPeriod} (VM ${ADOPT_VM_ID}).`
);
console.log(`Post-checks:`);
console.log(`  npx tsx debug/vps-exec.ts ${BUSINESS_ID} "docker ps --format '{{.Names}} {{.Status}}'"`);
console.log(`  npx tsx debug/smoke-owner-chat.ts ${BUSINESS_ID} "Are you there?"`);
console.log(`  Verify in Stripe: old monthly sub canceled BEFORE its next invoice (refund it if one fired).`);
