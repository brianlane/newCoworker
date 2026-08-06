import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn()
}));
vi.mock("@/lib/admin/view-as", () => ({
  isViewAsActive: vi.fn()
}));
vi.mock("@/lib/dashboard/active-business", () => ({
  resolveActiveBusinessIdForAction: vi.fn()
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/db/businesses", () => ({
  updateBusinessProfileFields: vi.fn()
}));
vi.mock("@/lib/business-profile/refresh", () => ({
  refreshBusinessProfileMdAndLog: vi.fn()
}));
vi.mock("@/lib/vps/sync-vault", () => ({
  syncVaultToVpsAndLog: vi.fn()
}));
vi.mock("@/lib/db/notification-preferences", () => ({
  updateNotificationPreferences: vi.fn()
}));
vi.mock("@/lib/db/telnyx-routes", () => ({
  setForwardToE164: vi.fn()
}));

import { POST } from "@/app/api/account/owner-profile/route";
import { getAuthUser } from "@/lib/auth";
import { isViewAsActive } from "@/lib/admin/view-as";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { updateBusinessProfileFields } from "@/lib/db/businesses";
import { updateNotificationPreferences } from "@/lib/db/notification-preferences";
import { setForwardToE164 } from "@/lib/db/telnyx-routes";
import { refreshBusinessProfileMdAndLog } from "@/lib/business-profile/refresh";
import { syncVaultToVpsAndLog } from "@/lib/vps/sync-vault";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OWNER = { userId: "user-1", email: "owner@example.com", isAdmin: false };

/**
 * Minimal supabase stub: businesses row lookup plus the two linked-number
 * reads. Each table returns its configured row through the chained select.
 */
function makeDb(rows: {
  business?: { id: string; phone: string | null } | null;
  prefsPhone?: string | null;
  forwardPhone?: string | null;
}) {
  const from = vi.fn((table: string) => {
    const result =
      table === "businesses"
        ? { data: rows.business ?? null, error: null }
        : table === "notification_preferences"
          ? { data: { phone_number: rows.prefsPhone ?? null }, error: null }
          : { data: { forward_to_e164: rows.forwardPhone ?? null }, error: null };
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.update = vi.fn(() => chain);
    chain.eq = vi.fn(() => Object.assign(Promise.resolve({ error: null }), chain));
    chain.in = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(() => Promise.resolve(result));
    return chain;
  });
  return { from };
}

