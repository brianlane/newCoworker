/**
 * Adopt an ALREADY-OWNED Hostinger VPS for a tenant business (no purchase).
 *
 * The VPS reuse pool (fleet economics Phase B, `vps_inventory`) exists
 * because Hostinger's refund policy makes canceled boxes sunk cost: 30 days
 * per box AND >180 days since the account's last VPS refund. Adoption turns
 * that sunk cost back into inventory — the orchestrator claims a pooled box
 * of the right size and calls this instead of `provisionVpsForBusiness`.
 *
 * The sequence is the one `debug/provision-kvm2-smoke.ts --adopt-vm` and
 * `debug/migrate-vps-size.ts --adopt-vm` proved empirically (July 2026):
 *
 *   1. Reuse the VM's existing `vps_ssh_keys` row when one is active (a
 *      prior partial adopt already uploaded the public half — the table
 *      enforces one active row per VPS), otherwise mint + upload + persist.
 *   2. Register the bootstrap as a post-install script. No 403 fallback:
 *      an account that owns an adoptable VPS is past the "no VPS yet"
 *      chicken-and-egg that gates this endpoint for new accounts.
 *   3. `setup` only if the box is stuck in `initial` (never set up).
 *   4. `recreate` with the same payload — standalone setup 422s on
 *      bare-label hostnames and IGNORES `public_key_ids`; recreate is what
 *      actually lands the key. A recreate issued right after setup settles
 *      sometimes still misses the key, so we PROBE ssh auth and re-run the
 *      recreate once before failing.
 *   5. Wait for the box's own post-install run to go quiescent (Hostinger
 *      runs the PIS through its own runner, not cloud-init, so the
 *      orchestrator's `cloud-init status --wait` can't see it) — otherwise
 *      the orchestrator's SSH bootstrap races it on the apt lock.
 *   6. Monarx (non-fatal) + billing-subscription lookup, mirroring
 *      `provisionVpsForBusiness`.
 *
 * Returns the same shape as `provisionVpsForBusiness` so the orchestrator's
 * downstream phases (SSH bootstrap, tunnel, DID, deploy) are identical.
 */

import { logger } from "@/lib/logger";
import type { HostingerClient, VpsSetupRequest } from "./client";
import { generateSshKeypair } from "./keypair";
import { sshExec } from "./ssh";
import {
  getActiveVpsSshKey,
  insertVpsSshKey,
  reassignVpsSshKeyBusiness,
  rotateVpsSshKey,
  type VpsSshKeyRow
} from "@/lib/db/vps-ssh-keys";
import {
  buildDefaultPostInstallScript,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_US_DATA_CENTER_ID,
  type ProvisionVpsForBusinessResult
} from "./provision";
import { resolveVpsSize, type VpsSize } from "@/lib/vps/size";

export type AdoptVpsForBusinessInput = {
  businessId: string;
  tier: "starter" | "standard";
  vpsSize?: VpsSize | null;
  /** The pooled Hostinger VM to adopt. */
  virtualMachineId: number;
  /** Poll interval while waiting for state transitions. Default 10s. */
  pollIntervalMs?: number;
  /** Time budget for each setup/recreate wait. Default 15 min. */
  readyTimeoutMs?: number;
};

export type AdoptVpsDeps = {
  client: HostingerClient;
  /** Override keypair generation (testing). */
  generateKeypair?: typeof generateSshKeypair;
  /** Override the sleep primitive (testing). */
  sleep?: (ms: number) => Promise<void>;
  /** Override the clock (testing — the wait loops use deadlines). */
  now?: () => number;
  db?: {
    insertVpsSshKey?: typeof insertVpsSshKey;
    getActiveVpsSshKey?: typeof getActiveVpsSshKey;
    reassignVpsSshKeyBusiness?: typeof reassignVpsSshKeyBusiness;
    rotateVpsSshKey?: typeof rotateVpsSshKey;
  };
  /**
   * SSH auth probe: true when the key authenticates on the host. Production
   * default runs `true` over SSH; auth failures are NOT connect errors, so
   * the orchestrator's connect-retry loop would never surface them.
   */
  sshAuthProbe?: (host: string, privateKeyPem: string) => Promise<boolean>;
  /**
   * Post-install quiescence probe: true when the box's own PIS run (and
   * apt/dpkg) are idle. Production default greps for the PIS loader's
   * long-lived `tee -a /post_install.log` plus apt-get/dpkg.
   */
  pisQuiescentProbe?: (host: string, privateKeyPem: string) => Promise<boolean>;
};

