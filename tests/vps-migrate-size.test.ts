import { beforeEach, describe, expect, it, vi } from "vitest";

const { loggerWarnMock, loggerInfoMock, loggerErrorMock } = vi.hoisted(() => ({
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerErrorMock: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    warn: loggerWarnMock,
    info: loggerInfoMock,
    error: loggerErrorMock,
    debug: vi.fn()
  }
}));

import { migrateBusinessVpsSize, type MigrateVpsSizeDeps } from "@/lib/vps/migrate-size";
import type { BusinessRow } from "@/lib/db/businesses";
import type { SubscriptionRow } from "@/lib/db/subscriptions";
import type { VpsSshKeyRow } from "@/lib/db/vps-ssh-keys";

const BIZ = "11111111-2222-3333-4444-555555555555";

function bizRow(overrides: Partial<BusinessRow> = {}): BusinessRow {
  return {
    id: BIZ,
    name: "Amy's Bakery",
    owner_email: "amy@example.com",
    tier: "standard",
    status: "online",
    hostinger_vps_id: "1800985",
    created_at: "2026-06-01T00:00:00.000Z",
    vps_size: "kvm2",
    ...overrides
  } as BusinessRow;
}

function subRow(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    id: "sub-1",
    status: "active",
    hostinger_billing_subscription_id: "hbs-old",
    ...overrides
  } as SubscriptionRow;
}

function sshKeyRow(): VpsSshKeyRow {
  return {
    id: "key-1",
    business_id: BIZ,
    hostinger_vps_id: "1800985",
    private_key_pem: "PEM",
    public_key: "ssh-ed25519 AAAA",
    ssh_username: "root"
  } as VpsSshKeyRow;
}

type Vm = { id: number; state: string; ipv4?: Array<{ id: number; address: string }>; subscription_id?: string };

function makeDeps(overrides: Partial<MigrateVpsSizeDeps> = {}): MigrateVpsSizeDeps {
  const vms = new Map<number, Vm>([
    [1800985, { id: 1800985, state: "running", ipv4: [{ id: 1, address: "1.2.3.4" }], subscription_id: "hbs-old" }],
    [1900001, { id: 1900001, state: "running", ipv4: [{ id: 2, address: "5.6.7.8" }], subscription_id: "hbs-new" }]
  ]);
  return {
    getBusiness: vi.fn(async () => bizRow()),
    getSubscription: vi.fn(async () => subRow()),
    updateSubscription: vi.fn(async () => ({})),
    updateBusinessVpsSize: vi.fn(async () => undefined),
    getActiveVpsSshKey: vi.fn(async () => sshKeyRow()),
    hostinger: {
      getVirtualMachine: vi.fn(async (id: number) => {
        const vm = vms.get(id);
        if (!vm) throw new Error(`vm ${id} not found`);
        return vm as never;
      }),
      createSnapshot: vi.fn(async () => ({}) as never),
      stopVirtualMachine: vi.fn(async () => ({}) as never),
      listBillingSubscriptions: vi.fn(async () => [
        { id: "hbs-new", resource_id: "1900001" } as never
      ]),
      disableBillingAutoRenewal: vi.fn(async () => ({}))
    },
    backupBusinessData: vi.fn(async () => ({
      storagePath: "backups/biz.tgz",
      sizeBytes: 1024,
      sha256: "abc123"
    })),
    restoreBusinessData: vi.fn(async () => ({})),
    orchestrateProvisioning: vi.fn(async () => ({
      vpsId: "1900001",
      hostingerBillingSubscriptionId: "hbs-new"
    })),
    sendOpsEmail: vi.fn(async () => undefined),
    ...overrides
  };
}

