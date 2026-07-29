/**
 * Recovery probe for background migrations: when orchestrateProvisioning
 * throws (e.g. Vercel killed the function mid-deploy) but the orchestrator
 * already repointed businesses.hostinger_vps_id and the new box finished
 * deploy-client, continue restore/teardown instead of fail-closed.
 */

import type { LatestProvisioningStatus } from "@/lib/provisioning/progress";
import { logger } from "@/lib/logger";

export type RecoverableNewBox = {
  vpsId: string;
  hostingerBillingSubscriptionId: string | null;
};

export type DeployCompleteProbeDeps = {
  getBusiness: (
    businessId: string
  ) => Promise<{ hostinger_vps_id: string | null } | null>;
  getLatestProvisioningStatus: (
    businessId: string
  ) => Promise<LatestProvisioningStatus>;
  getVirtualMachine: (vmId: number) => Promise<{
    ipv4?: Array<{ address?: string }> | null;
    subscription_id?: string | null;
  }>;
  /**
   * Optional short SSH. When omitted, only DB progress / exit-file (via
   * remoteExec) paths apply. Production injects ssh against the new box.
   */
  remoteExec?: (args: {
    host: string;
    username: string;
    privateKeyPem: string;
    command: string;
  }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  getActiveVpsSshKey?: (
    vpsId: string
  ) => Promise<{ private_key_pem: string; ssh_username?: string | null } | null>;
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Returns the new VM when it differs from the old one and looks deploy-complete.
 */
export async function tryRecoverDeployCompleteNewBox(
  input: { businessId: string; oldVmId: number },
  deps: DeployCompleteProbeDeps
): Promise<RecoverableNewBox | null> {
  let biz: { hostinger_vps_id: string | null } | null;
  try {
    biz = await deps.getBusiness(input.businessId);
  } catch (err) {
    logger.warn("cutover recovery: getBusiness failed", {
      businessId: input.businessId,
      error: errMsg(err)
    });
    return null;
  }

  const newIdRaw = biz?.hostinger_vps_id;
  if (!newIdRaw || !/^\d+$/.test(newIdRaw)) return null;
  const newVmId = Number.parseInt(newIdRaw, 10);
  if (!Number.isFinite(newVmId) || newVmId <= 0 || newVmId === input.oldVmId) {
    return null;
  }

  let progressOk = false;
  try {
    const latest = await deps.getLatestProvisioningStatus(input.businessId);
    progressOk =
      latest?.phase === "deploy_client_complete" ||
      latest?.phase === "complete" ||
      latest?.percent === 100;
  } catch (err) {
    /* c8 ignore next 6 -- best-effort probe logging */
    logger.warn("cutover recovery: progress lookup failed", {
      businessId: input.businessId,
      error: errMsg(err)
    });
  }

  let exitOk = false;
  let dockerOk = false;
  let vm: Awaited<ReturnType<DeployCompleteProbeDeps["getVirtualMachine"]>> | null =
    null;
  try {
    vm = await deps.getVirtualMachine(newVmId);
  } catch (err) {
    /* c8 ignore next 7 -- best-effort probe logging */
    logger.warn("cutover recovery: new VM lookup failed", {
      businessId: input.businessId,
      newVmId,
      error: errMsg(err)
    });
  }

  /* c8 ignore start -- optional SSH probe paths */
  const ip = vm?.ipv4?.[0]?.address ?? null;
  if (ip && deps.remoteExec && deps.getActiveVpsSshKey) {
    try {
      const key = await deps.getActiveVpsSshKey(String(newVmId));
      if (key?.private_key_pem) {
        const username = key.ssh_username?.trim() || "root";
        if (!progressOk) {
          try {
            const exitProbe = await deps.remoteExec({
              host: ip,
              username,
              privateKeyPem: key.private_key_pem,
              command:
                `cat /var/run/nc-deploy-${input.businessId}.exit 2>/dev/null || echo MISSING`
            });
            const code = (exitProbe.stdout ?? "").trim().split(/\r?\n/)[0]?.trim();
            if (code === "0") exitOk = true;
          } catch (err) {
            logger.warn("cutover recovery: exit-file probe failed", {
              businessId: input.businessId,
              error: errMsg(err)
            });
          }
        }
        if (!progressOk && !exitOk) {
          try {
            const dockerProbe = await deps.remoteExec({
              host: ip,
              username,
              privateKeyPem: key.private_key_pem,
              command:
                `docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'rowboat|voice-bridge' >/dev/null && echo OK || echo NO`
            });
            dockerOk = (dockerProbe.stdout ?? "").includes("OK");
          } catch (err) {
            logger.warn("cutover recovery: docker probe failed", {
              businessId: input.businessId,
              error: errMsg(err)
            });
          }
        }
      }
    } catch (err) {
      logger.warn("cutover recovery: ssh key lookup failed", {
        businessId: input.businessId,
        newVmId,
        error: errMsg(err)
      });
    }
  }
  /* c8 ignore stop */

  if (!progressOk && !exitOk && !dockerOk) return null;

  const billingId =
    typeof vm?.subscription_id === "string" && vm.subscription_id.length > 0
      ? vm.subscription_id
      : null;

  logger.info("cutover recovery: continuing after provision throw (new box healthy)", {
    businessId: input.businessId,
    oldVmId: input.oldVmId,
    newVmId,
    progressOk,
    exitOk,
    dockerOk
  });

  return {
    vpsId: String(newVmId),
    hostingerBillingSubscriptionId: billingId
  };
}
