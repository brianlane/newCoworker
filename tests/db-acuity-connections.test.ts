/**
 * Tests for the Acuity connection store (src/lib/db/acuity-connections.ts).
 *
 * The properties that matter here are security ones: the API key is never
 * returned to the dashboard, the hot-path probe never decrypts, an empty
 * stored key fails closed rather than authenticating as nobody, and the
 * webhook token is never rotated by an update (which would silently break
 * every inbound delivery the owner already wired up).
 */
import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
// Deterministic envelope so assertions don't depend on env keys.
vi.mock("@/lib/integrations/secrets", () => ({
  encryptIntegrationSecret: vi.fn((v: string | null | undefined) => (v ? `enc(${v})` : null)),
  decryptIntegrationSecret: vi.fn((v: string | null | undefined) => {
    if (!v) return null;
    const m = /^enc\((.*)\)$/.exec(v);
    return m ? m[1] : v;
  })
}));

import {
  ACUITY_DEFAULT_API_BASE_URL,
  AcuityConnectionValidationError,
  deleteAcuityConnection,
  getAcuityConnection,
  getActiveAcuityConnection,
  getActiveAcuityConnectionId,
  getPublicAcuityConnection,
  readWebhookRegistration,
  setAcuityBookingDefaults,
  setAcuityWebhookRegistration,
  toPublicAcuityConnection,
  upsertAcuityConnection,
  validateAcuityApiBaseUrl
} from "@/lib/db/acuity-connections";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(terminal?: unknown): Chain & PromiseLike<unknown> {
  const c = {
    select: vi.fn(() => c),
    insert: vi.fn(() => c),
    update: vi.fn(() => c),
    delete: vi.fn(() => c),
    eq: vi.fn(() => c),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve)
  };
  return c as never;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

const BIZ = "11111111-1111-4111-8111-111111111111";

const STORED = {
  id: "ac-1",
  business_id: BIZ,
  user_id: "12345",
  api_key_encrypted: "enc(key-abc)",
  api_base_url: "https://acuityscheduling.com",
  webhook_verification_token: "tok123",
  default_appointment_type_id: null,
  default_calendar_id: null,
  default_calendar_timezone: null,
  suppress_provider_emails: true,
  webhook_registration: {},
  is_active: true,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z"
};

describe("validateAcuityApiBaseUrl", () => {
  it("accepts a bare https origin and strips trailing slashes", () => {
    expect(validateAcuityApiBaseUrl("https://acuityscheduling.com/")).toBe(
      "https://acuityscheduling.com"
    );
    expect(validateAcuityApiBaseUrl(" https://acuity.example.com:8443 ")).toBe(
      "https://acuity.example.com:8443"
    );
  });

  it("rejects http, paths, queries and junk", () => {
    for (const bad of [
      "http://acuityscheduling.com",
      "https://acuityscheduling.com/api/v1",
      "https://acuityscheduling.com?a=1",
      "not a url",
      ""
    ]) {
      expect(() => validateAcuityApiBaseUrl(bad)).toThrow(AcuityConnectionValidationError);
    }
  });
});

describe("readWebhookRegistration", () => {
  it("narrows a well-formed jsonb blob", () => {
    expect(
      readWebhookRegistration({
        ids: ["1", "2", 3],
        targetUrl: "https://x/y",
        registeredAt: "2026-08-01T00:00:00Z",
        status: "registered"
      })
    ).toEqual({
      ids: ["1", "2"],
      targetUrl: "https://x/y",
      registeredAt: "2026-08-01T00:00:00Z",
      status: "registered"
    });
  });

  it("defaults an empty or unknown blob to unsupported with no ids", () => {
    // Unsupported is the safe default: it makes the card show the manual
    // paste-this-URL fallback rather than claiming a registration exists.
    expect(readWebhookRegistration({})).toEqual({
      ids: [],
      targetUrl: null,
      registeredAt: null,
      status: "unsupported"
    });
    expect(readWebhookRegistration(null).status).toBe("unsupported");
    expect(readWebhookRegistration({ status: "wat" }).status).toBe("unsupported");
  });

  it("keeps the cap_reached status", () => {
    expect(readWebhookRegistration({ status: "cap_reached" }).status).toBe("cap_reached");
  });
});

describe("toPublicAcuityConnection", () => {
  it("replaces the ciphertext with a boolean and leaks nothing", () => {
    const pub = toPublicAcuityConnection(STORED);
    expect(pub.has_api_key).toBe(true);
    expect(JSON.stringify(pub)).not.toContain("key-abc");
    expect("api_key_encrypted" in pub).toBe(false);
    // The webhook token IS exposed: the owner may need to paste the URL.
    expect(pub.webhook_verification_token).toBe("tok123");
  });

  it("reports has_api_key false for an empty stored value", () => {
    expect(toPublicAcuityConnection({ ...STORED, api_key_encrypted: "" }).has_api_key).toBe(false);
  });
});

