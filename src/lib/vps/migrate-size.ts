/**
 * Elective VPS hardware migration (admin "escalate/de-escalate hardware").
 *
 * Server-side port of debug/migrate-vps-size.ts so the admin panel can move
 * a business between box sizes (kvm1 ↔ kvm2 ↔ kvm4 ↔ kvm8) without an
 * operator shelling into the repo. The tenant keeps their `tier`
 * (entitlements : minutes, SMS caps, concurrency, AI budget, render gate);
 * only the hardware underneath changes.
 *
 * Sequencing and fail-closed guarantees mirror the debug script:
 *
 *   1. Snapshot the old VM (best-effort; the durable artefact is step 2).
 *   2. SSH-tarball backup of /opt/rowboat/{vault,memory} to Supabase
 *      Storage. FAIL-CLOSED: an elective migration aborts here : unlike a
 *      paid plan change, it can wait for a healthy old box.
 *   3. orchestrateProvisioning at the target size (pool adopt-first, then
 *      purchase). On failure the old box is untouched and still serving.
 *   4. Pin businesses.vps_size AFTER provisioning repointed
 *      hostinger_vps_id, so a concurrent fleet redeploy can never stamp the
 *      target profile onto the live old box.
 *   5. Restore the tarball onto the new box. FAIL-CLOSED: on failure the
 *      old box keeps running + renewing (it still has the live data).
 *   6. Repoint subscriptions.hostinger_billing_subscription_id at the new
 *      box. FAIL-CLOSED: without the repoint, teardown of the old box would
 *      leave the new one renewing untracked.
 *   7. Stop the old VM + disable its billing auto-renewal (Hostinger
 *      removed immediate cancel 2026-01-12; lapse-at-period-end is the only
 *      teardown).
 *
 * Every terminal outcome (completed or failed at any stage) emails the ops
 * inbox : this runs unattended behind a 202 response, so email is the
 * operator's only progress signal.
 */

import { logger } from "@/lib/logger";
import { resolveDeployedVpsSize, type VpsSize } from "@/lib/vps/size";
import { providerUsesHostingerLifecycle, resolveVpsProvider } from "@/lib/vps/provider";
import { sharedHardwareFor } from "@/lib/vps/shared-hardware";
import type { HostingerClient } from "@/lib/hostinger/client";
import type { HostingerBillingTerm } from "@/lib/hostinger/provision";
import type { BusinessRow } from "@/lib/db/businesses";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import { retireVpsSshKeysForVps, type VpsSshKeyRow } from "@/lib/db/vps-ssh-keys";
import {
  markVpsNeverRenew,
  paidThroughFromBillingSub,
  releaseVpsToPool
} from "@/lib/db/vps-inventory";
import {
  enqueueProvisioningJob,
  markProvisioningJobOutcome,
  runProvisioningJob,
  type EnqueueProvisioningJobInput,
  type RunProvisioningJobDeps
} from "@/lib/provisioning/jobs";
import { getLatestProvisioningStatus } from "@/lib/provisioning/progress";
import { tryRecoverDeployCompleteNewBox } from "@/lib/vps/migration-cutover-recovery";
import { sshExec } from "@/lib/hostinger/ssh";

export type MigrateVpsSizeInput = {
  businessId: string;
  targetSize: VpsSize;
  /** Admin identity for the audit trail + ops emails. */
  requestedBy: string;
};

export type MigrateVpsSizeOutcome =
  | {
      ok: true;
      fromSize: VpsSize;
      toSize: VpsSize;
      oldVmId: number | null;
      newVmId: string;
      newVmIp: string | null;
      /** What happened to the old box's billing (audit). */
      oldBillingHandling: string;
    }
  | {
      ok: false;
      stage: "load" | "guard" | "backup" | "provision" | "restore" | "billing";
      error: string;
    };

export type OpsMigrationEmailInput = {
  phase: "started" | "completed" | "failed";
  businessId: string;
  businessName: string;
  requestedBy: string;
  fromSize: string;
  toSize: string;
  detail: string;
};

