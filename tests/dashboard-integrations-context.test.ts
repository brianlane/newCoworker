import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  })
}));

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn() }));

vi.mock("@/lib/dashboard/active-business", () => ({
  resolveActiveBusinessContext: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  listWorkspaceOAuthConnections: vi.fn()
}));
vi.mock("@/lib/db/custom-integrations", () => ({ listCustomIntegrations: vi.fn() }));
vi.mock("@/lib/db/vagaro-connections", () => ({ getPublicVagaroConnection: vi.fn() }));
vi.mock("@/lib/db/acuity-connections", () => ({ getPublicAcuityConnection: vi.fn() }));
vi.mock("@/lib/db/calendly-connections", () => ({ listPublicCalendlyConnections: vi.fn() }));
vi.mock("@/lib/db/caldav-connections", () => ({ getPublicCaldavConnection: vi.fn() }));
vi.mock("@/lib/db/meta-connections", () => ({ getPublicMetaConnection: vi.fn() }));
vi.mock("@/lib/db/whatsapp-connections", () => ({ getPublicWhatsAppConnection: vi.fn() }));
vi.mock("@/lib/db/zoom-connections", () => ({ getPublicZoomConnection: vi.fn() }));
vi.mock("@/lib/db/slack-connections", () => ({ getPublicSlackConnection: vi.fn() }));
vi.mock("@/lib/db/coworker-connections", () => ({ getPublicCoworkerConnection: vi.fn() }));
vi.mock("@/lib/db/api-keys", () => ({ listApiKeys: vi.fn() }));
vi.mock("@/lib/db/webhook-subscriptions", () => ({ listWebhookSubscriptions: vi.fn() }));
vi.mock("@/lib/mcp/connector-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mcp/connector-status")>()),
  getMcpConnectorStatusForBusiness: vi.fn()
}));

import {
  computeIntegrationStatuses,
  loadIntegrationsContext,
  type IntegrationsContext
} from "@/lib/dashboard/integrations-context";
import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessContext } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import { listCustomIntegrations } from "@/lib/db/custom-integrations";
import { getPublicVagaroConnection } from "@/lib/db/vagaro-connections";
import { getPublicAcuityConnection } from "@/lib/db/acuity-connections";
import { listPublicCalendlyConnections } from "@/lib/db/calendly-connections";
import { getPublicCaldavConnection } from "@/lib/db/caldav-connections";
import { getPublicMetaConnection } from "@/lib/db/meta-connections";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { getPublicZoomConnection } from "@/lib/db/zoom-connections";
import { getPublicSlackConnection } from "@/lib/db/slack-connections";
import { getPublicCoworkerConnection } from "@/lib/db/coworker-connections";
import { listApiKeys } from "@/lib/db/api-keys";
import { listWebhookSubscriptions } from "@/lib/db/webhook-subscriptions";
import {
  getMcpConnectorStatusForBusiness,
  MCP_STALE_MS
} from "@/lib/mcp/connector-status";

const BIZ = "11111111-1111-4111-8111-111111111111";
const USER = { userId: "u1", email: "o@o.com", isAdmin: false };

function mockDb(rows: Array<{ id: string; tier?: string; enterprise_limits?: unknown }>) {
  const db = {
    from: vi.fn(),
    select: vi.fn(),
    in: vi.fn(),
    limit: vi.fn()
  };
  db.from.mockReturnValue(db);
  db.select.mockReturnValue(db);
  db.in.mockReturnValue(db);
  db.limit.mockResolvedValue({ data: rows });
  return db;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(USER as never);
  vi.mocked(resolveActiveBusinessContext).mockResolvedValue({
    businessId: BIZ,
    role: "owner",
    accessible: []
  } as never);
  vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockDb([{ id: BIZ }]) as never);
  vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([]);
  vi.mocked(listCustomIntegrations).mockResolvedValue([]);
  vi.mocked(getPublicVagaroConnection).mockResolvedValue(null);
  vi.mocked(listPublicCalendlyConnections).mockResolvedValue([]);
  vi.mocked(getPublicCaldavConnection).mockResolvedValue(null);
  vi.mocked(getPublicMetaConnection).mockResolvedValue(null);
  vi.mocked(getPublicZoomConnection).mockResolvedValue(null);
  vi.mocked(getPublicSlackConnection).mockResolvedValue(null);
  vi.mocked(getPublicCoworkerConnection).mockResolvedValue(null);
  vi.mocked(listApiKeys).mockResolvedValue([]);
  vi.mocked(listWebhookSubscriptions).mockResolvedValue([]);
  vi.mocked(getMcpConnectorStatusForBusiness).mockResolvedValue(null);
});

