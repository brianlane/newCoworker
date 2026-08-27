import { describe, expect, it, vi, beforeEach } from "vitest";

const { warn, error, info } = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn, error, info, debug: vi.fn() }
}));

import {
  ORPHAN_SWEEP_MIN_AGE_MS,
  isNeverSetUp,
  isOldEnoughToSweep,
  orphanPoolBlocker,
  runOrphanSweep,
  type OrphanSweepDeps
} from "@/lib/vps/orphan-sweep";
import { sharedHardwareForVm } from "@/lib/vps/shared-hardware";

const NOW = new Date("2026-07-31T20:00:00.000Z");
/** Older than the 6h floor: the shape the sweep is meant to catch. */
const OLD = "2026-07-05T04:41:31.000Z";

function vm(overrides: Record<string, unknown> = {}) {
  return {
    id: 1806114,
    state: "initial",
    plan: "KVM 1",
    hostname: "srv1806114.hstgr.cloud",
    created_at: OLD,
    template: null,
    subscription_id: "sub-orphan",
    ipv4: [],
    ...overrides
  } as never;
}

function billingSub(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub-orphan",
    status: "non_renewing",
    is_auto_renewed: false,
    expires_at: "2026-08-05T04:41:30.000Z",
    next_billing_at: null,
    total_price: 1949,
    renewal_price: 1949,
    ...overrides
  } as never;
}

function makeDeps(overrides: Partial<OrphanSweepDeps> = {}): OrphanSweepDeps {
  return {
    listVirtualMachines: vi.fn(async () => [vm()]),
    listVpsInventory: vi.fn(async () => []),
    listBusinesses: vi.fn(async () => []),
    listBillingSubscriptions: vi.fn(async () => [billingSub()]),
    getVirtualMachine: vi.fn(async () => vm()),
    disableBillingAutoRenewal: vi.fn(async () => ({})),
    releaseVpsToPool: vi.fn(async () => "pooled" as const),
    sendOpsEmail: vi.fn(async () => undefined),
    ...overrides
  } as OrphanSweepDeps;
}

describe("orphan sweep helpers", () => {
  it("isNeverSetUp only accepts an initial box with no template", () => {
    expect(isNeverSetUp({ state: "initial", template: null } as never)).toBe(true);
    expect(isNeverSetUp({ state: "running", template: null } as never)).toBe(false);
    expect(
      isNeverSetUp({ state: "initial", template: { name: "Ubuntu" } } as never)
    ).toBe(false);
  });

  // The mirror of reconcile-orphans' recency CEILING. A daily sweep needs a
  // FLOOR so it cannot take a box from a provision that is still running and
  // about to write its inventory row.
  it("isOldEnoughToSweep enforces a floor, not a ceiling", () => {
    const nowMs = NOW.getTime();
    expect(isOldEnoughToSweep(OLD, nowMs)).toBe(true);
    expect(isOldEnoughToSweep(new Date(nowMs - 60_000).toISOString(), nowMs)).toBe(false);
    expect(
      isOldEnoughToSweep(new Date(nowMs - ORPHAN_SWEEP_MIN_AGE_MS).toISOString(), nowMs)
    ).toBe(true);
    expect(isOldEnoughToSweep(null, nowMs)).toBe(false);
    expect(isOldEnoughToSweep("not-a-date", nowMs)).toBe(false);
  });

  it("orphanPoolBlocker lets a never-set-up, unreferenced box through", () => {
    expect(orphanPoolBlocker(vm(), new Set())).toBeNull();
  });

  // The gate that matters most: inventory forgetting a box does not make it
  // ownerless. A business row pointing at it means it is a tenant's.
  it("orphanPoolBlocker refuses a box a business still points at", () => {
    expect(orphanPoolBlocker(vm(), new Set([1806114]))).toMatch(/a business still points/);
  });

  it("orphanPoolBlocker refuses a box that was set up", () => {
    expect(orphanPoolBlocker(vm({ state: "running" }), new Set())).toMatch(/may be serving/);
    expect(
      orphanPoolBlocker(vm({ template: { name: "Ubuntu 24.04" } }), new Set())
    ).toMatch(/may be serving/);
  });

  // Keyed by VM id. An earlier draft called sharedHardwareFor(), which takes a
  // businessId, so this guard silently never fired.
  it("orphanPoolBlocker refuses shared hardware by VM id", () => {
    const hq = sharedHardwareForVm(1806097);
    expect(hq, "HQ's shared box should be in the registry").toBeTruthy();
    expect(orphanPoolBlocker(vm({ id: 1806097 }), new Set())).toMatch(
      /runs on shared hardware here/
    );
  });

  it("orphanPoolBlocker refuses an unrecognized plan", () => {
    expect(orphanPoolBlocker(vm({ plan: "SOMETHING NEW" }), new Set())).toMatch(
      /unrecognized plan/
    );
    expect(orphanPoolBlocker(vm({ plan: null }), new Set())).toMatch(/unrecognized plan/);
  });
});

