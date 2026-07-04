import { describe, expect, it, vi } from "vitest";

// Module-level fallbacks for when deps.db omits an override — the fallback
// import must not hit a real database.
const moduleGetActiveVpsSshKey = vi.fn();
const moduleInsertVpsSshKey = vi.fn();
const moduleReassignVpsSshKeyBusiness = vi.fn();
const moduleRotateVpsSshKey = vi.fn();
vi.mock("@/lib/db/vps-ssh-keys", () => ({
  getActiveVpsSshKey: (...args: unknown[]) => moduleGetActiveVpsSshKey(...args),
  insertVpsSshKey: (...args: unknown[]) => moduleInsertVpsSshKey(...args),
  reassignVpsSshKeyBusiness: (...args: unknown[]) => moduleReassignVpsSshKeyBusiness(...args),
  rotateVpsSshKey: (...args: unknown[]) => moduleRotateVpsSshKey(...args)
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

  it("reassigns the reused key row when it still points at the previous tenant", async () => {
    // Business-scoped lookups (backup/restore, admin console) resolve keys
    // via business_id — a row left on the old tenant would strand the new
    // one. The adopt must move the row to the adopting business.
    const prevTenantRow = { ...keyRow, business_id: "biz-previous" };
    const reassignedRow = { ...keyRow, business_id: "biz-new" };
    const client = makeClient();
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
