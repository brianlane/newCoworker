/**
 * The purchase path must put our public key on the box ITSELF, and these
 * tests assert it against the REAL production wiring rather than an injected
 * stand-in.
 *
 * Scar Fairy, 2026-08-29. The term-renewal sweep bought VM 1939337, Hostinger
 * returned success, the box came up running on the right template, and the
 * key was never in root's authorized_keys. Verified by hand hours later, so
 * not a cloud-init race. The provision died at 17% on "All configured
 * authentication methods failed" holding a box the account had already paid
 * for, while the tenant stayed on an old box due to renew the next morning at
 * full price.
 *
 * Root cause: Hostinger silently drops `setup.public_key_ids`. That was
 * already known for the standalone setup/recreate/attach endpoints and worked
 * around in #359 by embedding the key in the post-install script, but only on
 * the adopt path. The purchase path was documented as safe ("the
 * purchase-embedded setup path still honors public_key_ids") and it is not.
 *
 * Why no test caught it: `defaultVpsProvisioner` was private behind a
 * `c8 ignore` reading "tests inject vpsProvisioner". Every test did exactly
 * that, so nothing ever asserted what production sends. It is exported now,
 * and this file asserts the producer.
 *
 * Why it took months to surface: the purchase reply parser was broken
 * (#1696), so every purchase threw and every box the fleet owned arrived via
 * the adopt/reconcile path, which does embed the key. VM 1939337 was the
 * first clean purchase in the fleet's history and the first to actually
 * depend on `public_key_ids`. It failed on first contact.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HostingerClient } from "@/lib/hostinger/client";

const provisionVpsForBusiness = vi.fn();
const recordProvisioningProgress = vi.fn();

vi.mock("@/lib/hostinger/provision", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hostinger/provision")>();
  return { ...actual, provisionVpsForBusiness };
});

vi.mock("@/lib/provisioning/progress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/provisioning/progress")>();
  return { ...actual, recordProvisioningProgress };
});

const { defaultVpsProvisioner } = await import("@/lib/provisioning/orchestrate");

/** A real-shaped OpenSSH public key; the script builder validates the format. */
const PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEmQqJqwCDG5IdNqoV5XTREIsOU4MwHTm3PgV4Xh1B42 newcoworker-biz-1\n";

/** Capture the input object handed to the real `provisionVpsForBusiness`. */
async function captureProvisionInput(overrides?: {
  tier?: "starter" | "standard";
  vpsSize?: "kvm1" | "kvm2";
}) {
  provisionVpsForBusiness.mockResolvedValue({
    virtualMachineId: 42,
    publicIp: "1.2.3.4",
    sshUsername: "root",
    sshKey: {},
    publicKeyId: 9,
    postInstallScriptId: 555,
    hostingerBillingSubscriptionId: "sub_1"
  });
  const client = {} as unknown as HostingerClient;
  await defaultVpsProvisioner(client)({
    businessId: "biz-1",
    tier: overrides?.tier ?? "standard",
    vpsSize: overrides?.vpsSize ?? "kvm2"
  });
  return provisionVpsForBusiness.mock.calls[0][0] as {
    buildPostInstallScript?: (key: string) => string;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  recordProvisioningProgress.mockResolvedValue({});
});

describe("production purchase wiring", () => {
  it("embeds the minted key in the post-install script (never trusts public_key_ids alone)", async () => {
    const input = await captureProvisionInput();

    expect(input.buildPostInstallScript).toBeTypeOf("function");
    const script = input.buildPostInstallScript!(PUBLIC_KEY);

    // The deterministic attach: the box writes the key itself on first boot.
    expect(script).toContain("/root/.ssh/authorized_keys");
    expect(script).toContain(PUBLIC_KEY.trim());
    // Written BEFORE the long apt/Docker/Ollama bootstrap, so a bootstrap
    // that stalls or fails still leaves a box we can log into and repair.
    expect(script.indexOf("authorized_keys")).toBeLessThan(script.indexOf("apt-get"));
  });

  it("carries the hardware size into the script, so the key-embed did not cost the size pin", async () => {
    const kvm1 = (await captureProvisionInput({ tier: "starter", vpsSize: "kvm1" }))
      .buildPostInstallScript!(PUBLIC_KEY);
    expect(kvm1).toContain("kvm1");
    expect(kvm1).toContain(PUBLIC_KEY.trim());
  });

  it("records the pre-charge purchase_initiated breadcrumb, and only that phase", async () => {
    provisionVpsForBusiness.mockResolvedValue({
      virtualMachineId: 42,
      publicIp: "1.2.3.4",
      sshUsername: "root",
      sshKey: {},
      publicKeyId: 9,
      postInstallScriptId: 555,
      hostingerBillingSubscriptionId: "sub_1"
    });
    await defaultVpsProvisioner({} as unknown as HostingerClient)({
      businessId: "biz-1",
      tier: "standard",
      vpsSize: "kvm2"
    });
    const deps = provisionVpsForBusiness.mock.calls[0][1] as {
      onProgress: (phase: string, meta?: Record<string, unknown>) => void;
    };

    deps.onProgress("keypair_generated", {});
    expect(recordProvisioningProgress).not.toHaveBeenCalled();

    deps.onProgress("purchase_initiated", { itemId: "item-x", hostname: "nc-biz.example.com" });
    expect(recordProvisioningProgress).toHaveBeenCalledTimes(1);
    expect(recordProvisioningProgress.mock.calls[0][0]).toMatchObject({
      businessId: "biz-1",
      phase: "purchase_initiated",
      percent: 10
    });
    expect(recordProvisioningProgress.mock.calls[0][0].message).toContain("item-x");
  });

  it("swallows a failed breadcrumb write: the charge must not hinge on a log row", async () => {
    provisionVpsForBusiness.mockResolvedValue({
      virtualMachineId: 42,
      publicIp: "1.2.3.4",
      sshUsername: "root",
      sshKey: {},
      publicKeyId: 9,
      postInstallScriptId: 555,
      hostingerBillingSubscriptionId: "sub_1"
    });
    await defaultVpsProvisioner({} as unknown as HostingerClient)({
      businessId: "biz-1",
      tier: "standard",
      vpsSize: "kvm2"
    });
    const deps = provisionVpsForBusiness.mock.calls[0][1] as {
      onProgress: (phase: string, meta?: Record<string, unknown>) => void;
    };
    // Both rejection shapes: a real Error, and a bare thrown value (a
    // rejected fetch or a stringly-typed throw from a driver), which the
    // handler has to stringify rather than read `.message` off.
    recordProvisioningProgress.mockRejectedValueOnce(new Error("db down"));
    expect(() =>
      deps.onProgress("purchase_initiated", { itemId: "i", hostname: "h" })
    ).not.toThrow();
    await vi.waitFor(() => expect(recordProvisioningProgress).toHaveBeenCalledTimes(1));

    recordProvisioningProgress.mockRejectedValueOnce("db down, no Error wrapper");
    expect(() =>
      deps.onProgress("purchase_initiated", { itemId: "i", hostname: "h" })
    ).not.toThrow();
    await vi.waitFor(() => expect(recordProvisioningProgress).toHaveBeenCalledTimes(2));
  });
});
