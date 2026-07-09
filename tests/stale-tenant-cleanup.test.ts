import { describe, expect, it, vi } from "vitest";
import { cleanupStaleTenantsForVm } from "@/lib/provisioning/stale-tenant-cleanup";
import type { BusinessRow } from "@/lib/db/businesses";

function biz(overrides: Partial<BusinessRow> & { id: string }): BusinessRow {
  return {
    name: `biz-${overrides.id}`,
    owner_email: `${overrides.id}@example.com`,
    tier: "starter",
    status: "offline",
    hostinger_vps_id: "1815606",
    created_at: "2026-07-08T22:22:32Z",
    ...overrides
  } as BusinessRow;
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    listByVpsId: vi.fn().mockResolvedValue([]),
    deleteBiz: vi.fn().mockResolvedValue(undefined),
    // Default: the email owns nothing else after the row delete → auth user
    // is removable.
    listBusinessIdsForEmail: vi.fn().mockResolvedValue([]),
    // Default: no stale business has resubscribed — nothing is Stripe-live.
    listLiveSubscriptionIds: vi
      .fn()
      .mockResolvedValue({ stripeBacked: new Set<string>(), stripeless: new Set<string>() }),
    findAuthUserId: vi.fn().mockResolvedValue(null),
    deleteAuthUser: vi.fn().mockResolvedValue(undefined),
    ...overrides
  };
}