function request(body: unknown): Request {
  return new Request("http://localhost/api/account/owner-profile", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("api/account/owner-profile route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
    vi.mocked(isViewAsActive).mockResolvedValue(false);
    vi.mocked(resolveActiveBusinessIdForAction).mockResolvedValue(BIZ as never);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({ business: { id: BIZ, phone: "+15145188192" } }) as never
    );
    vi.mocked(updateBusinessProfileFields).mockResolvedValue(undefined as never);
    vi.mocked(updateNotificationPreferences).mockResolvedValue({} as never);
    vi.mocked(setForwardToE164).mockResolvedValue(undefined as never);
    vi.mocked(refreshBusinessProfileMdAndLog).mockResolvedValue(undefined as never);
    vi.mocked(syncVaultToVpsAndLog).mockResolvedValue(undefined as never);
  });

  it("coerces a bare NANP number to E.164 before persisting", async () => {
    const res = await POST(request({ phone: "602 555 0147" }));
    expect(res.status).toBe(200);
    expect(updateBusinessProfileFields).toHaveBeenCalledWith(
      BIZ,
      { phone: "+16025550147" },
      expect.anything()
    );
    const body = (await res.json()) as { data: { phone: string } };
    expect(body.data.phone).toBe("+16025550147");
  });

  it("rejects an uncoercible local number instead of storing a landmine", async () => {
    // The exact shape the old character-class check let through: a bare
    // 8-digit local number with no country code.
    const res = await POST(request({ phone: "6123 4567" }));
    expect(res.status).not.toBe(200);
    expect(updateBusinessProfileFields).not.toHaveBeenCalled();
  });

  it("syncs alert + forwarding numbers that still match the old phone", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({
        business: { id: BIZ, phone: "+15145188192" },
        // Alert phone matches the old number in a DIFFERENT format; the
        // forwarding cell matches exactly.
        prefsPhone: "514-518-8192",
        forwardPhone: "+15145188192"
      }) as never
    );
    const res = await POST(request({ phone: "+16025550147", syncLinkedNumbers: true }));
    const body = (await res.json()) as {
      data: { syncedAlertPhone: boolean; syncedForwardingPhone: boolean };
    };
    expect(updateNotificationPreferences).toHaveBeenCalledWith(BIZ, {
      phone_number: "+16025550147"
    });
    expect(setForwardToE164).toHaveBeenCalledWith(BIZ, "+16025550147");
    expect(body.data).toMatchObject({ syncedAlertPhone: true, syncedForwardingPhone: true });
  });

  it("leaves a linked number alone when it points somewhere else", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({
        business: { id: BIZ, phone: "+15145188192" },
        prefsPhone: "+16995550000",
        forwardPhone: "+15145188192"
      }) as never
    );
    const res = await POST(request({ phone: "+16025550147", syncLinkedNumbers: true }));
    const body = (await res.json()) as {
      data: { syncedAlertPhone: boolean; syncedForwardingPhone: boolean };
    };
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
    expect(setForwardToE164).toHaveBeenCalledWith(BIZ, "+16025550147");
    expect(body.data).toMatchObject({ syncedAlertPhone: false, syncedForwardingPhone: true });
  });

  it("does not sync when the checkbox is off or the phone is cleared", async () => {
    await POST(request({ phone: "+16025550147" }));
    expect(setForwardToE164).not.toHaveBeenCalled();

    await POST(request({ phone: "", syncLinkedNumbers: true }));
    // Clearing must never blank the forwarding cell (that would silently
    // disable Safe Mode).
    expect(setForwardToE164).not.toHaveBeenCalled();
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it("fills EMPTY linked columns even when the old primary was cleared or junk", async () => {
    // Bugbot: a null baseline (businesses.phone cleared, or legacy
    // uncoercible data) must not strand empty linked columns. Empty has
    // nothing deliberate to preserve, so it fills; a column holding a
    // DIFFERENT real number still does not move (unprovable tracking).
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({
        business: { id: BIZ, phone: "junk-not-a-phone" },
        prefsPhone: null,
        forwardPhone: "+16995550000"
      }) as never
    );
    const res = await POST(request({ phone: "+16025550147", syncLinkedNumbers: true }));
    const body = (await res.json()) as {
      data: { syncedAlertPhone: boolean; syncedForwardingPhone: boolean };
    };
    expect(updateNotificationPreferences).toHaveBeenCalledWith(BIZ, {
      phone_number: "+16025550147"
    });
    expect(setForwardToE164).not.toHaveBeenCalled();
    expect(body.data).toMatchObject({ syncedAlertPhone: true, syncedForwardingPhone: false });
  });

  it("an unchanged-phone resave never refills a cleared forwarding number", async () => {
    // Bugbot: the owner cleared forwarding via the forwarding-phone API
    // (which also auto-disabled Safe Mode); a later name-only or idempotent
    // profile save with the default-on checkbox must not resurrect it.
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({
        business: { id: BIZ, phone: "+15145188192" },
        prefsPhone: null,
        forwardPhone: null
      }) as never
    );
    const res = await POST(
      request({ ownerName: "James", phone: "+15145188192", syncLinkedNumbers: true })
    );
    expect(res.status).toBe(200);
    expect(setForwardToE164).not.toHaveBeenCalled();
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
  });

  it("skips a linked column already holding the new number (no pointless write)", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({
        business: { id: BIZ, phone: "+15145188192" },
        prefsPhone: "+16025550147",
        forwardPhone: "+15145188192"
      }) as never
    );
    const res = await POST(request({ phone: "+16025550147", syncLinkedNumbers: true }));
    const body = (await res.json()) as {
      data: { syncedAlertPhone: boolean; syncedForwardingPhone: boolean };
    };
    expect(updateNotificationPreferences).not.toHaveBeenCalled();
    expect(setForwardToE164).toHaveBeenCalledWith(BIZ, "+16025550147");
    expect(body.data).toMatchObject({ syncedAlertPhone: false, syncedForwardingPhone: true });
  });

  it("a failed linked-number sync stays visible but never fails the save", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(
      makeDb({
        business: { id: BIZ, phone: "+15145188192" },
        prefsPhone: "+15145188192",
        forwardPhone: "+15145188192"
      }) as never
    );
    vi.mocked(setForwardToE164).mockRejectedValue(new Error("db down"));
    const res = await POST(request({ phone: "+16025550147", syncLinkedNumbers: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { syncedAlertPhone: boolean; syncedForwardingPhone: boolean };
    };
    expect(body.data).toMatchObject({ syncedAlertPhone: true, syncedForwardingPhone: false });
  });

  it("returns a deliverability warning for a non-NANP number", async () => {
    // Hong Kong: saves fine, then every SMS would fail at Telnyx (the long
    // codes cannot originate non-NANP SMS). The save succeeds and the
    // response says so.
    const res = await POST(request({ phone: "+85261234567" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { warning: string | null } };
    expect(body.data.warning).toMatch(/not reachable by SMS/);
  });

  it("returns no warning for a Canadian number (every profile covers NANP now)", async () => {
    const res = await POST(request({ phone: "+15145188192" }));
    const body = (await res.json()) as { data: { warning: string | null } };
    expect(body.data.warning).toBeNull();
  });

  it("view-as stays read-only", async () => {
    vi.mocked(isViewAsActive).mockResolvedValue(true);
    const res = await POST(request({ phone: "+16025550147" }));
    expect(res.status).toBe(403);
    expect(updateBusinessProfileFields).not.toHaveBeenCalled();
  });
});
