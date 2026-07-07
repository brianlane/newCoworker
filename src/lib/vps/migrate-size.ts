/**
 * Elective VPS hardware migration (admin "escalate/de-escalate hardware").
 *
 * Server-side port of debug/migrate-vps-size.ts so the admin panel can move
 * a business between box sizes (kvm1 ↔ kvm2 ↔ kvm4 ↔ kvm8) without an
 * operator shelling into the repo. The tenant keeps their `tier`
 * (entitlements — minutes, SMS caps, concurrency, AI budget, render gate);
 * only the hardware underneath changes.
 *
 * Sequencing and fail-closed guarantees mirror the debug script:
 *
 *   1. Snapshot the old VM (best-effort; the durable artefact is step 2).
 *   2. SSH-tarball backup of /opt/rowboat/{vault,memory} to Supabase
 *      Storage. FAIL-CLOSED: an elective migration aborts here — unlike a
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
 * inbox — this runs unattended behind a 202 response, so email is the
 * operator's only progress signal.
 */

import { logger } from "@/lib/logger";
import { resolveDeployedVpsSize, type VpsSize } from "@/lib/vps/size";
import type { HostingerClient } from "@/lib/hostinger/client";
import type { BusinessRow } from "@/lib/db/businesses";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import type { VpsSshKeyRow } from "@/lib/db/vps-ssh-keys";

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
    /** Buys the replacement box at the tenant's committed Hostinger term. */
    billingPeriod?: SubscriptionRow["billing_period"];
  }) => Promise<{ vpsId: string; hostingerBillingSubscriptionId: string | null }>;
  sendOpsEmail: (input: OpsMigrationEmailInput) => Promise<void>;
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function migrateBusinessVpsSize(
  input: MigrateVpsSizeInput,
  deps: MigrateVpsSizeDeps
): Promise<MigrateVpsSizeOutcome> {
  const { businessId, targetSize, requestedBy } = input;

  // ── Load + guards ─────────────────────────────────────────────────────
  const biz = await deps.getBusiness(businessId);
  if (!biz) {
    return { ok: false, stage: "load", error: "business not found" };
  }
  // All tiers are migratable since enterprise became provisionable (Jul
  // 2026): the orchestrator maps enterprise onto the standard box profile
  // and the size resolvers know the enterprise kvm8 default.
  const tier = biz.tier;

  // Residency tenants FAIL CLOSED: this flow backs up and restores
  // /opt/rowboat/{vault,memory} only — the box-local residency datastore
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
      // The VM detail's subscription_id is the reliable billing mapping —
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
  // A business with no (numeric) recorded VM has nothing to back up — the
  // elective flow refuses rather than silently provisioning a fresh box.
  if (oldVmId === null || !oldVmIp) {
    const error =
      "old VM has no resolvable IP — cannot take the durable backup; aborting (old box untouched)";
    await notify("failed", `Backup stage: ${error}`);
    return { ok: false, stage: "backup", error };
  }
  // Key pinned to the OLD box specifically: the per-business "newest key"
  // lookup breaks after any partial earlier run inserted a key row for a
  // NEW box (that key would be tried against the old box → auth failure).
  const oldBoxKey = await deps.getActiveVpsSshKey(String(oldVmId));
  if (!oldBoxKey || !oldBoxKey.private_key_pem) {
    const error = `no active SSH key for the old VM ${oldVmId} — aborting (old box untouched)`;
    await notify("failed", `Backup stage: ${error}`);
    return { ok: false, stage: "backup", error };
  }

  // ── 1. Snapshot (best-effort, after the fail-closed preconditions) ────
  try {
    await deps.hostinger.createSnapshot(oldVmId);
  } catch (err) {
    logger.warn("migrate-size: snapshot failed (continuing — tarball is the durable artefact)", {
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
    const error = `backup failed: ${errMsg(err)} — aborting (old box untouched)`;
    await notify("failed", `Backup stage: ${error}`);
    return { ok: false, stage: "backup", error };
  }

  // ── 3. Provision at the target size ───────────────────────────────────
  // The pin is deliberately NOT written yet: pinning before cutover would
  // let a fleet redeploy during the provisioning window push the target
  // profile onto the live old box.
  let newProv: { vpsId: string; hostingerBillingSubscriptionId: string | null };
  try {
    newProv = await deps.orchestrateProvisioning({
      businessId,
      tier,
      vpsSize: targetSize,
      billingPeriod: activeSub?.billing_period ?? null
    });
  } catch (err) {
    const error = `provisioning failed: ${errMsg(err)} — old box untouched and still serving; re-run once fixed`;
    await notify("failed", `Provision stage: ${error}`);
    return { ok: false, stage: "provision", error };
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
      `cannot resolve the new VM ${newVmId}'s IP — restore manually (tarball: ${backupPath}); ` +
      `old box left running + renewing until the restore lands`;
    await notify("failed", `Restore stage: ${error}`);
    return { ok: false, stage: "restore", error };
  }
  try {
    await deps.restoreBusinessData({ businessId, vpsHost: newVmIp });
  } catch (err) {
    const error =
      `restore failed: ${errMsg(err)} — new box is on TEMPLATE state; tarball safe at ${backupPath}; ` +
      `old box left running + renewing (it still has the live data)`;
    await notify("failed", `Restore stage: ${error}`);
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
      `migration cutover DONE (new box srv${newVmId} serving) but the billing repoint failed — ` +
      `old box left RUNNING + RENEWING. Fix subscriptions.hostinger_billing_subscription_id ` +
      `(should be ${newBillingId ?? `<unknown — look up resource_id=${newVmId}>`}), then stop ` +
      `srv${oldVmId} and disable auto-renew on ${oldBillingId ?? "<unknown billing sub>"}.`;
    await notify("failed", `Billing stage: ${error}`);
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

  const followUp =
    oldBillingHandling === "auto-renew-disable-FAILED" ||
    oldBillingHandling === "billing-id-unknown-still-renewing"
      ? ` FOLLOW-UP REQUIRED: the old subscription (${oldBillingId ?? "id unknown"}) is still renewing — disable it in hPanel.`
      : "";
  await notify(
    "completed",
    `New box: srv${newVmId} (${newVmIp}). Old box srv${oldVmId}: stopped, billing=${oldBillingHandling}.` +
      followUp +
      ` Backup tarball: ${backupPath}.`
  );

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