export type MigrateVpsSizeDeps = {
  getBusiness: (id: string) => Promise<BusinessRow | null>;
  getSubscription: (businessId: string) => Promise<SubscriptionRow | null>;
  updateSubscription: (
    id: string,
    update: { hostinger_billing_subscription_id: string }
  ) => Promise<unknown>;
  updateBusinessVpsSize: (id: string, size: VpsSize) => Promise<void>;
  getActiveVpsSshKey: (vpsId: string) => Promise<VpsSshKeyRow | null>;
  /**
   * Retires the old box's key row at teardown so fleet sweeps stop SSHing
   * into it. Injected so unit tests can assert the call without a database.
   */
  retireVpsSshKeysForVps?: (vpsId: string) => Promise<number>;
  /**
   * Pools the old box's vps_inventory row at teardown. Without this the row
   * stays `assigned` to a business that no longer points at it, a shape no
   * monitor covered until billing-posture's stale_assigned_row check.
   */
  releaseVpsToPool?: typeof releaseVpsToPool;
  /** Flags the pooled old box to lapse, mirroring the term-renewal sweep. */
  markVpsNeverRenew?: (vmId: number) => Promise<void>;
  hostinger: Pick<
    HostingerClient,
    | "getVirtualMachine"
    | "createSnapshot"
    | "stopVirtualMachine"
    | "listBillingSubscriptions"
    | "disableBillingAutoRenewal"
  >;
  backupBusinessData: (
    input: { businessId: string; vpsHost: string },
    deps?: { sshKeyLookup?: (businessId: string) => Promise<VpsSshKeyRow | null> }
  ) => Promise<{ storagePath: string; sizeBytes: number; sha256: string }>;
  restoreBusinessData: (input: { businessId: string; vpsHost: string }) => Promise<unknown>;
  orchestrateProvisioning: (input: {
    businessId: string;
    tier: "starter" | "standard" | "enterprise";
    vpsSize: VpsSize;
    billingPeriod?: SubscriptionRow["billing_period"];
    /**
     * Explicit Hostinger purchase term. The purchase default is monthly, so
     * a job carrying a computed term has to forward it or the replacement
     * box silently comes back monthly.
     */
    hostingerTerm?: HostingerBillingTerm | null;
    suppressOwnerNotify?: boolean;
    /** Date.now() when the caller's route budget began. */
    deployBudgetStartedAtMs?: number;
  }) => Promise<{
    vpsId: string;
    hostingerBillingSubscriptionId: string | null;
    /** False when deploy-client.sh did not finish cleanly on the new box. */
    deploySucceeded?: boolean;
  }>;
  /** Injected so unit tests can skip the real provisioning_jobs ledger. */
  enqueueProvisioningJob?: (input: EnqueueProvisioningJobInput) => Promise<void>;
  runProvisioningJob?: typeof runProvisioningJob;
  /** Marks the ledger succeeded only after cutover finishes. */
  markProvisioningJobOutcome?: typeof markProvisioningJobOutcome;
  /** See term-renewal-sweep: continue cutover when provision throws but new box is healthy. */
  tryRecoverDeployCompleteNewBox?: typeof tryRecoverDeployCompleteNewBox;
  sendOpsEmail: (input: OpsMigrationEmailInput) => Promise<void>;
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function markMigrationJobFailed(
  deps: Pick<MigrateVpsSizeDeps, "markProvisioningJobOutcome">,
  businessId: string,
  message: string
): Promise<void> {
  /* c8 ignore next -- production ledger default; tests inject */
  const mark = deps.markProvisioningJobOutcome ?? markProvisioningJobOutcome;
  await mark(businessId, "failed", message).catch((err: unknown) => {
    logger.warn("migrate-size: markProvisioningJobOutcome(failed) failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  });
}

export async function migrateBusinessVpsSize(
  input: MigrateVpsSizeInput,
  deps: MigrateVpsSizeDeps
): Promise<MigrateVpsSizeOutcome> {
  const { businessId, targetSize, requestedBy } = input;
  // The route's maxDuration budget starts here. Snapshot, backup, purchase,
  // boot and bootstrap all run before the deploy poll, so the orchestrator
  // computes the deploy's remaining budget from this timestamp.
  const migrationStartedAt = Date.now();

  // ── Load + guards ─────────────────────────────────────────────────────
  const biz = await deps.getBusiness(businessId);
  if (!biz) {
    return { ok: false, stage: "load", error: "business not found" };
  }
  // All tiers are migratable since enterprise became provisionable (Jul
  // 2026): the orchestrator maps enterprise onto the standard box profile
  // and the size resolvers know the enterprise kvm8 default.
  const tier = biz.tier;

  // Non-hostinger tenants FAIL CLOSED: this flow purchases/adopts a
  // Hostinger replacement box and tears the old one down via the Hostinger
  // API : neither applies to a customer-owned BYOS box or an OVH Canada
  // box. Hardware changes for those tenants are provider-side operations
  // (customer resizes their own box / OVH plan change) followed by a
  // re-provision, never this migration.
  const vpsProvider = resolveVpsProvider(
    (biz as { vps_provider?: string }).vps_provider
  );
  if (!providerUsesHostingerLifecycle(vpsProvider)) {
    return {
      ok: false,
      stage: "guard",
      error:
        `vps_provider=${vpsProvider}: hardware migration is Hostinger-only. Resize the box ` +
        "provider-side (customer/OVH plan change), then re-run provisioning against it."
    };
  }

  // Residency tenants FAIL CLOSED: this flow backs up and restores
  // /opt/rowboat/{vault,memory} only : the box-local residency datastore
  // (the ONLY copy of purged content history) would be left behind on the
  // old box and silently lost at teardown. Until the automated datastore
  // move lands, the runbook is manual: verify a fresh encrypted dump
  // (residency-backup.timer), migrate, then debug/residency-restore.ts
  // --apply onto the new box before flipping traffic.
  const residencyMode =
    (biz as { data_residency_mode?: string }).data_residency_mode ?? "supabase";
  if (residencyMode !== "supabase") {
    return {
      ok: false,
      stage: "guard",
      error:
        `data_residency_mode=${residencyMode}: hardware migration would strand the box datastore ` +
        "(only copy of purged history). Follow the manual runbook: fresh encrypted backup -> " +
        "migrate -> debug/residency-restore.ts --apply onto the new box."
    };
  }

  // Co-tenanted boxes FAIL CLOSED: step 7 tears the old box down, which
  // destroys a second product's service on it with no backup of ours to
  // restore. There is deliberately no ack parameter here, because the admin
  // panel is the wrong place to accept that consequence: the operator has to
  // coordinate the co-tenant's redeploy first, then run the debug script with
  // --shared-box-ack.
  const shared = sharedHardwareFor(businessId);
  if (shared) {
    return {
      ok: false,
      stage: "guard",
      error:
        `${shared.businessName} runs on shared hardware (VM ${shared.vmId}): migrating it destroys ` +
        `${shared.coTenants.map((c) => c.name).join(", ")}. Coordinate the co-tenant redeploy, ` +
        "then run debug/migrate-vps-size.ts --shared-box-ack."
    };
  }

  const currentSize = resolveDeployedVpsSize(tier, biz.vps_size);
  if (currentSize === targetSize) {
    return { ok: false, stage: "guard", error: `business is already on ${targetSize}` };
  }

  const sub = await deps.getSubscription(businessId);
  const activeSub = sub && sub.status === "active" ? sub : null;

  const oldVmIdRaw = biz.hostinger_vps_id;
  const oldVmId = oldVmIdRaw && /^\d+$/.test(oldVmIdRaw) ? Number.parseInt(oldVmIdRaw, 10) : null;
  let oldVmIp: string | null = null;
  let oldBillingId: string | null = activeSub?.hostinger_billing_subscription_id ?? null;
  if (oldVmId !== null) {
    try {
      const vm = await deps.hostinger.getVirtualMachine(oldVmId);
      oldVmIp = vm.ipv4?.[0]?.address ?? null;
      // The VM detail's subscription_id is the reliable billing mapping :
      // the subscriptions LIST stopped returning resource_id (Jul 2026).
      if (!oldBillingId && typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
        oldBillingId = vm.subscription_id;
      }
    } catch (err) {
      logger.warn("migrate-size: old VM lookup failed", { businessId, oldVmId, error: errMsg(err) });
    }
    // Last-ditch billing lookup by resource_id (mirrors the debug script):
    // without an id, teardown can't disable auto-renew and the old box
    // renews forever behind a "billing-id-unknown" completion email.
    if (!oldBillingId) {
      try {
        const subs = await deps.hostinger.listBillingSubscriptions();
        oldBillingId = subs.find((s) => s.resource_id === String(oldVmId))?.id ?? null;
      } catch (err) {
        logger.warn("migrate-size: old billing list fallback failed", {
          businessId,
          oldVmId,
          error: errMsg(err)
        });
      }
    }
  }

  const notify = async (phase: OpsMigrationEmailInput["phase"], detail: string): Promise<void> => {
    await deps.sendOpsEmail({
      phase,
      businessId,
      businessName: biz.name,
      requestedBy,
      fromSize: currentSize,
      toSize: targetSize,
      detail
    });
  };

  await notify(
    "started",
    `Old box: ${oldVmId !== null ? `srv${oldVmId}` : "none recorded"} (${oldVmIp ?? "no IP"}). ` +
      `Flow: snapshot → backup → provision ${targetSize} → restore → old-box stop + auto-renew off.`
  );

  // ── 2. Backup (fail-closed) ───────────────────────────────────────────
  // A business with no (numeric) recorded VM has nothing to back up : the
  // elective flow refuses rather than silently provisioning a fresh box.
  if (oldVmId === null || !oldVmIp) {
    const error =
      "old VM has no resolvable IP : cannot take the durable backup; aborting (old box untouched)";
    await notify("failed", `Backup stage: ${error}`);
    return { ok: false, stage: "backup", error };
  }
  // Key pinned to the OLD box specifically: the per-business "newest key"
  // lookup breaks after any partial earlier run inserted a key row for a
  // NEW box (that key would be tried against the old box → auth failure).
  const oldBoxKey = await deps.getActiveVpsSshKey(String(oldVmId));
  if (!oldBoxKey || !oldBoxKey.private_key_pem) {
    const error = `no active SSH key for the old VM ${oldVmId} : aborting (old box untouched)`;
    await notify("failed", `Backup stage: ${error}`);
    return { ok: false, stage: "backup", error };
  }

  // ── 1. Snapshot (best-effort, after the fail-closed preconditions) ────
  try {
    await deps.hostinger.createSnapshot(oldVmId);
  } catch (err) {
    logger.warn("migrate-size: snapshot failed (continuing : tarball is the durable artefact)", {
      businessId,
      oldVmId,
      error: errMsg(err)
    });
  }
  let backupPath: string;
  try {
    const backup = await deps.backupBusinessData(
      { businessId, vpsHost: oldVmIp },
      { sshKeyLookup: async () => oldBoxKey }
    );
    backupPath = backup.storagePath;
  } catch (err) {
    const error = `backup failed: ${errMsg(err)} : aborting (old box untouched)`;
    await notify("failed", `Backup stage: ${error}`);
    return { ok: false, stage: "backup", error };
  }

  // ── 3. Provision at the target size ───────────────────────────────────
  // The pin is deliberately NOT written yet: pinning before cutover would
  // let a fleet redeploy during the provisioning window push the target
  // profile onto the live old box.
  let newProv: { vpsId: string; hostingerBillingSubscriptionId: string | null };
  try {
    /* c8 ignore start -- production ledger defaults; tests inject */
    const enqueue = deps.enqueueProvisioningJob ?? enqueueProvisioningJob;
    const runJob = deps.runProvisioningJob ?? runProvisioningJob;
    /* c8 ignore stop */
    await enqueue({
      businessId,
      tier,
      vpsSize: targetSize,
      billingPeriod: activeSub?.billing_period ?? null,
      suppressOwnerNotify: true,
      purpose: "migrate_size"
    });
    const jobOut = await runJob(
      {
        business_id: businessId,
        tier,
        vps_size: targetSize,
        billing_period: activeSub?.billing_period ?? null,
        suppress_owner_notify: true,
        skip_pool_adopt: false,
        purpose: "migrate_size"
      },
      {
        orchestrate: async (input) => {
          const out = await deps.orchestrateProvisioning({
            businessId: input.businessId,
            tier: input.tier,
            vpsSize: targetSize,
            billingPeriod: input.billingPeriod,
            // Forwarded for the same reason as the retry route: this object
            // is rebuilt field by field, and the purchase default is monthly.
            // migrate_size jobs carry no stored term today, so this is null
            // in practice, but the next purpose that does would silently get
            // a monthly box without it.
            hostingerTerm: input.hostingerTerm,
            suppressOwnerNotify: true,
            deployBudgetStartedAtMs: migrationStartedAt
          });
          return {
            hostingerBillingSubscriptionId: out.hostingerBillingSubscriptionId,
            vpsId: out.vpsId,
            deploySucceeded: out.deploySucceeded
          };
        }
      } satisfies RunProvisioningJobDeps
    );
    if (!jobOut.vpsId) {
      throw new Error("migrate-size provision returned no vpsId");
    }
    // Step 3 fail-closed, same posture as the header promises: orchestrate
    // hands back a normal result even when the deploy failed, and cutting over
    // would restore onto a dead box and then stop the healthy old one.
    if (jobOut.deploySucceeded === false) {
      const error =
        `deploy failed on new box ${jobOut.vpsId}: old box untouched and still serving; ` +
        "new box left for the stuck-alert path";
      await notify("failed", `Provision stage: ${error}`);
      await markMigrationJobFailed(deps, businessId, error);
      return { ok: false, stage: "provision", error };
    }
    newProv = {
      vpsId: jobOut.vpsId,
      hostingerBillingSubscriptionId: jobOut.hostingerBillingSubscriptionId
    };
  } catch (err) {
    /* c8 ignore start -- backup stage already fail-closed without an old VM id */
    if (oldVmId === null) {
      const error = `provisioning failed: ${errMsg(err)}: old box untouched and still serving; re-run once fixed`;
      await notify("failed", `Provision stage: ${error}`);
      await markMigrationJobFailed(deps, businessId, error);
      return { ok: false, stage: "provision", error };
    }
    /* c8 ignore stop */
    /* c8 ignore next -- production default recover factory */
    const recover =
      deps.tryRecoverDeployCompleteNewBox ??
      /* c8 ignore next 12 -- production default recover + SSH probe */
      ((input, probeDeps) =>
        tryRecoverDeployCompleteNewBox(input, {
          ...probeDeps,
          remoteExec: async (args) => {
            const r = await sshExec(args);
            return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
          }
        }));
    const recovered = await recover(
      { businessId, oldVmId },
      {
        getBusiness: deps.getBusiness,
        getLatestProvisioningStatus,
        getVirtualMachine: (id) => deps.hostinger.getVirtualMachine(id),
        getActiveVpsSshKey: deps.getActiveVpsSshKey
      }
    );
    if (recovered) {
      logger.warn(
        "migrate-size: provision threw but new box looks deploy-complete; continuing cutover",
        { businessId, oldVmId, newVpsId: recovered.vpsId, error: errMsg(err) }
      );
      newProv = recovered;
    } else {
      const error = `provisioning failed: ${errMsg(err)}: old box untouched and still serving; re-run once fixed`;
      await notify("failed", `Provision stage: ${error}`);
      await markMigrationJobFailed(deps, businessId, error);
      return { ok: false, stage: "provision", error };
    }
  }

  // ── 4. Pin the size (now that hostinger_vps_id points at the new box) ─
  await deps.updateBusinessVpsSize(businessId, targetSize);

  // ── 5. Restore (fail-closed) ──────────────────────────────────────────
  const newVmId = Number.parseInt(newProv.vpsId, 10);
  let newVmIp: string | null = null;
  try {
    const vm = await deps.hostinger.getVirtualMachine(newVmId);
    newVmIp = vm.ipv4?.[0]?.address ?? null;
  } catch {
    /* handled below */
  }
  if (!newVmIp) {
    const error =
      `cannot resolve the new VM ${newVmId}'s IP : restore manually (tarball: ${backupPath}); ` +
      `old box left running + renewing until the restore lands`;
    await notify("failed", `Restore stage: ${error}`);
    await markMigrationJobFailed(deps, businessId, error);
    return { ok: false, stage: "restore", error };
  }
  try {
    await deps.restoreBusinessData({ businessId, vpsHost: newVmIp });
  } catch (err) {
    const error =
      `restore failed: ${errMsg(err)} : new box is on TEMPLATE state; tarball safe at ${backupPath}; ` +
      `old box left running + renewing (it still has the live data)`;
    await notify("failed", `Restore stage: ${error}`);
    await markMigrationJobFailed(deps, businessId, error);
    return { ok: false, stage: "restore", error };
  }

  // ── 6. Billing repoint (fail-closed before teardown) ─────────────────
  let newBillingId: string | null = newProv.hostingerBillingSubscriptionId;
  if (!newBillingId) {
    try {
      const vm = await deps.hostinger.getVirtualMachine(newVmId);
      if (typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
        newBillingId = vm.subscription_id;
      }
    } catch {
      /* fall through to the list lookup */
    }
  }
  if (!newBillingId) {
    try {
      const subs = await deps.hostinger.listBillingSubscriptions();
      newBillingId = subs.find((s) => s.resource_id === String(newVmId))?.id ?? null;
    } catch {
      /* handled by the fail-closed branch below */
    }
  }
  let billingRepointed = !activeSub; // no active sub row → nothing to repoint
  if (activeSub && newBillingId) {
    try {
      await deps.updateSubscription(activeSub.id, {
        hostinger_billing_subscription_id: newBillingId
      });
      billingRepointed = true;
    } catch (err) {
      logger.error("migrate-size: billing repoint failed", { businessId, error: errMsg(err) });
    }
  }
  if (!billingRepointed) {
    const error =
      `migration cutover DONE (new box srv${newVmId} serving) but the billing repoint failed : ` +
      `old box left RUNNING + RENEWING. Fix subscriptions.hostinger_billing_subscription_id ` +
      `(should be ${newBillingId ?? `<unknown : look up resource_id=${newVmId}>`}), then stop ` +
      `srv${oldVmId} and disable auto-renew on ${oldBillingId ?? "<unknown billing sub>"}.`;
    await notify("failed", `Billing stage: ${error}`);
    await markMigrationJobFailed(deps, businessId, error);
    return { ok: false, stage: "billing", error };
  }

  // ── 7. Old-box teardown ───────────────────────────────────────────────
  // oldVmId is necessarily non-null here: the backup stage fail-closed
  // without one.
  let oldBillingHandling: string;
  try {
    await deps.hostinger.stopVirtualMachine(oldVmId);
  } catch (err) {
    logger.warn("migrate-size: old VM stop failed (may already be stopped)", {
      businessId,
      oldVmId,
      error: errMsg(err)
    });
  }
  if (oldBillingId) {
    try {
      await deps.hostinger.disableBillingAutoRenewal(oldBillingId);
      oldBillingHandling = "auto-renew-disabled";
    } catch (err) {
      oldBillingHandling = "auto-renew-disable-FAILED";
      logger.error("migrate-size: old billing auto-renew disable failed", {
        businessId,
        oldBillingId,
        error: errMsg(err)
      });
    }
  } else {
    oldBillingHandling = "billing-id-unknown-still-renewing";
  }

  // The tenant is off this box now, so its key row must stop counting as
  // active or every fleet sweep will keep trying to SSH into it. Deliberately
  // after the backup + restore above, which read the OLD box's key. Non-fatal:
  // a stale row is bookkeeping noise, not a reason to fail a good cutover.
  /* c8 ignore next -- production default; tests inject */
  const retireKeys = deps.retireVpsSshKeysForVps ?? retireVpsSshKeysForVps;
  try {
    const retired = await retireKeys(String(oldVmId));
    logger.info("migrate-size: retired old box key rows", { businessId, oldVmId, retired });
  } catch (err) {
    logger.warn("migrate-size: old key-row retire failed (stale row left active)", {
      businessId,
      oldVmId,
      error: errMsg(err)
    });
  }

  // Return the old box's inventory row to the pool and flag it to lapse,
  // mirroring the term-renewal sweep's old-box bookkeeping. Skipping this
  // left the row `assigned` to a business that no longer points at it, which
  // no monitor covered: posture direction 1 checks the pointed-at box,
  // direction 2 and the reaper walk `available` rows only, and untracked_vm
  // needs NO row at all. Best-effort like the rest of this teardown (the
  // cutover is DONE; a bookkeeping failure is a follow-up, not a migration
  // failure), and the stale_assigned_row posture check backstops a miss.
  /* c8 ignore next 2 -- production defaults; tests inject */
  const poolRelease = deps.releaseVpsToPool ?? releaseVpsToPool;
  const flagNeverRenew = deps.markVpsNeverRenew ?? markVpsNeverRenew;
  let oldRowPooled = false;
  let oldRowFlagged = false;
  try {
    let oldPaidThrough: string | null = null;
    if (oldBillingId) {
      try {
        const subs = await deps.hostinger.listBillingSubscriptions();
        const oldSub = subs.find((s) => s.id === oldBillingId);
        if (oldSub) oldPaidThrough = paidThroughFromBillingSub(oldSub);
      } catch {
        /* expiry stamp is best-effort; releaseVpsToPool preserves the row's existing value when omitted */
      }
    }
    await poolRelease({
      vmId: oldVmId,
      plan: currentSize,
      hostingerBillingSubscriptionId: oldBillingId,
      ...(oldPaidThrough ? { expiresAt: oldPaidThrough } : {}),
      notes: `migrate-size ${currentSize}->${targetSize} of business ${businessId}; auto-renew off, never_renew`
    });
    oldRowPooled = true;
  } catch (err) {
    logger.error("migrate-size: old-box pool return failed", {
      businessId,
      oldVmId,
      error: errMsg(err)
    });
  }
  if (oldRowPooled) {
    try {
      await flagNeverRenew(oldVmId);
      oldRowFlagged = true;
    } catch (err) {
      logger.error("migrate-size: old-box never_renew mark failed", {
        businessId,
        oldVmId,
        error: errMsg(err)
      });
    }
  }
  const poolNote =
    !oldRowPooled || !oldRowFlagged
      ? ` FOLLOW-UP: old srv${oldVmId} vps_inventory bookkeeping incomplete (pooled=${oldRowPooled}, never_renew=${oldRowFlagged}); pool the row and set never_renew by hand or the daily posture report will flag it.`
      : "";

  const followUp =
    (oldBillingHandling === "auto-renew-disable-FAILED" ||
    oldBillingHandling === "billing-id-unknown-still-renewing"
      ? ` FOLLOW-UP REQUIRED: the old subscription (${oldBillingId ?? "id unknown"}) is still renewing : disable it in hPanel.`
      : "") + poolNote;
  await notify(
    "completed",
    `New box: srv${newVmId} (${newVmIp}). Old box srv${oldVmId}: stopped, billing=${oldBillingHandling}.` +
      followUp +
      ` Backup tarball: ${backupPath}.`
  );

  /* c8 ignore next -- production ledger default; tests inject */
  const markOutcome = deps.markProvisioningJobOutcome ?? markProvisioningJobOutcome;
  await markOutcome(businessId, "succeeded").catch((err: unknown) => {
    logger.warn("migrate-size: markProvisioningJobOutcome(succeeded) failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  });

  logger.info("migrate-size: complete", {
    businessId,
    fromSize: currentSize,
    toSize: targetSize,
    oldVmId,
    newVmId,
    oldBillingHandling,
    requestedBy
  });

  return {
    ok: true,
    fromSize: currentSize,
    toSize: targetSize,
    oldVmId,
    newVmId: newProv.vpsId,
    newVmIp,
    oldBillingHandling
  };
}
