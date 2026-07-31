/**
 * The Acuity connect endpoint, which is the only way an
 * `acuity_connections` row comes into existence.
 *
 * The behaviors worth pinning are the ones an owner would otherwise
 * discover the hard way: a rejected key must still SAVE the row (so a typo
 * is fixable with another save) while reporting honestly that it was
 * rejected, and connecting Acuity while Vagaro is live must say so, because
 * Vagaro wins calendar resolution and the new connection would silently do
 * nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getAuthUser: vi.fn(), requireBusinessRole: vi.fn() }));
vi.mock("@/lib/db/acuity-connections", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/acuity-connections")>(
    "@/lib/db/acuity-connections"
  );
  return {
    AcuityConnectionValidationError: actual.AcuityConnectionValidationError,
    deleteAcuityConnection: vi.fn(),
    getAcuityConnection: vi.fn(),
    getPublicAcuityConnection: vi.fn(),
    setAcuityBookingDefaults: vi.fn(),
    upsertAcuityConnection: vi.fn()
  };
});
vi.mock("@/lib/db/vagaro-connections", () => ({ getActiveVagaroConnectionId: vi.fn() }));
vi.mock("@/lib/acuity/webhook-registration", () => ({
  acuityWebhookCallbackUrl: vi.fn(() => "https://app/api/webhooks/acuity?business=x&token=y"),
  ensureAcuityWebhooks: vi.fn(),
  recheckAcuityWebhooks: vi.fn(),
  teardownAcuityWebhooks: vi.fn()
}));
vi.mock("@/lib/acuity/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/acuity/client")>(
    "@/lib/acuity/client"
  );
  return {
    AcuityApiError: actual.AcuityApiError,
    clearAcuityCaches: vi.fn(),
    listAcuityAppointmentTypes: vi.fn(),
    listAcuityCalendars: vi.fn(),
    verifyAcuityCredentials: vi.fn()
  };
});
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { DELETE, GET, PATCH, POST } from "@/app/api/integrations/acuity/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  deleteAcuityConnection,
  getAcuityConnection,
  getPublicAcuityConnection,
  setAcuityBookingDefaults,
  upsertAcuityConnection
} from "@/lib/db/acuity-connections";
import { getActiveVagaroConnectionId } from "@/lib/db/vagaro-connections";
import {
  ensureAcuityWebhooks,
  recheckAcuityWebhooks,
  teardownAcuityWebhooks
} from "@/lib/acuity/webhook-registration";
import {
  AcuityApiError,
  clearAcuityCaches,
  listAcuityAppointmentTypes,
  listAcuityCalendars,
  verifyAcuityCredentials
} from "@/lib/acuity/client";

const BIZ = "11111111-1111-4111-8111-111111111111";

const PUBLIC_ROW = {
  id: "ac-1",
  business_id: BIZ,
  user_id: "12345",
  api_base_url: "https://acuityscheduling.com",
  webhook_verification_token: "tok",
  default_appointment_type_id: null,
  default_calendar_id: null,
  default_calendar_timezone: null,
  suppress_provider_emails: true,
  webhook_registration: {},
  is_active: true,
  has_api_key: true,
  created_at: "",
  updated_at: ""
};

function req(body: unknown) {
  return new Request("https://x/api/integrations/acuity", {
    method: "POST",
    body: JSON.stringify(body)
  });
}

async function json(res: Response) {
  return (await res.json()) as { data?: Record<string, unknown>; error?: { message?: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue({ email: "o@x.co", isAdmin: false } as never);
  vi.mocked(requireBusinessRole).mockResolvedValue(undefined as never);
  vi.mocked(getActiveVagaroConnectionId).mockResolvedValue(null);
  vi.mocked(getPublicAcuityConnection).mockResolvedValue(PUBLIC_ROW as never);
  vi.mocked(getAcuityConnection).mockResolvedValue({ ...PUBLIC_ROW, apiKey: "k" } as never);
  vi.mocked(upsertAcuityConnection).mockResolvedValue(PUBLIC_ROW as never);
  vi.mocked(verifyAcuityCredentials).mockResolvedValue({
    id: "12345",
    email: "owner@shop.com",
    timezone: "America/Denver"
  } as never);
  vi.mocked(listAcuityAppointmentTypes).mockResolvedValue([] as never);
  vi.mocked(listAcuityCalendars).mockResolvedValue([] as never);
});

describe("GET", () => {
  it("requires a businessId", async () => {
    const res = await GET(new Request("https://x/api/integrations/acuity"));
    expect(res.status).not.toBe(200);
    expect((await json(res)).error?.message).toMatch(/businessId/);
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await GET(new Request(`https://x/api/integrations/acuity?businessId=${BIZ}`));
    expect((await json(res)).error?.message).toMatch(/Authentication/);
  });

  it("reports when Vagaro is already handling booking", async () => {
    // Vagaro wins calendar resolution, so an Acuity connection made while it
    // is live would never be consulted. Say so rather than let the owner
    // wonder why nothing happens.
    vi.mocked(getActiveVagaroConnectionId).mockResolvedValue("vg-1" as never);
    const res = await GET(new Request(`https://x/api/integrations/acuity?businessId=${BIZ}`));
    expect((await json(res)).data).toMatchObject({ otherBookingProviderActive: "vagaro" });
  });

  it("omits the catalog unless asked, and includes it on request", async () => {
    const bare = await json(
      await GET(new Request(`https://x/api/integrations/acuity?businessId=${BIZ}`))
    );
    expect(bare.data).not.toHaveProperty("appointmentTypes");

    const withCatalog = await json(
      await GET(new Request(`https://x/api/integrations/acuity?businessId=${BIZ}&catalog=1`))
    );
    expect(withCatalog.data).toMatchObject({ appointmentTypes: [], catalogError: null });
  });

  it("rechecks the webhook registration on a dashboard load", async () => {
    // Acuity disables a webhook after five days of failure and never says
    // so. The recheck self-limits to once a day, so this is cheap.
    await GET(new Request(`https://x/api/integrations/acuity?businessId=${BIZ}&catalog=1`));
    expect(vi.mocked(recheckAcuityWebhooks)).toHaveBeenCalled();
  });

  it("returns the connection as it stands AFTER the recheck", async () => {
    // The recheck can rewrite webhook_registration; returning the row read
    // before it would show stale status until the next load.
    const after = { ...PUBLIC_ROW, webhook_registration: { status: "registered" } };
    vi.mocked(getPublicAcuityConnection)
      .mockResolvedValueOnce(PUBLIC_ROW as never)
      .mockResolvedValueOnce(after as never);
    const res = await json(
      await GET(new Request(`https://x/api/integrations/acuity?businessId=${BIZ}&catalog=1`))
    );
    expect((res.data as { connection: typeof after }).connection.webhook_registration).toEqual({
      status: "registered"
    });
  });

  it("does not let a failing recheck take down the dashboard read", async () => {
    vi.mocked(recheckAcuityWebhooks).mockRejectedValue(new Error("acuity down"));
    const res = await GET(
      new Request(`https://x/api/integrations/acuity?businessId=${BIZ}&catalog=1`)
    );
    expect(res.status).toBe(200);
  });

  it("skips the recheck when the bare state is requested", async () => {
    await GET(new Request(`https://x/api/integrations/acuity?businessId=${BIZ}`));
    expect(vi.mocked(recheckAcuityWebhooks)).not.toHaveBeenCalled();
  });

  it("reports a catalog read failure without hiding the saved connection", async () => {
    vi.mocked(listAcuityAppointmentTypes).mockRejectedValue(
      new AcuityApiError("auth_failed", "nope", 401)
    );
    const res = await json(
      await GET(new Request(`https://x/api/integrations/acuity?businessId=${BIZ}&catalog=1`))
    );
    expect(res.data).toMatchObject({ catalogError: "auth_failed" });
    expect((res.data as { connection: unknown }).connection).toBeTruthy();
  });

  it("reports request_failed when the row vanished between reads", async () => {
    vi.mocked(getAcuityConnection).mockResolvedValue(null as never);
    const res = await json(
      await GET(new Request(`https://x/api/integrations/acuity?businessId=${BIZ}&catalog=1`))
    );
    expect(res.data).toMatchObject({ catalogError: "request_failed" });
  });
});

describe("POST", () => {
  it("saves, verifies, and caches the account timezone", async () => {
    const res = await json(await POST(req({ businessId: BIZ, userId: "12345", apiKey: "k" })));
    expect(res.data).toMatchObject({ verified: true });
    // The booking hot path should never have to ask Acuity what zone the
    // merchant is in.
    expect(vi.mocked(setAcuityBookingDefaults)).toHaveBeenCalledWith(BIZ, {
      defaultCalendarTimezone: "America/Denver"
    });
    // A credential rotation must not serve a catalog cached under the old key.
    expect(vi.mocked(clearAcuityCaches)).toHaveBeenCalled();
    // Webhooks are registered only once the key is known to work.
    expect(vi.mocked(ensureAcuityWebhooks)).toHaveBeenCalled();
  });

  it("does not register webhooks when the key was rejected", async () => {
    vi.mocked(verifyAcuityCredentials).mockRejectedValue(
      new AcuityApiError("auth_failed", "nope", 401)
    );
    await POST(req({ businessId: BIZ, userId: "12345", apiKey: "bad" }));
    expect(vi.mocked(ensureAcuityWebhooks)).not.toHaveBeenCalled();
  });

  it("KEEPS the row when Acuity rejects the key, and says so", async () => {
    // The owner must be able to fix a typo with another save rather than
    // starting over.
    vi.mocked(verifyAcuityCredentials).mockRejectedValue(
      new AcuityApiError("auth_failed", "nope", 401)
    );
    const res = await json(await POST(req({ businessId: BIZ, userId: "12345", apiKey: "bad" })));
    expect(res.data).toMatchObject({ verified: false, verifyError: "auth_failed" });
    expect((res.data as { connection: unknown }).connection).toBeTruthy();
  });

  it("reports a generic failure for a non-Acuity error", async () => {
    vi.mocked(verifyAcuityCredentials).mockRejectedValue(new Error("boom"));
    const res = await json(await POST(req({ businessId: BIZ, userId: "12345", apiKey: "k" })));
    expect(res.data).toMatchObject({ verified: false, verifyError: "request_failed" });
  });

  it("stays verified when post-verification bookkeeping fails", async () => {
    // The key already authenticated. Reporting "Acuity rejected the
    // credentials" because a follow-up write failed would send the owner
    // hunting a typo that is not there.
    vi.mocked(setAcuityBookingDefaults).mockRejectedValue(new Error("db down"));
    const res = await json(await POST(req({ businessId: BIZ, userId: "12345", apiKey: "k" })));
    expect(res.data).toMatchObject({ verified: true });
    expect(res.data).not.toHaveProperty("verifyError");
  });

  it("skips the timezone cache when the account reports none", async () => {
    vi.mocked(verifyAcuityCredentials).mockResolvedValue({
      id: "1",
      email: null,
      timezone: null
    } as never);
    await POST(req({ businessId: BIZ, userId: "12345", apiKey: "k" }));
    expect(vi.mocked(setAcuityBookingDefaults)).not.toHaveBeenCalled();
  });

  it("surfaces a validation error as a validation error", async () => {
    const { AcuityConnectionValidationError } = await vi.importActual<
      typeof import("@/lib/db/acuity-connections")
    >("@/lib/db/acuity-connections");
    vi.mocked(upsertAcuityConnection).mockRejectedValue(
      new AcuityConnectionValidationError("api_key_required", "API Key is required")
    );
    const res = await json(await POST(req({ businessId: BIZ, userId: "12345" })));
    expect(res.error?.message).toMatch(/API Key is required/);
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await json(await POST(req({ businessId: BIZ, userId: "1", apiKey: "k" })));
    expect(res.error?.message).toMatch(/Authentication/);
  });
});

describe("PATCH", () => {
  it("writes only the defaults supplied", async () => {
    await PATCH(req({ businessId: BIZ, defaultAppointmentTypeId: "7" }));
    expect(vi.mocked(setAcuityBookingDefaults)).toHaveBeenCalledWith(BIZ, {
      defaultAppointmentTypeId: "7"
    });
  });

  it("toggles Acuity's own customer emails", async () => {
    await PATCH(req({ businessId: BIZ, suppressProviderEmails: false }));
    expect(vi.mocked(setAcuityBookingDefaults)).toHaveBeenCalledWith(BIZ, {
      suppressProviderEmails: false
    });
  });

  it("flips is_active without touching credentials", async () => {
    await PATCH(req({ businessId: BIZ, isActive: false }));
    const call = vi.mocked(upsertAcuityConnection).mock.calls[0][0];
    expect(call).toMatchObject({ businessId: BIZ, userId: "12345", isActive: false });
    expect(call).not.toHaveProperty("apiKey");
  });

  it("is a no-op when there is nothing to disable", async () => {
    vi.mocked(getPublicAcuityConnection).mockResolvedValue(null as never);
    await PATCH(req({ businessId: BIZ, isActive: false }));
    expect(vi.mocked(upsertAcuityConnection)).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await json(await PATCH(req({ businessId: BIZ, isActive: true })));
    expect(res.error?.message).toMatch(/Authentication/);
  });
});

describe("DELETE", () => {
  it("tears the webhooks down BEFORE the row, then removes it", async () => {
    // Teardown needs the API key, so it cannot run after the delete.
    const res = await json(await DELETE(req({ businessId: BIZ })));
    expect(res.data).toMatchObject({ deleted: true });
    expect(vi.mocked(teardownAcuityWebhooks)).toHaveBeenCalled();
    expect(vi.mocked(deleteAcuityConnection)).toHaveBeenCalledWith(BIZ);
    expect(vi.mocked(clearAcuityCaches)).toHaveBeenCalled();
  });

  it("still deletes when there is no row to tear down", async () => {
    vi.mocked(getAcuityConnection).mockResolvedValue(null as never);
    await DELETE(req({ businessId: BIZ }));
    expect(vi.mocked(teardownAcuityWebhooks)).not.toHaveBeenCalled();
    expect(vi.mocked(deleteAcuityConnection)).toHaveBeenCalledWith(BIZ);
  });

  it("refuses an unauthenticated caller", async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const res = await json(await DELETE(req({ businessId: BIZ })));
    expect(res.error?.message).toMatch(/Authentication/);
    expect(vi.mocked(deleteAcuityConnection)).not.toHaveBeenCalled();
  });
});

describe("authorization", () => {
  it("requires manage_settings for a non-admin", async () => {
    await GET(new Request(`https://x/api/integrations/acuity?businessId=${BIZ}`));
    expect(vi.mocked(requireBusinessRole)).toHaveBeenCalledWith(BIZ, "manage_settings");
  });

  it("lets an admin bypass the business-role check", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ email: "a@x.co", isAdmin: true } as never);
    await GET(new Request(`https://x/api/integrations/acuity?businessId=${BIZ}`));
    expect(vi.mocked(requireBusinessRole)).not.toHaveBeenCalled();
  });
});