describe("loadIntegrationsContext", () => {
  it("redirects unauthenticated users to login with the page as redirectTo", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    await expect(loadIntegrationsContext("/dashboard/integrations/zoom")).rejects.toThrow(
      "REDIRECT:/login?redirectTo=%2Fdashboard%2Fintegrations%2Fzoom"
    );
    expect(redirect).toHaveBeenCalledWith(
      "/login?redirectTo=%2Fdashboard%2Fintegrations%2Fzoom"
    );
  });

  it("redirects users without an email to plain login", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...USER, email: null } as never);
    await expect(loadIntegrationsContext("/dashboard/integrations")).rejects.toThrow(
      "REDIRECT:/login"
    );
  });

  it("loads every connection for an owner with an active business", async () => {
    const ctx = await loadIntegrationsContext("/dashboard/integrations");
    expect(ctx.businessId).toBe(BIZ);
    expect(ctx.canManageApiKeys).toBe(true);
    // No tier on the row → conservative starter cap (1).
    expect(ctx.workspaceConnectionCap).toEqual({ used: 0, max: 1, atCap: false });
    expect(listWorkspaceOAuthConnections).toHaveBeenCalledWith(BIZ);
    expect(listCustomIntegrations).toHaveBeenCalledWith(BIZ);
    expect(getPublicVagaroConnection).toHaveBeenCalledWith(BIZ);
    expect(listPublicCalendlyConnections).toHaveBeenCalledWith(BIZ);
    expect(getPublicCaldavConnection).toHaveBeenCalledWith(BIZ);
    expect(getPublicMetaConnection).toHaveBeenCalledWith(BIZ);
    expect(getPublicZoomConnection).toHaveBeenCalledWith(BIZ);
    expect(getPublicSlackConnection).toHaveBeenCalledWith(BIZ);
    expect(getPublicCoworkerConnection).toHaveBeenCalledWith(BIZ, "telegram");
    // No tier on the row → Slack (Standard+) reads as not enabled.
    expect(ctx.slackEnabled).toBe(false);
    expect(listApiKeys).toHaveBeenCalledWith(BIZ);
    expect(listWebhookSubscriptions).toHaveBeenCalledWith(BIZ);
    // The BUSINESS and the client, never the signed-in user. Reading by user
    // is the bug this page shipped with: an admin using view-as saw their own
    // connector on every tenant's tile.
    expect(getMcpConnectorStatusForBusiness).toHaveBeenCalledWith(BIZ, "claude");
    expect(getMcpConnectorStatusForBusiness).not.toHaveBeenCalledWith(
      USER.userId,
      expect.anything()
    );
  });

  it("loads a status per MCP client (business-scoped) and tolerates a read failure", async () => {
    const status = {
      firstConnectedAt: "2026-07-18T00:00:00Z",
      lastSeenAt: "2026-07-19T00:00:00Z",
      userId: "someone-else"
    };
    // One connector connected and the other not is the normal state, so the
    // two reads have to be independent rather than one shared answer.
    vi.mocked(getMcpConnectorStatusForBusiness).mockImplementation(
      async (_businessId: string, client: string) => (client === "claude" ? status : null) as never
    );
    const ctx = await loadIntegrationsContext("/dashboard/integrations");
    expect(ctx.mcpConnectorStatuses).toEqual({ claude: status, chatgpt: null });
    expect(getMcpConnectorStatusForBusiness).toHaveBeenCalledWith(BIZ, "claude");
    expect(getMcpConnectorStatusForBusiness).toHaveBeenCalledWith(BIZ, "chatgpt");

    vi.mocked(getMcpConnectorStatusForBusiness).mockRejectedValue(new Error("status down"));
    const degraded = await loadIntegrationsContext("/dashboard/integrations");
    expect(degraded.mcpConnectorStatuses).toEqual({ claude: null, chatgpt: null });
  });

  /**
   * The reported bug, end to end: a signed-in login whose own assistant is
   * connected, viewing a business that has never been touched by one. Nothing
   * may be read on the user's behalf, so the tiles stay dark.
   */
  it("reads no connector status at all when there is no active business", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockDb([]) as never);
    const ctx = await loadIntegrationsContext("/dashboard/integrations");
    expect(getMcpConnectorStatusForBusiness).not.toHaveBeenCalled();
    expect(ctx.mcpConnectorStatuses).toEqual({ claude: null, chatgpt: null });
  });

  it("computes the workspace connection cap from tier, count, and enterprise override", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      mockDb([{ id: BIZ, tier: "standard" }]) as never
    );
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({ id: `row-${i}` })) as never
    );
    const ctx = await loadIntegrationsContext("/dashboard/integrations");
    expect(ctx.workspaceConnectionCap).toEqual({ used: 10, max: 10, atCap: true });
    // Standard tier → the Slack integration is available.
    expect(ctx.slackEnabled).toBe(true);

    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      mockDb([
        { id: BIZ, tier: "enterprise", enterprise_limits: { workspaceConnectionsMax: 2 } }
      ]) as never
    );
    vi.mocked(listWorkspaceOAuthConnections).mockResolvedValue([{ id: "a" }] as never);
    const ent = await loadIntegrationsContext("/dashboard/integrations");
    expect(ent.workspaceConnectionCap).toEqual({ used: 1, max: 2, atCap: false });
  });

  it("never loads API key metadata for a manager (no manage_billing)", async () => {
    vi.mocked(resolveActiveBusinessContext).mockResolvedValue({
      businessId: BIZ,
      role: "manager",
      accessible: []
    } as never);
    const ctx = await loadIntegrationsContext("/dashboard/integrations");
    expect(ctx.businessId).toBe(BIZ);
    expect(ctx.canManageApiKeys).toBe(false);
    expect(ctx.apiKeys).toEqual([]);
    expect(listApiKeys).not.toHaveBeenCalled();
  });

  it("returns an empty context when the login can manage no business", async () => {
    vi.mocked(resolveActiveBusinessContext).mockResolvedValue({
      businessId: BIZ,
      role: "staff", // staff lacks manage_settings
      accessible: []
    } as never);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockDb([]) as never);
    const ctx = await loadIntegrationsContext("/dashboard/integrations");
    expect(ctx.businessId).toBeNull();
    expect(ctx.workspaceConnections).toEqual([]);
    expect(ctx.customIntegrations).toEqual([]);
    expect(ctx.vagaroConnection).toBeNull();
    expect(ctx.calendlyConnections).toEqual([]);
    expect(ctx.caldavConnection).toBeNull();
    expect(ctx.metaConnection).toBeNull();
    expect(ctx.whatsappConnection).toBeNull();
    expect(ctx.zoomConnection).toBeNull();
    expect(ctx.slackConnection).toBeNull();
    expect(ctx.apiKeys).toEqual([]);
    expect(ctx.activeHooks).toEqual([]);
    expect(listWorkspaceOAuthConnections).not.toHaveBeenCalled();
  });

  it("treats a missing role as no active business", async () => {
    vi.mocked(resolveActiveBusinessContext).mockResolvedValue({
      businessId: null,
      role: null,
      accessible: []
    } as never);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(mockDb([]) as never);
    const ctx = await loadIntegrationsContext("/dashboard/integrations");
    expect(ctx.businessId).toBeNull();
    expect(ctx.canManageApiKeys).toBe(false);
  });
});

