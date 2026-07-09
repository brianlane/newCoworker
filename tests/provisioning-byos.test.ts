import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateBusinessVpsProvider: vi.fn()
}));

vi.mock("@/lib/db/vps-ssh-keys", () => ({
  getActiveVpsSshKey: vi.fn(),
  insertVpsSshKey: vi.fn(),
  updateVpsSshKeyPlacement: vi.fn(),
  updateVpsSshKeyHostKeyFingerprint: vi.fn()
}));

vi.mock("@/lib/hostinger/keypair", () => ({
  generateSshKeypair: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import {
  BYOS_PROBE_MARKER,
  ByosEnrollmentError,
  byosBoxId,
  isValidByosHost,
  makeByosProvisioner,
  parseByosPreflightOutput,
  prepareByosEnrollment,
  probeByosSsh,
  runByosPreflight
} from "@/lib/provisioning/byos";
import { getBusiness, updateBusinessVpsProvider } from "@/lib/db/businesses";
import {
  getActiveVpsSshKey,
  insertVpsSshKey,
  updateVpsSshKeyPlacement
} from "@/lib/db/vps-ssh-keys";
import { generateSshKeypair } from "@/lib/hostinger/keypair";
import { VpsProviderValidationError } from "@/lib/vps/provider";
import type { SshExecResult } from "@/lib/hostinger/ssh";

const BIZ = "11111111-1111-4111-8111-111111111111";

function keyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    business_id: BIZ,
    hostinger_vps_id: byosBoxId(BIZ),
    hostinger_public_key_id: null,
    public_key: "ssh-ed25519 AAAA byos",
    private_key_pem: "PEM",
    fingerprint_sha256: "SHA256:byosfp",
    ssh_username: "root",
    provider: "byos",
    region: "ca",
    host: "203.0.113.7",
    created_at: "2026-07-01T00:00:00Z",
    rotated_at: null,
    ...overrides
  };
}

function okProbe(): SshExecResult {
  return { exitCode: 0, signal: null, stdout: `${BYOS_PROBE_MARKER}\n`, stderr: "" };
}

describe("byos: host validation + box id", () => {
  it("byosBoxId builds the sentinel", () => {
    expect(byosBoxId(BIZ)).toBe(`byos-${BIZ}`);
  });

  it("accepts IPv4 and hostnames, rejects everything else", () => {
    expect(isValidByosHost("203.0.113.7")).toBe(true);
    expect(isValidByosHost("box.customer-domain.ca")).toBe(true);
    // Bad octet
    expect(isValidByosHost("999.0.113.7")).toBe(false);
    // user@host, ports, paths, shell metachars
    expect(isValidByosHost("root@203.0.113.7")).toBe(false);
    expect(isValidByosHost("box.example.com:2222")).toBe(false);
    expect(isValidByosHost("box.example.com/path")).toBe(false);
    expect(isValidByosHost("$(reboot).example.com")).toBe(false);
    // Bare labels (no dot) are rejected — require a resolvable FQDN or IP.
    expect(isValidByosHost("localhost")).toBe(false);
    expect(isValidByosHost("")).toBe(false);
    expect(isValidByosHost(`${"a".repeat(254)}.com`)).toBe(false);
  });
});

describe("prepareByosEnrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ, tier: "enterprise" } as never);
    vi.mocked(updateBusinessVpsProvider).mockResolvedValue(undefined);
    vi.mocked(getActiveVpsSshKey).mockResolvedValue(null);
    vi.mocked(generateSshKeypair).mockResolvedValue({
      publicKey: "ssh-ed25519 AAAA fresh",
      privateKeyPem: "FRESH-PEM",
      fingerprintSha256: "SHA256:freshfp"
    } as never);
    vi.mocked(insertVpsSshKey).mockImplementation(async (input) => keyRow(input) as never);
  });

  it("throws for an unknown business", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    await expect(
      prepareByosEnrollment({ businessId: BIZ, host: "203.0.113.7", region: "ca" })
    ).rejects.toThrow(ByosEnrollmentError);
  });

  it("enforces the enterprise tier gate", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ, tier: "standard" } as never);
    await expect(
      prepareByosEnrollment({ businessId: BIZ, host: "203.0.113.7", region: "us" })
    ).rejects.toThrow(VpsProviderValidationError);
    expect(updateBusinessVpsProvider).not.toHaveBeenCalled();
  });

  it("rejects malformed hosts before writing anything", async () => {
    await expect(
      prepareByosEnrollment({ businessId: BIZ, host: "root@box", region: "ca" })
    ).rejects.toThrow(/not a valid IPv4/);
    expect(updateBusinessVpsProvider).not.toHaveBeenCalled();
    expect(insertVpsSshKey).not.toHaveBeenCalled();
  });

  it("mints + persists a byos key row and pins the provider axis", async () => {
    const res = await prepareByosEnrollment({
      businessId: BIZ,
      host: " 203.0.113.7 ",
      region: "ca"
    });

    expect(updateBusinessVpsProvider).toHaveBeenCalledWith(BIZ, "byos", "ca");
    expect(insertVpsSshKey).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        hostinger_vps_id: byosBoxId(BIZ),
        hostinger_public_key_id: null,
        provider: "byos",
        region: "ca",
        host: "203.0.113.7",
        ssh_username: "root",
        public_key: "ssh-ed25519 AAAA fresh",
        private_key_pem: "FRESH-PEM"
      })
    );
    expect(res).toEqual({
      publicKey: "ssh-ed25519 AAAA fresh",
      fingerprintSha256: "SHA256:freshfp",
      host: "203.0.113.7",
      region: "ca",
      reusedExistingKey: false
    });
  });

  it("re-prepare reuses the existing key and only updates a changed placement", async () => {
    vi.mocked(getActiveVpsSshKey).mockResolvedValue(keyRow() as never);

    const changed = await prepareByosEnrollment({
      businessId: BIZ,
      host: "198.51.100.9",
      region: "ca"
    });
    expect(updateVpsSshKeyPlacement).toHaveBeenCalledWith("row-1", {
      host: "198.51.100.9",
      region: "ca"
    });
    expect(insertVpsSshKey).not.toHaveBeenCalled();
    expect(changed).toEqual(
      expect.objectContaining({
        publicKey: "ssh-ed25519 AAAA byos",
        reusedExistingKey: true,
        host: "198.51.100.9"
      })
    );

    // Region-only change (fixture row is region 'ca') must also refresh.
    vi.mocked(updateVpsSshKeyPlacement).mockClear();
    const regionOnly = await prepareByosEnrollment({
      businessId: BIZ,
      host: "203.0.113.7",
      region: "us"
    });
    expect(updateVpsSshKeyPlacement).toHaveBeenCalledWith("row-1", {
      host: "203.0.113.7",
      region: "us"
    });
    expect(regionOnly.reusedExistingKey).toBe(true);

    vi.mocked(updateVpsSshKeyPlacement).mockClear();
    const same = await prepareByosEnrollment({
      businessId: BIZ,
      host: "203.0.113.7",
      region: "ca"
    });
    expect(updateVpsSshKeyPlacement).not.toHaveBeenCalled();
    expect(same.reusedExistingKey).toBe(true);
  });
});