const input = { businessId: BIZ, targetSize: "kvm4" as const, requestedBy: "brian@newcoworker.com" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("migrateBusinessVpsSize — guards", () => {
  it("fails at load when the business does not exist", async () => {
    const deps = makeDeps({ getBusiness: vi.fn(async () => null) });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out).toEqual({ ok: false, stage: "load", error: "business not found" });
    expect(deps.sendOpsEmail).not.toHaveBeenCalled();
  });

  it("refuses enterprise tenants", async () => {
    const deps = makeDeps({ getBusiness: vi.fn(async () => bizRow({ tier: "enterprise" })) });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("guard");
      expect(out.error).toContain("enterprise");
    }
  });

  it("refuses a no-op migration to the current effective size", async () => {
    const deps = makeDeps();
    const out = await migrateBusinessVpsSize({ ...input, targetSize: "kvm2" }, deps);
    expect(out).toEqual({ ok: false, stage: "guard", error: "business is already on kvm2" });
  });

  it("resolves an unpinned standard tenant as legacy kvm8 (deployed-box semantics)", async () => {
    const deps = makeDeps({ getBusiness: vi.fn(async () => bizRow({ vps_size: null })) });
    const out = await migrateBusinessVpsSize({ ...input, targetSize: "kvm8" }, deps);
    expect(out).toEqual({ ok: false, stage: "guard", error: "business is already on kvm8" });
  });
});

