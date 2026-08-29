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

const { defaultVpsProvisioner, waitForPostInstallQuiescence } = await import(
  "@/lib/provisioning/orchestrate"
);

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

/**
 * The purchase path's OTHER missing guard.
 *
 * Hostinger runs an attached post-install script through its own runner, not
 * cloud-init, so the `cloud-init status --wait` the bootstrap command prefixes
 * cannot see it. `adopt.ts` has waited for that runner since it was written;
 * the purchase path never did, because until #1696 no purchase ever reached
 * this step.
 *
 * Measured: KIN's box ran the loader 15:53:13 to 15:54:22 (69s) on 2026-08-28,
 * while on the purchase path Hostinger reported VM 1939337 running 103s after
 * create and the orchestrator SSHed in one second later. Overlapping.
 */
describe("waitForPostInstallQuiescence", () => {
  const base = {
    host: "1.2.3.4",
    username: "root",
    privateKeyPem: "pem"
  };
  const ok = (stdout: string) => ({ exitCode: 0, signal: null, stdout, stderr: "" });

  it("returns idle on the first probe when the box is already quiet", async () => {
    const remoteExec = vi.fn().mockResolvedValue(ok("idle\n"));
    const sleep = vi.fn();
    const out = await waitForPostInstallQuiescence({
      ...base,
      remoteExec,
      sleep,
      now: () => 0
    });
    expect(out).toBe("idle");
    expect(remoteExec).toHaveBeenCalledTimes(1);
    // One SSH round trip and no waiting: this must stay cheap on the adopt
    // path, which has already done its own wait before handing the host over.
    expect(sleep).not.toHaveBeenCalled();
    // The probe must not match its own command line, hence the [e] class.
    expect(remoteExec.mock.calls[0][0].command).toContain("te[e] -a /post_install.log");
    expect(remoteExec.mock.calls[0][0].command).toContain("pgrep -x apt ");
  });

  /**
   * Fail-open default, and the reason the pre-existing orchestrator test
   * `vps_bootstrapping/_bootstrapped messages reflect PIS attached` caught the
   * first draft of this guard: it injects a generic successful executor whose
   * stdout says neither word, and the loop sat there. In production the same
   * shape (empty stdout, no `pgrep` on a minimal template) would have burned
   * the whole ten-minute budget inside a 1800s sweep and CAUSED a failure that
   * would not otherwise happen. Only an explicit "busy" may keep us waiting.
   */
  it("proceeds when the probe answers anything other than busy", async () => {
    for (const stdout of ["", "idle\n", "sh: 1: pgrep: not found\n"]) {
      const remoteExec = vi.fn().mockResolvedValue(ok(stdout));
      const sleep = vi.fn();
      const out = await waitForPostInstallQuiescence({
        ...base,
        remoteExec,
        sleep,
        now: () => 0
      });
      expect(out).toBe("idle");
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  /**
   * Exercises the REAL timers rather than injected ones, so the production
   * defaults are covered code instead of an assumption behind a `c8 ignore`.
   * A zero poll interval keeps it instant while still routing through the
   * actual `setTimeout` sleep and the actual `Date.now` clock.
   */
  it("uses real timers when the caller injects none", async () => {
    const remoteExec = vi
      .fn()
      .mockResolvedValueOnce(ok("busy\n"))
      .mockResolvedValueOnce(ok("idle\n"));
    const out = await waitForPostInstallQuiescence({
      ...base,
      remoteExec,
      pollIntervalMs: 0
    });
    expect(out).toBe("idle");
    expect(remoteExec).toHaveBeenCalledTimes(2);
  });

  it("keeps polling while the runner is busy, then proceeds once it goes idle", async () => {
    const remoteExec = vi
      .fn()
      .mockResolvedValueOnce(ok("busy\n"))
      .mockResolvedValueOnce(ok("busy\n"))
      .mockResolvedValueOnce(ok("idle\n"));
    const sleep = vi.fn();
    let t = 0;
    const out = await waitForPostInstallQuiescence({
      ...base,
      remoteExec,
      sleep,
      now: () => t,
      pollIntervalMs: 15_000
    });
    expect(out).toBe("idle");
    expect(remoteExec).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(15_000);
    void t;
  });

  it("treats a refused port as still-coming-up, not as a reason to give up", async () => {
    // sshd binding late is indistinguishable from "still busy" here, and the
    // bootstrap phase has its own connect-retry behind this.
    const remoteExec = vi
      .fn()
      .mockRejectedValueOnce(new Error("sshExec: connection error: ECONNREFUSED"))
      .mockResolvedValueOnce(ok("idle\n"));
    const out = await waitForPostInstallQuiescence({
      ...base,
      remoteExec,
      sleep: vi.fn(),
      now: () => 0
    });
    expect(out).toBe("idle");
    expect(remoteExec).toHaveBeenCalledTimes(2);
  });

  it("gives up at the deadline and reports timed_out rather than hanging", async () => {
    const remoteExec = vi.fn().mockResolvedValue(ok("busy\n"));
    const sleep = vi.fn();
    const times = [0, 0, 999_999];
    const out = await waitForPostInstallQuiescence({
      ...base,
      remoteExec,
      sleep,
      now: () => times.shift() ?? 999_999,
      timeoutMs: 1000
    });
    expect(out).toBe("timed_out");
  });

  /**
   * Bugbot caught the first draft of this, and was right: the wait only runs
   * when a post-install script is attached, and that script is now the thing
   * that WRITES the key. So an early auth rejection is the expected transient,
   * not proof the key will never come. Returning at once on it would exit the
   * wait exactly on the boxes that depend on the PIS write, which is to say
   * exactly when Hostinger dropped `public_key_ids`, which is the case this
   * whole change exists for.
   */
  it("waits through early auth rejections, because the script is what installs the key", async () => {
    const remoteExec = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("sshExec: connection error: All configured authentication methods failed")
      )
      .mockRejectedValueOnce(
        new Error("sshExec: connection error: All configured authentication methods failed")
      )
      .mockResolvedValueOnce(ok("busy\n"))
      .mockResolvedValueOnce(ok("idle\n"));
    const sleep = vi.fn();
    const out = await waitForPostInstallQuiescence({
      ...base,
      remoteExec,
      sleep,
      now: () => 0
    });
    expect(out).toBe("idle");
    expect(remoteExec).toHaveBeenCalledTimes(4);
  });

  /**
   * The bound on that patience. A box where the key genuinely never lands
   * (PIS never ran AND `public_key_ids` dropped) must not consume the full
   * quiescence budget: the bootstrap raises the real error inside its own 76s
   * retry, and the sweep's 1800s runway is finite.
   */
  it("gives up on auth once the grace window passes and the key still is not there", async () => {
    const remoteExec = vi
      .fn()
      .mockRejectedValue(
        new Error("sshExec: connection error: All configured authentication methods failed")
      );
    const sleep = vi.fn();
    let t = 0;
    const out = await waitForPostInstallQuiescence({
      ...base,
      remoteExec,
      sleep,
      // First call stamps the deadlines, then the clock jumps past the grace.
      now: () => (t++ === 0 ? 0 : 10_000),
      authGraceMs: 1000
    });
    expect(out).toBe("unauthenticated");
    // Gave up well inside the overall budget rather than polling it away.
    expect(remoteExec).toHaveBeenCalledTimes(1);
  });

  /**
   * Once a probe HAS authenticated, the key is demonstrably on the box, so a
   * later auth blip is not the "never landed" case and only the overall
   * deadline bounds it.
   */
  it("does not apply the auth grace after a probe has already authenticated", async () => {
    const remoteExec = vi
      .fn()
      .mockResolvedValueOnce(ok("busy\n"))
      .mockRejectedValueOnce(
        new Error("sshExec: connection error: All configured authentication methods failed")
      )
      .mockResolvedValueOnce(ok("idle\n"));
    let t = 0;
    const out = await waitForPostInstallQuiescence({
      ...base,
      remoteExec,
      sleep: vi.fn(),
      now: () => (t++ === 0 ? 0 : 10_000),
      authGraceMs: 1000
    });
    expect(out).toBe("idle");
    expect(remoteExec).toHaveBeenCalledTimes(3);
  });
});

describe("auth rejection vs a port that will not open", () => {
  const base = { host: "1.2.3.4", username: "root", privateKeyPem: "pem" };

  it.each([
    "sshExec: connection error: All configured authentication methods failed",
    "Permission denied (publickey)",
    "SSH authentication failure"
  ])("is recognised as an auth rejection, not a connect failure: %s", async (message) => {
    const remoteExec = vi.fn().mockRejectedValue(new Error(message));
    let t = 0;
    const out = await waitForPostInstallQuiescence({
      ...base,
      remoteExec,
      sleep: vi.fn(),
      now: () => (t++ === 0 ? 0 : 10_000),
      authGraceMs: 1000
    });
    expect(out).toBe("unauthenticated");
  });

  it("keeps waiting on a refused port and on a non-Error throw, past the grace", async () => {
    for (const thrown of [
      new Error("sshExec: connection error: ECONNREFUSED"),
      "a bare string, not an Error"
    ]) {
      const remoteExec = vi
        .fn()
        .mockRejectedValueOnce(thrown)
        .mockResolvedValueOnce({ exitCode: 0, signal: null, stdout: "idle", stderr: "" });
      let t = 0;
      const out = await waitForPostInstallQuiescence({
        ...base,
        remoteExec,
        sleep: vi.fn(),
        // Well past the grace: neither of these may ever be mistaken for an
        // auth rejection and end the wait early.
        now: () => (t++ === 0 ? 0 : 10_000),
        authGraceMs: 1000
      });
      expect(out).toBe("idle");
      expect(remoteExec).toHaveBeenCalledTimes(2);
    }
  });
});
