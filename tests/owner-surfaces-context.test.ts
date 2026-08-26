import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import {
  OWNER_SURFACE_SETTING_KEYS,
  loadOwnerSurfaceContext,
  readOwnerSurfaceMeta,
  type OwnerSurfaceContextDeps
} from "@/lib/owner-surfaces/context";
import { ownerTurnSurface } from "@/lib/owner-surfaces/turn-surfaces";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { SurfaceSpeaker } from "@/lib/owner-surfaces/speaker";

/**
 * What an owner-surface turn needs to know before it can build a prompt.
 *
 * The load-bearing rule is the MCP bridge gate: those tools are OWNER-only,
 * and a teammate must never even see the declarations. The handlers re-check
 * the caller's role per call, so this is defence in depth rather than the
 * only lock, but a declared tool the model then calls and gets refused is a
 * worse conversation than one that was never offered.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const OWNER: SurfaceSpeaker = { kind: "owner", name: "James", readFailed: false };
const TEAMMATE: SurfaceSpeaker = { kind: "teammate", name: "Dana", readFailed: false };

const ALL_SETTINGS = Object.fromEntries(
  OWNER_SURFACE_SETTING_KEYS.map((k) => [k, true])
) as Record<(typeof OWNER_SURFACE_SETTING_KEYS)[number], boolean>;

function deps(overrides: OwnerSurfaceContextDeps = {}): OwnerSurfaceContextDeps {
  return {
    fetchToolStates: vi.fn(async () => ALL_SETTINGS) as never,
    fetchWhatsAppConnection: vi.fn(async () => ({ is_active: true })) as never,
    fetchSpend: vi.fn(async () => ({ spendMicros: 10, effectiveCapMicros: 100 })) as never,
    fetchMeta: vi.fn(async () => ({
      timezone: "America/Toronto",
      tier: "standard" as never,
      ownerEmail: "james@kypads.com"
    })),
    buildIntegrations: vi.fn(async () => "INTEGRATIONS") as never,
    buildContextBlock: vi.fn(async () => "CONTEXT") as never,
    buildBookingLink: vi.fn(async () => "BOOKING") as never,
    buildBridge: vi.fn(() => ({ declarations: [] })) as never,
    ...overrides
  };
}

describe("loadOwnerSurfaceContext", () => {
  it("reads the settings from the surface's own channel", async () => {
    const d = deps();
    await loadOwnerSurfaceContext(BIZ, ownerTurnSurface("slack"), OWNER, d);
    expect(d.fetchToolStates).toHaveBeenCalledWith(BIZ, "slack", OWNER_SURFACE_SETTING_KEYS);
  });

  it("reads WhatsApp settings from the dashboard channel, like owner-over-SMS", async () => {
    // These surfaces ARE the owner's own assistant reached from elsewhere,
    // so they share the dashboard toggles rather than needing a settings
    // card nobody has filled in.
    const d = deps();
    await loadOwnerSurfaceContext(BIZ, ownerTurnSurface("whatsapp"), OWNER, d);
    expect(d.fetchToolStates).toHaveBeenCalledWith(BIZ, "dashboard", OWNER_SURFACE_SETTING_KEYS);
  });

  it("carries the grounding blocks through", async () => {
    const ctx = await loadOwnerSurfaceContext(BIZ, ownerTurnSurface("whatsapp"), OWNER, deps());
    expect(ctx.integrationsLine).toBe("INTEGRATIONS");
    expect(ctx.businessContextBlock).toBe("CONTEXT");
    expect(ctx.bookingLinkLine).toBe("BOOKING");
    expect(ctx.timezone).toBe("America/Toronto");
  });

  it("builds the MCP bridge for a verified owner with an email on record", async () => {
    const d = deps();
    const ctx = await loadOwnerSurfaceContext(BIZ, ownerTurnSurface("whatsapp"), OWNER, d);
    expect(ctx.bridgeExtraTools).not.toBeNull();
    const call = vi.mocked(d.buildBridge!).mock.calls[0];
    expect(call[1]).toMatchObject({ email: "james@kypads.com" });
    expect(call[3]).toBe("owner");
  });

  it("never builds the bridge for a teammate", async () => {
    const d = deps();
    const ctx = await loadOwnerSurfaceContext(BIZ, ownerTurnSurface("whatsapp"), TEAMMATE, d);
    expect(ctx.bridgeExtraTools).toBeNull();
    expect(d.buildBridge).not.toHaveBeenCalled();
  });

  it("skips the bridge when no owner email is on record", async () => {
    // The handlers could only refuse, so declaring the tools would offer
    // the owner something that cannot work.
    const d = deps({
      fetchMeta: async () => ({ timezone: null, tier: null, ownerEmail: null })
    });
    const ctx = await loadOwnerSurfaceContext(BIZ, ownerTurnSurface("whatsapp"), OWNER, d);
    expect(ctx.bridgeExtraTools).toBeNull();
  });

  it("reports the WhatsApp connection as live only when it is active", async () => {
    const live = await loadOwnerSurfaceContext(BIZ, ownerTurnSurface("whatsapp"), OWNER, deps());
    expect(live.whatsappConnected).toBe(true);

    const inactive = await loadOwnerSurfaceContext(
      BIZ,
      ownerTurnSurface("whatsapp"),
      OWNER,
      deps({ fetchWhatsAppConnection: (async () => ({ is_active: false })) as never })
    );
    expect(inactive.whatsappConnected).toBe(false);
  });

  it("treats an unreadable WhatsApp connection as not connected", async () => {
    const ctx = await loadOwnerSurfaceContext(
      BIZ,
      ownerTurnSurface("whatsapp"),
      OWNER,
      deps({
        fetchWhatsAppConnection: (async () => {
          throw new Error("down");
        }) as never
      })
    );
    expect(ctx.whatsappConnected).toBe(false);
  });

  it("raises the cap fuse when spend has reached the cap", async () => {
    const ctx = await loadOwnerSurfaceContext(
      BIZ,
      ownerTurnSurface("whatsapp"),
      OWNER,
      deps({ fetchSpend: (async () => ({ spendMicros: 100, effectiveCapMicros: 100 })) as never })
    );
    expect(ctx.overCap).toBe(true);
  });

  it("fails the cap read OPEN, so a blip does not silence the owner", async () => {
    const ctx = await loadOwnerSurfaceContext(
      BIZ,
      ownerTurnSurface("whatsapp"),
      OWNER,
      deps({
        fetchSpend: (async () => {
          throw new Error("down");
        }) as never
      })
    );
    expect(ctx.overCap).toBe(false);
  });

  it("projects the settings into the gate shape", async () => {
    const ctx = await loadOwnerSurfaceContext(BIZ, ownerTurnSurface("whatsapp"), OWNER, deps());
    expect(ctx.knowledgeToolEnabled).toBe(true);
    expect(ctx.emailToolEnabled).toBe(true);
    expect(ctx.toolStates.custom_table_manage).toBe(true);
    expect(ctx.toolStates.manage_employee).toBe(true);
  });
});

describe("readOwnerSurfaceMeta", () => {
  function dbReturning(result: { data?: unknown; error?: unknown }) {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq"]) b[m] = () => b;
    b.maybeSingle = () => Promise.resolve(result);
    return { from: () => b };
  }

  it("reads timezone, tier, and owner email", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      dbReturning({
        data: { timezone: "America/Toronto", tier: "standard", owner_email: "j@x.co" }
      }) as never
    );
    await expect(readOwnerSurfaceMeta(BIZ)).resolves.toEqual({
      timezone: "America/Toronto",
      tier: "standard",
      ownerEmail: "j@x.co"
    });
  });

  it("treats a blank owner email as absent", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      dbReturning({ data: { timezone: null, tier: null, owner_email: "   " } }) as never
    );
    await expect(readOwnerSurfaceMeta(BIZ)).resolves.toEqual({
      timezone: null,
      tier: null,
      ownerEmail: null
    });
  });

  it("degrades to nulls rather than failing the turn", async () => {
    // Losing the date line costs grounding; failing here costs the answer.
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("down"));
    await expect(readOwnerSurfaceMeta(BIZ)).resolves.toEqual({
      timezone: null,
      tier: null,
      ownerEmail: null
    });
  });

  it("degrades when the row is missing entirely", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      dbReturning({ data: null }) as never
    );
    await expect(readOwnerSurfaceMeta(BIZ)).resolves.toEqual({
      timezone: null,
      tier: null,
      ownerEmail: null
    });
  });
});