describe("runOrphanSweep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pools a never-set-up untracked box and stamps its paid-through", async () => {
    const deps = makeDeps();
    const result = await runOrphanSweep(deps, { now: NOW });

    expect(result).toMatchObject({ checked: 1, orphaned: 1, pooled: 1, reported: 0 });
    expect(deps.releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({
        vmId: 1806114,
        plan: "kvm1",
        hostingerBillingSubscriptionId: "sub-orphan",
        // Without this, claimAvailableVps reads the runway as unknown and
        // could hand a nearly-lapsed box to a new tenant.
        expiresAt: "2026-08-05T04:41:30.000Z"
      })
    );
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(
      expect.objectContaining({ checkedVms: 1, dryRun: false })
    );
  });

  // Auto-renew off is what makes "pooled" honest: releaseVpsToPool documents a
  // pooled box as lapsing at period end, so a still-renewing one would bill
  // forever while claiming otherwise.
  it("disables auto-renew before pooling when the box is still renewing", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [
        billingSub({ status: "active", is_auto_renewed: true, next_billing_at: "2026-08-05T04:41:30.000Z", expires_at: null })
      ])
    });
    const result = await runOrphanSweep(deps, { now: NOW });

    expect(deps.disableBillingAutoRenewal).toHaveBeenCalledWith("sub-orphan");
    expect(result.pooled).toBe(1);
    expect(result.findings[0].detail).toMatch(/auto-renew disabled/);
  });

  it("leaves an already non-renewing box alone", async () => {
    const deps = makeDeps();
    const result = await runOrphanSweep(deps, { now: NOW });
    expect(deps.disableBillingAutoRenewal).not.toHaveBeenCalled();
    expect(result.findings[0].detail).toMatch(/auto-renew already-off/);
  });

  it("does not pool when auto-renew could not be disabled", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [
        billingSub({ status: "active", is_auto_renewed: true })
      ]),
      disableBillingAutoRenewal: vi.fn(async () => {
        throw new Error("hostinger 500");
      })
    });
    const result = await runOrphanSweep(deps, { now: NOW });

    expect(deps.releaseVpsToPool).not.toHaveBeenCalled();
    expect(result).toMatchObject({ pooled: 0, reported: 1 });
    expect(result.findings[0].detail).toMatch(/could not disable auto-renew/);
  });

  it("skips boxes that already have an inventory row", async () => {
    const deps = makeDeps({ listVpsInventory: vi.fn(async () => [{ vm_id: 1806114 }]) });
    const result = await runOrphanSweep(deps, { now: NOW });
    expect(result).toMatchObject({ checked: 1, orphaned: 0, pooled: 0 });
    expect(deps.sendOpsEmail).not.toHaveBeenCalled();
  });

  // The floor doing its job: a provision that purchased minutes ago has not
  // written its row yet, and must not have its box taken.
  it("ignores a box young enough to belong to an in-flight provision", async () => {
    const fresh = new Date(NOW.getTime() - 60_000).toISOString();
    const deps = makeDeps({
      listVirtualMachines: vi.fn(async () => [vm({ created_at: fresh })])
    });
    const result = await runOrphanSweep(deps, { now: NOW });
    expect(result).toMatchObject({ orphaned: 0, pooled: 0 });
    expect(deps.releaseVpsToPool).not.toHaveBeenCalled();
  });

  it("reports a running untracked box instead of pooling it", async () => {
    const running = vm({ state: "running", template: { name: "Ubuntu 24.04 with Docker" } });
    const deps = makeDeps({
      listVirtualMachines: vi.fn(async () => [running]),
      getVirtualMachine: vi.fn(async () => running)
    });
    const result = await runOrphanSweep(deps, { now: NOW });

    expect(result).toMatchObject({ pooled: 0, reported: 1 });
    expect(deps.releaseVpsToPool).not.toHaveBeenCalled();
    expect(deps.disableBillingAutoRenewal).not.toHaveBeenCalled();
  });

  it("reports a box a business still references", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [
        { id: "biz-1", name: "Someone", hostinger_vps_id: "1806114" } as never
      ])
    });
    const result = await runOrphanSweep(deps, { now: NOW });
    expect(result).toMatchObject({ pooled: 0, reported: 1 });
    expect(deps.releaseVpsToPool).not.toHaveBeenCalled();
  });

  // A dry run's poolable boxes are NOT awaiting a human. Counting them as
  // `reported` made a clean dry run send an ACTION REQUIRED digest about boxes
  // the live sweep would have handled by itself (Bugbot on #1061).
  it("changes nothing on a dry run and does not call it an action item", async () => {
    const deps = makeDeps();
    const result = await runOrphanSweep(deps, { now: NOW, dryRun: true });

    expect(deps.releaseVpsToPool).not.toHaveBeenCalled();
    expect(deps.disableBillingAutoRenewal).not.toHaveBeenCalled();
    expect(result).toMatchObject({ pooled: 0, wouldPool: 1, reported: 0 });
    expect(result.findings[0].kind).toBe("would_pool");
    expect(result.findings[0].detail).toMatch(/dry run: would pool/);
    expect(deps.sendOpsEmail).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  // A dry run still has to surface the boxes it would refuse to touch.
  it("still reports genuinely stuck boxes on a dry run", async () => {
    const running = vm({ state: "running", template: { name: "Ubuntu 24.04 with Docker" } });
    const deps = makeDeps({
      listVirtualMachines: vi.fn(async () => [running]),
      getVirtualMachine: vi.fn(async () => running)
    });
    const result = await runOrphanSweep(deps, { now: NOW, dryRun: true });
    expect(result).toMatchObject({ pooled: 0, wouldPool: 0, reported: 1 });
  });

  it("falls back to the list payload when the detail lookup fails", async () => {
    const deps = makeDeps({
      getVirtualMachine: vi.fn(async () => {
        throw new Error("hostinger 503");
      })
    });
    const result = await runOrphanSweep(deps, { now: NOW });
    expect(result.pooled).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "orphan sweep: VM detail lookup failed (using list payload)",
      expect.objectContaining({ vmId: 1806114 })
    );
  });

  it("resolves billing by resource_id when the VM carries no subscription_id", async () => {
    const deps = makeDeps({
      listVirtualMachines: vi.fn(async () => [vm({ subscription_id: null })]),
      getVirtualMachine: vi.fn(async () => vm({ subscription_id: null })),
      listBillingSubscriptions: vi.fn(async () => [billingSub({ resource_id: "1806114" })])
    });
    const result = await runOrphanSweep(deps, { now: NOW });
    expect(result.pooled).toBe(1);
    expect(deps.releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({ hostingerBillingSubscriptionId: "sub-orphan" })
    );
  });

  it("reports a box with no resolvable billing subscription", async () => {
    const deps = makeDeps({
      listVirtualMachines: vi.fn(async () => [vm({ subscription_id: null })]),
      getVirtualMachine: vi.fn(async () => vm({ subscription_id: null })),
      listBillingSubscriptions: vi.fn(async () => [])
    });
    const result = await runOrphanSweep(deps, { now: NOW });
    // Nothing to disable and nothing to stamp, but still worth pooling: the
    // box exists and adopt-first can reuse it.
    expect(result.pooled).toBe(1);
    expect(deps.releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({ hostingerBillingSubscriptionId: null, expiresAt: null })
    );
    expect(result.findings[0].detail).toMatch(/paid-through unknown/);
  });

  it("reports a pool write failure instead of claiming the box is pooled", async () => {
    const deps = makeDeps({
      releaseVpsToPool: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    const result = await runOrphanSweep(deps, { now: NOW });
    expect(result).toMatchObject({ pooled: 0, reported: 1 });
    expect(result.findings[0].detail).toMatch(/pool write failed: db down/);
  });

  it("sends no email when the account is clean", async () => {
    const deps = makeDeps({ listVirtualMachines: vi.fn(async () => []) });
    const result = await runOrphanSweep(deps, { now: NOW });
    expect(result).toEqual({
      checked: 0,
      orphaned: 0,
      pooled: 0,
      wouldPool: 0,
      reported: 0,
      findings: []
    });
    expect(deps.sendOpsEmail).not.toHaveBeenCalled();
  });

  it("honours an explicit age floor", async () => {
    const deps = makeDeps({
      listVirtualMachines: vi.fn(async () => [
        vm({ created_at: new Date(NOW.getTime() - 60_000).toISOString() })
      ])
    });
    const result = await runOrphanSweep(deps, { now: NOW, minAgeMs: 30_000 });
    expect(result.pooled).toBe(1);
  });

  // The age check reads the LIST payload but everything after reads the
  // DETAIL payload, and Hostinger does not populate the two identically. A
  // detail response missing created_at or hostname must not break the run.
  it("pools a box whose detail payload omits created_at and hostname", async () => {
    const sparse = { id: 1806114, state: "initial", plan: "KVM 1", template: null, subscription_id: "sub-orphan" };
    const deps = makeDeps({ getVirtualMachine: vi.fn(async () => sparse as never) });
    const result = await runOrphanSweep(deps, { now: NOW });

    expect(result.pooled).toBe(1);
    expect(deps.releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({ vmId: 1806114, hostname: null })
    );
    expect(result.findings[0].createdAt).toBeNull();
  });

  it("reports a box whose detail payload has no plan", async () => {
    const noPlan = { id: 1806114, state: "initial", plan: null, template: null, created_at: OLD };
    const deps = makeDeps({ getVirtualMachine: vi.fn(async () => noPlan as never) });
    const result = await runOrphanSweep(deps, { now: NOW });

    expect(result).toMatchObject({ pooled: 0, reported: 1 });
    expect(result.findings[0].plan).toBeNull();
    expect(result.findings[0].detail).toMatch(/unrecognized plan/);
  });

  // A business that has never been provisioned has a null hostinger_vps_id;
  // parsing that must not produce a NaN that matches something.
  it("ignores businesses with no box when building the in-use set", async () => {
    const deps = makeDeps({
      listBusinesses: vi.fn(async () => [
        { id: "biz-1", name: "Not provisioned", hostinger_vps_id: null } as never
      ])
    });
    const result = await runOrphanSweep(deps, { now: NOW });
    expect(result.pooled).toBe(1);
  });

  // Hostinger has handed us a subscription_id that is not in the account's
  // own subscription list. Fall through to the resource_id join rather than
  // treating the box as having no billing at all.
  it("falls back to the resource join when subscription_id resolves to nothing", async () => {
    const deps = makeDeps({
      listBillingSubscriptions: vi.fn(async () => [
        billingSub({ id: "some-other-sub", resource_id: "1806114" })
      ])
    });
    const result = await runOrphanSweep(deps, { now: NOW });
    expect(deps.releaseVpsToPool).toHaveBeenCalledWith(
      expect.objectContaining({ hostingerBillingSubscriptionId: "some-other-sub" })
    );
    expect(result.pooled).toBe(1);
  });

  it("stringifies a non-Error rejection from the pool write", async () => {
    const deps = makeDeps({
      releaseVpsToPool: vi.fn(async () => {
        throw "db exploded";
      })
    });
    const result = await runOrphanSweep(deps, { now: NOW });
    expect(result.findings[0].detail).toBe("pool write failed: db exploded");
  });

  it("uses the wall clock when no now is supplied", async () => {
    const deps = makeDeps();
    const result = await runOrphanSweep(deps);
    expect(result.checked).toBe(1);
  });
});
