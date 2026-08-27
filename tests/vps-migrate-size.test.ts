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
import { HQ_BUSINESS_ID } from "@/lib/vps/shared-hardware";
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
    billing_period: "biennial",
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
    retireVpsSshKeysForVps: vi.fn(async () => 1),
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
    enqueueProvisioningJob: vi.fn(async () => undefined),
    runProvisioningJob: vi.fn(async (job, jobDeps) => {
      const tier =
        job.tier === "starter" || job.tier === "enterprise" ? job.tier : "standard";
      const out = await jobDeps.orchestrate({
        businessId: job.business_id,
        tier,
        vpsSize: (job.vps_size as "kvm1" | "kvm2" | "kvm4" | "kvm8" | null) ?? "kvm4",
        billingPeriod:
          job.billing_period === "monthly" ||
          job.billing_period === "annual" ||
          job.billing_period === "biennial"
            ? job.billing_period
            : null,
        suppressOwnerNotify: job.suppress_owner_notify === true ? true : undefined,
        skipPoolAdopt: job.skip_pool_adopt === true ? true : undefined
      });
      // Mirrors the real runProvisioningJob, which returns the orchestrate
      // result unchanged.
      return {
        hostingerBillingSubscriptionId: out.hostingerBillingSubscriptionId,
        vpsId: out.vpsId ?? "1900001",
        deploySucceeded: out.deploySucceeded
      };
    }),
    markProvisioningJobOutcome: vi.fn(async () => undefined),
    sendOpsEmail: vi.fn(async () => undefined),
    ...overrides
  };
}

