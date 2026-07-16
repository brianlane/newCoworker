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
vi.mock("@/lib/db/calendly-connections", () => ({ getPublicCalendlyConnection: vi.fn() }));
vi.mock("@/lib/db/caldav-connections", () => ({ getPublicCaldavConnection: vi.fn() }));
vi.mock("@/lib/db/meta-connections", () => ({ getPublicMetaConnection: vi.fn() }));
vi.mock("@/lib/db/whatsapp-connections", () => ({ getPublicWhatsAppConnection: vi.fn() }));
vi.mock("@/lib/db/zoom-connections", () => ({ getPublicZoomConnection: vi.fn() }));
vi.mock("@/lib/db/api-keys", () => ({ listApiKeys: vi.fn() }));
vi.mock("@/lib/db/webhook-subscriptions", () => ({ listWebhookSubscriptions: vi.fn() }));

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
import { getPublicCalendlyConnection } from "@/lib/db/calendly-connections";
import { getPublicCaldavConnection } from "@/lib/db/caldav-connections";
import { getPublicMetaConnection } from "@/lib/db/meta-connections";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { getPublicZoomConnection } from "@/lib/db/zoom-connections";
import { listApiKeys } from "@/lib/db/api-keys";
import { listWebhookSubscriptions } from "@/lib/db/webhook-subscriptions";

const BIZ = "11111111-1111-4111-8111-111111111111";
const USER = { userId: "u1", email: "o@o.com", isAdmin: false };

function mockDb(rows: Array<{ id: string }>) {
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
  vi.mocked(getPublicCalendlyConnection).mockResolvedValue(null);
  vi.mocked(getPublicCaldavConnection).mockResolvedValue(null);
  vi.mocked(getPublicMetaConnection).mockResolvedValue(null);
  vi.mocked(getPublicZoomConnection).mockResolvedValue(null);
  vi.mocked(listApiKeys).mockResolvedValue([]);
  vi.mocked(listWebhookSubscriptions).mockResolvedValue([]);
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
    expect(listWorkspaceOAuthConnections).toHaveBeenCalledWith(BIZ);
    expect(listCustomIntegrations).toHaveBeenCalledWith(BIZ);
    expect(getPublicVagaroConnection).toHaveBeenCalledWith(BIZ);
    expect(getPublicCalendlyConnection).toHaveBeenCalledWith(BIZ);
    expect(getPublicCaldavConnection).toHaveBeenCalledWith(BIZ);
    expect(getPublicMetaConnection).toHaveBeenCalledWith(BIZ);
    expect(getPublicZoomConnection).toHaveBeenCalledWith(BIZ);
    expect(listApiKeys).toHaveBeenCalledWith(BIZ);
    expect(listWebhookSubscriptions).toHaveBeenCalledWith(BIZ);
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
    expect(ctx.calendlyConnection).toBeNull();
    expect(ctx.caldavConnection).toBeNull();
    expect(ctx.metaConnection).toBeNull();
    expect(ctx.whatsappConnection).toBeNull();
    expect(ctx.zoomConnection).toBeNull();
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
      calendlyConnection: null,
      caldavConnection: null,
      metaConnection: null,
      whatsappConnection: null,
      zoomConnection: null,
      apiKeys: [],
      activeHooks: [],
      ...overrides
    } as IntegrationsContext;
  }

  it("reports everything disconnected on an empty context", () => {
    const s = computeIntegrationStatuses(baseCtx());
    expect(s.workspace).toEqual({ state: "disconnected", label: "Not connected" });
    expect(s.vagaro.state).toBe("disconnected");
    expect(s.calendly.state).toBe("disconnected");
    expect(s.caldav.state).toBe("disconnected");
    expect(s.meta.state).toBe("disconnected");
    expect(s.whatsapp.state).toBe("disconnected");
    expect(s.zoom.state).toBe("disconnected");
    expect(s.custom).toEqual({ state: "disconnected", label: "None yet" });
    expect(s["zapier-api"]).toEqual({ state: "disconnected", label: "No keys" });
    expect(s.claude).toEqual({ state: "disconnected", label: "Available" });
  });

  it("labels a single workspace connection Connected and counts multiples", () => {
    const one = computeIntegrationStatuses(
      baseCtx({ workspaceConnections: [{ id: "a" }] as never })
    );
    expect(one.workspace).toEqual({ state: "connected", label: "Connected" });

    const two = computeIntegrationStatuses(
      baseCtx({ workspaceConnections: [{ id: "a" }, { id: "b" }] as never })
    );
    expect(two.workspace).toEqual({ state: "connected", label: "2 connected" });
  });

  it("marks direct calendar connections connected when a row exists", () => {
    const s = computeIntegrationStatuses(
      baseCtx({
        vagaroConnection: { id: "v" } as never,
        calendlyConnection: { id: "c" } as never,
        caldavConnection: { id: "d" } as never
      })
    );
    expect(s.vagaro).toEqual({ state: "connected", label: "Connected" });
    expect(s.calendly).toEqual({ state: "connected", label: "Connected" });
    expect(s.caldav).toEqual({ state: "connected", label: "Connected" });
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
});