describe("reads", () => {
  it("decrypts the api key for server-side use", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const row = await getAcuityConnection(BIZ, makeDb(c));
    expect(row?.apiKey).toBe("key-abc");
    expect(row).not.toHaveProperty("api_key_encrypted");
  });

  it("returns null when there is no connection", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(getAcuityConnection(BIZ, makeDb(c))).resolves.toBeNull();
    await expect(getPublicAcuityConnection(BIZ, makeDb(c))).resolves.toBeNull();
  });

  it("fails closed on an empty stored key rather than authenticating as nobody", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { ...STORED, api_key_encrypted: "" }, error: null });
    await expect(getAcuityConnection(BIZ, makeDb(c))).rejects.toThrow(/no stored api key/);
  });

  it("hides an inactive row from the calendar-tool gate", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { ...STORED, is_active: false }, error: null });
    await expect(getActiveAcuityConnection(BIZ, makeDb(c))).resolves.toBeNull();
  });

  it("returns an active row from the gate", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    await expect(getActiveAcuityConnection(BIZ, makeDb(c))).resolves.toMatchObject({
      apiKey: "key-abc"
    });
  });

  it("probes by id only, never decrypting on the resolver hot path", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "ac-1" }, error: null });
    await expect(getActiveAcuityConnectionId(BIZ, makeDb(c))).resolves.toBe("ac-1");
    expect(c.select).toHaveBeenCalledWith("id");
    expect(c.eq).toHaveBeenCalledWith("is_active", true);
  });

  it("returns null from the probe when nothing is connected", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(getActiveAcuityConnectionId(BIZ, makeDb(c))).resolves.toBeNull();
  });

  it("masks the dashboard read", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const pub = await getPublicAcuityConnection(BIZ, makeDb(c));
    expect(pub?.has_api_key).toBe(true);
    expect(pub).not.toHaveProperty("api_key_encrypted");
  });

  it("surfaces read errors", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getAcuityConnection(BIZ, makeDb(c))).rejects.toThrow(/getAcuityConnection: boom/);
    await expect(getPublicAcuityConnection(BIZ, makeDb(c))).rejects.toThrow(
      /getPublicAcuityConnection: boom/
    );
    await expect(getActiveAcuityConnectionId(BIZ, makeDb(c))).rejects.toThrow(
      /getActiveAcuityConnectionId: boom/
    );
  });
});

describe("upsert", () => {
  it("creates with an encrypted key, the default origin, and a fresh token", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertAcuityConnection({ businessId: BIZ, userId: " 12345 ", apiKey: " key-abc " }, makeDb(c));
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.user_id).toBe("12345");
    expect(inserted.api_key_encrypted).toBe("enc(key-abc)");
    expect(inserted.api_base_url).toBe(ACUITY_DEFAULT_API_BASE_URL);
    expect(String(inserted.webhook_verification_token)).toHaveLength(48);
  });

  it("requires an api key on create", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(
      upsertAcuityConnection({ businessId: BIZ, userId: "12345" }, makeDb(c))
    ).rejects.toMatchObject({ validationCode: "api_key_required" });
  });

  it("rejects a missing or oversized user id", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    for (const userId of ["   ", "x".repeat(65)]) {
      await expect(
        upsertAcuityConnection({ businessId: BIZ, userId, apiKey: "k" }, makeDb(c))
      ).rejects.toMatchObject({ validationCode: "user_id_invalid" });
    }
  });

  it("keeps the stored key and origin when an update omits them", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "ac-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertAcuityConnection({ businessId: BIZ, userId: "12345" }, makeDb(c));
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("api_key_encrypted");
    expect(patch).not.toHaveProperty("api_base_url");
    // Rotating the webhook token on update would break every delivery the
    // owner already wired up in Acuity.
    expect(patch).not.toHaveProperty("webhook_verification_token");
  });

  it("re-encrypts when an update supplies a new key, and honors isActive", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "ac-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertAcuityConnection(
      {
        businessId: BIZ,
        userId: "12345",
        apiKey: "new-key",
        apiBaseUrl: "https://acuity.example.com",
        isActive: false
      },
      makeDb(c)
    );
    expect(c.update.mock.calls[0][0]).toMatchObject({
      api_key_encrypted: "enc(new-key)",
      api_base_url: "https://acuity.example.com",
      is_active: false
    });
  });

  it("passes isActive through on create", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertAcuityConnection(
      { businessId: BIZ, userId: "12345", apiKey: "k", isActive: false },
      makeDb(c)
    );
    expect(c.insert.mock.calls[0][0]).toMatchObject({ is_active: false });
  });

  it("surfaces read, insert and update errors", async () => {
    const readErr = chain();
    readErr.maybeSingle.mockResolvedValue({ data: null, error: { message: "read boom" } });
    await expect(
      upsertAcuityConnection({ businessId: BIZ, userId: "1", apiKey: "k" }, makeDb(readErr))
    ).rejects.toThrow(/read boom/);

    const insertErr = chain();
    insertErr.maybeSingle.mockResolvedValue({ data: null, error: null });
    insertErr.single.mockResolvedValue({ data: null, error: { message: "insert boom" } });
    await expect(
      upsertAcuityConnection({ businessId: BIZ, userId: "1", apiKey: "k" }, makeDb(insertErr))
    ).rejects.toThrow(/insert boom/);

    const updateErr = chain();
    updateErr.maybeSingle.mockResolvedValue({ data: { id: "ac-1" }, error: null });
    updateErr.single.mockResolvedValue({ data: null, error: { message: "update boom" } });
    await expect(
      upsertAcuityConnection({ businessId: BIZ, userId: "1" }, makeDb(updateErr))
    ).rejects.toThrow(/update boom/);
  });
});

