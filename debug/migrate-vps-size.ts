/**
 * migrate-vps-size.ts — move an existing business to a different VPS hardware
 * size (kvm2 ↔ kvm8) with no entitlement change.
 *
 * This is the operational half of the tier/hardware decoupling
 * (businesses.vps_size, src/lib/vps/size.ts): the tenant keeps their `tier`
 * (minutes, SMS caps, concurrency, AI budget, aiflow-render) and only the box
 * underneath changes. Flow — the same primitives the change-plan orchestrator
 * uses, sequenced for an elective migration instead of a paid plan change:
 *
 *   1. Snapshot the old VM (best-effort safety net; Hostinger keeps ONE
 *      snapshot per VM and it dies with the VM — the durable artefact is
 *      step 2's tarball).
 *   2. SSH-tarball backup of /opt/rowboat/{vault,memory} to Supabase Storage
 *      (backupBusinessData). FAIL-CLOSED: an elective migration aborts if the
 *      backup fails, unlike change-plan which continues (a paid upgrade must
 *      not be blocked by a dead old box; an elective move can wait).
 *   3. Pin businesses.vps_size to the target size.
 *   4. orchestrateProvisioning with the pinned size — buys the new box
 *      (kvm2/kvm8 SKU), bootstraps (ZRAM/Ollama profile keyed on VPS_SIZE,
 *      render gate keyed on TIER), deploys the tenant, re-registers the
 *      per-tenant Cloudflare tunnel (DNS swings when the new cloudflared
 *      connects), and overwrites businesses.hostinger_vps_id.
 *   5. Restore the tarball onto the new box (restoreBusinessData).
 *   6. Old box teardown: stop the VM + DISABLE AUTO-RENEWAL on its Hostinger
 *      billing subscription. (Hostinger removed the immediate-cancel
 *      endpoint `DELETE /api/billing/v1/subscriptions/{id}` on 2026-01-12 —
 *      auto-renew-off + lapse at period end is the only teardown.)
 *   7. Repoint subscriptions.hostinger_billing_subscription_id at the NEW
 *      box's billing subscription so the lifecycle engine tears down the
 *      right thing on a future cancel.
 *
 * The owner "your coworker is live" email/SMS is suppressed by default
 * (ownerEmail is NOT passed → orchestrator notifies ADMIN_EMAIL instead);
 * pass --notify-owner for a real communicated maintenance window.
 *
 * Usage:
 *   npx tsx debug/migrate-vps-size.ts --business <id> --size kvm2         # dry run
 *   npx tsx debug/migrate-vps-size.ts --business <id> --size kvm2 --apply # ⚠️ buys a VPS
 *   Flags: --notify-owner   send the owner the provisioning-complete email/SMS
 *          --keep-old       skip step 6 (leave the old box running + renewing)
 *          --adopt-vm <id>  NO purchase: adopt an already-paid VM stuck in
 *                           `initial` (Hostinger sometimes charges the card
 *                           but 402s the order API, leaving paid boxes in
 *                           "Pending setup"). Uses the same setup→recreate
 *                           flow provision-kvm2-smoke.ts validated, injected
 *                           as the orchestrator's vpsProvisioner so bootstrap,
 *                           tunnel, and deploy run identically to a purchase.
 *
 * State (for audit / manual recovery) is written to
 * debug/.migrate-vps-size-<businessId>.json after each apply run.
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv, makeHostingerClient } from "./_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const NOTIFY_OWNER = process.argv.includes("--notify-owner");
const KEEP_OLD = process.argv.includes("--keep-old");

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i > -1 ? (process.argv[i + 1] ?? null) : null;
}

const BUSINESS_ID = argValue("--business");
const TARGET_SIZE = argValue("--size");
if (!BUSINESS_ID || (TARGET_SIZE !== "kvm2" && TARGET_SIZE !== "kvm8")) {
  console.error("usage: migrate-vps-size.ts --business <uuid> --size kvm2|kvm8 [--apply] [--notify-owner] [--keep-old] [--adopt-vm <vmId>]");
  process.exit(1);
}
const adoptRaw = argValue("--adopt-vm");
const ADOPT_VM_ID = adoptRaw !== null ? Number(adoptRaw) : null;
if (adoptRaw !== null && (!Number.isInteger(ADOPT_VM_ID) || ADOPT_VM_ID! <= 0)) {
  console.error("--adopt-vm requires a numeric Hostinger virtual machine id");
  process.exit(1);
}

const { resolveVpsSize } = await import("../src/lib/vps/size.ts");
const { VPS_SIZE_PRICE_ITEM } = await import("../src/lib/hostinger/provision.ts");
const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");

const hostinger = makeHostingerClient();
const db = await createSupabaseServiceClient();

// ---------------------------------------------------------------- load state
const { data: biz, error: bizErr } = await db
  .from("businesses")
  .select("id, name, tier, status, hostinger_vps_id, owner_email, vps_size, is_paused")
  .eq("id", BUSINESS_ID)
  .single();
if (bizErr || !biz) {
  console.error(`business ${BUSINESS_ID} not found: ${bizErr?.message}`);
  process.exit(1);
}
if (biz.tier !== "starter" && biz.tier !== "standard") {
  console.error(`tier=${biz.tier} is not migratable by this script (enterprise is custom)`);
  process.exit(1);
}

const { data: subRows } = await db
  .from("subscriptions")
  .select("id, status, hostinger_billing_subscription_id, created_at")
  .eq("business_id", BUSINESS_ID)
  .eq("status", "active")
  .order("created_at", { ascending: false })
  .limit(1);
const activeSub = subRows?.[0] ?? null;

const currentSize = resolveVpsSize(biz.tier, biz.vps_size);
const targetItem = VPS_SIZE_PRICE_ITEM[TARGET_SIZE as "kvm2" | "kvm8"];

const oldVmIdRaw = biz.hostinger_vps_id;
const oldVmId = oldVmIdRaw && /^\d+$/.test(oldVmIdRaw) ? Number.parseInt(oldVmIdRaw, 10) : null;
let oldVmIp: string | null = null;
let oldBillingId: string | null = activeSub?.hostinger_billing_subscription_id ?? null;
if (oldVmId !== null) {
  try {
    const vm = await hostinger.getVirtualMachine(oldVmId);
    oldVmIp = vm.ipv4?.[0]?.address ?? null;
    // The VM detail's subscription_id is the reliable billing mapping — the
    // subscriptions LIST stopped returning resource_id (verified Jul 2026).
    if (!oldBillingId && typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
      oldBillingId = vm.subscription_id;
    }
    console.log(`old VM          : ${oldVmId} state=${vm.state} ip=${oldVmIp ?? "none"}`);
  } catch (err) {
    console.log(`old VM          : ${oldVmId} (lookup failed: ${err instanceof Error ? err.message : String(err)})`);
  }
  if (!oldBillingId) {
    try {
      const subs = await hostinger.listBillingSubscriptions();
      oldBillingId = subs.find((s) => s.resource_id === String(oldVmId))?.id ?? null;
    } catch {
      /* keep null — teardown will warn */
    }
  }
}

