import { beforeEach, describe, expect, it, vi } from "vitest";

const afterCallbacks: Array<() => Promise<void> | void> = [];

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (cb: () => Promise<void> | void) => {
      afterCallbacks.push(cb);
    }
  };
});

async function flushAfterCallbacks(): Promise<void> {
  while (afterCallbacks.length > 0) {
    const cb = afterCallbacks.shift();
    if (cb) await cb();
  }
}

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  updateBusinessVpsSize: vi.fn()
}));
vi.mock("@/lib/db/subscriptions", () => ({
  getSubscription: vi.fn(),
  updateSubscription: vi.fn()
}));
vi.mock("@/lib/db/vps-ssh-keys", () => ({
  getActiveVpsSshKey: vi.fn()
}));
vi.mock("@/lib/hostinger/data-migration", () => ({
  backupBusinessData: vi.fn(),
  restoreBusinessData: vi.fn()
}));
vi.mock("@/lib/hostinger/client", () => ({
  DEFAULT_HOSTINGER_BASE_URL: "https://developers.hostinger.com",
  // Must be constructible (`new HostingerClient(...)` in the route).
  HostingerClient: class {}
}));
vi.mock("@/lib/provisioning/orchestrate", () => ({
  orchestrateProvisioning: vi.fn()
}));
vi.mock("@/lib/vps/migrate-size", () => ({
  migrateBusinessVpsSize: vi.fn()
}));
vi.mock("@/lib/email/ops-notify", () => ({
  sendOpsHardwareMigrationEmail: vi.fn()
}));
vi.mock("@/lib/db/vps-migration-locks", () => ({
  tryClaimVpsMigration: vi.fn(),
  releaseVpsMigrationLock: vi.fn()
}));

import { POST } from "@/app/api/admin/vps/[businessId]/migrate-size/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness } from "@/lib/db/businesses";
import { migrateBusinessVpsSize } from "@/lib/vps/migrate-size";
import { sendOpsHardwareMigrationEmail } from "@/lib/email/ops-notify";
import { tryClaimVpsMigration, releaseVpsMigrationLock } from "@/lib/db/vps-migration-locks";

const BIZ_ID = "11111111-1111-4111-8111-111111111111";

function makeRequest(size: string): Request {
  return new Request(`http://localhost/api/admin/vps/${BIZ_ID}/migrate-size`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ size })
  });
}

function makeCtx(businessId: string = BIZ_ID) {
  return { params: Promise.resolve({ businessId }) };
}

const standardBiz = {
  id: BIZ_ID,
  name: "Amy's Bakery",
  owner_email: "amy@example.com",
  tier: "standard" as const,
  status: "online" as const,
  hostinger_vps_id: "1800985",
  created_at: "2026-06-01T00:00:00Z",
  vps_size: "kvm2" as const
};