describe("probeByosSsh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveVpsSshKey).mockResolvedValue(keyRow() as never);
  });

  it("throws when no enrollment exists or the row has no host", async () => {
    vi.mocked(getActiveVpsSshKey).mockResolvedValueOnce(null);
    await expect(probeByosSsh(BIZ, { exec: vi.fn() })).rejects.toThrow(
      /No BYOS enrollment found/
    );

    vi.mocked(getActiveVpsSshKey).mockResolvedValueOnce(keyRow({ host: null }) as never);
    await expect(probeByosSsh(BIZ, { exec: vi.fn() })).rejects.toThrow(/has no host/);
  });

  it("wraps connection failures with an operator-actionable hint", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("connection error: ECONNREFUSED"));
    await expect(probeByosSsh(BIZ, { exec })).rejects.toThrow(/authorized_keys/);
  });

  it("wraps non-Error rejections too", async () => {
    const exec = vi.fn().mockRejectedValue("plain failure");
    await expect(probeByosSsh(BIZ, { exec })).rejects.toThrow(/plain failure/);
  });

  it("rejects a non-zero exit and a missing marker", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 1, signal: null, stdout: "", stderr: "sh: boom" });
    await expect(probeByosSsh(BIZ, { exec })).rejects.toThrow(/exit 1.*sh: boom/s);

    exec.mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: "garbled", stderr: "" });
    await expect(probeByosSsh(BIZ, { exec })).rejects.toThrow(/command failed/);
  });

  it("falls back to <no output> when the failed probe produced no streams", async () => {
    const exec = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 3, signal: null, stdout: "", stderr: "" });
    await expect(probeByosSsh(BIZ, { exec })).rejects.toThrow(/<no output>/);
  });

  it("resolves with the host on success", async () => {
    const exec = vi.fn().mockResolvedValue(okProbe());
    await expect(probeByosSsh(BIZ, { exec })).resolves.toEqual({ host: "203.0.113.7" });
    expect(exec).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "203.0.113.7",
        username: "root",
        privateKeyPem: "PEM",
        command: `echo ${BYOS_PROBE_MARKER}`
      })
    );
  });
});