/* c8 ignore start -- production-only SSH probes; tests inject fakes */
async function defaultSshAuthProbe(host: string, privateKeyPem: string): Promise<boolean> {
  try {
    await sshExec({ host, username: "root", privateKeyPem, command: "true" });
    return true;
  } catch {
    return false;
  }
}

async function defaultPisQuiescentProbe(host: string, privateKeyPem: string): Promise<boolean> {
  try {
    const res = await sshExec({
      host,
      username: "root",
      privateKeyPem,
      // The [e] class stops pgrep -f from matching this probe's own command
      // line (which contains the literal pattern).
      command:
        "if pgrep -f 'te[e] -a /post_install.log' >/dev/null || pgrep -x apt-get >/dev/null || pgrep -x dpkg >/dev/null; then echo busy; else echo idle; fi"
    });
    return (res.stdout ?? "").includes("idle");
  } catch {
    // Transient SSH blip — treat as "still busy" and let the caller retry.
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/* c8 ignore stop */

export async function adoptVpsForBusiness(
  input: AdoptVpsForBusinessInput,
  deps: AdoptVpsDeps
): Promise<ProvisionVpsForBusinessResult> {
  const {
    client,
    /* c8 ignore next 4 -- production defaults; tests inject fakes */
    generateKeypair = generateSshKeypair,
    sleep = defaultSleep,
    now = Date.now,
    sshAuthProbe = defaultSshAuthProbe,
    /* c8 ignore next -- production default; tests inject a fake probe */
    pisQuiescentProbe = defaultPisQuiescentProbe
  } = deps;
  /* c8 ignore next 4 -- production defaults; tests inject db overrides */
  const dbInsert = deps.db?.insertVpsSshKey ?? insertVpsSshKey;
  const dbGetKey = deps.db?.getActiveVpsSshKey ?? getActiveVpsSshKey;
  const dbReassign = deps.db?.reassignVpsSshKeyBusiness ?? reassignVpsSshKeyBusiness;
  const dbRotate = deps.db?.rotateVpsSshKey ?? rotateVpsSshKey;

  const vmId = input.virtualMachineId;
  const vpsSize = resolveVpsSize(input.tier, input.vpsSize);
  const pollInterval = input.pollIntervalMs ?? 10_000;
  const readyTimeout = input.readyTimeoutMs ?? 15 * 60 * 1000;

  // 1. Key material: reuse the VM's active row (one active row per VPS is
  //    enforced by a partial unique index — a second insert would violate
  //    it) or mint + upload + persist a fresh pair.
  const existingKey = await dbGetKey(String(vmId));
  let sshKeyRow: VpsSshKeyRow;
  let publicKeyId: number;
  // True only when the active key row was minted by a PRIOR ADOPT ATTEMPT
  // FOR THIS SAME BUSINESS — the one case where a running box with our key
  // attached is known to be a freshly recreated image (safe to skip the
  // destructive recreate below). A key row inherited from a previous tenant
  // must never unlock that fast path: the disk still holds their data.
  let sameBusinessRetry = false;
  if (existingKey?.hostinger_public_key_id && existingKey.private_key_pem) {
    // The keypair follows the BOX, but the row must follow the TENANT:
    // business-scoped lookups (backup/restore, admin console) resolve keys
    // via business_id, so a row left pointing at the previous tenant would
    // strand the new one (or leak SSH access under the old tenant's id).
    sameBusinessRetry = existingKey.business_id === input.businessId;
    sshKeyRow = sameBusinessRetry
      ? existingKey
      : await dbReassign(existingKey.id, input.businessId);
    publicKeyId = existingKey.hostinger_public_key_id;
    logger.info("adoptVps: reusing existing key row", {
      businessId: input.businessId,
      virtualMachineId: vmId,
      publicKeyId,
      sameBusinessRetry
    });
  } else {
    // An active row that exists but is unusable (missing public-key id or
    // private key) must be rotated out first: the one-active-row-per-VPS
    // partial unique index would reject the replacement insert, aborting
    // the adopt and pushing the signup onto the purchase path for a box we
    // could have repaired in place.
    if (existingKey) {
      await dbRotate(existingKey.id);
    }
    const keypair = await generateKeypair(`newcoworker-${input.businessId}`);
    const pubKey = await client.createPublicKey(
      `newcoworker-${input.businessId}-${Date.now().toString(36)}`,
      keypair.publicKey.trim()
    );
    publicKeyId = pubKey.id;
    sshKeyRow = await dbInsert({
      business_id: input.businessId,
      hostinger_vps_id: String(vmId),
      hostinger_public_key_id: pubKey.id,
      public_key: keypair.publicKey,
      private_key_pem: keypair.privateKeyPem,
      fingerprint_sha256: keypair.fingerprintSha256,
      ssh_username: "root"
    });
  }
  const privateKeyPem = sshKeyRow.private_key_pem;

  // 2. Bootstrap as a post-install script (no 403 fallback — see header).
  const script = await client.createPostInstallScript(
    `newcoworker-${input.businessId}-${Date.now().toString(36)}`,
    buildDefaultPostInstallScript({ tier: input.tier, vpsSize })
  );

  const setupPayload: VpsSetupRequest = {
    data_center_id: DEFAULT_US_DATA_CENTER_ID,
    template_id: DEFAULT_TEMPLATE_ID,
    // Standalone setup validates hostname as an FQDN (bare labels 422).
    hostname: `nc-${input.businessId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 12)}.newcoworker.com`,
    public_key_ids: [publicKeyId],
    post_install_script_id: script.id,
    install_monarx: false
  };

  const waitRunning = async (phase: string): Promise<string> => {
    const deadline = now() + readyTimeout;
    for (;;) {
      const vm = await client.getVirtualMachine(vmId);
      const ip = vm.ipv4?.[0]?.address;
      if (vm.state === "running" && ip) return ip;
      if (vm.state === "error" || vm.state === "suspended") {
        throw new Error(`adoptVps: VM ${vmId} entered terminal state=${vm.state} during ${phase}`);
      }
      if (now() > deadline) {
        throw new Error(`adoptVps: VM ${vmId} not running after ${readyTimeout}ms in ${phase}`);
      }
      await sleep(pollInterval);
    }
  };

  // 3. A box stuck in `initial` was never set up — run setup first.
  const initialState = (await client.getVirtualMachine(vmId)).state;
  if (initialState === "initial") {
    await client.setupVirtualMachine(vmId, setupPayload);
    await waitRunning("setup");
  }

  const sshAuthOk = async (host: string): Promise<boolean> => {
    // sshd can lag `running` by ~a minute; give auth three probes.
    for (let i = 0; i < 3; i += 1) {
      if (await sshAuthProbe(host, privateKeyPem)) return true;
      await sleep(30_000);
    }
    return false;
  };

  const recreateOnce = async (): Promise<string> => {
    // The VM can report its PRE-recreate state for a few polls after the
    // recreate call; wait for it to LEAVE that state before waiting for it
    // to come back, or a stale running+IP gets treated as ready mid-rebuild.
    const preRecreateState = (await client.getVirtualMachine(vmId)).state;
    await client.recreateVirtualMachine(vmId, setupPayload);
    const leaveDeadline = now() + 3 * 60 * 1000;
    for (;;) {
      const vm = await client.getVirtualMachine(vmId);
      if (vm.state !== preRecreateState) break;
      if (now() > leaveDeadline) {
        logger.warn("adoptVps: VM never left pre-recreate state — assuming transition missed", {
          virtualMachineId: vmId,
          preRecreateState
        });
        break;
      }
      await sleep(5_000);
    }
    return waitRunning("recreate");
  };

  // 4. Skip the destructive recreate ONLY when a previous adopt attempt FOR
  //    THIS SAME BUSINESS already attached our key (the box is a freshly
  //    recreated image; the orchestrator's idempotent SSH bootstrap
  //    follows). A key inherited from a previous tenant authenticating is
  //    NOT sufficient — skipping recreate there would hand the new tenant
  //    the previous tenant's live filesystem. Otherwise recreate (which
  //    wipes the disk), probe, retry once.
  const preState = await client.getVirtualMachine(vmId);
  const preIp = preState.ipv4?.[0]?.address ?? null;
  let publicIp: string;
  if (sameBusinessRetry && preState.state === "running" && preIp && (await sshAuthOk(preIp))) {
    logger.info("adoptVps: key from this business's prior attempt already attached — skipping recreate", {
      virtualMachineId: vmId
    });
    publicIp = preIp;
  } else {
    publicIp = await recreateOnce();
    if (!(await sshAuthOk(publicIp))) {
      logger.warn("adoptVps: key did not attach on first recreate — retrying once", {
        virtualMachineId: vmId
      });
      publicIp = await recreateOnce();
      if (!(await sshAuthOk(publicIp))) {
        throw new Error(`adoptVps: VM ${vmId} SSH key still not attached after recreate retry`);
      }
    }
  }

  // 5. Wait for the box's own PIS run to finish before handing the host to
  //    the orchestrator's SSH bootstrap (apt lock contention otherwise).
  const quiescenceDeadline = now() + 25 * 60 * 1000;
  for (;;) {
    if (await pisQuiescentProbe(publicIp, privateKeyPem)) break;
    if (now() > quiescenceDeadline) {
      logger.warn("adoptVps: post-install quiescence wait timed out — proceeding", {
        virtualMachineId: vmId
      });
      break;
    }
    await sleep(15_000);
  }

  // 6. Monarx is defense-in-depth, not a gate — mirror provisionVpsForBusiness.
  try {
    await client.installMonarx(vmId);
  } catch (err) {
    logger.warn("adoptVps: Monarx install failed; continuing", {
      virtualMachineId: vmId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  // The VM detail endpoint's `subscription_id` is the reliable mapping —
  // Hostinger's subscriptions LIST stopped returning `resource_id` (verified
  // against the live API Jul 2026), so the historical find-by-resource_id is
  // kept only as a fallback for older API surfaces that still populate it.
  let hostingerBillingSubscriptionId: string | null = null;
  try {
    const vm = await client.getVirtualMachine(vmId);
    if (typeof vm.subscription_id === "string" && vm.subscription_id.length > 0) {
      hostingerBillingSubscriptionId = vm.subscription_id;
    }
  } catch (err) {
    logger.warn("adoptVps: VM detail lookup for billing subscription failed", {
      virtualMachineId: vmId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  if (!hostingerBillingSubscriptionId) {
    try {
      const subs = await client.listBillingSubscriptions();
      hostingerBillingSubscriptionId = subs.find((s) => s.resource_id === String(vmId))?.id ?? null;
    } catch (err) {
      logger.warn("adoptVps: billing subscription lookup failed", {
        virtualMachineId: vmId,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return {
    virtualMachineId: vmId,
    publicIp,
    sshUsername: "root",
    sshKey: sshKeyRow,
    publicKeyId,
    postInstallScriptId: script.id,
    hostingerBillingSubscriptionId
  };
}