describe("computeIntegrationStatuses", () => {
  function baseCtx(overrides: Partial<IntegrationsContext> = {}): IntegrationsContext {
    return {
      businessId: BIZ,
      canManageApiKeys: true,
      workspaceConnections: [],
      customIntegrations: [],
      vagaroConnection: null,
      calendlyConnections: [],
      caldavConnection: null,
      metaConnection: null,
      whatsappConnection: null,
      zoomConnection: null,
      apiKeys: [],
      activeHooks: [],
      mcpConnectorStatuses: { claude: null, chatgpt: null },
      ...overrides
    } as IntegrationsContext;
  }

  it("distinguishes a live Slack connection from an uninstalled one", () => {
    const connected = computeIntegrationStatuses(
      baseCtx({ slackConnection: { is_active: true, has_bot_token: true } as never })
    );
    expect(connected.slack).toEqual({ state: "connected", label: "Connected" });

    const uninstalled = computeIntegrationStatuses(
      baseCtx({ slackConnection: { is_active: false, has_bot_token: false } as never })
    );
    expect(uninstalled.slack).toEqual({ state: "attention", label: "Needs reconnect" });

    const wipedToken = computeIntegrationStatuses(
      baseCtx({ slackConnection: { is_active: true, has_bot_token: false } as never })
    );
    expect(wipedToken.slack.state).toBe("attention");
  });

  it("reports everything disconnected on an empty context", () => {
    const s = computeIntegrationStatuses(baseCtx());
    expect(s.google).toEqual({ state: "disconnected", label: "Not connected" });
    expect(s.microsoft).toEqual({ state: "disconnected", label: "Not connected" });
    expect(s.workspace).toEqual({ state: "disconnected", label: "Not connected" });
    expect(s.vagaro.state).toBe("disconnected");
    expect(s.calendly.state).toBe("disconnected");
    expect(s.caldav.state).toBe("disconnected");
    expect(s.meta.state).toBe("disconnected");
    expect(s.whatsapp.state).toBe("disconnected");
    expect(s.zoom.state).toBe("disconnected");
    expect(s.slack.state).toBe("disconnected");
    expect(s.custom).toEqual({ state: "disconnected", label: "None yet" });
    expect(s["zapier-api"]).toEqual({ state: "disconnected", label: "No keys" });
    expect(s.claude).toEqual({ state: "disconnected", label: "Available" });
  });

  it("labels a single long-tail connection Connected and counts multiples", () => {
    const one = computeIntegrationStatuses(
      baseCtx({
        workspaceConnections: [{ id: "a", provider_config_key: "onedrive" }] as never
      })
    );
    expect(one.workspace).toEqual({ state: "connected", label: "Connected" });

    const two = computeIntegrationStatuses(
      baseCtx({
        workspaceConnections: [
          { id: "a", provider_config_key: "onedrive" },
          { id: "b", provider_config_key: "some-crm" }
        ] as never
      })
    );
    expect(two.workspace).toEqual({ state: "connected", label: "2 connected" });
  });

  it("counts each workspace tile from only the rows it shows", () => {
    // One table, one plan cap, three tiles. Counting the whole table per tile
    // would light all three up the moment a tenant connected any one of them,
    // which is exactly what the old single Workspace tile did.
    const s = computeIntegrationStatuses(
      baseCtx({
        workspaceConnections: [
          { id: "g1", provider_config_key: "google" },
          { id: "g2", provider_config_key: "google-mail" },
          { id: "m1", provider_config_key: "outlook" },
          { id: "o1", provider_config_key: "onedrive" }
        ] as never
      })
    );
    expect(s.google).toEqual({ state: "connected", label: "2 connected" });
    expect(s.microsoft).toEqual({ state: "connected", label: "Connected" });
    expect(s.workspace).toEqual({ state: "connected", label: "Connected" });
  });

  it("leaves the other two tiles disconnected when only Google is connected", () => {
    const s = computeIntegrationStatuses(
      baseCtx({
        workspaceConnections: [{ id: "g1", provider_config_key: "google" }] as never
      })
    );
    expect(s.google).toEqual({ state: "connected", label: "Connected" });
    expect(s.microsoft.state).toBe("disconnected");
    expect(s.workspace.state).toBe("disconnected");
  });

  it("shows a legacy outlook-calendar row on the Microsoft tile, not the long tail", () => {
    const s = computeIntegrationStatuses(
      baseCtx({
        workspaceConnections: [
          { id: "m1", provider_config_key: "outlook-calendar" }
        ] as never
      })
    );
    expect(s.microsoft).toEqual({ state: "connected", label: "Connected" });
    expect(s.workspace.state).toBe("disconnected");
  });

  it("marks direct calendar connections connected when a row exists", () => {
    const s = computeIntegrationStatuses(
      baseCtx({
        vagaroConnection: { id: "v" } as never,
        acuityConnection: { id: "a" } as never,
        calendlyConnections: [{ id: "c" }, { id: "c2" }] as never,
        caldavConnection: { id: "d" } as never
      })
    );
    expect(s.vagaro).toEqual({ state: "connected", label: "Connected" });
    expect(s.acuity).toEqual({ state: "connected", label: "Connected" });
    expect(s.calendly).toEqual({ state: "connected", label: "2 accounts connected" });
    expect(s.caldav).toEqual({ state: "connected", label: "Connected" });

    // A single Calendly account keeps the plain label.
    const single = computeIntegrationStatuses(
      baseCtx({ calendlyConnections: [{ id: "c" }] as never })
    );
    expect(single.calendly).toEqual({ state: "connected", label: "Connected" });
  });

  it("distinguishes active vs pending Meta connections", () => {
    const active = computeIntegrationStatuses(
      baseCtx({ metaConnection: { status: "active" } as never })
    );
    expect(active.meta).toEqual({ state: "connected", label: "Connected" });

    const pending = computeIntegrationStatuses(
      baseCtx({ metaConnection: { status: "pending" } as never })
    );
    expect(pending.meta).toEqual({ state: "attention", label: "Almost there" });
  });

  it("distinguishes active vs paused WhatsApp connections", () => {
    const active = computeIntegrationStatuses(
      baseCtx({ whatsappConnection: { is_active: true } as never })
    );
    expect(active.whatsapp).toEqual({ state: "connected", label: "Connected" });

    const paused = computeIntegrationStatuses(
      baseCtx({ whatsappConnection: { is_active: false } as never })
    );
    expect(paused.whatsapp).toEqual({ state: "attention", label: "Paused" });
  });

  it("flags a revoked Zoom grant as needing reconnect", () => {
    const active = computeIntegrationStatuses(
      baseCtx({ zoomConnection: { is_active: true } as never })
    );
    expect(active.zoom).toEqual({ state: "connected", label: "Connected" });

    const revoked = computeIntegrationStatuses(
      baseCtx({ zoomConnection: { is_active: false } as never })
    );
    expect(revoked.zoom).toEqual({ state: "attention", label: "Needs reconnect" });
  });

  it("counts custom integrations and API keys", () => {
    const s = computeIntegrationStatuses(
      baseCtx({
        customIntegrations: [{ id: "1" }, { id: "2" }] as never,
        apiKeys: [{ id: "k1" }] as never
      })
    );
    expect(s.custom).toEqual({ state: "connected", label: "2 connected" });
    expect(s["zapier-api"]).toEqual({ state: "connected", label: "1 key" });

    const many = computeIntegrationStatuses(
      baseCtx({ apiKeys: [{ id: "k1" }, { id: "k2" }] as never })
    );
    expect(many["zapier-api"]).toEqual({ state: "connected", label: "2 keys" });
  });

  it("marks each connector connected independently, once that client has made a call", () => {
    const stamp = {
      firstConnectedAt: "2026-07-18T00:00:00Z",
      lastSeenAt: new Date().toISOString(),
      userId: "u1"
    };
    const connected = computeIntegrationStatuses(
      baseCtx({ mcpConnectorStatuses: { claude: stamp, chatgpt: null } })
    );
    // The whole point of keying the table on (user, client, business): one
    // assistant's traffic must not light the other one's tile.
    expect(connected.chatgpt).toEqual({ state: "disconnected", label: "Available" });
    expect(connected.claude).toEqual({ state: "connected", label: "Connected" });

    // And the mirror image, so neither tile is wired to the other's status.
    const swapped = computeIntegrationStatuses(
      baseCtx({ mcpConnectorStatuses: { claude: null, chatgpt: stamp } })
    );
    expect(swapped.chatgpt).toEqual({ state: "connected", label: "Connected" });
    expect(swapped.claude).toEqual({ state: "disconnected", label: "Available" });
  });

  /**
   * Nothing tells us a connector was removed inside Claude or ChatGPT, so a
   * long silence is the only signal there is. Without this the badge stayed
   * green forever, including for connectors that had been deleted.
   */
  it("drops a long-silent connector out of Connected", () => {
    const quiet = {
      firstConnectedAt: "2026-01-01T00:00:00Z",
      lastSeenAt: new Date(Date.now() - MCP_STALE_MS - 1000).toISOString(),
      userId: "u1"
    };
    const s = computeIntegrationStatuses(
      baseCtx({ mcpConnectorStatuses: { claude: quiet, chatgpt: null } })
    );
    expect(s.claude).toEqual({ state: "attention", label: "Gone quiet" });
  });
});