const input = { businessId: BIZ, targetSize: "kvm4" as const, requestedBy: "brian@newcoworker.com" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("migrateBusinessVpsSize, guards", () => {
  it("fails at load when the business does not exist", async () => {
    const deps = makeDeps({ getBusiness: vi.fn(async () => null) });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out).toEqual({ ok: false, stage: "load", error: "business not found" });
    expect(deps.sendOpsEmail).not.toHaveBeenCalled();
  });

  it("fails closed for non-hostinger tenants (BYOS/OVH boxes are not Hostinger-migratable)", async () => {
    const deps = makeDeps({
      getBusiness: vi.fn(async () =>
        bizRow({ tier: "enterprise", vps_provider: "byos" } as never)
      )
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("guard");
      expect(out.error).toContain("vps_provider=byos");
      expect(out.error).toContain("Hostinger-only");
    }
    expect(deps.orchestrateProvisioning).not.toHaveBeenCalled();
  });

  it("fails closed for residency tenants (box datastore would be stranded)", async () => {
    const deps = makeDeps({
      getBusiness: vi.fn(async () =>
        bizRow({ tier: "enterprise", data_residency_mode: "vps" } as never)
      )
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("guard");
      expect(out.error).toContain("residency");
      expect(out.error).toContain("residency-restore");
    }
    expect(deps.orchestrateProvisioning).not.toHaveBeenCalled();
  });

  it("fails closed on co-tenanted hardware (teardown would destroy the co-tenant)", async () => {
    // The admin panel deliberately has no ack: coordinating the co-tenant's
    // redeploy comes first, then the debug script with --shared-box-ack.
    const deps = makeDeps({
      getBusiness: vi.fn(async () => bizRow({ id: HQ_BUSINESS_ID } as never))
    });
    const out = await migrateBusinessVpsSize({ ...input, businessId: HQ_BUSINESS_ID }, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("guard");
      expect(out.error).toContain("shared hardware");
      expect(out.error).toContain("jobarms-render");
      expect(out.error).toContain("--shared-box-ack");
    }
    expect(deps.orchestrateProvisioning).not.toHaveBeenCalled();
  });

  it("migrates enterprise tenants, passing the real tier to provisioning", async () => {
    // Enterprise became provisionable (Jul 2026): the old "enterprise is
    // custom" guard is gone, and the tenant's REAL tier flows through so
    // the orchestrator resolves the enterprise box profile itself.
    const deps = makeDeps({ getBusiness: vi.fn(async () => bizRow({ tier: "enterprise" })) });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    expect(deps.orchestrateProvisioning).toHaveBeenCalledWith(
      expect.objectContaining({ tier: "enterprise", vpsSize: "kvm4" })
    );
  });

  it("retires the OLD box's key row at teardown, not the new one", async () => {
    // The root cause of the stale-row pile-up: nothing rotated the old row
    // when a tenant moved to different hardware, so every fleet sweep kept
    // SSHing into dead boxes ("4/9 succeeded", 2026-08-14).
    const deps = makeDeps();
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    expect(deps.retireVpsSshKeysForVps).toHaveBeenCalledWith("1800985");
    expect(deps.retireVpsSshKeysForVps).toHaveBeenCalledTimes(1);
  });

  it("retires the old key row only after the backup read it", async () => {
    // Ordering is load-bearing: the backup SSHes into the old box with the
    // key this call retires, so retiring first would break the migration.
    const order: string[] = [];
    const deps = makeDeps();
    (deps.backupBusinessData as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("backup");
      return { storagePath: "p", sizeBytes: 1, sha256: "s" };
    });
    (deps.retireVpsSshKeysForVps as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push("retire");
      return 1;
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    expect(order).toEqual(["backup", "retire"]);
  });

  it("pools the old box with never_renew at teardown, so no assigned row strands", async () => {
    // The teardown used to stop the VM and disable renewal but never touch
    // vps_inventory, leaving the old row `assigned` to a business that no
    // longer points at it. That shape is invisible to every monitor: billing
    // posture direction 1 checks the pointed-at box, direction 2 and the
    // reaper walk `available` only, and untracked_vm needs NO row at all.
    const releaseVpsToPool = vi.fn(async () => undefined);
    const markVpsNeverRenew = vi.fn(async () => undefined);
    const deps = makeDeps({ releaseVpsToPool, markVpsNeverRenew });
    // The billing list carries the OLD sub too, so the pool row gets its
    // paid-through stamped instead of waiting for the daily posture refresh.
    (deps.hostinger.listBillingSubscriptions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: "hbs-new", resource_id: "1900001" },
      { id: "hbs-old", resource_id: "1800985", next_billing_at: "2026-09-30T00:00:00Z" }
    ]);
    const res = await migrateBusinessVpsSize(input, deps);
    expect(res.ok).toBe(true);
    expect(releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({
        vmId: 1800985,
        plan: "kvm2",
        hostingerBillingSubscriptionId: "hbs-old",
        expiresAt: "2026-09-30T00:00:00Z",
        notes: expect.stringContaining(BIZ)
      })
    );
    // Flag AFTER pooling, mirroring the term sweep: the old box must lapse
    // unless a plan-matched adopt later revives it (#1661).
    expect(markVpsNeverRenew).toHaveBeenCalledWith(1800985);
  });

  it("still completes the migration when the pool return fails (follow-up noted)", async () => {
    const releaseVpsToPool = vi.fn(async () => {
      throw new Error("inventory down");
    });
    const markVpsNeverRenew = vi.fn(async () => undefined);
    const sendOpsEmail = vi.fn(async () => undefined);
    const deps = makeDeps({ releaseVpsToPool, markVpsNeverRenew, sendOpsEmail });
    const res = await migrateBusinessVpsSize(input, deps);
    expect(res.ok).toBe(true);
    // never_renew is only meaningful on a pooled row; skipped when pooling failed.
    expect(markVpsNeverRenew).not.toHaveBeenCalled();
    const calls = sendOpsEmail.mock.calls as unknown as Array<[{ phase: string; detail: string }]>;
    const completed = calls.find((c) => c[0].phase === "completed");
    expect(completed?.[0].detail).toContain("vps_inventory");
  });

  it("still completes when the never_renew mark fails after a successful pool return", async () => {
    const releaseVpsToPool = vi.fn(async () => undefined);
    const markVpsNeverRenew = vi.fn(async () => {
      throw new Error("flag write down");
    });
    const sendOpsEmail = vi.fn(async () => undefined);
    const deps = makeDeps({ releaseVpsToPool, markVpsNeverRenew, sendOpsEmail });
    const res = await migrateBusinessVpsSize(input, deps);
    expect(res.ok).toBe(true);
    const calls = sendOpsEmail.mock.calls as unknown as Array<[{ phase: string; detail: string }]>;
    const completed = calls.find((c) => c[0].phase === "completed");
    expect(completed?.[0].detail).toContain("never_renew=false");
  });

  it("pools without an expiry stamp when the billing list is unavailable", async () => {
    const releaseVpsToPool = vi.fn(async () => undefined);
    const markVpsNeverRenew = vi.fn(async () => undefined);
    const deps = makeDeps({ releaseVpsToPool, markVpsNeverRenew });
    (deps.hostinger.listBillingSubscriptions as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("hostinger 5xx")
    );
    const res = await migrateBusinessVpsSize(input, deps);
    expect(res.ok).toBe(true);
    // releaseVpsToPool preserves the row's existing expires_at when the key
    // is omitted, so the daily posture refresh backfills it.
    const arg = releaseVpsToPool.mock.calls[0][0] as Record<string, unknown>;
    expect("expiresAt" in arg).toBe(false);
    expect(markVpsNeverRenew).toHaveBeenCalledWith(1800985);
  });

  it("still completes the migration when retiring the old key row fails", async () => {
    // A stale bookkeeping row must never fail an otherwise-good cutover.
    const deps = makeDeps({
      retireVpsSshKeysForVps: vi.fn(async () => {
        throw new Error("postgrest down");
      })
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
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

describe("migrateBusinessVpsSize, backup stage (fail-closed)", () => {
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

describe("migrateBusinessVpsSize, provision + pin", () => {
  it("fails at provision and leaves the pin unwritten", async () => {
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => {
        throw new Error("hostinger 402");
      }),
      tryRecoverDeployCompleteNewBox: vi.fn(async () => null)
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("provision");
      expect(out.error).toContain("hostinger 402");
    }
    expect(deps.updateBusinessVpsSize).not.toHaveBeenCalled();
    expect(deps.hostinger.stopVirtualMachine).not.toHaveBeenCalled();
    expect(deps.markProvisioningJobOutcome).toHaveBeenCalledWith(
      BIZ,
      "failed",
      expect.stringContaining("hostinger 402")
    );
  });

  it("continues cutover when provision throws but new box is deploy-complete", async () => {
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => {
        throw new Error("vercel killed mid-deploy");
      }),
      tryRecoverDeployCompleteNewBox: vi.fn(async (_input, probeDeps) => {
        await probeDeps.getVirtualMachine?.(1900001);
        return {
          vpsId: "1900001",
          hostingerBillingSubscriptionId: "hbs-new"
        };
      })
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    expect(deps.restoreBusinessData).toHaveBeenCalled();
    expect(deps.updateBusinessVpsSize).toHaveBeenCalledWith(BIZ, "kvm4");
    expect(deps.hostinger.stopVirtualMachine).toHaveBeenCalledWith(1800985);
  });

  it("fails when provision returns no vpsId", async () => {
    const deps = makeDeps({
      runProvisioningJob: vi.fn(async () => ({
        hostingerBillingSubscriptionId: "hbs-new",
        vpsId: ""
      })),
      tryRecoverDeployCompleteNewBox: vi.fn(async () => null)
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("provision");
      expect(out.error).toMatch(/no vpsId/);
    }
  });
  // Step 3 is documented fail-closed, but orchestrate hands back a normal
  // result on a failed deploy, so without a success flag the cutover restored
  // onto a dead box and then stopped the healthy old one.
  it("fails at provision when the deploy failed, leaving the old box serving", async () => {
    const deps = makeDeps({
      orchestrateProvisioning: vi.fn(async () => ({
        vpsId: "1900001",
        hostingerBillingSubscriptionId: "hbs-new",
        deploySucceeded: false
      }))
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("provision");
      expect(out.error).toMatch(/deploy failed/);
    }
    expect(deps.hostinger.stopVirtualMachine).not.toHaveBeenCalled();
    expect(deps.hostinger.disableBillingAutoRenewal).not.toHaveBeenCalled();
    expect(deps.restoreBusinessData).not.toHaveBeenCalled();
  });

  it("pins the size only after provisioning succeeds", async () => {
    const deps = makeDeps();
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    expect(deps.updateBusinessVpsSize).toHaveBeenCalledWith(BIZ, "kvm4");
    expect(deps.orchestrateProvisioning).toHaveBeenCalledWith({
      businessId: BIZ,
      // The replacement box is bought at the tenant's committed term.
      billingPeriod: "biennial",
      tier: "standard",
      vpsSize: "kvm4",
      suppressOwnerNotify: true,
      // Derived from the wall clock (route budget minus time already spent),
      // so pin the shape, not the value. remainingDeployDeadlineMs is covered
      // exactly in tests/provisioning-deploy-budget.test.ts.
      deployBudgetStartedAtMs: expect.any(Number)
    });
    expect(deps.markProvisioningJobOutcome).toHaveBeenCalledWith(BIZ, "succeeded");
  });

  it("still completes when the post-cutover ledger mark throws", async () => {
    const deps = makeDeps({
      markProvisioningJobOutcome: vi.fn(async () => {
        throw new Error("ledger down");
      })
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("markProvisioningJobOutcome"),
      expect.objectContaining({ error: "ledger down" })
    );

    const deps2 = makeDeps({
      markProvisioningJobOutcome: vi.fn(async () => {
        throw "ledger string fail";
      })
    });
    const out2 = await migrateBusinessVpsSize(input, deps2);
    expect(out2.ok).toBe(true);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("markProvisioningJobOutcome"),
      expect.objectContaining({ error: "ledger string fail" })
    );
  });
});

describe("migrateBusinessVpsSize, restore stage (fail-closed)", () => {
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
    expect(deps.markProvisioningJobOutcome).toHaveBeenCalledWith(
      BIZ,
      "failed",
      expect.stringContaining("cannot resolve")
    );
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
    expect(deps.markProvisioningJobOutcome).toHaveBeenCalledWith(
      BIZ,
      "failed",
      expect.stringContaining("tar corrupt")
    );
  });

  it("still returns restore failure when the failed-ledger mark throws", async () => {
    const deps = makeDeps({
      restoreBusinessData: vi.fn(async () => {
        throw new Error("tar corrupt");
      }),
      markProvisioningJobOutcome: vi.fn(async () => {
        throw new Error("ledger down");
      })
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("markProvisioningJobOutcome(failed)"),
      expect.objectContaining({ error: "ledger down" })
    );

    const deps2 = makeDeps({
      restoreBusinessData: vi.fn(async () => {
        throw "tar string fail";
      }),
      markProvisioningJobOutcome: vi.fn(async () => {
        throw "ledger string fail";
      })
    });
    const out2 = await migrateBusinessVpsSize(input, deps2);
    expect(out2.ok).toBe(false);
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining("markProvisioningJobOutcome(failed)"),
      expect.objectContaining({ error: "ledger string fail" })
    );
  });
});

describe("migrateBusinessVpsSize, billing repoint (fail-closed)", () => {
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
    expect(deps.markProvisioningJobOutcome).toHaveBeenCalledWith(
      BIZ,
      "failed",
      expect.stringContaining("RUNNING + RENEWING")
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

describe("migrateBusinessVpsSize, old-box teardown + completion", () => {
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

  it("resolves the old billing id via the billing list when the sub row and VM detail have none", async () => {
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
        ),
        listBillingSubscriptions: vi.fn(async () => [
          { id: "hbs-old-listed", resource_id: "1800985" } as never
        ])
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.oldBillingHandling).toBe("auto-renew-disabled");
    expect(deps.hostinger.disableBillingAutoRenewal).toHaveBeenCalledWith("hbs-old-listed");
  });

  it("survives the old-billing list fallback throwing (still-renewing outcome, migration completes)", async () => {
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
        ),
        listBillingSubscriptions: vi.fn(async () => {
          throw new Error("hostinger list down");
        })
      }
    });
    const out = await migrateBusinessVpsSize(input, deps);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.oldBillingHandling).toBe("billing-id-unknown-still-renewing");
  });

  it("handles a business with no recorded VM: no backup possible → fail-closed at backup", async () => {
    const deps = makeDeps({
      getBusiness: vi.fn(async () => bizRow({ hostinger_vps_id: null }))
    });
    const out = await migrateBusinessVpsSize(input, deps);
    // No old box means no IP and no key, the elective flow refuses rather
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
