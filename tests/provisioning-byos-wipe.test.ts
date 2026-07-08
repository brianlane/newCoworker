import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/vps-ssh-keys", () => ({
  getActiveVpsSshKeyForBusiness: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import {
  BYOS_WIPE_DONE_MARKER,
  BYOS_WIPE_SCRIPT,
  wipeByosBox
} from "@/lib/provisioning/byos-wipe";
import { getActiveVpsSshKeyForBusiness } from "@/lib/db/vps-ssh-keys";

const BIZ = "11111111-1111-4111-8111-111111111111";

function keyRow() {
  return {
    id: "row-1",
    business_id: BIZ,
    hostinger_vps_id: `byos-${BIZ}`,
    hostinger_public_key_id: null,
    public_key: "ssh-ed25519 AAAA",
    private_key_pem: "PEM",
    fingerprint_sha256: "SHA256:fp",
    ssh_username: "root",
    provider: "byos",
    region: "ca",
    host: "203.0.113.7",
    created_at: "2026-07-01T00:00:00Z",
    rotated_at: null
  };
}

describe("wipeByosBox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActiveVpsSshKeyForBusiness).mockResolvedValue(keyRow() as never);
  });

  it("the embedded script sheds secrets and prints the completion marker", () => {
    // Sanity-pin the load-bearing steps so a refactor can't silently drop
    // the secret-shredding or the marker the executor keys success on.
    expect(BYOS_WIPE_SCRIPT).toContain('name ".env" -type f -exec shred -u');
    expect(BYOS_WIPE_SCRIPT).toContain("rm -rf /opt/rowboat");
    expect(BYOS_WIPE_SCRIPT).toContain("docker system prune -af --volumes");
    expect(BYOS_WIPE_SCRIPT).toContain(BYOS_WIPE_DONE_MARKER);
  });

  it("stages the wipe base64-encoded over SSH and resolves on the marker", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      stdout: `[newcoworker-wipe] stopping platform services\n${BYOS_WIPE_DONE_MARKER}\n`,
      stderr: ""
    });
    await wipeByosBox({ businessId: BIZ, vpsHost: "203.0.113.7" }, { exec });
    const call = exec.mock.calls[0][0];
    expect(call.host).toBe("203.0.113.7");
    expect(call.username).toBe("root");
    expect(call.command).toContain(
      Buffer.from(BYOS_WIPE_SCRIPT, "utf8").toString("base64")
    );
  });

  it("throws when no SSH key exists for the business", async () => {
    vi.mocked(getActiveVpsSshKeyForBusiness).mockResolvedValue(null);
    await expect(
      wipeByosBox({ businessId: BIZ, vpsHost: "203.0.113.7" }, { exec: vi.fn() })
    ).rejects.toThrow(/no active SSH key/);
  });

  it("throws when the wipe never printed its completion marker", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 1,
      signal: null,
      stdout: "partial output",
      stderr: "disk io error"
    });
    await expect(
      wipeByosBox({ businessId: BIZ, vpsHost: "203.0.113.7" }, { exec })
    ).rejects.toThrow(/did not complete \(exit 1\).*disk io error/s);
  });

  it("falls back to <no output> when the failed wipe produced no streams", async () => {
    const exec = vi.fn().mockResolvedValue({
      exitCode: 255,
      signal: null,
      stdout: "",
      stderr: ""
    });
    await expect(
      wipeByosBox({ businessId: BIZ, vpsHost: "203.0.113.7" }, { exec })
    ).rejects.toThrow(/<no output>/);
  });
});
