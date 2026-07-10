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
  updateVpsSshKeyPlacement,
  type VpsSshKeyRow
} from "@/lib/db/vps-ssh-keys";
import { generateSshKeypair } from "@/lib/hostinger/keypair";
import { sshExec } from "@/lib/hostinger/ssh";
import { sshExecPinned } from "@/lib/hostinger/ssh-pinned";
import type { ProvisionVpsForBusinessResult } from "@/lib/hostinger/provision";
import {
  runWithSshConnectRetry,
  type VpsProvisioner
} from "@/lib/provisioning/orchestrate";
import { assertVpsProviderAllowed, type VpsRegion } from "@/lib/vps/provider";
import type { VpsSize } from "@/lib/vps/size";
import { logger } from "@/lib/logger";
import { readFileSync } from "fs";
import { join } from "path";

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
    // installed; only the operator-entered placement (host and/or region)
    // is refreshed.
    if (existing.host !== host || existing.region !== region) {
      await updateVpsSshKeyPlacement(existing.id, { host, region });
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
    // Host-key pinning (G7): first probe captures the box fingerprint,
    // later probes verify strictly.
    result = await sshExecPinned(
      row,
      {
        host: row.host,
        username: row.ssh_username,
        privateKeyPem: row.private_key_pem,
        command: `echo ${BYOS_PROBE_MARKER}`,
        // Fast feedback: the admin is waiting on this HTTP response.
        timeoutMs: 30_000,
        connectTimeoutMs: 15_000
      },
      { exec }
    );
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

// ─────────────────────────────────────────────────────────────────────────
// Preflight gate (PII hard requirements — see vps/scripts/byos-preflight.sh)
// ─────────────────────────────────────────────────────────────────────────

export type ByosPreflightStatus = "PASS" | "FAIL" | "WARN";

export type ByosPreflightCheck = {
  name: string;
  status: ByosPreflightStatus;
  detail: string;
};

export type ByosPreflightReport = {
  /** True when no check FAILed (WARNs allowed — enforced separately). */
  ok: boolean;
  checks: ByosPreflightCheck[];
  /**
   * Disk-encryption posture: 'detected' (dm-crypt/LUKS on the box) or
   * 'attestation_required' (provider-level encryption cannot be verified
   * remotely — the operator must attest to it explicitly).
   */
  diskEncryption: "detected" | "attestation_required";
};

/**
 * Parse the machine-readable `PREFLIGHT <check> <status> <detail>` lines the
 * script emits. Exported for tests; tolerant of interleaved noise lines but
 * NOT of a missing verdict — a script that died mid-run must read as failed.
 */
export function parseByosPreflightOutput(stdout: string): ByosPreflightReport {
  const checks: ByosPreflightCheck[] = [];
  let verdict: string | null = null;
  for (const line of stdout.split("\n")) {
    const m = /^PREFLIGHT (\S+) (PASS|FAIL|WARN)(?: (.*))?$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === "RESULT") {
      verdict = m[2];
      continue;
    }
    checks.push({ name: m[1], status: m[2] as ByosPreflightStatus, detail: m[3] ?? "" });
  }
  const encryptionCheck = checks.find((c) => c.name === "disk_encryption");
  return {
    // Fail closed: no verdict line (script crashed / connection dropped
    // mid-run) is a failure even if every parsed check passed.
    ok: verdict === "PASS" && checks.every((c) => c.status !== "FAIL"),
    checks,
    diskEncryption: encryptionCheck?.status === "PASS" ? "detected" : "attestation_required"
  };
}

/* c8 ignore start -- filesystem read of a repo-tracked script; the missing-file
   throw is a deploy-packaging error surfaced loudly in prod, not a unit-testable
   branch (tests inject loadScript). */
function loadByosPreflightScript(): string {
  // Fail closed — unlike soul.md's template fallback, a missing SECURITY
  // GATE script must abort enrollment, never degrade to "no checks".
  return readFileSync(join(process.cwd(), "vps/scripts/byos-preflight.sh"), "utf-8");
}
/* c8 ignore stop */

