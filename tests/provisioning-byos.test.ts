import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateBusinessVpsProvider: vi.fn()
}));

vi.mock("@/lib/db/vps-ssh-keys", () => ({
  getActiveVpsSshKey: vi.fn(),
  insertVpsSshKey: vi.fn(),
  updateVpsSshKeyHost: vi.fn()
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
  prepareByosEnrollment,
  probeByosSsh
} from "@/lib/provisioning/byos";
import { getBusiness, updateBusinessVpsProvider } from "@/lib/db/businesses";
import {
  getActiveVpsSshKey,
  insertVpsSshKey,
  updateVpsSshKeyHost
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

  it("re-prepare reuses the existing key and only updates a changed host", async () => {
    vi.mocked(getActiveVpsSshKey).mockResolvedValue(keyRow() as never);

    const changed = await prepareByosEnrollment({
      businessId: BIZ,
      host: "198.51.100.9",
      region: "ca"
    });
    expect(updateVpsSshKeyHost).toHaveBeenCalledWith("row-1", "198.51.100.9");
    expect(insertVpsSshKey).not.toHaveBeenCalled();
    expect(changed).toEqual(
      expect.objectContaining({
        publicKey: "ssh-ed25519 AAAA byos",
        reusedExistingKey: true,
        host: "198.51.100.9"
      })
    );

    vi.mocked(updateVpsSshKeyHost).mockClear();
    const same = await prepareByosEnrollment({
      businessId: BIZ,
      host: "203.0.113.7",
      region: "ca"
    });
    expect(updateVpsSshKeyHost).not.toHaveBeenCalled();
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
    ).rejects.toThrow(/exited 7.*denied/s);

    vi.mocked(getActiveVpsSshKey).mockResolvedValueOnce(null);
    await expect(
      provision({ businessId: BIZ, tier: "standard", vpsSize: "kvm8" })
    ).rejects.toThrow(/No BYOS enrollment/);
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
