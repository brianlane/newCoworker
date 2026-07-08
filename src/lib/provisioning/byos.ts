/**
 * BYOS (bring-your-own-server) enrollment — enterprise-only, SSH handover.
 *
 * The customer supplies a fresh Ubuntu 24.04 box; the platform never
 * purchases anything. Enrollment is a two-step admin flow:
 *
 *   1. PREPARE ({@link prepareByosEnrollment}): pin the business to
 *      `vps_provider='byos'` + region, mint a per-box ed25519 keypair, and
 *      persist it in `vps_ssh_keys` (provider='byos', `host` = the
 *      operator-entered IP/hostname, box id = the `byos-<businessId>`
 *      sentinel). The PUBLIC key is returned for the customer to append to
 *      root's `authorized_keys` on their box. Re-running prepare is
 *      idempotent: the existing active key is reused (so a key the customer
 *      already installed keeps working) and only the `host` is updated.
 *
 *   2. PROVISION: the admin route probes SSH auth ({@link probeByosSsh})
 *      for fast feedback, then runs the standard provisioning orchestrator
 *      with {@link makeByosProvisioner} injected — the provisioner verifies
 *      SSH reachability and returns the same result shape as a Hostinger
 *      purchase, so bootstrap/tunnel/DID/deploy run unchanged.
 *
 * SSH is fixed at port 22 (same as the fleet; UFW on the box only opens 22
 * after bootstrap anyway). The box id sentinel keeps the one-active-key-
 * per-box invariant working without a numeric VM id.
 */

import { getBusiness, updateBusinessVpsProvider } from "@/lib/db/businesses";
import {
  getActiveVpsSshKey,
  insertVpsSshKey,
  updateVpsSshKeyHost,
  type VpsSshKeyRow
} from "@/lib/db/vps-ssh-keys";
import { generateSshKeypair } from "@/lib/hostinger/keypair";
import { sshExec } from "@/lib/hostinger/ssh";
import type { ProvisionVpsForBusinessResult } from "@/lib/hostinger/provision";
import {
  runWithSshConnectRetry,
  type VpsProvisioner
} from "@/lib/provisioning/orchestrate";
import { assertVpsProviderAllowed, type VpsRegion } from "@/lib/vps/provider";
import { logger } from "@/lib/logger";

/** Marker echoed by the SSH probe so a mangled shell can't fake success. */
export const BYOS_PROBE_MARKER = "newcoworker-byos-ok";

/** Generic box id stored in `vps_ssh_keys.hostinger_vps_id` for BYOS rows. */
export function byosBoxId(businessId: string): string {
  return `byos-${businessId}`;
}

export class ByosEnrollmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByosEnrollmentError";
  }
}

/**
 * Operator-entered box address: a dotted-quad IPv4 or an RFC-1123 hostname.
 * Validated defensively because the value ends up in SSH connect config and
 * on the admin page — a URL, a `user@host` pair, or shell metachars are
 * always operator mistakes worth rejecting loudly.
 */
export function isValidByosHost(host: string): boolean {
  const trimmed = host.trim();
  if (trimmed.length === 0 || trimmed.length > 253) return false;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(trimmed);
  if (ipv4) {
    return ipv4.slice(1).every((octet) => Number.parseInt(octet, 10) <= 255);
  }
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(trimmed);
}

export type PrepareByosEnrollmentResult = {
  /** OpenSSH public key for the customer's /root/.ssh/authorized_keys. */
  publicKey: string;
  fingerprintSha256: string;
  host: string;
  region: VpsRegion;
  /**
   * True when an existing active key was reused (idempotent re-prepare) —
   * the customer's already-installed key keeps working; only the host was
   * refreshed.
   */
  reusedExistingKey: boolean;
};

/**
 * Step 1 of BYOS enrollment. Enterprise-gated (via
 * {@link assertVpsProviderAllowed}); throws {@link ByosEnrollmentError} on
 * operator mistakes (unknown business, malformed host).
 */
export async function prepareByosEnrollment(input: {
  businessId: string;
  host: string;
  region: VpsRegion;
}): Promise<PrepareByosEnrollmentResult> {
  const { businessId, region } = input;
  const host = input.host.trim();

  const business = await getBusiness(businessId);
  if (!business) {
    throw new ByosEnrollmentError(`Business ${businessId} not found`);
  }
  assertVpsProviderAllowed("byos", business.tier);
  if (!isValidByosHost(host)) {
    throw new ByosEnrollmentError(
      `'${host}' is not a valid IPv4 address or hostname (no ports, paths, or user@ prefixes)`
    );
  }

  // Pin the provider/region axis first: from this moment every provisioning
  // and lifecycle path treats the tenant as BYOS (no Hostinger purchase, no
  // pool, no Hostinger teardown ops).
  await updateBusinessVpsProvider(businessId, "byos", region);

  const boxId = byosBoxId(businessId);
  const existing = await getActiveVpsSshKey(boxId);
  if (existing) {
    // Idempotent re-prepare: keep the keypair the customer may already have
    // installed; only the operator-entered host is refreshed.
    if (existing.host !== host) {
      await updateVpsSshKeyHost(existing.id, host);
    }
    return {
      publicKey: existing.public_key,
      fingerprintSha256: existing.fingerprint_sha256,
      host,
      region,
      reusedExistingKey: true
    };
  }

  const keypair = await generateSshKeypair(`newcoworker-byos-${businessId}`);
  const row = await insertVpsSshKey({
    business_id: businessId,
    hostinger_vps_id: boxId,
    hostinger_public_key_id: null,
    public_key: keypair.publicKey,
    private_key_pem: keypair.privateKeyPem,
    fingerprint_sha256: keypair.fingerprintSha256,
    ssh_username: "root",
    provider: "byos",
    region,
    host
  });
  logger.info("BYOS enrollment prepared", {
    businessId,
    host,
    region,
    fingerprint: row.fingerprint_sha256
  });
  return {
    publicKey: row.public_key,
    fingerprintSha256: row.fingerprint_sha256,
    host,
    region,
    reusedExistingKey: false
  };
}

