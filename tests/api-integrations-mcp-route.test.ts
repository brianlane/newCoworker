/**
 * DELETE /api/integrations/mcp, the Disconnect button on the Claude and
 * ChatGPT cards.
 *
 * The behavior worth pinning is the asymmetry between its two halves.
 * Clearing the status row is ours and must always land; revoking the OAuth
 * grant only works on the CALLER's own login, so a teammate's grant (and,
 * under admin view-as, the tenant's) survives. A route that reported both as
 * one "disconnected" would tell an owner their data stopped flowing to an
 * assistant that still has access.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn(), requireBusinessRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("@/lib/mcp/connector-status", () => ({
  deleteMcpConnectorStatus: vi.fn(),
  hasMcpConnectorRow: vi.fn()
}));
vi.mock("@/lib/mcp/grants", () => ({ revokeMcpGrantsForClient: vi.fn() }));

import { DELETE } from "@/app/api/integrations/mcp/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { deleteMcpConnectorStatus, hasMcpConnectorRow } from "@/lib/mcp/connector-status";
import { revokeMcpGrantsForClient } from "@/lib/mcp/grants";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const BUSINESS = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER = { userId: "u1", email: "owner@biz.com", isAdmin: false };
const SESSION_CLIENT = { auth: { oauth: {} } };

function req(body: unknown) {
  return new Request("https://app/api/integrations/mcp", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
  // The SESSION client, not the service one: auth.oauth acts on the signed-in
  // user's own grants, and the service role holds none.
  vi.mocked(createSupabaseServerClient).mockResolvedValue(SESSION_CLIENT as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  vi.mocked(deleteMcpConnectorStatus).mockResolvedValue(1);
  vi.mocked(hasMcpConnectorRow).mockResolvedValue(true);
  vi.mocked(revokeMcpGrantsForClient).mockResolvedValue({ revoked: 1, skippedReason: null });
});

describe("DELETE /api/integrations/mcp", () => {
  it("revokes the caller's grant and clears the business's rows", async () => {
    const res = await DELETE(req({ businessId: BUSINESS, client: "claude" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { cleared: 1, revoked: 1, revokeSkippedReason: null }
    });
    expect(revokeMcpGrantsForClient).toHaveBeenCalledWith(SESSION_CLIENT, "claude");
    expect(deleteMcpConnectorStatus).toHaveBeenCalledWith(BUSINESS, "claude");
  });

  it("gates on manage_settings for a non-admin", async () => {
    vi.mocked(requireBusinessRole).mockRejectedValue(
      Object.assign(new Error("Forbidden"), { status: 403 })
    );
    const res = await DELETE(req({ businessId: BUSINESS, client: "chatgpt" }));
    expect(res.status).toBe(403);
    expect(deleteMcpConnectorStatus).not.toHaveBeenCalled();
  });

  it("lets an admin through without a team role", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...OWNER, isAdmin: true } as never);
    const res = await DELETE(req({ businessId: BUSINESS, client: "claude" }));
    expect(res.status).toBe(200);
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });

  /**
   * The admin view-as case, and the teammate case with it. `auth.oauth` acts
   * on the SIGNED-IN session, so revoking whatever it holds would destroy the
   * caller's own Claude access to clear a card belonging to someone else, and
   * leave the real connector alive to re-light the tile on its next call.
   * Nothing is revoked unless the caller is connected to THIS business.
   */
  it("never revokes when the caller is not connected to this business", async () => {
    vi.mocked(hasMcpConnectorRow).mockResolvedValue(false);
    const res = await DELETE(req({ businessId: BUSINESS, client: "claude" }));
    expect(res.status).toBe(200);
    expect(revokeMcpGrantsForClient).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      ok: true,
      data: { cleared: 1, revoked: 0, revokeSkippedReason: "caller_not_connected_here" }
    });
    // The card still clears: that half is ours and always lands.
    expect(deleteMcpConnectorStatus).toHaveBeenCalledWith(BUSINESS, "claude");
  });

  it("checks the caller against this business and this client, not just any row", async () => {
    await DELETE(req({ businessId: BUSINESS, client: "chatgpt" }));
    expect(hasMcpConnectorRow).toHaveBeenCalledWith(OWNER.userId, BUSINESS, "chatgpt");
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await DELETE(req({ businessId: BUSINESS, client: "claude" }));
    expect(res.status).toBe(401);
    expect(deleteMcpConnectorStatus).not.toHaveBeenCalled();
  });

  /**
   * The teammate / view-as case. The row goes, nothing is revoked, and the
   * response says which so the card can tell the truth about it.
   */
  it("still clears the rows when the caller has no grant of their own", async () => {
    vi.mocked(revokeMcpGrantsForClient).mockResolvedValue({
      revoked: 0,
      skippedReason: "no_matching_grant"
    });
    vi.mocked(deleteMcpConnectorStatus).mockResolvedValue(2);
    const res = await DELETE(req({ businessId: BUSINESS, client: "claude" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { cleared: 2, revoked: 0, revokeSkippedReason: "no_matching_grant" }
    });
  });

  it("still clears the rows when the revoke itself fails", async () => {
    vi.mocked(revokeMcpGrantsForClient).mockResolvedValue({
      revoked: 0,
      skippedReason: "revoke_failed"
    });
    const res = await DELETE(req({ businessId: BUSINESS, client: "claude" }));
    expect(res.status).toBe(200);
    expect(deleteMcpConnectorStatus).toHaveBeenCalledWith(BUSINESS, "claude");
  });

  it("rejects a bad business id or an unknown client", async () => {
    expect((await DELETE(req({ businessId: "nope", client: "claude" }))).status).toBe(400);
    expect((await DELETE(req({ businessId: BUSINESS, client: "gemini" }))).status).toBe(400);
    expect(deleteMcpConnectorStatus).not.toHaveBeenCalled();
  });
});
