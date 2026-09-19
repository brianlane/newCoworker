/**
 * Wait until the per-tenant voice bridge has heartbeated after a plan
 * change (or after reclaiming a pooled box). A success email / "complete"
 * log with a stale bridge is a failed migration: inbound calls die even
 * when `businesses.status` still reads online.
 *
 * When the heartbeat is already fresh we return immediately. When it is
 * stale or missing we SSH `docker compose restart` (or `up -d` if the
 * container is not running) and poll `business_telnyx_settings`.
 */

import { logger } from "@/lib/logger";
import { getBusinessTelnyxSettings } from "@/lib/db/telnyx-routes";
import { getActiveVpsSshKey } from "@/lib/db/vps-ssh-keys";
import { sshExec } from "@/lib/hostinger/ssh";
import {
  BRIDGE_FRESHNESS_THRESHOLD_MS,
  resolveBridgeHealthState
} from "@/lib/telnyx/bridge-health";
import {
  HostingerClient,
  DEFAULT_HOSTINGER_BASE_URL
} from "@/lib/hostinger/client";

const VOICE_BRIDGE_RESTART_CMD =
  "cd /opt/voice-bridge && (docker compose restart voice-bridge || docker compose up -d voice-bridge)";

export type VoiceBridgeHeartbeatResult = {
  healthy: boolean;
  heartbeatAt: string | null;
  restarted: boolean;
};

export type WaitForVoiceBridgeHeartbeatInput = {
  businessId: string;
  vpsId: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  getSettings?: typeof getBusinessTelnyxSettings;
  getSshKey?: typeof getActiveVpsSshKey;
  getVmIp?: (vmId: number) => Promise<string | null>;
  remoteExec?: (
    args: Parameters<typeof sshExec>[0]
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  timeoutMs?: number;
  pollMs?: number;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* c8 ignore start -- env-var fallbacks; tests inject getVmIp. */
async function defaultGetVmIp(vmId: number): Promise<string | null> {
  const client = new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token: process.env.HOSTINGER_API_TOKEN ?? ""
  });
  try {
    const vm = await client.getVirtualMachine(vmId);
    return vm.ipv4?.find((addr) => addr?.address)?.address ?? null;
  } catch (err) {
    logger.warn("voice-bridge cutover: resolveVmIp failed", {
      vmId,
      error: errorMessage(err)
    });
    return null;
  }
}
/* c8 ignore stop */

export async function waitForVoiceBridgeHeartbeat(
  input: WaitForVoiceBridgeHeartbeatInput
): Promise<VoiceBridgeHeartbeatResult> {
  const now = input.now ?? (() => new Date());
  /* c8 ignore next -- production sleep; tests inject a no-op */
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  /* c8 ignore next -- production default; tests inject getSettings */
  const getSettings = input.getSettings ?? getBusinessTelnyxSettings;
  /* c8 ignore next -- production default; tests inject getSshKey */
  const getSshKey = input.getSshKey ?? getActiveVpsSshKey;
  /* c8 ignore next -- production Hostinger lookup; tests inject getVmIp */
  const getVmIp = input.getVmIp ?? defaultGetVmIp;
  /* c8 ignore next -- production SSH; tests inject remoteExec */
  const remoteExec = input.remoteExec ?? sshExec;
  const timeoutMs = input.timeoutMs ?? 90_000;
  const pollMs = input.pollMs ?? 5_000;

  const deadline = now().getTime() + timeoutMs;
  let restarted = false;

  const readHealth = async (): Promise<{
    state: ReturnType<typeof resolveBridgeHealthState>;
    heartbeatAt: string | null;
  }> => {
    const settings = await getSettings(input.businessId);
    const heartbeatAt = settings?.bridge_last_heartbeat_at ?? null;
    return {
      state: resolveBridgeHealthState(heartbeatAt, now()),
      heartbeatAt
    };
  };

  let current = await readHealth();
  if (current.state === "healthy") {
    return { healthy: true, heartbeatAt: current.heartbeatAt, restarted: false };
  }

  const vmId = /^\d+$/.test(input.vpsId) ? Number.parseInt(input.vpsId, 10) : NaN;
  if (!Number.isFinite(vmId) || vmId <= 0) {
    logger.warn("voice-bridge cutover: no numeric VM id to restart", {
      businessId: input.businessId,
      vpsId: input.vpsId
    });
    return { healthy: false, heartbeatAt: current.heartbeatAt, restarted: false };
  }

  try {
    const [ip, key] = await Promise.all([getVmIp(vmId), getSshKey(String(vmId))]);
    if (ip && key?.private_key_pem) {
      const username = key.ssh_username?.trim() || "root";
      const execResult = await remoteExec({
        host: ip,
        username,
        privateKeyPem: key.private_key_pem,
        command: VOICE_BRIDGE_RESTART_CMD,
        timeoutMs: 60_000
      });
      restarted = true;
      logger.info("voice-bridge cutover: restart issued", {
        businessId: input.businessId,
        vpsId: input.vpsId,
        exitCode: execResult.exitCode
      });
    } else {
      logger.warn("voice-bridge cutover: missing IP or SSH key; cannot restart", {
        businessId: input.businessId,
        vpsId: input.vpsId,
        hasIp: Boolean(ip),
        hasKey: Boolean(key?.private_key_pem)
      });
    }
  } catch (err) {
    logger.warn("voice-bridge cutover: restart failed (continuing to poll)", {
      businessId: input.businessId,
      vpsId: input.vpsId,
      error: errorMessage(err)
    });
  }

  while (now().getTime() < deadline) {
    await sleep(pollMs);
    current = await readHealth();
    if (current.state === "healthy") {
      return { healthy: true, heartbeatAt: current.heartbeatAt, restarted };
    }
  }

  logger.warn("voice-bridge cutover: heartbeat still stale after wait", {
    businessId: input.businessId,
    vpsId: input.vpsId,
    heartbeatAt: current.heartbeatAt,
    restarted
  });
  return { healthy: false, heartbeatAt: current.heartbeatAt, restarted };
}