const PREFLIGHT_PASS_OUTPUT = [
  "PREFLIGHT os PASS ubuntu 24.04",
  "PREFLIGHT cpu PASS 8 vCPU (min 8 for kvm8)",
  "PREFLIGHT disk_encryption PASS dm-crypt/LUKS volume detected",
  "PREFLIGHT RESULT PASS"
].join("\n");

const PREFLIGHT_WARN_ENCRYPTION_OUTPUT = [
  "PREFLIGHT os PASS ubuntu 24.04",
  "PREFLIGHT disk_encryption WARN no dm-crypt/LUKS detected — provider-level encryption-at-rest attestation required",
  "PREFLIGHT RESULT PASS"
].join("\n");

describe("parseByosPreflightOutput", () => {
  it("parses checks, tolerates noise lines, and reads the verdict", () => {
    const report = parseByosPreflightOutput(
      `random boot noise\n${PREFLIGHT_PASS_OUTPUT}\ntrailing`
    );
    expect(report.ok).toBe(true);
    expect(report.diskEncryption).toBe("detected");
    expect(report.checks).toHaveLength(3);
    expect(report.checks[0]).toEqual({
      name: "os",
      status: "PASS",
      detail: "ubuntu 24.04"
    });
  });

  it("fails closed when the verdict line is missing (script died mid-run)", () => {
    const report = parseByosPreflightOutput("PREFLIGHT os PASS ubuntu 24.04\n");
    expect(report.ok).toBe(false);
  });

  it("any FAIL check fails the report and WARN encryption requires attestation", () => {
    const failed = parseByosPreflightOutput(
      [
        "PREFLIGHT os FAIL requires Ubuntu 24.04, found debian 12",
        "PREFLIGHT RESULT FAIL"
      ].join("\n")
    );
    expect(failed.ok).toBe(false);
    expect(failed.diskEncryption).toBe("attestation_required");

    const warned = parseByosPreflightOutput(PREFLIGHT_WARN_ENCRYPTION_OUTPUT);
    expect(warned.ok).toBe(true);
    expect(warned.diskEncryption).toBe("attestation_required");
  });

  it("tolerates a check line without detail", () => {
    const report = parseByosPreflightOutput(
      "PREFLIGHT egress443 PASS\nPREFLIGHT RESULT PASS"
    );
    expect(report.checks[0]).toEqual({ name: "egress443", status: "PASS", detail: "" });
  });
});

describe("runByosPreflight", () => {
  const loadScript = () => "#!/bin/bash\necho preflight-script";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveVpsSshKey).mockResolvedValue(keyRow() as never);
  });

  it("stages the script base64-encoded with the VPS_SIZE and returns the report", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ exitCode: 0, signal: null, stdout: PREFLIGHT_PASS_OUTPUT, stderr: "" });
    const report = await runByosPreflight(
      BIZ,
      { vpsSize: "kvm8", attestProviderDiskEncryption: false },
      { exec, loadScript }
    );
    expect(report.ok).toBe(true);
    const cmd = exec.mock.calls[0][0].command as string;
    expect(cmd).toContain("base64 -d");
    expect(cmd).toContain("VPS_SIZE='kvm8'");
    expect(cmd).toContain(
      Buffer.from(loadScript(), "utf8").toString("base64")
    );
  });

  it("wraps SSH failures (Error and non-Error)", async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error("connection error"));
    await expect(
      runByosPreflight(BIZ, { vpsSize: "kvm2", attestProviderDiskEncryption: false }, { exec, loadScript })
    ).rejects.toThrow(/Preflight SSH run .* failed: connection error/);

    exec.mockRejectedValueOnce("plain failure");
    await expect(
      runByosPreflight(BIZ, { vpsSize: "kvm2", attestProviderDiskEncryption: false }, { exec, loadScript })
    ).rejects.toThrow(/plain failure/);
  });

  it("throws with the failed-check summary on a FAIL", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 1,
      signal: null,
      stdout: [
        "PREFLIGHT os FAIL requires Ubuntu 24.04, found debian 12",
        "PREFLIGHT containers FAIL running containers found: crypto-miner",
        "PREFLIGHT RESULT FAIL"
      ].join("\n"),
      stderr: ""
    });
    await expect(
      runByosPreflight(BIZ, { vpsSize: "kvm8", attestProviderDiskEncryption: true }, { exec, loadScript })
    ).rejects.toThrow(/os: requires Ubuntu 24.04.*containers: running containers found/s);
  });

  it("throws a no-verdict summary when the script died without a RESULT line", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 137,
      signal: null,
      stdout: "PREFLIGHT os PASS ubuntu 24.04",
      stderr: ""
    });
    await expect(
      runByosPreflight(BIZ, { vpsSize: "kvm8", attestProviderDiskEncryption: false }, { exec, loadScript })
    ).rejects.toThrow(/no verdict from the preflight script \(exit 137\)/);
  });

  it("requires the operator attestation when disk encryption is undetectable", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: PREFLIGHT_WARN_ENCRYPTION_OUTPUT,
      stderr: ""
    });
    await expect(
      runByosPreflight(BIZ, { vpsSize: "kvm8", attestProviderDiskEncryption: false }, { exec, loadScript })
    ).rejects.toThrow(/attestation/);

    const attested = await runByosPreflight(
      BIZ,
      { vpsSize: "kvm8", attestProviderDiskEncryption: true },
      { exec, loadScript }
    );
    expect(attested.diskEncryption).toBe("attestation_required");
  });
});

