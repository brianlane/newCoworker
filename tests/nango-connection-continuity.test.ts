import { describe, expect, it, vi } from "vitest";
import { consolidateReconnectedWorkspaceConnection } from "@/lib/nango/connection-continuity";
import type { WorkspaceOAuthConnectionRow } from "@/lib/db/workspace-oauth-connections";

/**
 * Reconnect continuity: reconnecting the SAME mailbox used to mint a NEW
 * workspace_oauth_connections row (fresh Nango connection id), stranding
 * every AiFlow mailbox binding on the old row id — the KYP Jul 22 2026
 * `connection_not_found` incident class. Consolidation keeps the OLD row id
 * and re-points it at the fresh grant.
 */

const BIZ = "11111111-1111-4111-8111-111111111111";

const row = (over: Partial<WorkspaceOAuthConnectionRow> = {}): WorkspaceOAuthConnectionRow => ({
  id: "row-old",
  business_id: BIZ,
  provider_config_key: "outlook",
  connection_id: "conn-old",
  metadata: { provider_account_email: "sam@example.com", shared_calendar_id: "cal-1" },
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  ...over
});

const newRow = (over: Partial<WorkspaceOAuthConnectionRow> = {}): WorkspaceOAuthConnectionRow =>
  row({
    id: "row-new",
    connection_id: "conn-new",
    metadata: { provider_account_email: "sam@example.com", connected_via: "connect_ui" },
    created_at: "2026-07-22T00:00:00Z",
    ...over
  });

function deps(over: Record<string, unknown> = {}) {
  return {
    fetchConnections: vi.fn(async () => [row(), newRow()]),
    fetchByNangoIds: vi.fn(async () => newRow()),
    removeRow: vi.fn(async () => newRow()),
    updateLink: vi.fn(async () => row({ connection_id: "conn-new" })),
    ...over
  };
}

const baseArgs = (deleteNango = vi.fn(async () => undefined)) => ({
  businessId: BIZ,
  providerConfigKey: "outlook",
  newConnectionId: "conn-new",
  accountEmail: "sam@example.com",
  deleteNangoConnection: deleteNango
});

describe("consolidateReconnectedWorkspaceConnection", () => {
  it("keeps the oldest row's id, re-points it, deletes the duplicate + old grant", async () => {
    const deleteNango = vi.fn(async () => undefined);
    const d = deps();
    const result = await consolidateReconnectedWorkspaceConnection(baseArgs(deleteNango), d);

    expect(result).toEqual({
      consolidated: true,
      keptRowId: "row-old",
      supersededNangoConnectionId: "conn-old"
    });
    // Duplicate row removed BEFORE the keeper is re-pointed (unique index).
    expect(d.removeRow).toHaveBeenCalledWith(BIZ, "row-new");
    expect(d.updateLink).toHaveBeenCalledWith({
      businessId: BIZ,
      id: "row-old",
      connectionId: "conn-new",
      // App-owned keys survive; the fresh row's keys win on conflict.
      metadata: expect.objectContaining({
        shared_calendar_id: "cal-1",
        connected_via: "connect_ui",
        provider_account_email: "sam@example.com"
      })
    });
    expect(deleteNango).toHaveBeenCalledWith("outlook", "conn-old");
  });

  it("matches the account email case-insensitively", async () => {
    const d = deps({
      fetchConnections: vi.fn(async () => [
        row({ metadata: { provider_account_email: "Sam@Example.COM" } }),
        newRow()
      ])
    });
    const result = await consolidateReconnectedWorkspaceConnection(baseArgs(), d);
    expect(result.consolidated).toBe(true);
  });

  it("no-ops on a blank account email (failed identity probe)", async () => {
    const d = deps();
    const result = await consolidateReconnectedWorkspaceConnection(
      { ...baseArgs(), accountEmail: "   " },
      d
    );
    expect(result).toEqual({ consolidated: false });
    expect(d.fetchConnections).not.toHaveBeenCalled();
  });

  it("no-ops when no older row represents the same account", async () => {
    const d = deps({
      fetchConnections: vi.fn(async () => [
        // Different account on the same provider.
        row({ metadata: { provider_account_email: "other@example.com" } }),
        // Same email but a DIFFERENT provider key.
        row({ id: "row-g", provider_config_key: "google", connection_id: "conn-g" }),
        // The new row itself (same connection id) never counts.
        newRow(),
        // Legacy row with no identity metadata.
        row({ id: "row-legacy", connection_id: "conn-legacy", metadata: {} })
      ])
    });
    const result = await consolidateReconnectedWorkspaceConnection(baseArgs(), d);
    expect(result).toEqual({ consolidated: false });
    expect(d.removeRow).not.toHaveBeenCalled();
    expect(d.updateLink).not.toHaveBeenCalled();
  });

  it("no-ops when the new row already raced away (parallel completes / cap eviction)", async () => {
    const d = deps({ fetchByNangoIds: vi.fn(async () => null) });
    const result = await consolidateReconnectedWorkspaceConnection(baseArgs(), d);
    expect(result).toEqual({ consolidated: false });
    expect(d.removeRow).not.toHaveBeenCalled();
  });

  it("consolidates onto the OLDEST sibling when several rows match", async () => {
    const d = deps({
      fetchConnections: vi.fn(async () => [
        row({ id: "row-oldest", connection_id: "conn-oldest", created_at: "2026-06-01T00:00:00Z" }),
        row(),
        newRow()
      ])
    });
    const result = await consolidateReconnectedWorkspaceConnection(baseArgs(), d);
    expect(result).toMatchObject({ consolidated: true, keptRowId: "row-oldest" });
  });

  it("still consolidates when the superseded Nango-side delete fails (quota leak logged)", async () => {
    const deleteNango = vi.fn(async () => {
      throw new Error("nango down");
    });
    const d = deps();
    const result = await consolidateReconnectedWorkspaceConnection(baseArgs(deleteNango), d);
    expect(result.consolidated).toBe(true);
    expect(d.updateLink).toHaveBeenCalled();
  });

  it("tolerates a non-Error throw from the Nango delete", async () => {
    const deleteNango = vi.fn(async () => {
      throw "string failure";
    });
    const result = await consolidateReconnectedWorkspaceConnection(
      baseArgs(deleteNango),
      deps()
    );
    expect(result.consolidated).toBe(true);
  });
});