describe("the Telegram tile", () => {
  it.each([
    ["disconnected", null, "Not connected"],
    ["connected", { is_active: true }, null],
    ["paused", { is_active: false }, "Paused"]
  ])("reports %s", async (_label, row, label) => {
    vi.mocked(getPublicCoworkerConnection).mockResolvedValue(row as never);
    const ctx = await loadIntegrationsContext("/dashboard/integrations");
    const status = computeIntegrationStatuses(ctx).telegram;
    if (label) expect(status.label).toBe(label);
    else expect(status.state).toBe("connected");
  });
});

describe("the Microsoft Teams tile", () => {
  it.each([
    ["disconnected", null, "Not connected"],
    ["paused", { is_active: false, alert_target_id: "19:x" }, "Paused"],
    // The state no other channel has: installed, but nobody has messaged
    // the bot, so there is no conversation to deliver an alert into.
    ["awaiting a first message", { is_active: true, alert_target_id: null }, "Message your bot once"],
    ["fully connected", { is_active: true, alert_target_id: "19:x" }, null]
  ])("reports %s", async (_label, row, label) => {
    vi.mocked(getPublicCoworkerConnection).mockImplementation(async (_biz, channel) =>
      channel === "teams" ? (row as never) : null
    );
    const ctx = await loadIntegrationsContext("/dashboard/integrations");
    const status = computeIntegrationStatuses(ctx).teams;
    if (label) expect(status.label).toBe(label);
    else expect(status.state).toBe("connected");
  });
});
