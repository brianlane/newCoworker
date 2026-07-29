/**
 * Resume a mid-deploy background migration without purchasing another VPS.
 *
 * Used by the provisioning watchdog when a term_renewal / migrate_size job
 * is stalled after acquireVps already repointed businesses.hostinger_vps_id.
 */

import { getBusiness } from "@/lib/db/businesses";
import { getActiveVpsSshKey } from "@/lib/db/vps-ssh-keys";
import { HostingerClient } from "@/lib/hostinger/client";
import { sshExec } from "@/lib/hostinger/ssh";
import { logger } from "@/lib/logger";
import {
  getLatestProvisioningStatus,
  recordProvisioningProgress
} from "@/lib/provisioning/progress";
import {
  runDetachedDeployClient,
  type RemoteExecutor
} from "@/lib/provisioning/orchestrate";
import { getSubscription } from "@/lib/db/subscriptions";

export type ResumeMigrationDeployDeps = {
  getBusiness?: typeof getBusiness;
  getActiveVpsSshKey?: typeof getActiveVpsSshKey;
  getLatestProvisioningStatus?: typeof getLatestProvisioningStatus;
  getSubscription?: typeof getSubscription;
  recordProgress?: typeof recordProvisioningProgress;
  remoteExec?: RemoteExecutor;
  hostingerGetVm?: (vmId: number) => Promise<{
    ipv4?: Array<{ address?: string }> | null;
    subscription_id?: string | null;
  }>;
  sleep?: (ms: number) => Promise<void>;
};

export async function resumeMigrationDeploy(
  input: { businessId: string },
  deps: ResumeMigrationDeployDeps = {}
): Promise<{ hostingerBillingSubscriptionId: string | null; vpsId: string }> {
  const getBiz = deps.getBusiness ?? getBusiness;
  const getKey = deps.getActiveVpsSshKey ?? getActiveVpsSshKey;
  const getLatest = deps.getLatestProvisioningStatus ?? getLatestProvisioningStatus;
  const getSub = deps.getSubscription ?? getSubscription;
  const recordProgress = deps.recordProgress ?? recordProvisioningProgress;
  /* c8 ignore next 6 -- production SSH default; tests inject remoteExec */
  const remoteExec: RemoteExecutor =
    deps.remoteExec ??
    (async (args) => {
      const r = await sshExec(args);
      return {
        exitCode: r.exitCode,
        signal: r.signal,
        stdout: r.stdout,
        stderr: r.stderr
      };
    });

  const biz = await getBiz(input.businessId);
  const vpsIdRaw = biz?.hostinger_vps_id;
  if (!vpsIdRaw || !/^\d+$/.test(vpsIdRaw)) {
    throw new Error("resumeMigrationDeploy: no hostinger_vps_id on business");
  }
  const vmId = Number.parseInt(vpsIdRaw, 10);

  let host: string | null = null;
  let billingId: string | null = null;
  if (deps.hostingerGetVm) {
    const vm = await deps.hostingerGetVm(vmId);
    host = vm.ipv4?.[0]?.address ?? null;
    billingId =
      typeof vm.subscription_id === "string" && vm.subscription_id.length > 0
        ? vm.subscription_id
        : null;
  } else {
    /* c8 ignore start -- production Hostinger path */
    const token = process.env.HOSTINGER_API_TOKEN ?? "";
    const client = new HostingerClient({ token });
    const vm = await client.getVirtualMachine(vmId);
    host = vm.ipv4?.[0]?.address ?? null;
    billingId =
      typeof vm.subscription_id === "string" && vm.subscription_id.length > 0
        ? vm.subscription_id
        : null;
    /* c8 ignore stop */
  }
  if (!host) {
    throw new Error(`resumeMigrationDeploy: no IP for VM ${vmId}`);
  }

  const key = await getKey(vpsIdRaw);
  if (!key?.private_key_pem) {
    throw new Error(`resumeMigrationDeploy: no SSH key for VM ${vmId}`);
  }

  await recordProgress({
    businessId: input.businessId,
    phase: "remote_deploy_resume",
    percent: 40,
    message: "Watchdog resuming detached deploy-client (no new purchase)",
    source: "orchestrator"
  });

  const result = await runDetachedDeployClient({
    businessId: input.businessId,
    envVars: "",
    host,
    username: key.ssh_username?.trim() || "root",
    privateKeyPem: key.private_key_pem,
    sshKeyRow: key,
    remoteExec,
    latestProvisioningStatus: getLatest,
    sleep: deps.sleep
  });

  if (!result.ok) {
    throw new Error(result.reason);
  }

  if (!billingId) {
    try {
      const sub = await getSub(input.businessId);
      billingId = sub?.hostinger_billing_subscription_id ?? null;
    } catch (err) {
      /* c8 ignore next 6 -- best-effort billing id */
      logger.warn("resumeMigrationDeploy: subscription lookup failed", {
        businessId: input.businessId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  await recordProgress({
    businessId: input.businessId,
    phase: "deploy_client_complete",
    percent: 100,
    message: "deploy-client finished via watchdog resume (cutover still pending)",
    source: "orchestrator"
  });

  return { vpsId: vpsIdRaw, hostingerBillingSubscriptionId: billingId };
}
