import { describe, expect, it, vi } from "vitest";

// Module-level fallbacks for when deps.db omits an override — the fallback
// import must not hit a real database.
const moduleGetActiveVpsSshKey = vi.fn();
const moduleInsertVpsSshKey = vi.fn();
const moduleReassignVpsSshKeyBusiness = vi.fn();
const moduleRotateVpsSshKey = vi.fn();
const moduleUpdateVpsSshKeyHostKeyFingerprint = vi.fn();
vi.mock("@/lib/db/vps-ssh-keys", () => ({
  getActiveVpsSshKey: (...args: unknown[]) => moduleGetActiveVpsSshKey(...args),
  insertVpsSshKey: (...args: unknown[]) => moduleInsertVpsSshKey(...args),
  reassignVpsSshKeyBusiness: (...args: unknown[]) => moduleReassignVpsSshKeyBusiness(...args),
  rotateVpsSshKey: (...args: unknown[]) => moduleRotateVpsSshKey(...args),
  updateVpsSshKeyHostKeyFingerprint: (...args: unknown[]) =>
    moduleUpdateVpsSshKeyHostKeyFingerprint(...args)
}));
// The adopt path reads vps_inventory for the never_renew flag; the module
// fallback (deps.db omits the override) must not touch a real database.
// Defaults to "not tracked" so pre-existing tests keep their behavior.
const moduleGetVpsInventoryByVmId = vi.fn().mockResolvedValue(null);
vi.mock("@/lib/db/vps-inventory", () => ({
  getVpsInventoryByVmId: (...args: unknown[]) => moduleGetVpsInventoryByVmId(...args)
}));

import { adoptVpsForBusiness, type AdoptVpsDeps } from "@/lib/hostinger/adopt";
import type { VpsSshKeyRow } from "@/lib/db/vps-ssh-keys";

/**
 * Fake clock: `sleep` advances `now` by the requested ms without real
 * waiting, so the adopt module's deadline loops (setup/recreate readiness,
 * leave-state, PIS quiescence) run deterministically.
 */
function makeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    }
  };
}

const keyRow: VpsSshKeyRow = {
  id: "row-1",
  business_id: "biz-1",
  hostinger_vps_id: "1800985",
  hostinger_public_key_id: 9,
  public_key: "ssh-ed25519 AAA k",
  private_key_pem: "PEM",
  fingerprint_sha256: "SHA256:abc",
  ssh_username: "root",
  provider: "hostinger",
  region: "us",
  host: null,
  created_at: "2026-07-01T00:00:00Z",
  rotated_at: null
};

const runningVm = { state: "running", ipv4: [{ address: "1.2.3.4" }] };

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    createPublicKey: vi.fn().mockResolvedValue({ id: 9, name: "k", key: "ssh-ed25519 AAA k" }),
    createPostInstallScript: vi.fn().mockResolvedValue({ id: 555, name: "pis", content: "#!" }),
    getVirtualMachine: vi.fn().mockResolvedValue(runningVm),
    setupVirtualMachine: vi.fn().mockResolvedValue({}),
    recreateVirtualMachine: vi.fn().mockResolvedValue({}),
    installMonarx: vi.fn().mockResolvedValue({ id: 1, name: "a", state: "initiated" }),
    listBillingSubscriptions: vi.fn().mockResolvedValue([]),
    enableBillingAutoRenewal: vi.fn().mockResolvedValue({}),
    ...overrides
  };
}

function makeDeps(
  client: ReturnType<typeof makeClient>,
  overrides: Partial<AdoptVpsDeps> = {}
): AdoptVpsDeps {
  const clock = makeClock();
  return {
    client: client as never,
    generateKeypair: vi.fn().mockResolvedValue({
      publicKey: "ssh-ed25519 AAAA fresh\n",
      privateKeyPem: "FRESH-PEM",
      fingerprintSha256: "SHA256:fresh"
    }),
    sleep: clock.sleep,
    now: clock.now,
    db: {
      insertVpsSshKey: vi.fn().mockResolvedValue({ ...keyRow, private_key_pem: "FRESH-PEM" }),
      getActiveVpsSshKey: vi.fn().mockResolvedValue(null)
    },
    sshAuthProbe: vi.fn().mockResolvedValue(true),
    pisQuiescentProbe: vi.fn().mockResolvedValue(true),
    ...overrides
  };
}