describe("mutations", () => {
  it("writes only the defaults that were supplied", async () => {
    const c = chain({ error: null });
    await setAcuityBookingDefaults(BIZ, { defaultAppointmentTypeId: "7" }, makeDb(c));
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.default_appointment_type_id).toBe("7");
    expect(patch).not.toHaveProperty("default_calendar_id");
    expect(patch).not.toHaveProperty("suppress_provider_emails");
  });

  it("clears a default when passed null, and toggles email suppression", async () => {
    const c = chain({ error: null });
    await setAcuityBookingDefaults(
      BIZ,
      {
        defaultAppointmentTypeId: null,
        defaultCalendarId: null,
        defaultCalendarTimezone: "America/Denver",
        suppressProviderEmails: false
      },
      makeDb(c)
    );
    expect(c.update.mock.calls[0][0]).toMatchObject({
      default_appointment_type_id: null,
      default_calendar_id: null,
      default_calendar_timezone: "America/Denver",
      suppress_provider_emails: false
    });
  });

  it("writes every default when all are supplied with values", async () => {
    const c = chain({ error: null });
    await setAcuityBookingDefaults(
      BIZ,
      {
        defaultAppointmentTypeId: "7",
        defaultCalendarId: "9",
        defaultCalendarTimezone: "America/New_York",
        suppressProviderEmails: true
      },
      makeDb(c)
    );
    expect(c.update.mock.calls[0][0]).toMatchObject({
      default_appointment_type_id: "7",
      default_calendar_id: "9",
      default_calendar_timezone: "America/New_York",
      suppress_provider_emails: true
    });
  });

  it("coerces an explicitly undefined default to null rather than skipping it", async () => {
    const c = chain({ error: null });
    await setAcuityBookingDefaults(
      BIZ,
      { defaultCalendarId: undefined, defaultCalendarTimezone: undefined },
      makeDb(c)
    );
    expect(c.update.mock.calls[0][0]).toMatchObject({
      default_calendar_id: null,
      default_calendar_timezone: null
    });
  });

  it("persists the webhook registration blob", async () => {
    const c = chain({ error: null });
    const registration = {
      ids: ["1"],
      targetUrl: "https://x/y",
      registeredAt: "2026-08-01T00:00:00Z",
      status: "registered" as const
    };
    await setAcuityWebhookRegistration(BIZ, registration, makeDb(c));
    expect(c.update.mock.calls[0][0]).toMatchObject({ webhook_registration: registration });
  });

  it("deletes the connection", async () => {
    const c = chain({ error: null });
    await deleteAcuityConnection(BIZ, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
  });

  it("surfaces mutation errors", async () => {
    const c = chain({ error: { message: "boom" } });
    await expect(setAcuityBookingDefaults(BIZ, {}, makeDb(c))).rejects.toThrow(
      /setAcuityBookingDefaults: boom/
    );
    await expect(
      setAcuityWebhookRegistration(
        BIZ,
        { ids: [], targetUrl: null, registeredAt: null, status: "unsupported" },
        makeDb(c)
      )
    ).rejects.toThrow(/setAcuityWebhookRegistration: boom/);
    await expect(deleteAcuityConnection(BIZ, makeDb(c))).rejects.toThrow(
      /deleteAcuityConnection: boom/
    );
  });
});

describe("default client", () => {
  it("falls back to the service client on every helper", async () => {
    const c = chain({ error: null });
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));

    await expect(getAcuityConnection(BIZ)).resolves.toBeNull();
    await expect(getPublicAcuityConnection(BIZ)).resolves.toBeNull();
    await expect(getActiveAcuityConnectionId(BIZ)).resolves.toBeNull();
    await expect(
      upsertAcuityConnection({ businessId: BIZ, userId: "12345", apiKey: "k" })
    ).resolves.toMatchObject({ has_api_key: true });
    await setAcuityBookingDefaults(BIZ, { defaultCalendarId: "7" });
    await setAcuityWebhookRegistration(BIZ, {
      ids: [],
      targetUrl: null,
      registeredAt: null,
      status: "unsupported"
    });
    await deleteAcuityConnection(BIZ);

    expect(defaultClientSpy).toHaveBeenCalledTimes(7);
  });
});