/**
 * Load the active BYOS key row for a business, asserting it is actually a
 * BYOS row with a host. Shared by the probe and the provisioner.
 */
async function requireByosKeyRow(businessId: string): Promise<VpsSshKeyRow & { host: string }> {
  const row = await getActiveVpsSshKey(byosBoxId(businessId));
  if (!row) {
    throw new ByosEnrollmentError(
      `No BYOS enrollment found for business ${businessId} — run the prepare step first`
    );
  }
  if (!row.host) {
    throw new ByosEnrollmentError(
      `BYOS key row for business ${businessId} has no host — re-run the prepare step`
    );
  }
  return row as VpsSshKeyRow & { host: string };
}

export type ByosSshDeps = {
  /** Injectable SSH executor (tests). Defaults to {@link sshExec}. */
  exec?: typeof sshExec;
  /** Injectable sleep for the connect-retry loop (tests). */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * One-shot SSH auth probe (no retry loop): `echo` a marker as root. Used by
 * the admin route for fast synchronous feedback BEFORE kicking off the
 * multi-minute orchestrator run. Throws {@link ByosEnrollmentError} with an
 * operator-actionable message on any failure.
 */
export async function probeByosSsh(
  businessId: string,
  deps: ByosSshDeps = {}
): Promise<{ host: string }> {
  /* c8 ignore next -- production default; tests inject exec */
  const exec = deps.exec ?? sshExec;
  const row = await requireByosKeyRow(businessId);
  let result;
  try {
    result = await exec({
      host: row.host,
      username: row.ssh_username,
      privateKeyPem: row.private_key_pem,
      command: `echo ${BYOS_PROBE_MARKER}`,
      // Fast feedback: the admin is waiting on this HTTP response.
      timeoutMs: 30_000,
      connectTimeoutMs: 15_000
    });
  } catch (err) {
    throw new ByosEnrollmentError(
      `SSH probe to ${row.host} failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Check that the box is up, port 22 is reachable, and the public key is in /root/.ssh/authorized_keys."
    );
  }
  if (result.exitCode !== 0 || !result.stdout.includes(BYOS_PROBE_MARKER)) {
    throw new ByosEnrollmentError(
      `SSH probe to ${row.host} authenticated but the command failed (exit ${result.exitCode}): ` +
        `${(result.stderr || result.stdout || "<no output>").slice(0, 500)}`
    );
  }
  return { host: row.host };
}

/**
 * VpsProvisioner for BYOS tenants — the no-purchase path injected into the
 * standard orchestrator by the enrollment route. Verifies SSH reachability
 * (with the connect-retry loop, since a customer may have just booted the
 * box) and returns the standard result shape so every downstream phase
 * (bootstrap, tunnel, DID, deploy, gateway token) runs unchanged.
 */
export function makeByosProvisioner(deps: ByosSshDeps = {}): VpsProvisioner {
  /* c8 ignore next -- production default; tests inject exec */
  const exec = deps.exec ?? sshExec;
  return async ({ businessId }) => {
    const row = await requireByosKeyRow(businessId);
    const probe = await runWithSshConnectRetry(
      () =>
        exec({
          host: row.host,
          username: row.ssh_username,
          privateKeyPem: row.private_key_pem,
          command: `echo ${BYOS_PROBE_MARKER}`,
          timeoutMs: 60_000,
          connectTimeoutMs: 30_000
        }),
      deps.sleep ? { sleep: deps.sleep } : undefined
    );
    if (probe.exitCode !== 0) {
      throw new ByosEnrollmentError(
        `BYOS box ${row.host} is reachable but the SSH probe exited ${probe.exitCode}: ` +
          `${(probe.stderr || probe.stdout || "<no output>").slice(0, 500)}`
      );
    }
    return {
      virtualMachineId: byosBoxId(businessId),
      publicIp: row.host,
      sshUsername: row.ssh_username,
      sshKey: row,
      publicKeyId: null,
      postInstallScriptId: null,
      hostingerBillingSubscriptionId: null
    } satisfies ProvisionVpsForBusinessResult;
  };
}