describe("api/admin/vps/[businessId]/migrate-size route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: "admin@example.com",
      isAdmin: true
    } as never);
    vi.mocked(getBusiness).mockResolvedValue(standardBiz as never);
    vi.mocked(tryClaimVpsMigration).mockResolvedValue(true);
    vi.mocked(releaseVpsMigrationLock).mockResolvedValue(undefined);
    vi.mocked(migrateBusinessVpsSize).mockResolvedValue({
      ok: true,
      fromSize: "kvm2",
      toSize: "kvm4",
      oldVmId: 1800985,
      newVmId: "1900001",
      newVmIp: "5.6.7.8",
      oldBillingHandling: "auto-renew-disabled"
    } as never);
  });

  it("accepts the migration with 202 and runs it in the background", async () => {
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(202);
    const json = await res.json();
    expect(json.data).toEqual({
      accepted: true,
      businessId: BIZ_ID,
      fromSize: "kvm2",
      toSize: "kvm4"
    });

    expect(migrateBusinessVpsSize).not.toHaveBeenCalled();
    expect(tryClaimVpsMigration).toHaveBeenCalledWith(BIZ_ID, "admin@example.com", "kvm4");
    await flushAfterCallbacks();
    expect(migrateBusinessVpsSize).toHaveBeenCalledWith(
      { businessId: BIZ_ID, targetSize: "kvm4", requestedBy: "admin@example.com" },
      expect.objectContaining({ sendOpsEmail: sendOpsHardwareMigrationEmail })
    );
    expect(releaseVpsMigrationLock).toHaveBeenCalledWith(BIZ_ID);
  });

  it("409s when a migration is already in flight and never dispatches", async () => {
    vi.mocked(tryClaimVpsMigration).mockResolvedValue(false);
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.message).toContain("already in flight");
    expect(afterCallbacks).toHaveLength(0);
    expect(releaseVpsMigrationLock).not.toHaveBeenCalled();
  });

  it("releases the lease even when the background migration crashes, and survives a failed release", async () => {
    vi.mocked(migrateBusinessVpsSize).mockRejectedValue(new Error("boom"));
    vi.mocked(releaseVpsMigrationLock).mockRejectedValue(new Error("release down"));
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(202);
    await flushAfterCallbacks();
    expect(releaseVpsMigrationLock).toHaveBeenCalledWith(BIZ_ID);
    // The crash email still went out despite the release failure.
    expect(sendOpsHardwareMigrationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "failed" })
    );
  });

  it("releases the lease after a background failure outcome", async () => {
    vi.mocked(migrateBusinessVpsSize).mockResolvedValue({
      ok: false,
      stage: "backup",
      error: "no ssh key"
    } as never);
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(202);
    await flushAfterCallbacks();
    expect(releaseVpsMigrationLock).toHaveBeenCalledWith(BIZ_ID);
  });

  it("falls back to the admin user id when the session has no email", async () => {
    vi.mocked(requireAdmin).mockResolvedValue({
      userId: "admin-1",
      email: null,
      isAdmin: true
    } as never);
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(202);
    await flushAfterCallbacks();
    expect(migrateBusinessVpsSize).toHaveBeenCalledWith(
      expect.objectContaining({ requestedBy: "admin-1" }),
      expect.anything()
    );
  });

  it("logs a background failure without crashing the route", async () => {
    vi.mocked(migrateBusinessVpsSize).mockResolvedValue({
      ok: false,
      stage: "backup",
      error: "no ssh key"
    } as never);
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(202);
    await flushAfterCallbacks();
    // Failure emails come from the migration lib itself; the route only logs.
    expect(sendOpsHardwareMigrationEmail).not.toHaveBeenCalled();
  });

  it("emails a failed notice when the background migration crashes unexpectedly", async () => {
    vi.mocked(migrateBusinessVpsSize).mockRejectedValue(new Error("boom"));
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(202);
    await flushAfterCallbacks();
    expect(sendOpsHardwareMigrationEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "failed",
        detail: expect.stringContaining("boom")
      })
    );
  });

  it("also reports non-Error crash values", async () => {
    vi.mocked(migrateBusinessVpsSize).mockRejectedValue("string crash");
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(202);
    await flushAfterCallbacks();
    expect(sendOpsHardwareMigrationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining("string crash") })
    );
  });

  it("rejects an invalid size", async () => {
    const res = await POST(makeRequest("kvm999"), makeCtx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("kvm1|kvm2|kvm4|kvm8");
    expect(afterCallbacks).toHaveLength(0);
  });

  it("404s when the business does not exist", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null);
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(404);
  });

  it("rejects residency tenants before the 202 with the manual runbook", async () => {
    vi.mocked(getBusiness).mockResolvedValue({
      ...standardBiz,
      tier: "enterprise",
      data_residency_mode: "vps"
    } as never);
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("residency-restore");
    expect(afterCallbacks).toHaveLength(0);
    expect(migrateBusinessVpsSize).not.toHaveBeenCalled();
  });

  it("accepts enterprise businesses (provisionable since Jul 2026)", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ ...standardBiz, tier: "enterprise" } as never);
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(202);
    await flushAfterCallbacks();
    expect(migrateBusinessVpsSize).toHaveBeenCalledWith(
      expect.objectContaining({ targetSize: "kvm4" }),
      expect.anything()
    );
  });

  it("rejects a no-op migration to the current effective size", async () => {
    const res = await POST(makeRequest("kvm2"), makeCtx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("already on kvm2");
  });

  it("treats an unpinned standard business as legacy kvm8", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ ...standardBiz, vps_size: null } as never);
    const res = await POST(makeRequest("kvm8"), makeCtx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.message).toContain("already on kvm8");
  });

  it("403s non-admin sessions", async () => {
    vi.mocked(requireAdmin).mockRejectedValue(
      Object.assign(new Error("Admin access required"), { status: 403 })
    );
    const res = await POST(makeRequest("kvm4"), makeCtx());
    expect(res.status).toBe(403);
  });

  it("validates the businessId param", async () => {
    const res = await POST(makeRequest("kvm4"), makeCtx("not-a-uuid"));
    expect(res.status).toBe(400);
  });
});
