import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMaybeSingle = vi.fn();
const mockCreateClient = vi.fn();
const mockListConnections = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => mockCreateClient(...a)
}));

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: (...a: unknown[]) => mockListConnections(...a)
}));

import {
  WorkspaceConnectionCapError,
  assertWorkspaceConnectionAllowed,
  resolveWorkspaceConnectionCapState,
  settleWorkspaceConnectionInsert,
  workspaceConnectionCapMessage,
  workspaceConnectionCapState
} from "@/lib/nango/connection-cap";

function mockDb(row: unknown, error: { message: string } | null = null) {
  const db = {
    from: vi.fn(),
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: mockMaybeSingle
  };
  db.from.mockReturnValue(db);
  db.select.mockReturnValue(db);
  db.eq.mockReturnValue(db);
  mockMaybeSingle.mockResolvedValue({ data: row, error });
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("workspaceConnectionCapState (pure)", () => {
  it("caps starter at 1", () => {
    expect(workspaceConnectionCapState("starter", 0)).toEqual({ used: 0, max: 1, atCap: false });
    expect(workspaceConnectionCapState("starter", 1)).toEqual({ used: 1, max: 1, atCap: true });
  });

  it("caps standard at 3", () => {
    expect(workspaceConnectionCapState("standard", 2)).toEqual({ used: 2, max: 3, atCap: false });
    expect(workspaceConnectionCapState("standard", 3)).toEqual({ used: 3, max: 3, atCap: true });
  });

  it("treats a grandfathered over-cap count as at cap (blocks new, keeps existing)", () => {
    expect(workspaceConnectionCapState("standard", 5)).toEqual({ used: 5, max: 3, atCap: true });
  });

  it("enterprise is unlimited (max null, never at cap)", () => {
    expect(workspaceConnectionCapState("enterprise", 50)).toEqual({
      used: 50,
      max: null,
      atCap: false
    });
  });

  it("applies a per-deal enterprise override", () => {
    expect(
      workspaceConnectionCapState("enterprise", 5, { workspaceConnectionsMax: 5 })
    ).toEqual({ used: 5, max: 5, atCap: true });
  });

  it("treats unknown/missing tier as starter (most conservative)", () => {
    expect(workspaceConnectionCapState(null, 1)).toEqual({ used: 1, max: 1, atCap: true });
    expect(workspaceConnectionCapState("bogus", 0)).toEqual({ used: 0, max: 1, atCap: false });
  });
});

describe("workspaceConnectionCapMessage", () => {
  it("pluralizes the connection noun", () => {
    expect(workspaceConnectionCapMessage({ used: 1, max: 1, atCap: true })).toBe(
      "Your plan includes 1 workspace connection (1 in use). Remove one or upgrade your plan to connect another."
    );
    expect(workspaceConnectionCapMessage({ used: 3, max: 3, atCap: true })).toBe(
      "Your plan includes 3 workspace connections (3 in use). Remove one or upgrade your plan to connect another."
    );
  });

  it("degrades a null max to 0 (never reachable through the routes, but total)", () => {
    expect(workspaceConnectionCapMessage({ used: 2, max: null, atCap: false })).toContain(
      "0 workspace connections"
    );
  });
});

describe("resolveWorkspaceConnectionCapState", () => {
  it("reads tier + enterprise override and counts rows", async () => {
    const db = mockDb({ tier: "enterprise", enterprise_limits: { workspaceConnectionsMax: 2 } });
    mockCreateClient.mockResolvedValue(db);
    mockListConnections.mockResolvedValue([{ id: "a" }, { id: "b" }]);

    const state = await resolveWorkspaceConnectionCapState("biz-1");
    expect(state).toEqual({ used: 2, max: 2, atCap: true });
    expect(db.from).toHaveBeenCalledWith("businesses");
    expect(mockListConnections).toHaveBeenCalledWith("biz-1", db);
  });

  it("uses an injected client and treats a missing business row as starter", async () => {
    const db = mockDb(null);
    mockListConnections.mockResolvedValue([]);

    const state = await resolveWorkspaceConnectionCapState("biz-1", db as never);
    expect(state).toEqual({ used: 0, max: 1, atCap: false });
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("throws on a business read error (fail closed)", async () => {
    const db = mockDb(null, { message: "boom" });
    await expect(
      resolveWorkspaceConnectionCapState("biz-1", db as never)
    ).rejects.toThrow("resolveWorkspaceConnectionCapState: boom");
  });
});

describe("settleWorkspaceConnectionInsert (post-insert race settle)", () => {
  const link = { providerConfigKey: "google-mail", connectionId: "c-new" };

  function rows(specs: Array<{ id: string; at: string; key?: string; conn?: string }>) {
    return specs.map((s) => ({
      id: s.id,
      created_at: s.at,
      provider_config_key: s.key ?? "google-mail",
      connection_id: s.conn ?? s.id
    }));
  }

  it("keeps a row that landed inside the cap", async () => {
    const db = mockDb({ tier: "standard", enterprise_limits: null });
    mockCreateClient.mockResolvedValue(db);
    mockListConnections.mockResolvedValue(
      rows([
        { id: "r1", at: "2026-07-01T00:00:00Z" },
        { id: "r2", at: "2026-07-02T00:00:00Z", conn: "c-new" }
      ])
    );
    const settlement = await settleWorkspaceConnectionInsert("biz-1", link);
    expect(settlement.evictRowId).toBeNull();
    expect(settlement.state).toEqual({ used: 2, max: 3, atCap: false });
  });

  it("evicts the racer whose row landed past the cap (seats go to the earliest rows)", async () => {
    const db = mockDb({ tier: "starter", enterprise_limits: null });
    mockListConnections.mockResolvedValue(
      rows([
        { id: "r1", at: "2026-07-01T00:00:00Z" },
        { id: "r2", at: "2026-07-02T00:00:00Z", conn: "c-new" }
      ])
    );
    const settlement = await settleWorkspaceConnectionInsert("biz-1", link, db as never);
    expect(settlement.evictRowId).toBe("r2");
    expect(settlement.state.atCap).toBe(true);
  });

  it("breaks created_at ties deterministically by row id (both directions)", async () => {
    const db = mockDb({ tier: "starter", enterprise_limits: null });
    mockListConnections.mockResolvedValue(
      rows([
        { id: "r2", at: "2026-07-01T00:00:00Z", conn: "c-new" },
        { id: "r1", at: "2026-07-01T00:00:00Z" }
      ])
    );
    // r1 < r2 on the tie, so the new row (r2) is past the starter cap of 1.
    const tied = await settleWorkspaceConnectionInsert("biz-1", link, db as never);
    expect(tied.evictRowId).toBe("r2");

    mockListConnections.mockResolvedValue(
      rows([
        { id: "r0", at: "2026-07-01T00:00:00Z", conn: "c-new" },
        { id: "r1", at: "2026-07-01T00:00:00Z" }
      ])
    );
    // r0 < r1: the new row holds the seat, nothing to evict for THIS caller.
    const kept = await settleWorkspaceConnectionInsert("biz-1", link, db as never);
    expect(kept.evictRowId).toBeNull();
  });

  it("returns no eviction for unlimited plans and for a row already gone", async () => {
    const unlimited = mockDb({ tier: "enterprise", enterprise_limits: null });
    mockListConnections.mockResolvedValue(rows([{ id: "r1", at: "2026-07-01T00:00:00Z" }]));
    const ent = await settleWorkspaceConnectionInsert("biz-1", link, unlimited as never);
    expect(ent.evictRowId).toBeNull();

    const db = mockDb({ tier: "starter", enterprise_limits: null });
    // Two foreign rows, the just-inserted one is gone (concurrent delete).
    mockListConnections.mockResolvedValue(
      rows([
        { id: "r1", at: "2026-07-01T00:00:00Z" },
        { id: "r2", at: "2026-07-02T00:00:00Z" }
      ])
    );
    const gone = await settleWorkspaceConnectionInsert("biz-1", link, db as never);
    expect(gone.evictRowId).toBeNull();
  });

  it("throws on a business read error (fail closed)", async () => {
    const db = mockDb(null, { message: "boom" });
    await expect(
      settleWorkspaceConnectionInsert("biz-1", link, db as never)
    ).rejects.toThrow("settleWorkspaceConnectionInsert: boom");
  });
});

describe("assertWorkspaceConnectionAllowed", () => {
  it("passes below the cap", async () => {
    const db = mockDb({ tier: "standard", enterprise_limits: null });
    mockListConnections.mockResolvedValue([{ id: "a" }]);
    await expect(assertWorkspaceConnectionAllowed("biz-1", db as never)).resolves.toBeUndefined();
  });

  it("throws a typed error with the owner-facing message at the cap", async () => {
    const db = mockDb({ tier: "starter", enterprise_limits: null });
    mockListConnections.mockResolvedValue([{ id: "a" }]);

    const err = await assertWorkspaceConnectionAllowed("biz-1", db as never).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceConnectionCapError);
    expect((err as WorkspaceConnectionCapError).state).toEqual({ used: 1, max: 1, atCap: true });
    expect((err as Error).message).toContain("Your plan includes 1 workspace connection");
  });
});