export type ByosPreflightDeps = ByosSshDeps & {
  /** Injectable script source (tests). Default reads vps/scripts/byos-preflight.sh. */
  loadScript?: () => string;
};

/**
 * Run the preflight gate on the customer's box over SSH and enforce it:
 * throws {@link ByosEnrollmentError} when any check FAILs, and when disk
 * encryption is undetectable without the operator's provider-level
 * encryption attestation (`attestProviderDiskEncryption`). Returns the full
 * report so the caller can persist it to the provisioning log.
 */
export async function runByosPreflight(
  businessId: string,
  opts: { vpsSize: VpsSize; attestProviderDiskEncryption: boolean },
  deps: ByosPreflightDeps = {}
): Promise<ByosPreflightReport> {
  /* c8 ignore next -- production default; tests inject exec */
  const exec = deps.exec ?? sshExec;
  /* c8 ignore next -- production default; tests inject loadScript */
  const loadScript = deps.loadScript ?? loadByosPreflightScript;

  const row = await requireByosKeyRow(businessId);
  const b64 = Buffer.from(loadScript(), "utf8").toString("base64");
  // VPS_SIZE is app-resolved (kvm1|kvm2|kvm4|kvm8 union type) — safe to
  // interpolate; the script itself is staged base64 so no quoting hazards.
  const command =
    `printf '%s' '${b64}' | base64 -d > /tmp/newcoworker-byos-preflight.sh` +
    ` && chmod +x /tmp/newcoworker-byos-preflight.sh` +
    ` && VPS_SIZE='${opts.vpsSize}' bash /tmp/newcoworker-byos-preflight.sh`;

  let result;
  try {
    result = await sshExecPinned(
      row,
      {
        host: row.host,
        username: row.ssh_username,
        privateKeyPem: row.private_key_pem,
        command,
        timeoutMs: 120_000,
        connectTimeoutMs: 30_000
      },
      { exec }
    );
  } catch (err) {
    throw new ByosEnrollmentError(
      `Preflight SSH run on ${row.host} failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  const report = parseByosPreflightOutput(result.stdout);
  if (!report.ok) {
    const failed = report.checks.filter((c) => c.status === "FAIL");
    const summary =
      failed.length > 0
        ? failed.map((c) => `${c.name}: ${c.detail}`).join("; ")
        : `no verdict from the preflight script (exit ${result.exitCode})`;
    throw new ByosEnrollmentError(`BYOS preflight failed — ${summary}`);
  }
  if (report.diskEncryption === "attestation_required" && !opts.attestProviderDiskEncryption) {
    throw new ByosEnrollmentError(
      "No disk encryption detected on the box (dm-crypt/LUKS). Confirm provider-level " +
        "encryption at rest and re-run with the attestation checkbox checked — PII must " +
        "not land on an unencrypted disk."
    );
  }
  logger.info("BYOS preflight passed", {
    businessId,
    host: row.host,
    diskEncryption: report.diskEncryption,
    attested: opts.attestProviderDiskEncryption
  });
  return report;
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
        sshExecPinned(
          row,
          {
            host: row.host,
            username: row.ssh_username,
            privateKeyPem: row.private_key_pem,
            command: `echo ${BYOS_PROBE_MARKER}`,
            timeoutMs: 60_000,
            connectTimeoutMs: 30_000
          },
          { exec }
        ),
      deps.sleep ? { sleep: deps.sleep } : undefined
    );
    // Same success contract as probeByosSsh: exit 0 AND the echoed marker —
    // a zero exit with mangled output (broken shell, MOTD-only session)
    // must not pass the orchestrator probe when the admin probe would
    // reject it.
    if (probe.exitCode !== 0 || !probe.stdout.includes(BYOS_PROBE_MARKER)) {
      throw new ByosEnrollmentError(
        `BYOS box ${row.host} is reachable but the SSH probe failed ` +
          `(exit ${probe.exitCode}, marker ${probe.stdout.includes(BYOS_PROBE_MARKER) ? "present" : "missing"}): ` +
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
