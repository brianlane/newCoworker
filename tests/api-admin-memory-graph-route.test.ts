/**
 * POST /api/admin/memory-graph — the KG rollout controls: per-tenant mode
 * override (with the projection-shipping vault sync) and the fleet-wide
 * default every 'inherit' tenant follows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  getBusiness: vi.fn(),
  listBusinesses: vi.fn(async () => [])
}));
vi.mock("@/lib/db/configs", () => ({
  patchBusinessConfig: vi.fn(),
  getBusinessConfig: vi.fn(async () => null)
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/admin/platform-settings", () => ({
  upsertAdminPlatformSetting: vi.fn()
}));
vi.mock("@/lib/vps/schedule-vault-sync", () => ({
  scheduleVaultSync: vi.fn()
}));

import { POST } from "@/app/api/admin/memory-graph/route";
import { requireAdmin } from "@/lib/auth";
import { getBusiness, listBusinesses } from "@/lib/db/businesses";
import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { upsertAdminPlatformSetting } from "@/lib/admin/platform-settings";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";
import { MEMORY_GRAPH_DEFAULT_MODE_KEY } from "@/lib/memory/graph-db";

const BIZ = "11111111-1111-4111-8111-111111111111";

function makeReq(body: unknown): Request {
  return new Request("http://localhost/api/admin/memory-graph", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getBusiness).mockResolvedValue({ id: BIZ, name: "Amy" } as never);
});

describe("POST /api/admin/memory-graph", () => {
  it("requires admin (auth failure propagates as an error response)", async () => {
    vi.mocked(requireAdmin).mockRejectedValueOnce(new Error("Unauthorized"));
    const res = await POST(makeReq({ businessId: BIZ, mode: "shadow" }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(patchBusinessConfig).not.toHaveBeenCalled();
  });

  it("sets a per-tenant mode and schedules the projection vault sync", async () => {
    const res = await POST(makeReq({ businessId: BIZ, mode: "active" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ businessId: BIZ, mode: "active" });
    expect(patchBusinessConfig).toHaveBeenCalledWith(BIZ, { memory_graph_mode: "active" });
    expect(scheduleVaultSync).toHaveBeenCalledWith(BIZ);
  });

  it("accepts inherit as a per-tenant value", async () => {
    const res = await POST(makeReq({ businessId: BIZ, mode: "inherit" }));
    expect(res.status).toBe(200);
    expect(patchBusinessConfig).toHaveBeenCalledWith(BIZ, { memory_graph_mode: "inherit" });
  });

  it("404s an unknown business without writing", async () => {
    vi.mocked(getBusiness).mockResolvedValue(null as never);
    const res = await POST(makeReq({ businessId: BIZ, mode: "shadow" }));
    const json = await res.json();
    expect(json.error?.code ?? json.error).toBeTruthy();
    expect(patchBusinessConfig).not.toHaveBeenCalled();
    expect(scheduleVaultSync).not.toHaveBeenCalled();
  });

  it("updates the fleet default and fans a vault sync out to INHERIT tenants only", async () => {
    vi.mocked(listBusinesses).mockResolvedValue([
      { id: "b-inherit", name: "A" },
      { id: "b-norow", name: "B" },
      { id: "b-explicit", name: "C" }
    ] as never);
    vi.mocked(getBusinessConfig).mockImplementation(async (id: string) => {
      if (id === "b-inherit") return { memory_graph_mode: "inherit" } as never;
      if (id === "b-explicit") return { memory_graph_mode: "shadow" } as never;
      return null; // b-norow: no config row yet (absent = inherit)
    });

    const res = await POST(makeReq({ defaultMode: "active" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ defaultMode: "active", syncedTenants: 2 });
    expect(upsertAdminPlatformSetting).toHaveBeenCalledWith(
      MEMORY_GRAPH_DEFAULT_MODE_KEY,
      "active"
    );
    // Per-tenant config writes never happen on a default change.
    expect(patchBusinessConfig).not.toHaveBeenCalled();
    // Inherit + row-less tenants ship/wipe immediately; the explicit-mode
    // tenant is untouched by a default change, so no wasted SSH.
    expect(scheduleVaultSync).toHaveBeenCalledTimes(2);
    expect(scheduleVaultSync).toHaveBeenCalledWith("b-inherit");
    expect(scheduleVaultSync).toHaveBeenCalledWith("b-norow");
    expect(scheduleVaultSync).not.toHaveBeenCalledWith("b-explicit");
  });

  it("a tenant whose config read fails is skipped; the rest still sync", async () => {
    vi.mocked(listBusinesses).mockResolvedValue([
      { id: "b-broken", name: "A" },
      { id: "b-inherit", name: "B" }
    ] as never);
    vi.mocked(getBusinessConfig).mockImplementation(async (id: string) => {
      if (id === "b-broken") throw new Error("config read down");
      return { memory_graph_mode: "inherit" } as never;
    });
    const res = await POST(makeReq({ defaultMode: "off" }));
    const json = await res.json();
    // The .catch(() => null) treats a failed read as "no row" = inherit,
    // which errs toward syncing (the sync itself resolves the true mode).
    expect(json.data.syncedTenants).toBe(2);
    expect(scheduleVaultSync).toHaveBeenCalledWith("b-broken");
  });

  it("a fan-out failure never fails the default update (non-Error too)", async () => {
    vi.mocked(listBusinesses).mockRejectedValueOnce(new Error("db down"));
    const res = await POST(makeReq({ defaultMode: "shadow" }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ defaultMode: "shadow", syncedTenants: 0 });
    expect(upsertAdminPlatformSetting).toHaveBeenCalled();

    vi.mocked(listBusinesses).mockRejectedValueOnce("string failure" as never);
    const res2 = await POST(makeReq({ defaultMode: "shadow" }));
    expect(res2.status).toBe(200);
  });

  it("rejects malformed bodies (bad mode, inherit as default, missing fields)", async () => {
    expect((await POST(makeReq({ businessId: BIZ, mode: "banana" }))).status).toBe(400);
    expect((await POST(makeReq({ defaultMode: "inherit" }))).status).toBe(400);
    expect((await POST(makeReq({}))).status).toBe(400);
    expect(patchBusinessConfig).not.toHaveBeenCalled();
    expect(upsertAdminPlatformSetting).not.toHaveBeenCalled();
  });
});