describe("adoptVpsForBusiness", () => {
  it("reuses the VM's active key row and skips recreate when the key already authenticates", async () => {
    const client = makeClient({
      listBillingSubscriptions: vi
        .fn()
        .mockResolvedValue([{ id: "hsub-1", resource_id: "1800985" }])
    });
    const reassign = vi.fn();
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow),
        reassignVpsSshKeyBusiness: reassign
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", vpsSize: "kvm2", virtualMachineId: 1800985 },
      deps
    );
    expect(res).toEqual({
      virtualMachineId: 1800985,
      publicIp: "1.2.3.4",
      sshUsername: "root",
      sshKey: keyRow,
      publicKeyId: 9,
      postInstallScriptId: 555,
      hostingerBillingSubscriptionId: "hsub-1"
    });
    // Reuse path: no fresh key minted, no upload, no insert. The row
    // already belongs to biz-1, so no reassign either.
    expect(deps.generateKeypair).not.toHaveBeenCalled();
    expect(client.createPublicKey).not.toHaveBeenCalled();
    expect(deps.db!.insertVpsSshKey).not.toHaveBeenCalled();
    expect(reassign).not.toHaveBeenCalled();
    // Already running with our key attached: no setup, no recreate.
    expect(client.setupVirtualMachine).not.toHaveBeenCalled();
    expect(client.recreateVirtualMachine).not.toHaveBeenCalled();
    expect(deps.db!.getActiveVpsSshKey).toHaveBeenCalledWith("1800985");
  });

  it("embeds the public key in the registered post-install script (deterministic attach)", async () => {
    // Hostinger's setup/recreate/attach endpoints silently drop
    // public_key_ids on some VMs (VM 1798267 KVM2 experiment, VM 1806097
    // KVM1 Phase E smoke) — the PIS-embedded authorized_keys write is the
    // only attach path that always works, so the adopt flow must pass the
    // key row's public half into the script builder.
    const client = makeClient();
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow),
        reassignVpsSshKeyBusiness: vi.fn()
      }
    });
    await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", vpsSize: "kvm2", virtualMachineId: 1800985 },
      deps
    );
    expect(client.createPostInstallScript).toHaveBeenCalledTimes(1);
    const scriptContent = client.createPostInstallScript.mock.calls[0][1] as string;
    expect(scriptContent).toContain(`echo '${keyRow.public_key}' >> /root/.ssh/authorized_keys`);
  });

  it("reassigns a previous tenant's key row AND still recreates — inherited keys never skip the wipe", async () => {
    // Two guarantees in one path: (a) business-scoped lookups (backup/
    // restore, admin console) resolve keys via business_id, so the row must
    // move to the adopting business; (b) the previous tenant's key
    // authenticating is NOT proof of a fresh image — the disk still holds
    // their data, so the destructive recreate must run regardless.
    const prevTenantRow = { ...keyRow, business_id: "biz-previous" };
    const reassignedRow = { ...keyRow, business_id: "biz-new" };
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        // initial-state check: running (no setup needed)
        .mockResolvedValueOnce(runningVm)
        // recreateOnce: pre-recreate state read, leave loop, waitRunning
        .mockResolvedValueOnce(runningVm)
        .mockResolvedValueOnce({ state: "recreating", ipv4: [] })
        .mockResolvedValue(runningVm)
    });
    const reassign = vi.fn().mockResolvedValue(reassignedRow);
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(prevTenantRow),
        reassignVpsSshKeyBusiness: reassign
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-new", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(reassign).toHaveBeenCalledWith("row-1", "biz-new");
    expect(res.sshKey).toEqual(reassignedRow);
    expect(deps.db!.insertVpsSshKey).not.toHaveBeenCalled();
    // The old tenant's data is wiped even though their key authenticated.
    expect(client.recreateVirtualMachine).toHaveBeenCalledTimes(1);
  });

  it("clears a stale host-key pin on the reused row after recreate (re-image = new host keys)", async () => {
    const pinnedRow = { ...keyRow, business_id: "biz-previous", host_key_fingerprint: "SHA256:stale" };
    const reassignedRow = { ...pinnedRow, business_id: "biz-new" };
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce(runningVm)
        .mockResolvedValueOnce(runningVm)
        .mockResolvedValueOnce({ state: "recreating", ipv4: [] })
        .mockResolvedValue(runningVm)
    });
    const clearPin = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(pinnedRow),
        reassignVpsSshKeyBusiness: vi.fn().mockResolvedValue(reassignedRow),
        updateVpsSshKeyHostKeyFingerprint: clearPin
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-new", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(clearPin).toHaveBeenCalledWith("row-1", null);
    // The returned row must also be unpinned so the orchestrator's
    // bootstrap TOFU-captures the fresh image's key.
    expect(res.sshKey.host_key_fingerprint).toBeNull();
  });

  it("recreates a stopped box even on a same-business retry", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        // initial-state check + preState: stopped
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        // recreateOnce: pre-state read (stopped), then running
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        .mockResolvedValue(runningVm)
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(client.recreateVirtualMachine).toHaveBeenCalledTimes(1);
  });

  it("recreates when a same-business box is running but has no IP yet", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        // initial-state check + preState: running, IP not surfaced yet
        .mockResolvedValueOnce({ state: "running", ipv4: [] })
        .mockResolvedValueOnce({ state: "running", ipv4: [] })
        // recreateOnce: pre-state read, leave loop, waitRunning
        .mockResolvedValueOnce({ state: "running", ipv4: [] })
        .mockResolvedValueOnce({ state: "recreating", ipv4: [] })
        .mockResolvedValue(runningVm)
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(client.recreateVirtualMachine).toHaveBeenCalledTimes(1);
  });

  it("freshly minted keys always recreate even when the box is already running", async () => {
    // Mint path (no reusable row): the box may be running with SOME key,
    // but not ours from a same-business retry — recreate must run.
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce(runningVm)
        .mockResolvedValueOnce(runningVm)
        .mockResolvedValueOnce({ state: "recreating", ipv4: [] })
        .mockResolvedValue(runningVm)
    });
    const deps = makeDeps(client);
    await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(client.recreateVirtualMachine).toHaveBeenCalledTimes(1);
  });

  it("mints + uploads + persists a fresh keypair when no active key row exists", async () => {
    const client = makeClient();
    const deps = makeDeps(client);
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "starter", virtualMachineId: 1800985 },
      deps
    );
    expect(deps.generateKeypair).toHaveBeenCalledWith("newcoworker-biz-1");
    expect(client.createPublicKey).toHaveBeenCalledWith(
      expect.stringMatching(/^newcoworker-biz-1-/),
      "ssh-ed25519 AAAA fresh"
    );
    const insertArg = (deps.db!.insertVpsSshKey as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(insertArg).toMatchObject({
      business_id: "biz-1",
      hostinger_vps_id: "1800985",
      hostinger_public_key_id: 9,
      public_key: "ssh-ed25519 AAAA fresh\n",
      private_key_pem: "FRESH-PEM",
      ssh_username: "root"
    });
    expect(res.hostingerBillingSubscriptionId).toBeNull();
  });

  it("rotates out an existing row missing its private key before minting a replacement", async () => {
    // Without the rotation the one-active-row-per-VPS partial unique index
    // would reject the replacement insert and abort the whole adopt.
    const rotate = vi.fn();
    const client = makeClient();
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn().mockResolvedValue({ ...keyRow, private_key_pem: "FRESH-PEM" }),
        getActiveVpsSshKey: vi.fn().mockResolvedValue({ ...keyRow, private_key_pem: "" }),
        rotateVpsSshKey: rotate
      }
    });
    await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(rotate).toHaveBeenCalledWith("row-1");
    expect(deps.generateKeypair).toHaveBeenCalled();
    expect(deps.db!.insertVpsSshKey).toHaveBeenCalled();
  });

  it("does not rotate anything when no active key row exists at all", async () => {
    const rotate = vi.fn();
    const client = makeClient();
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn().mockResolvedValue({ ...keyRow, private_key_pem: "FRESH-PEM" }),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(null),
        rotateVpsSshKey: rotate
      }
    });
    await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(rotate).not.toHaveBeenCalled();
    expect(deps.db!.insertVpsSshKey).toHaveBeenCalled();
  });

  it("runs setup first when the box is stuck in `initial`, then recreates when auth fails pre-recreate", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        // initial-state check
        .mockResolvedValueOnce({ state: "initial", ipv4: [] })
        // setup waitRunning: one not-ready poll (running but no IP), then ready
        .mockResolvedValueOnce({ state: "running", ipv4: [] })
        .mockResolvedValueOnce(runningVm)
        // pre-recreate state check (auth will fail → recreate path)
        .mockResolvedValueOnce(runningVm)
        // recreateOnce: pre-recreate state read
        .mockResolvedValueOnce(runningVm)
        // leave-state loop: box left `running` (rebuilding), then waitRunning ready
        .mockResolvedValueOnce({ state: "recreating", ipv4: [] })
        .mockResolvedValue(runningVm)
    });
    const deps = makeDeps(client, {
      // Same-business row from a prior partial adopt (box never left
      // `initial`): unlocks the pre-recreate auth probe, which then fails.
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      },
      sshAuthProbe: vi
        .fn()
        // pre-recreate check: 3 probes, all fail → recreate
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        // post-recreate: key attached
        .mockResolvedValue(true),
      pisQuiescentProbe: vi
        .fn()
        // exercise the quiescence wait loop once before going idle
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true)
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", vpsSize: "kvm2", virtualMachineId: 1800985 },
      deps
    );
    expect(client.setupVirtualMachine).toHaveBeenCalledTimes(1);
    const setupPayload = client.setupVirtualMachine.mock.calls[0][1];
    expect(setupPayload.hostname).toBe("nc-biz-1.newcoworker.com");
    expect(setupPayload.public_key_ids).toEqual([9]);
    expect(setupPayload.post_install_script_id).toBe(555);
    expect(setupPayload.install_monarx).toBe(false);
    expect(client.recreateVirtualMachine).toHaveBeenCalledTimes(1);
    expect(res.publicIp).toBe("1.2.3.4");
  });

  it("retries the recreate once when the key does not attach, succeeding on the second pass", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        // initial-state check: not initial, pre-recreate check: not running
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        // recreate #1: pre-state read, leave loop (state changed), waitRunning
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        .mockResolvedValueOnce(runningVm)
        .mockResolvedValueOnce(runningVm)
        // recreate #2 (retry): pre-state read, leave loop, waitRunning
        .mockResolvedValueOnce(runningVm)
        .mockResolvedValueOnce({ state: "recreating", ipv4: [] })
        .mockResolvedValue(runningVm)
    });
    const deps = makeDeps(client, {
      sshAuthProbe: vi
        .fn()
        // recreate #1 probes: all 3 fail
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        // recreate #2 probes: first succeeds
        .mockResolvedValue(true)
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(client.recreateVirtualMachine).toHaveBeenCalledTimes(2);
    expect(res.publicIp).toBe("1.2.3.4");
  });

  it("throws when the key still does not attach after the recreate retry", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        // both recreates: pre-state stopped, then running
        .mockResolvedValue(runningVm)
    });
    const deps = makeDeps(client, { sshAuthProbe: vi.fn().mockResolvedValue(false) });
    await expect(
      adoptVpsForBusiness(
        { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
        deps
      )
    ).rejects.toThrow(/SSH key still not attached after recreate retry/);
    expect(client.recreateVirtualMachine).toHaveBeenCalledTimes(2);
  });

  it("throws when the VM enters a terminal state during setup", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce({ state: "initial", ipv4: [] })
        .mockResolvedValueOnce({ state: "error", ipv4: [] })
    });
    const deps = makeDeps(client);
    await expect(
      adoptVpsForBusiness(
        { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
        deps
      )
    ).rejects.toThrow(/terminal state=error during setup/);
  });

  it("throws when the VM never reaches running within the ready timeout", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce({ state: "initial", ipv4: [] })
        .mockResolvedValue({ state: "starting", ipv4: [] })
    });
    const deps = makeDeps(client);
    await expect(
      adoptVpsForBusiness(
        {
          businessId: "biz-1",
          tier: "standard",
          virtualMachineId: 1800985,
          pollIntervalMs: 10_000,
          readyTimeoutMs: 25_000
        },
        deps
      )
    ).rejects.toThrow(/not running after 25000ms in setup/);
  });

  it("gives up waiting for the VM to leave its pre-recreate state after the leave deadline", async () => {
    // The VM reports `running` before recreate and keeps reporting `running`
    // (the transition was missed) — after 3 minutes the loop warns + assumes
    // the transition happened; waitRunning then accepts the running VM.
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        .mockResolvedValueOnce(runningVm)
        .mockResolvedValue(runningVm)
    });
    const deps = makeDeps(client, {
      sshAuthProbe: vi.fn().mockResolvedValue(true)
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(client.recreateVirtualMachine).toHaveBeenCalledTimes(1);
    expect(res.publicIp).toBe("1.2.3.4");
  });

  it("proceeds after the post-install quiescence wait times out", async () => {
    const client = makeClient();
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      },
      pisQuiescentProbe: vi.fn().mockResolvedValue(false)
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(res.publicIp).toBe("1.2.3.4");
    expect(deps.pisQuiescentProbe).toHaveBeenCalled();
  });

  it("continues when Monarx install fails and when the billing lookup throws", async () => {
    const client = makeClient({
      installMonarx: vi.fn().mockRejectedValue(new Error("monarx down")),
      listBillingSubscriptions: vi.fn().mockRejectedValue(new Error("billing down"))
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(res.hostingerBillingSubscriptionId).toBeNull();
  });

  it("stringifies non-Error throwables from the Monarx and billing lookups", async () => {
    const client = makeClient({
      installMonarx: vi.fn().mockRejectedValue("monarx string failure"),
      listBillingSubscriptions: vi.fn().mockRejectedValue("billing string failure")
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(res.hostingerBillingSubscriptionId).toBeNull();
  });

  it("falls back to the module-level DB accessors when deps.db omits overrides", async () => {
    moduleGetActiveVpsSshKey.mockResolvedValueOnce(keyRow);
    const client = makeClient();
    const deps = makeDeps(client, { db: {} });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(moduleGetActiveVpsSshKey).toHaveBeenCalledWith("1800985");
    // Reuse path — the fallback insert must never fire.
    expect(moduleInsertVpsSshKey).not.toHaveBeenCalled();
    expect(res.publicIp).toBe("1.2.3.4");
  });

  it("returns null billing id when no subscription matches the VM", async () => {
    const client = makeClient({
      listBillingSubscriptions: vi
        .fn()
        .mockResolvedValue([{ id: "hsub-other", resource_id: "999" }])
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(res.hostingerBillingSubscriptionId).toBeNull();
    // With no billing id there is nothing to re-enable — the adopt logs a
    // loud follow-up instead (a pooled box left with auto-renew off lapses
    // at period end under the new tenant).
    expect(client.enableBillingAutoRenewal).not.toHaveBeenCalled();
  });

  it("leaves auto-renew OFF when the box is flagged never_renew (must lapse at period end)", async () => {
    // srv1632631 case: KVM8 hardware pooled under the kvm2 label whose
    // $73.99/mo renewal must never be paid for a kvm2-priced tenant — the
    // tenant gets migrated off before the paid period ends instead.
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ ...runningVm, subscription_id: "hsub-never" })
    });
    const getInventory = vi
      .fn()
      .mockResolvedValue({ vm_id: 1800985, never_renew: true, state: "assigned" });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow),
        getVpsInventoryByVmId: getInventory
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    // The adopt succeeds and still reports the billing id, but renewal was
    // deliberately NOT re-enabled.
    expect(res.hostingerBillingSubscriptionId).toBe("hsub-never");
    expect(getInventory).toHaveBeenCalledWith(1800985);
    expect(client.enableBillingAutoRenewal).not.toHaveBeenCalled();
  });

  it("re-enables renewal when the never_renew lookup fails — tenant safety wins over the flag", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ ...runningVm, subscription_id: "hsub-adopted" })
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow),
        getVpsInventoryByVmId: vi.fn().mockRejectedValue(new Error("inventory db down"))
      }
    });
    await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    // With the flag unknowable the box must not lapse under the tenant; the
    // posture cron re-checks the flag daily and surfaces any conflict.
    expect(client.enableBillingAutoRenewal).toHaveBeenCalledWith("hsub-adopted");
  });

  it("stringifies a non-Error never_renew lookup failure and still re-enables", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ ...runningVm, subscription_id: "hsub-adopted" })
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow),
        getVpsInventoryByVmId: vi.fn().mockRejectedValue("inventory string boom")
      }
    });
    await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(client.enableBillingAutoRenewal).toHaveBeenCalledWith("hsub-adopted");
  });

  it("re-enables billing auto-renew on the adopted box (pooled boxes are parked with it off)", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ ...runningVm, subscription_id: "hsub-adopted" })
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(client.enableBillingAutoRenewal).toHaveBeenCalledWith("hsub-adopted");
  });

  it("completes the adopt (with a loud log) when the auto-renew re-enable fails", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ ...runningVm, subscription_id: "hsub-adopted" }),
      enableBillingAutoRenewal: vi.fn().mockRejectedValue(new Error("billing api down"))
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    // The adopt itself still succeeds — the re-enable is an ops follow-up.
    expect(res.hostingerBillingSubscriptionId).toBe("hsub-adopted");
  });

  it("stringifies a non-Error throwable from the auto-renew re-enable", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ ...runningVm, subscription_id: "hsub-adopted" }),
      enableBillingAutoRenewal: vi.fn().mockRejectedValue("renew string failure")
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(res.hostingerBillingSubscriptionId).toBe("hsub-adopted");
  });

  it("resolves the billing id from the VM detail's subscription_id without touching the list", async () => {
    // Hostinger's subscriptions LIST stopped returning resource_id
    // (Jul 2026) — the VM detail endpoint is the reliable mapping.
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ ...runningVm, subscription_id: "hsub-vm-detail" })
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(res.hostingerBillingSubscriptionId).toBe("hsub-vm-detail");
    expect(client.listBillingSubscriptions).not.toHaveBeenCalled();
  });

  it("falls back to the subscriptions list when the VM detail's subscription_id is empty", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValue({ ...runningVm, subscription_id: "" }),
      listBillingSubscriptions: vi
        .fn()
        .mockResolvedValue([{ id: "hsub-list", resource_id: "1800985" }])
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(res.hostingerBillingSubscriptionId).toBe("hsub-list");
  });

  it("falls back to the subscriptions list when the VM detail read for billing throws", async () => {
    // The billing-time getVirtualMachine is the LAST detail read in the
    // skip-recreate flow: initial-state check, pre-recreate state check,
    // then billing. Fail only that final read.
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce(runningVm)
        .mockResolvedValueOnce(runningVm)
        .mockRejectedValueOnce(new Error("vm detail down")),
      listBillingSubscriptions: vi
        .fn()
        .mockResolvedValue([{ id: "hsub-list-2", resource_id: "1800985" }])
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(res.hostingerBillingSubscriptionId).toBe("hsub-list-2");
  });

  it("stringifies a non-Error throwable from the billing-time VM detail read", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce(runningVm)
        .mockResolvedValueOnce(runningVm)
        .mockRejectedValueOnce("vm detail string failure"),
      listBillingSubscriptions: vi.fn().mockResolvedValue([])
    });
    const deps = makeDeps(client, {
      db: {
        insertVpsSshKey: vi.fn(),
        getActiveVpsSshKey: vi.fn().mockResolvedValue(keyRow)
      }
    });
    const res = await adoptVpsForBusiness(
      { businessId: "biz-1", tier: "standard", virtualMachineId: 1800985 },
      deps
    );
    expect(res.hostingerBillingSubscriptionId).toBeNull();
  });

  it("sanitizes the business id when building the recreate hostname", async () => {
    const client = makeClient({
      getVirtualMachine: vi
        .fn()
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        .mockResolvedValueOnce({ state: "stopped", ipv4: [] })
        .mockResolvedValue(runningVm)
    });
    const deps = makeDeps(client);
    await adoptVpsForBusiness(
      {
        businessId: "0a1b2c3d-4e5f-6789-abcd-ef0123456789",
        tier: "standard",
        virtualMachineId: 1800985
      },
      deps
    );
    const payload = client.recreateVirtualMachine.mock.calls[0][1];
    // Dashes survive the sanitize; the label is clamped to 12 chars.
    expect(payload.hostname).toBe("nc-0a1b2c3d-4e5.newcoworker.com");
  });
});