describe("migrateBusinessVpsSize — backup stage (fail-closed)", () => {
  it("aborts when the old VM has no resolvable IP", async () => {
    const deps = makeDeps({
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async () => ({ id: 1800985, state: "running", ipv4: [] }) as never)
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.stage).toBe("backup");
    expect(deps.orchestrateProvisioning).not.toHaveBeenCalled();
    // started email + failed email
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(expect.objectContaining({ phase: "started" }));
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(expect.objectContaining({ phase: "failed" }));
  });

  it("aborts when the old VM lookup itself throws (no IP resolvable)", async () => {
    const deps = makeDeps({
      hostinger: {
        ...makeDeps().hostinger,
        getVirtualMachine: vi.fn(async () => {
          throw new Error("hostinger 500");
        })
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.stage).toBe("backup");
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "migrate-size: old VM lookup failed",
      expect.objectContaining({ error: "hostinger 500" })
    );
  });

  it("aborts when there is no SSH key for the old box", async () => {
    const deps = makeDeps({ getActiveVpsSshKey: vi.fn(async () => null) });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("backup");
      expect(out.error).toContain("no active SSH key");
    }
  });

  it("aborts when the key row has no private key PEM", async () => {
    const deps = makeDeps({
      getActiveVpsSshKey: vi.fn(async () => ({ ...sshKeyRow(), private_key_pem: null }) as never)
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.stage).toBe("backup");
  });

  it("aborts when the tarball backup fails, leaving the old box untouched", async () => {
    const deps = makeDeps({
      backupBusinessData: vi.fn(async () => {
        throw new Error("ssh timeout");
      })
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("backup");
      expect(out.error).toContain("ssh timeout");
    }
    expect(deps.hostinger.stopVirtualMachine).not.toHaveBeenCalled();
    expect(deps.updateBusinessVpsSize).not.toHaveBeenCalled();
  });

  it("continues when the best-effort snapshot fails", async () => {
    const deps = makeDeps({
      hostinger: {
        ...makeDeps().hostinger,
        createSnapshot: vi.fn(async () => {
          throw new Error("snapshot quota");
        })
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("snapshot failed"),
      expect.objectContaining({ error: "snapshot quota" })
    );
  });

  it("passes the OLD box's key to the backup (not the per-business default lookup)", async () => {
    const deps = makeDeps();
    await migrateBusinessVpsSize(input, deps);
    expect(deps.getActiveVpsSshKey).toHaveBeenCalledWith("1800985");
    const backupCall = (deps.backupBusinessData as ReturnType<typeof vi.fn>).mock.calls[0];
    const lookup = backupCall[1]?.sshKeyLookup;
    await expect(lookup?.(BIZ)).resolves.toEqual(sshKeyRow());
  });
});

describe("migrateBusinessVpsSize — provision + pin", () => {
  it("fails at provision and leaves the pin unwritten", async () => {
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => {
        throw new Error("hostinger 402");
      })
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("provision");
      expect(out.error).toContain("hostinger 402");
    }
    expect(deps.updateBusinessVpsSize).not.toHaveBeenCalled();
    expect(deps.hostinger.stopVirtualMachine).not.toHaveBeenCalled();
  });

  it("pins the size only after provisioning succeeds", async () => {
    const deps = makeDeps();
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    expect(deps.updateBusinessVpsSize).toHaveBeenCalledWith(BIZ, "kvm4");
    expect(deps.orchestrateProvisioning).toHaveBeenCalledWith({
      businessId: BIZ,
      tier: "standard",
      vpsSize: "kvm4"
    });
  });
});

describe("migrateBusinessVpsSize — restore stage (fail-closed)", () => {
  it("fails when the new VM's IP cannot be resolved", async () => {
    const base = makeDeps();
    const deps = makeDeps({
      hostinger: {
        ...base.hostinger,
        getVirtualMachine: vi.fn(async (id: number) => {
          if (id === 1800985) {
            return { id, state: "running", ipv4: [{ id: 1, address: "1.2.3.4" }] } as never;
          }
          throw new Error("new vm lookup down");
        })
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("restore");
      expect(out.error).toContain("backups/biz.tgz");
    }
    expect(deps.hostinger.stopVirtualMachine).not.toHaveBeenCalled();
  });

  it("fails when the restore throws, keeping the old box running", async () => {
    const deps = makeDeps({
      restoreBusinessData: vi.fn(async () => {
        throw new Error("tar corrupt");
      })
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("restore");
      expect(out.error).toContain("tar corrupt");
    }
    expect(deps.hostinger.stopVirtualMachine).not.toHaveBeenCalled();
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
  });
});

describe("migrateBusinessVpsSize — billing repoint (fail-closed)", () => {
  it("fails when the repoint update throws, leaving the old box renewing", async () => {
    const deps = makeDeps({
      updateSubscription: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("billing");
      expect(out.error).toContain("RUNNING + RENEWING");
    }
    expect(deps.hostinger.stopVirtualMachine).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "migrate-size: billing repoint failed",
      expect.objectContaining({ error: "db down" })
    );
  });

  it("fails when the new billing id cannot be found anywhere", async () => {
    const base = makeDeps();
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => ({
        vpsId: "1900001",
        hostingerBillingSubscriptionId: null
      })),
      hostinger: {
        ...base.hostinger,
        getVirtualMachine: vi.fn(async (id: number) =>
          id === 1800985
            ? ({ id, state: "running", ipv4: [{ id: 1, address: "1.2.3.4" }], subscription_id: "hbs-old" } as never)
            : ({ id, state: "running", ipv4: [{ id: 2, address: "5.6.7.8" }] } as never)
        ),
        listBillingSubscriptions: vi.fn(async () => {
          throw new Error("billing api down");
        })
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.stage).toBe("billing");
    expect(deps.updateSubscription).not.toHaveBeenCalled();
  });

  it("falls back to the VM detail subscription_id, then the billing list", async () => {
    const base = makeDeps();
    // VM detail for the new box has no subscription_id → list lookup wins.
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => ({
        vpsId: "1900001",
        hostingerBillingSubscriptionId: null
      })),
      hostinger: {
        ...base.hostinger,
        getVirtualMachine: vi.fn(async (id: number) =>
          id === 1800985
            ? ({ id, state: "running", ipv4: [{ id: 1, address: "1.2.3.4" }], subscription_id: "hbs-old" } as never)
            : ({ id, state: "running", ipv4: [{ id: 2, address: "5.6.7.8" }] } as never)
        )
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    expect(deps.updateSubscription).toHaveBeenCalledWith("sub-1", {
      hostinger_billing_subscription_id: "hbs-new"
    });
  });

  it("uses the new VM detail's subscription_id when the orchestrator returned none", async () => {
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => ({
        vpsId: "1900001",
        hostingerBillingSubscriptionId: null
      }))
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    expect(deps.updateSubscription).toHaveBeenCalledWith("sub-1", {
      hostinger_billing_subscription_id: "hbs-new"
    });
  });

  it("skips the repoint entirely when there is no active subscription", async () => {
    const deps = makeDeps({ getSubscription: vi.fn(async () => subRow({ status: "canceled" })) });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    expect(deps.updateSubscription).not.toHaveBeenCalled();
  });
});

describe("migrateBusinessVpsSize — old-box teardown + completion", () => {
  it("stops the old box, disables auto-renew, and reports success", async () => {
    const deps = makeDeps();
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out).toEqual({
      ok: true,
      fromSize: "kvm2",
      toSize: "kvm4",
      oldVmId: 1800985,
      newVmId: "1900001",
      newVmIp: "5.6.7.8",
      oldBillingHandling: "auto-renew-disabled"
    });
    expect(deps.hostinger.stopVirtualMachine).toHaveBeenCalledWith(1800985);
    expect(deps.hostinger.disableBillingAutoRenewal).toHaveBeenCalledWith("hbs-old");
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "completed", detail: expect.stringContaining("srv1900001") })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "migrate-size: complete",
      expect.objectContaining({ fromSize: "kvm2", toSize: "kvm4", requestedBy: input.requestedBy })
    );
  });

  it("tolerates a failed stop and reports the auto-renew-disable failure as follow-up", async () => {
    const base = makeDeps();
    const deps = makeDeps({
      hostinger: {
        ...base.hostinger,
        stopVirtualMachine: vi.fn(async () => {
          throw new Error("already stopped");
        }),
        disableBillingAutoRenewal: vi.fn(async () => {
          throw new Error("hpanel 500");
        })
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.oldBillingHandling).toBe("auto-renew-disable-FAILED");
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "completed",
        detail: expect.stringContaining("FOLLOW-UP REQUIRED")
      })
    );
  });

  it("flags an unknown old billing id as still renewing", async () => {
    const base = makeDeps();
    const deps = makeDeps({
      getSubscription: vi.fn(async () =>
        subRow({ hostinger_billing_subscription_id: null })
      ),
      hostinger: {
        ...base.hostinger,
        getVirtualMachine: vi.fn(async (id: number) =>
          id === 1800985
            ? ({ id, state: "running", ipv4: [{ id: 1, address: "1.2.3.4" }] } as never)
            : ({ id, state: "running", ipv4: [{ id: 2, address: "5.6.7.8" }], subscription_id: "hbs-new" } as never)
        )
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.oldBillingHandling).toBe("billing-id-unknown-still-renewing");
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
  });

  it("handles a business with no recorded VM: no backup possible → fail-closed at backup", async () => {
    const deps = makeDeps({
      getBusiness: vi.fn(async () => bizRow({ hostinger_vps_id: null }))
    });
    const out = await migrateBusinessVpsSize(input, deps);
    // No old box means no IP and no key — the elective flow refuses rather
    // than silently provisioning a fresh box (that's what re-provision is for).
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.stage).toBe("backup");
  });

  it("stringifies non-Error failures (backup throwing a string)", async () => {
    const deps = makeDeps({
      backupBusinessData: vi.fn(async () => {
        throw "ssh string blowup";
      })
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toContain("ssh string blowup");
  });

  it("fails at restore when the new VM detail simply has no IP (no throw)", async () => {
    const base = makeDeps();
    const deps = makeDeps({
      hostinger: {
        ...base.hostinger,
        getVirtualMachine: vi.fn(async (id: number) =>
          id === 1800985
            ? ({ id, state: "running", ipv4: [{ id: 1, address: "1.2.3.4" }], subscription_id: "hbs-old" } as never)
            : ({ id, state: "running" } as never)
        )
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.stage).toBe("restore");
  });

  it("fails at billing when the billing list has no row for the new VM and nothing is known about the old sub", async () => {
    const base = makeDeps();
    const deps = makeDeps({
      getSubscription: vi.fn(async () => subRow({ hostinger_billing_subscription_id: null })),
      orchestrateProvisioning: vi.fn(async () => ({
        vpsId: "1900001",
        hostingerBillingSubscriptionId: null
      })),
      hostinger: {
        ...base.hostinger,
        getVirtualMachine: vi.fn(async (id: number) =>
          id === 1800985
            ? ({ id, state: "running", ipv4: [{ id: 1, address: "1.2.3.4" }] } as never)
            : ({ id, state: "running", ipv4: [{ id: 2, address: "5.6.7.8" }] } as never)
        ),
        listBillingSubscriptions: vi.fn(async () => [
          { id: "hbs-unrelated", resource_id: "999999" } as never
        ])
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("billing");
      expect(out.error).toContain("<unknown billing sub>");
      expect(out.error).toContain("look up resource_id=1900001");
    }
  });

  it("handles a non-numeric hostinger_vps_id the same way", async () => {
    const deps = makeDeps({
      getBusiness: vi.fn(async () => bizRow({ hostinger_vps_id: "not-a-number" }))
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.stage).toBe("backup");
    expect(deps.hostinger.getVirtualMachine).not.toHaveBeenCalled();
  });
});