describe("cleanupStaleTenantsForVm", () => {
  it("deletes the stale business and its auth user, keeping the adopting business", async () => {
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([
        biz({ id: "old-biz", owner_email: "old@example.com" }),
        biz({ id: "new-biz" })
      ]),
      findAuthUserId: vi.fn().mockResolvedValue("auth-user-1")
    });

    const result = await cleanupStaleTenantsForVm(
      { vmId: 1815606, newBusinessId: "new-biz" },
      deps
    );

    expect(deps.listByVpsId).toHaveBeenCalledWith("1815606");
    expect(deps.findAuthUserId).toHaveBeenCalledWith("old@example.com");
    expect(deps.deleteAuthUser).toHaveBeenCalledWith("auth-user-1");
    expect(deps.deleteBiz).toHaveBeenCalledTimes(1);
    expect(deps.deleteBiz).toHaveBeenCalledWith("old-biz");
    expect(result.deletedBusinessIds).toEqual(["old-biz"]);
  });

  it("returns empty when only the adopting business references the VM", async () => {
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([biz({ id: "new-biz" })])
    });

    const result = await cleanupStaleTenantsForVm(
      { vmId: "1815606", newBusinessId: "new-biz" },
      deps
    );

    expect(result.deletedBusinessIds).toEqual([]);
    expect(deps.deleteBiz).not.toHaveBeenCalled();
    // No stale rows → the live-subscription guard lookup is skipped.
    expect(deps.listLiveSubscriptionIds).not.toHaveBeenCalled();
  });

  it("skips (never deletes) a stale business that resubscribed via Stripe after release", async () => {
    // Admin released the box, the old owner completed a NEW paid checkout
    // before anyone adopted it. Deleting now would orphan a live Stripe
    // subscription — the guard skips that business and deletes only the
    // genuinely dead one.
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([
        biz({ id: "resubscribed" }),
        biz({ id: "dead" })
      ]),
      listLiveSubscriptionIds: vi
        .fn()
        .mockResolvedValue({ stripeBacked: new Set(["resubscribed"]), stripeless: new Set() })
    });

    const result = await cleanupStaleTenantsForVm(
      { vmId: 1815606, newBusinessId: "new-biz" },
      deps
    );

    expect(deps.listLiveSubscriptionIds).toHaveBeenCalledWith(["resubscribed", "dead"]);
    expect(result.deletedBusinessIds).toEqual(["dead"]);
    expect(deps.deleteBiz).toHaveBeenCalledTimes(1);
    expect(deps.deleteBiz).toHaveBeenCalledWith("dead");
  });

  it("never deletes wiped businesses (lifecycle audit rows)", async () => {
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([
        biz({ id: "wiped-biz", status: "wiped" }),
        biz({ id: "stale-biz" })
      ])
    });

    const result = await cleanupStaleTenantsForVm(
      { vmId: 42, newBusinessId: "new-biz" },
      deps
    );

    expect(result.deletedBusinessIds).toEqual(["stale-biz"]);
    expect(deps.deleteBiz).toHaveBeenCalledTimes(1);
  });

  it("skips the auth lookup when the stale business has no owner email", async () => {
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([
        biz({ id: "stale-biz", owner_email: "" as unknown as string })
      ])
    });

    const result = await cleanupStaleTenantsForVm(
      { vmId: 42, newBusinessId: "new-biz" },
      deps
    );

    expect(deps.findAuthUserId).not.toHaveBeenCalled();
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(result.deletedBusinessIds).toEqual(["stale-biz"]);
  });

  it("skips the auth delete when no auth user matches the owner email", async () => {
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([biz({ id: "stale-biz" })]),
      findAuthUserId: vi.fn().mockResolvedValue(null)
    });

    await cleanupStaleTenantsForVm({ vmId: 42, newBusinessId: "new-biz" }, deps);

    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
    expect(deps.deleteBiz).toHaveBeenCalledWith("stale-biz");
  });

  it("still deletes the business row when the auth delete fails (Error)", async () => {
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([biz({ id: "stale-biz" })]),
      findAuthUserId: vi.fn().mockResolvedValue("auth-user-1"),
      deleteAuthUser: vi.fn().mockRejectedValue(new Error("auth down"))
    });

    const result = await cleanupStaleTenantsForVm(
      { vmId: 42, newBusinessId: "new-biz" },
      deps
    );

    expect(result.deletedBusinessIds).toEqual(["stale-biz"]);
  });

  it("stringifies a non-Error auth-delete failure and continues", async () => {
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([biz({ id: "stale-biz" })]),
      findAuthUserId: vi.fn().mockRejectedValue("auth string boom")
    });

    const result = await cleanupStaleTenantsForVm(
      { vmId: 42, newBusinessId: "new-biz" },
      deps
    );

    expect(result.deletedBusinessIds).toEqual(["stale-biz"]);
  });

  it("keeps the auth user when the owner email still owns other businesses (agency login)", async () => {
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([biz({ id: "stale-biz" })]),
      listBusinessIdsForEmail: vi.fn().mockResolvedValue(["other-live-biz"]),
      findAuthUserId: vi.fn().mockResolvedValue("auth-user-1")
    });

    const result = await cleanupStaleTenantsForVm(
      { vmId: 42, newBusinessId: "new-biz" },
      deps
    );

    expect(result.deletedBusinessIds).toEqual(["stale-biz"]);
    // The remaining-ownership check short-circuits before any auth lookup.
    expect(deps.findAuthUserId).not.toHaveBeenCalled();
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("tolerates a failing remaining-ownership check (row already deleted)", async () => {
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([biz({ id: "stale-biz" })]),
      listBusinessIdsForEmail: vi.fn().mockRejectedValue(new Error("replica down"))
    });

    const result = await cleanupStaleTenantsForVm(
      { vmId: 42, newBusinessId: "new-biz" },
      deps
    );

    expect(result.deletedBusinessIds).toEqual(["stale-biz"]);
    expect(deps.deleteAuthUser).not.toHaveBeenCalled();
  });

  it("logs and continues to the next business when a row delete fails (Error)", async () => {
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([
        biz({ id: "fails" }),
        biz({ id: "succeeds" })
      ]),
      deleteBiz: vi
        .fn()
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce(undefined),
      findAuthUserId: vi.fn().mockResolvedValue("auth-user-1")
    });

    const result = await cleanupStaleTenantsForVm(
      { vmId: 42, newBusinessId: "new-biz" },
      deps
    );

    expect(result.deletedBusinessIds).toEqual(["succeeds"]);
    expect(deps.deleteBiz).toHaveBeenCalledTimes(2);
    // The login must survive while its business row does: the failed row's
    // auth user is untouched, only the deleted row's user is removed.
    expect(deps.deleteAuthUser).toHaveBeenCalledTimes(1);
  });

  it("stringifies a non-Error row-delete failure", async () => {
    const deps = makeDeps({
      listByVpsId: vi.fn().mockResolvedValue([biz({ id: "fails" })]),
      deleteBiz: vi.fn().mockRejectedValue("delete string boom")
    });

    const result = await cleanupStaleTenantsForVm(
      { vmId: 42, newBusinessId: "new-biz" },
      deps
    );

    expect(result.deletedBusinessIds).toEqual([]);
  });
});