// Target-SKU price from the live catalog so the dry run states the real cost.
let priceStr = "unknown";
try {
  const catalog = await hostinger.listCatalog("VPS");
  const item = catalog.find((c) => c.prices.some((p) => p.id === targetItem));
  const price = item?.prices.find((p) => p.id === targetItem);
  if (price) {
    priceStr =
      `$${(price.price / 100).toFixed(2)}/${price.period_unit}` +
      (price.first_period_price !== undefined
        ? ` (first period $${(price.first_period_price / 100).toFixed(2)})`
        : "");
  }
} catch {
  /* dry-run nicety only */
}

console.log(`== VPS size migration ==`);
console.log(`business        : ${biz.name} (${biz.id})`);
console.log(`tier            : ${biz.tier} (entitlements — unchanged by this migration)`);
console.log(`size            : ${currentSize} (pin=${biz.vps_size ?? "null/tier-default"}) → ${TARGET_SIZE}`);
console.log(
  ADOPT_VM_ID !== null
    ? `new box         : ADOPT paid VM ${ADOPT_VM_ID} (no purchase)`
    : `target SKU      : ${targetItem}  →  ${priceStr}`
);
console.log(`old billing sub : ${oldBillingId ?? "UNKNOWN — teardown will need a manual lookup"}`);