describe("makeByosProvisioner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveVpsSshKey).mockResolvedValue(keyRow() as never);
  });

  it("returns the standard provisioning result shape on a successful probe", async () => {
    const exec = vi.fn().mockResolvedValue(okProbe());
    const provision = makeByosProvisioner({ exec });
    const res = await provision({
      businessId: BIZ,
      tier: "standard",
      vpsSize: "kvm8"
    });
    expect(res).toEqual({
      virtualMachineId: byosBoxId(BIZ),
      publicIp: "203.0.113.7",
      sshUsername: "root",
      sshKey: keyRow(),
      publicKeyId: null,
      postInstallScriptId: null,
      hostingerBillingSubscriptionId: null
    });
  });

  it("retries transient connect failures via the shared retry loop", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("connection error: ECONNREFUSED"))
      .mockResolvedValueOnce(okProbe());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const provision = makeByosProvisioner({ exec, sleep });
    const res = await provision({ businessId: BIZ, tier: "standard", vpsSize: "kvm8" });
    expect(res.publicIp).toBe("203.0.113.7");
    expect(exec).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalled();
  });

  it("throws when the probe command exits non-zero (and when no enrollment exists)", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ exitCode: 7, signal: null, stdout: "", stderr: "denied" });
    const provision = makeByosProvisioner({ exec });
    await expect(
      provision({ businessId: BIZ, tier: "standard", vpsSize: "kvm8" })
    ).rejects.toThrow(/exit 7, marker missing.*denied/s);

    vi.mocked(getActiveVpsSshKey).mockResolvedValueOnce(null);
    await expect(
      provision({ businessId: BIZ, tier: "standard", vpsSize: "kvm8" })
    ).rejects.toThrow(/No BYOS enrollment/);
  });

  it("rejects a zero-exit probe whose output lacks the marker (same contract as the admin probe)", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: "Welcome to Ubuntu banner only",
      stderr: ""
    });
    const provision = makeByosProvisioner({ exec });
    await expect(
      provision({ businessId: BIZ, tier: "standard", vpsSize: "kvm8" })
    ).rejects.toThrow(/exit 0, marker missing/);
  });

  it("reports the marker as present when a non-zero exit still echoed it", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 3,
      signal: null,
      stdout: `${BYOS_PROBE_MARKER}\n`,
      stderr: "post-echo failure"
    });
    const provision = makeByosProvisioner({ exec });
    await expect(
      provision({ businessId: BIZ, tier: "standard", vpsSize: "kvm8" })
    ).rejects.toThrow(/exit 3, marker present/);
  });

  it("falls back to <no output> when the failing probe produced no streams", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ exitCode: 9, signal: null, stdout: "", stderr: "" });
    const provision = makeByosProvisioner({ exec });
    await expect(
      provision({ businessId: BIZ, tier: "standard", vpsSize: "kvm8" })
    ).rejects.toThrow(/<no output>/);
  });
});