if (ADOPT_VM_ID !== null) {
  if (ADOPT_VM_ID === oldVmId) {
    console.error(`--adopt-vm ${ADOPT_VM_ID} is the business's CURRENT box — pick the new one.`);
    process.exit(1);
  }
  try {
    const vm = await hostinger.getVirtualMachine(ADOPT_VM_ID);
    console.log(`adopt target    : vm=${vm.id} state=${vm.state} ip=${vm.ipv4?.[0]?.address ?? "none"}`);
  } catch (err) {
    console.error(`--adopt-vm ${ADOPT_VM_ID} lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
console.log(`owner notify    : ${NOTIFY_OWNER ? `YES → ${biz.owner_email}` : "no (admin email only)"}`);
console.log(`old box         : ${KEEP_OLD ? "KEPT (renewing!)" : "stop + auto-renew off (lapses at period end)"}`);

if (currentSize === TARGET_SIZE) {
  console.log(`\nNOTE: effective size is already ${TARGET_SIZE}. Proceeding anyway would still`);
  console.log(`buy a fresh ${TARGET_SIZE} box and migrate onto it (box refresh). Aborting —`);
  console.log(`if that's what you want, flip the pin first or edit this guard.`);
  process.exit(1);
}

if (!APPLY) {
  console.log(`\n[dry-run] Would: snapshot+backup old box →`);
  console.log(
    ADOPT_VM_ID !== null
      ? `[dry-run] adopt + bootstrap paid VM ${ADOPT_VM_ID} (no purchase) → pin`
      : `[dry-run] provision ${targetItem} (⚠️ charges the Hostinger account) → pin`
  );
  console.log(`[dry-run] vps_size=${TARGET_SIZE} → restore`);
  console.log(`[dry-run] data → ${KEEP_OLD ? "leave old box running" : "stop old box + disable its billing auto-renewal"}.`);
  console.log(`[dry-run] Re-run with --apply to act.`);
  process.exit(0);
}

// ---------------------------------------------------------------- 1. snapshot
if (oldVmId !== null) {
  try {
    await hostinger.createSnapshot(oldVmId);
    console.log(`\n[snapshot] requested on old VM ${oldVmId}`);
  } catch (err) {
    console.log(`\n[snapshot] failed (continuing — tarball is the durable artefact): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------- 2. backup
const { backupBusinessData, restoreBusinessData } = await import("../src/lib/hostinger/data-migration.ts");
const { getActiveVpsSshKey } = await import("../src/lib/db/vps-ssh-keys.ts");
if (!oldVmIp) {
  console.error(`[backup] ABORT: old VM has no resolvable IP — cannot take the durable backup.`);
  console.error(`         If the old box is truly gone and you accept template state, backup/restore`);
  console.error(`         must be skipped manually (edit this script's guard).`);
  process.exit(1);
}
// Pin the backup to the key registered for the OLD box specifically. The
// default per-business "newest unrotated key" lookup breaks after any partial
// earlier run that already inserted a key row for the NEW box (that newer key
// would be tried against the old box → USERAUTH_FAILURE).
const oldBoxKey = await getActiveVpsSshKey(String(oldVmId));
if (!oldBoxKey) {
  console.error(`[backup] ABORT: no active SSH key for the old VM ${oldVmId} in vps_ssh_keys.`);
  process.exit(1);
}
console.log(`[backup] tarballing /opt/rowboat/{vault,memory} from ${oldVmIp}…`);
const backup = await backupBusinessData(
  { businessId: BUSINESS_ID, vpsHost: oldVmIp },
  { sshKeyLookup: async () => oldBoxKey }
);
console.log(`[backup] ok: ${backup.storagePath} (${backup.sizeBytes} bytes, sha256=${backup.sha256.slice(0, 12)}…)`);

// ------------------------------------------------- adopt-mode vpsProvisioner
// Injected into the orchestrator in place of the purchase when --adopt-vm is
// given. Same steps as provisionVpsForBusiness minus the purchase, using the
// setup→recreate sequence provision-kvm2-smoke.ts validated empirically
// (standalone setup 422s on bare-label hostnames and IGNORES public_key_ids;
// recreate with the identical payload is what actually lands the key).
async function makeAdoptProvisioner(vmId: number): Promise<
  (input: {
    businessId: string;
    tier: "starter" | "standard";
    vpsSize: "kvm2" | "kvm8";
  }) => Promise<import("../src/lib/hostinger/provision.ts").ProvisionVpsForBusinessResult>
> {
  const { generateSshKeypair } = await import("../src/lib/hostinger/keypair.ts");
  const { insertVpsSshKey, getActiveVpsSshKey: getKeyForVm, reassignVpsSshKeyBusiness } =
    await import("../src/lib/db/vps-ssh-keys.ts");
  const { buildDefaultPostInstallScript, DEFAULT_TEMPLATE_ID, DEFAULT_US_DATA_CENTER_ID } =
    await import("../src/lib/hostinger/provision.ts");

  return async (input) => {
    // A prior partial adopt run may have already minted + persisted a keypair
    // for this VM (vps_ssh_keys enforces one active row per VPS, so a second
    // insert would violate the unique index). Reuse it — its public half is
    // already uploaded to Hostinger under hostinger_public_key_id.
    const existingKey = await getKeyForVm(String(vmId));
    let sshKeyRow: NonNullable<typeof existingKey> | null = null;
    let publicKeyId: number;
    let privateKeyPem: string;
    if (existingKey?.hostinger_public_key_id && existingKey.private_key_pem) {
      // The keypair follows the BOX, but the row must follow the TENANT:
      // step 5's restore resolves keys via getActiveVpsSshKeyForBusiness, so
      // a row still pointing at the previous owner (e.g. a smoke-clone
      // business) would make the restore try the OLD box's key against the
      // new box → USERAUTH_FAILURE. Mirror adoptVpsForBusiness's reassign.
      sshKeyRow =
        existingKey.business_id === input.businessId
          ? existingKey
          : await reassignVpsSshKeyBusiness(existingKey.id, input.businessId);
      publicKeyId = existingKey.hostinger_public_key_id;
      privateKeyPem = existingKey.private_key_pem;
      console.log(
        `  [adopt] reusing existing key row for vm=${vmId} (hostinger key id=${publicKeyId}` +
          (existingKey.business_id === input.businessId ? ")" : `, reassigned from ${existingKey.business_id})`)
      );
    } else {
      const keypair = await generateSshKeypair(`newcoworker-${input.businessId}`);
      const pubKey = await hostinger.createPublicKey(
        `newcoworker-${input.businessId}-${Date.now().toString(36)}`,
        keypair.publicKey.trim()
      );
      console.log(`  [adopt] public key uploaded id=${pubKey.id}`);
      publicKeyId = pubKey.id;
      privateKeyPem = keypair.privateKeyPem;
      sshKeyRow = await insertVpsSshKey({
        business_id: input.businessId,
        hostinger_vps_id: String(vmId),
        hostinger_public_key_id: pubKey.id,
        public_key: keypair.publicKey,
        private_key_pem: keypair.privateKeyPem,
        fingerprint_sha256: keypair.fingerprintSha256,
        ssh_username: "root"
      });
    }
    const script = await hostinger.createPostInstallScript(
      `newcoworker-${input.businessId}-${Date.now().toString(36)}`,
      buildDefaultPostInstallScript({ tier: input.tier, vpsSize: input.vpsSize })
    );
    console.log(`  [adopt] post-install script registered id=${script.id}`);

    const setupPayload = {
      data_center_id: DEFAULT_US_DATA_CENTER_ID,
      template_id: DEFAULT_TEMPLATE_ID,
      // Standalone setup validates hostname as an FQDN (bare labels 422).
      hostname: `nc-${input.businessId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12)}.newcoworker.com`,
      public_key_ids: [publicKeyId],
      post_install_script_id: script.id,
      install_monarx: false
    };

    const waitRunning = async (phase: string): Promise<string> => {
      const deadline = Date.now() + 15 * 60 * 1000;
      for (;;) {
        const vm = await hostinger.getVirtualMachine(vmId);
        const ip = vm.ipv4?.[0]?.address;
        if (vm.state === "running" && ip) return ip;
        if (vm.state === "error" || vm.state === "suspended") {
          throw new Error(`VM ${vmId} entered terminal state=${vm.state} during ${phase}`);
        }
        if (Date.now() > deadline) throw new Error(`VM ${vmId} not running 15 min into ${phase}`);
        console.log(`  [adopt:${phase}] state=${vm.state} ip=${ip ?? "none"}`);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    };

    const initialState = (await hostinger.getVirtualMachine(vmId)).state;
    if (initialState === "initial") {
      console.log(`  [adopt] setup initiated on vm=${vmId}`);
      await hostinger.setupVirtualMachine(vmId, setupPayload);
      await waitRunning("setup");
    }

    const recreateOnce = async (): Promise<string> => {
      // The VM can report its PRE-recreate state (`running`, or `stopped` when
      // re-adopting a torn-down box) for a few polls after the recreate call;
      // wait for it to LEAVE that state before waiting for it to come back,
      // otherwise a stale running+IP gets treated as ready mid-rebuild.
      const preRecreateState = (await hostinger.getVirtualMachine(vmId)).state;
      console.log(`  [adopt] recreate initiated on vm=${vmId} state=${preRecreateState} (attaches key + post-install)`);
      await hostinger.recreateVirtualMachine(vmId, setupPayload);
      const leaveDeadline = Date.now() + 3 * 60 * 1000;
      for (;;) {
        const vm = await hostinger.getVirtualMachine(vmId);
        if (vm.state !== preRecreateState) break;
        if (Date.now() > leaveDeadline) {
          console.log(`  [adopt] vm never left state=${preRecreateState} after recreate — assuming the transition was missed`);
          break;
        }
        await new Promise((r) => setTimeout(r, 5_000));
      }
      return waitRunning("recreate");
    };

    // Verify the key actually landed. Empirically (VM 1800980, July 2026) a
    // recreate issued right after setup finishes does NOT attach the key —
    // sshd comes up but rejects the keypair — while a second recreate from
    // the settled running state does. Auth failures are not connect errors,
    // so runWithSshConnectRetry won't retry them; probe explicitly and re-run
    // the recreate once before giving up.
    const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
    const sshAuthOk = async (host: string): Promise<boolean> => {
      // sshd can lag `running` by ~a minute; give auth three probes before
      // concluding the key is missing.
      for (let i = 0; i < 3; i += 1) {
        try {
          await sshExec({
            host,
            username: "root",
            privateKeyPem,
            command: "true"
          });
          return true;
        } catch {
          await new Promise((r) => setTimeout(r, 30_000));
        }
      }
      return false;
    };

    // On a recreate Hostinger runs the post-install script through its own
    // runner, NOT cloud-init runcmd — so the orchestrator's `cloud-init
    // status --wait` prefix reports done while the PIS bootstrap is still
    // mid-apt. Wait for that in-flight bootstrap to finish (its slim loader
    // holds a `tee -a /post_install.log` for its whole lifetime) before
    // returning, or the orchestrator's SSH bootstrap races it on the apt lock.
    const waitForPisQuiescence = async (host: string): Promise<void> => {
      const deadline = Date.now() + 25 * 60 * 1000;
      for (;;) {
        try {
          const res = await sshExec({
            host,
            username: "root",
            privateKeyPem,
            command:
              // The [e] class stops pgrep -f from matching this probe's own
              // command line (which contains the literal pattern).
              "if pgrep -f 'te[e] -a /post_install.log' >/dev/null || pgrep -x apt-get >/dev/null || pgrep -x dpkg >/dev/null; then echo busy; else echo idle; fi"
          });
          if ((res.stdout ?? "").includes("idle")) return;
          console.log(`  [adopt] waiting for the box's own post-install to finish…`);
        } catch {
          /* transient ssh blip — retry below */
        }
        if (Date.now() > deadline) {
          console.log(`  [adopt] post-install quiescence wait timed out — proceeding anyway`);
          return;
        }
        await new Promise((r) => setTimeout(r, 15_000));
      }
    };

    // If a previous adopt attempt already attached our key, skip the
    // destructive recreate — the box is set up, possibly still running its
    // post-install; the orchestrator's idempotent SSH bootstrap follows.
    const preState = await hostinger.getVirtualMachine(vmId);
    const preIp = preState.ipv4?.[0]?.address ?? null;
    let publicIp: string;
    if (preState.state === "running" && preIp && (await sshAuthOk(preIp))) {
      console.log(`  [adopt] key already attached from a previous attempt — skipping recreate`);
      publicIp = preIp;
    } else {
      publicIp = await recreateOnce();
      if (!(await sshAuthOk(publicIp))) {
        console.log(`  [adopt] key did not attach on first recreate — retrying recreate once`);
        publicIp = await recreateOnce();
        if (!(await sshAuthOk(publicIp))) {
          throw new Error(`VM ${vmId}: SSH key still not attached after recreate retry`);
        }
      }
    }
    await waitForPisQuiescence(publicIp);
    console.log(`  [adopt] vps running ip=${publicIp}, ssh key verified`);

    try {
      await hostinger.installMonarx(vmId);
    } catch (err) {
      console.log(`  [adopt] monarx install failed (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }

    let billingId: string | null = null;
    try {
      // VM detail subscription_id first — the subscriptions LIST stopped
      // returning resource_id (verified Jul 2026), so the find() below only
      // helps on older API surfaces.
      const vm = await hostinger.getVirtualMachine(vmId);
      if (typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
        billingId = vm.subscription_id;
      }
    } catch {
      /* fall through to the list lookup */
    }
    if (!billingId) {
      try {
        const subs = await hostinger.listBillingSubscriptions();
        billingId = subs.find((s) => s.resource_id === String(vmId))?.id ?? null;
      } catch {
        /* the billing-swap step below warns when this stays null */
      }
    }

    return {
      virtualMachineId: vmId,
      publicIp,
      sshUsername: "root",
      sshKey: sshKeyRow,
      publicKeyId,
      postInstallScriptId: script.id,
      hostingerBillingSubscriptionId: billingId
    };
  };
}

// ---------------------------------------------------------------- 3. provision
// The target size is passed EXPLICITLY to the orchestrator — the
// businesses.vps_size pin is deliberately NOT written yet. Pinning before the
// cutover would make any fleet redeploy during the ~10-20 min provisioning
// window resolve VPS_SIZE=${TARGET_SIZE} while hostinger_vps_id still points
// at the old box, deploying the wrong hardware profile onto live hardware.
// The pin lands in step 4, after the orchestrator has repointed
// hostinger_vps_id to the new VM.
const { orchestrateProvisioning } = await import("../src/lib/provisioning/orchestrate.ts");
console.log(
  ADOPT_VM_ID !== null
    ? `[provision] adopting paid VM ${ADOPT_VM_ID} + bootstrapping (no purchase; ~10-20 min)…`
    : `[provision] purchasing + bootstrapping ${targetItem} (this takes ~10-20 min)…`
);
let newProv: Awaited<ReturnType<typeof orchestrateProvisioning>>;
try {
  newProv = await orchestrateProvisioning(
    {
      businessId: BUSINESS_ID,
      tier: biz.tier,
      vpsSize: TARGET_SIZE,
      ...(NOTIFY_OWNER && biz.owner_email ? { ownerEmail: biz.owner_email } : {})
    },
    // --adopt-vm names a SPECIFIC box, so the vps_inventory adopt-first pool
    // must be bypassed (vpsPool: null): the orchestrator checks the pool
    // BEFORE the injected vpsProvisioner, and a pool hit would silently land
    // the tenant on whatever box the pool coughs up instead of the named one.
    ADOPT_VM_ID !== null
      ? { vpsProvisioner: await makeAdoptProvisioner(ADOPT_VM_ID), vpsPool: null }
      : undefined
  );
} catch (err) {
  console.error(`[provision] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`[provision] The old box is untouched and still serving, and businesses.vps_size`);
  console.error(`[provision] was never repinned — redeploys keep targeting the old hardware`);
  console.error(`[provision] profile. Re-run once the cause is fixed.`);
  process.exit(1);
}
console.log(`[provision] new VM ${newProv.vpsId}, tunnel ${newProv.tunnelUrl}`);

// ---------------------------------------------------------------- 4. pin size
// hostinger_vps_id now points at the new VM (the orchestrator repointed it
// via updateBusinessStatus), so the pin and the registered box agree from
// here on. The residual mismatch window — between the orchestrator's mid-run
// repoint and this pin — has a redeploy hitting the NEW (not-yet-serving) box
// with the old profile, which is recoverable, unlike the old ordering where a
// redeploy pushed the target profile onto the LIVE old box.
const { updateBusinessVpsSize } = await import("../src/lib/db/businesses.ts");
await updateBusinessVpsSize(BUSINESS_ID, TARGET_SIZE as "kvm2" | "kvm8");
console.log(`[pin] businesses.vps_size = ${TARGET_SIZE}`);

// ---------------------------------------------------------------- 5. restore
const newVmId = Number.parseInt(newProv.vpsId, 10);
let newVmIp: string | null = null;
try {
  const vm = await hostinger.getVirtualMachine(newVmId);
  newVmIp = vm.ipv4?.[0]?.address ?? null;
} catch {
  /* handled below */
}
if (!newVmIp) {
  // Same fail-closed semantics as a restore failure below: the new box is on
  // TEMPLATE state, so billing must NOT be repointed and the old box (which
  // still has the live data) must NOT be stopped or set to lapse.
  console.error(`[restore] ABORT: cannot resolve the new VM's IP — restore manually:`);
  console.error(`          restoreBusinessData({ businessId: '${BUSINESS_ID}', vpsHost: <ip> })`);
  console.error(`[restore] The tarball is safe at ${backup.storagePath}. The old box is left`);
  console.error(`[restore] running and renewing — re-run the teardown/billing steps after the`);
  console.error(`[restore] manual restore succeeds.`);
  process.exit(1);
}
try {
  await restoreBusinessData({ businessId: BUSINESS_ID, vpsHost: newVmIp });
  console.log(`[restore] durable data restored onto ${newVmIp}`);
} catch (err) {
  console.error(`[restore] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  console.error(`[restore] The new box is serving TEMPLATE state. The tarball is safe at`);
  console.error(`[restore] ${backup.storagePath} — retry restoreBusinessData before tearing`);
  console.error(`[restore] down the old box (it still has the live data).`);
  process.exit(1);
}

// ------------------------------------------------- 6+7. old box + billing swap
const stateFile = path.resolve(process.cwd(), `debug/.migrate-vps-size-${BUSINESS_ID}.json`);
const writeAuditState = (oldBillingHandling: string): void => {
  fs.writeFileSync(
    stateFile,
    JSON.stringify(
      {
        migratedAt: new Date().toISOString(),
        businessId: BUSINESS_ID,
        tier: biz.tier,
        fromSize: currentSize,
        toSize: TARGET_SIZE,
        oldVmId,
        oldVmIp,
        oldBillingId,
        oldBillingHandling,
        newVmId,
        newVmIp,
        newBillingId,
        tunnelUrl: newProv.tunnelUrl,
        backupPath: backup.storagePath,
        backupSha256: backup.sha256
      },
      null,
      2
    ) + "\n"
  );
};

let newBillingId: string | null = newProv.hostingerBillingSubscriptionId;
if (!newBillingId) {
  try {
    const vm = await hostinger.getVirtualMachine(newVmId);
    if (typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
      newBillingId = vm.subscription_id;
    }
  } catch {
    /* fall through to the list lookup */
  }
}
if (!newBillingId) {
  try {
    const subs = await hostinger.listBillingSubscriptions();
    newBillingId = subs.find((s) => s.resource_id === String(newVmId))?.id ?? null;
  } catch {
    /* warned below */
  }
}
// Fail closed on the billing swap: if the sub row still points at the OLD
// box's subscription, a future cancel through the lifecycle engine tears down
// the wrong resource and the NEW box renews untracked forever. In that state
// the old box must stay running AND renewing until an operator fixes billing.
let billingRepointed = !activeSub; // no active sub row → nothing to repoint
if (activeSub) {
  if (newBillingId) {
    const { error } = await db
      .from("subscriptions")
      .update({ hostinger_billing_subscription_id: newBillingId })
      .eq("id", activeSub.id);
    if (error) {
      console.error(`[billing] subscriptions row update FAILED: ${error.message}`);
    } else {
      billingRepointed = true;
      console.log(`[billing] subscriptions.hostinger_billing_subscription_id → ${newBillingId}`);
    }
  } else {
    console.error(`[billing] new box's billing subscription id unknown — look it up`);
    console.error(`[billing] (listBillingSubscriptions, resource_id=${newVmId}) and update the sub row.`);
  }
}

if (!KEEP_OLD && !billingRepointed) {
  writeAuditState("kept-billing-repoint-failed");
  console.error(`[old-box] ABORT: the billing swap did not complete, so the old box is left`);
  console.error(`[old-box] RUNNING and RENEWING (tearing it down now would leave the DB pointing`);
  console.error(`[old-box] at a lapsing subscription while the new box renews untracked).`);
  console.error(`[old-box] Fix subscriptions.hostinger_billing_subscription_id for sub ${activeSub?.id},`);
  console.error(`[old-box] then finish teardown manually: stop VM ${oldVmId} and disable auto-renew`);
  console.error(`[old-box] on billing subscription ${oldBillingId ?? "<unknown — find it in hPanel>"}.`);
  process.exit(1);
}

// What actually happened to the old subscription — the audit file must not
// claim "auto-renew-disabled" when the disable call failed or was impossible,
// or the operator reads it as safe while the old box keeps renewing.
let oldBillingHandling: string;
if (KEEP_OLD) {
  oldBillingHandling = "kept";
  console.log(`[old-box] kept per --keep-old — REMEMBER it keeps billing until you tear it down.`);
} else {
  if (oldVmId !== null) {
    try {
      await hostinger.stopVirtualMachine(oldVmId);
      console.log(`[old-box] VM ${oldVmId} stop requested`);
    } catch (err) {
      console.log(`[old-box] stop failed (may already be stopped): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (oldVmId !== null && oldBillingId) {
    try {
      await hostinger.disableBillingAutoRenewal(oldBillingId);
      oldBillingHandling = "auto-renew-disabled";
      console.log(`[old-box] billing ${oldBillingId} auto-renewal disabled (lapses at period end;`);
      console.log(`[old-box] the immediate-cancel endpoint was removed by Hostinger 2026-01-12)`);
    } catch (err) {
      oldBillingHandling = "auto-renew-disable-FAILED";
      console.log(`[old-box] auto-renew disable FAILED: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`[old-box] Disable it manually in hPanel or you keep paying for the old box.`);
    }
  } else if (oldVmId !== null) {
    oldBillingHandling = "billing-id-unknown-still-renewing";
    console.log(`[old-box] WARNING: no billing subscription id for the old box — disable its`);
    console.log(`[old-box] auto-renewal manually or you keep paying for it.`);
  } else {
    oldBillingHandling = "no-old-vm";
  }
}

// ---------------------------------------------------------------- audit state
writeAuditState(oldBillingHandling);

if (oldBillingHandling === "auto-renew-disable-FAILED" || oldBillingHandling === "billing-id-unknown-still-renewing") {
  console.log(`\nMigration complete WITH FOLLOW-UP: ${biz.name} is on ${TARGET_SIZE} (VM ${newVmId}, ${newVmIp ?? "ip?"}),`);
  console.log(`but the OLD subscription is still renewing — disable it in hPanel (see [old-box] above).`);
} else {
  console.log(`\nMigration complete: ${biz.name} is on ${TARGET_SIZE} (VM ${newVmId}, ${newVmIp ?? "ip?"}).`);
}
console.log(`State written to ${stateFile}`);
console.log(`Post-checks:`);
console.log(`  npx tsx debug/vps-exec.ts ${BUSINESS_ID} "docker ps --format '{{.Names}} {{.Status}}'"`);
console.log(`  npx tsx debug/smoke-owner-chat.ts ${BUSINESS_ID} "Are you there?"`);
console.log(`  npx tsx debug/check-vault-sync.ts ${BUSINESS_ID}`);
