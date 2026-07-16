/**
 * Tests for the WhatsApp connections data layer
 * (src/lib/db/whatsapp-connections.ts): token encryption round-trips,
 * masked public projections, phone-number-id routing lookups, upsert
 * validation, template-status merges, and pause/delete.
 */
import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

vi.mock("@/lib/integrations/secrets", () => ({
  encryptIntegrationSecret: (v: string | null) => (v == null ? null : `enc(${v})`),
  decryptIntegrationSecret: (v: string | null) =>
    v == null ? null : v.replace(/^enc\((.*)\)$/, "$1")
}));

import {
  WhatsAppConnectionValidationError,
  deleteWhatsAppConnection,
  isWabaClaimedByOtherBusiness,
  getActiveWhatsAppConnectionByPhoneNumberId,
  getPublicWhatsAppConnection,
  getWhatsAppConnection,
  getWhatsAppPhoneNumberClaim,
  saveWhatsAppConnection,
  setWhatsAppConnectionActive,
  toPublicWhatsAppConnection,
  updateWhatsAppTemplates
} from "@/lib/db/whatsapp-connections";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(terminal?: unknown): Chain & PromiseLike<unknown> {
  const c = {
    select: vi.fn(() => c),
    upsert: vi.fn(() => c),
    update: vi.fn(() => c),
    delete: vi.fn(() => c),
    eq: vi.fn(() => c),
    neq: vi.fn(() => c),
    limit: vi.fn(() => c),
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
  id: "wc-1",
  business_id: BIZ,
  waba_id: "waba-9",
  phone_number_id: "pn-9",
  display_phone_number: "+1 555-010-0000",
  access_token_encrypted: "enc(business-token)",
  templates: { nc_owner_alert: { status: "APPROVED", language: "en_US" } },
  is_active: true,
  created_at: "2026-07-16T00:00:00Z",
  updated_at: "2026-07-16T00:00:00Z"
};

describe("toPublicWhatsAppConnection", () => {
  it("drops the encrypted token", () => {
    const pub = toPublicWhatsAppConnection(STORED as never);
    expect(pub).not.toHaveProperty("access_token_encrypted");
    expect(pub.phone_number_id).toBe("pn-9");
  });
});

describe("reads", () => {
  it("getWhatsAppConnection decrypts; null when absent; throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const row = await getWhatsAppConnection(BIZ, makeDb(c));
    expect(row?.accessToken).toBe("business-token");
    expect(row).not.toHaveProperty("access_token_encrypted");

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getWhatsAppConnection(BIZ, makeDb(c2))).toBeNull();

    const c3 = chain();
    c3.maybeSingle.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(getWhatsAppConnection(BIZ, makeDb(c3))).rejects.toThrow(/down/);
  });

  it("getPublicWhatsAppConnection masks; null when absent; throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const pub = await getPublicWhatsAppConnection(BIZ, makeDb(c));
    expect(pub).not.toHaveProperty("access_token_encrypted");
    expect(pub).not.toHaveProperty("accessToken");

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getPublicWhatsAppConnection(BIZ, makeDb(c2))).toBeNull();

    const c3 = chain();
    c3.maybeSingle.mockResolvedValue({ data: null, error: { message: "pub down" } });
    await expect(getPublicWhatsAppConnection(BIZ, makeDb(c3))).rejects.toThrow(/pub down/);
  });

  it("routes webhooks by phone_number_id filtered to active connections", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const row = await getActiveWhatsAppConnectionByPhoneNumberId("pn-9", makeDb(c));
    expect(row?.accessToken).toBe("business-token");
    expect(c.eq).toHaveBeenCalledWith("phone_number_id", "pn-9");
    expect(c.eq).toHaveBeenCalledWith("is_active", true);

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getActiveWhatsAppConnectionByPhoneNumberId("pn-9", makeDb(c2))).toBeNull();

    const c3 = chain();
    c3.maybeSingle.mockResolvedValue({ data: null, error: { message: "route down" } });
    await expect(
      getActiveWhatsAppConnectionByPhoneNumberId("pn-9", makeDb(c3))
    ).rejects.toThrow(/route down/);
  });

  it("isWabaClaimedByOtherBusiness detects sharing / exclusivity / errors", async () => {
    const c = chain({ data: [{ business_id: "other-biz" }], error: null });
    c.eq.mockImplementation(() => c);
    (c as unknown as { neq: unknown }).neq = vi.fn(() => c);
    (c as unknown as { limit: unknown }).limit = vi.fn(() => c);
    expect(await isWabaClaimedByOtherBusiness("waba-9", BIZ, makeDb(c))).toBe(true);

    const c2 = chain({ data: [], error: null });
    (c2 as unknown as { neq: unknown }).neq = vi.fn(() => c2);
    (c2 as unknown as { limit: unknown }).limit = vi.fn(() => c2);
    expect(await isWabaClaimedByOtherBusiness("waba-9", BIZ, makeDb(c2))).toBe(false);

    const c2b = chain({ data: null, error: null });
    (c2b as unknown as { neq: unknown }).neq = vi.fn(() => c2b);
    (c2b as unknown as { limit: unknown }).limit = vi.fn(() => c2b);
    expect(await isWabaClaimedByOtherBusiness("waba-9", BIZ, makeDb(c2b))).toBe(false);

    const c3 = chain({ data: null, error: { message: "waba claim down" } });
    (c3 as unknown as { neq: unknown }).neq = vi.fn(() => c3);
    (c3 as unknown as { limit: unknown }).limit = vi.fn(() => c3);
    await expect(isWabaClaimedByOtherBusiness("waba-9", BIZ, makeDb(c3))).rejects.toThrow(
      /waba claim down/
    );
  });

  it("getWhatsAppPhoneNumberClaim returns the holder / null / throws", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { business_id: BIZ }, error: null });
    expect(await getWhatsAppPhoneNumberClaim("pn-9", makeDb(c))).toEqual({
      business_id: BIZ
    });

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getWhatsAppPhoneNumberClaim("pn-9", makeDb(c2))).toBeNull();

    const c3 = chain();
    c3.maybeSingle.mockResolvedValue({ data: null, error: { message: "claim down" } });
    await expect(getWhatsAppPhoneNumberClaim("pn-9", makeDb(c3))).rejects.toThrow(
      /claim down/
    );
  });
});

describe("saveWhatsAppConnection", () => {
  const INPUT = {
    businessId: BIZ,
    wabaId: "waba-9",
    phoneNumberId: "pn-9",
    displayPhoneNumber: "+1 555-010-0000",
    accessToken: " business-token ",
    templates: { nc_owner_alert: { status: "PENDING", language: "en_US" } }
  };

  it("rejects empty/oversized tokens and missing ids", async () => {
    await expect(
      saveWhatsAppConnection({ ...INPUT, accessToken: "  " }, makeDb(chain()))
    ).rejects.toThrow(WhatsAppConnectionValidationError);
    await expect(
      saveWhatsAppConnection({ ...INPUT, accessToken: "x".repeat(4097) }, makeDb(chain()))
    ).rejects.toThrow(/1-4096/);
    await expect(
      saveWhatsAppConnection({ ...INPUT, wabaId: " " }, makeDb(chain()))
    ).rejects.toThrow(/required/);
    await expect(
      saveWhatsAppConnection({ ...INPUT, phoneNumberId: "" }, makeDb(chain()))
    ).rejects.toThrow(/required/);
  });

  it("upserts on business_id with the encrypted trimmed token", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: STORED, error: null });
    const pub = await saveWhatsAppConnection(INPUT, makeDb(c));
    expect(pub.waba_id).toBe("waba-9");
    const [row, opts] = c.upsert.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(row.access_token_encrypted).toBe("enc(business-token)");
    expect(row.waba_id).toBe("waba-9");
    expect(row.is_active).toBe(true);
    expect(opts).toEqual({ onConflict: "business_id" });
  });

  it("surfaces upsert errors", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "save fail" } });
    await expect(saveWhatsAppConnection(INPUT, makeDb(c))).rejects.toThrow(/save fail/);
  });
});

describe("updates", () => {
  it("merges template statuses and throws on error", async () => {
    const c = chain();
    c.eq.mockReturnValue(Promise.resolve({ error: null }));
    await updateWhatsAppTemplates(
      BIZ,
      { nc_owner_alert: { status: "APPROVED", language: "en_US" } },
      makeDb(c)
    );
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.templates).toEqual({
      nc_owner_alert: { status: "APPROVED", language: "en_US" }
    });

    const c2 = chain();
    c2.eq.mockReturnValue(Promise.resolve({ error: { message: "tmpl fail" } }));
    await expect(updateWhatsAppTemplates(BIZ, {}, makeDb(c2))).rejects.toThrow(/tmpl fail/);
  });

  it("toggles is_active and throws on error", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { ...STORED, is_active: false }, error: null });
    const pub = await setWhatsAppConnectionActive(BIZ, false, makeDb(c));
    expect(pub.is_active).toBe(false);
    expect((c.update.mock.calls[0][0] as Record<string, unknown>).is_active).toBe(false);

    const c2 = chain();
    c2.single.mockResolvedValue({ data: null, error: { message: "toggle fail" } });
    await expect(setWhatsAppConnectionActive(BIZ, true, makeDb(c2))).rejects.toThrow(
      /toggle fail/
    );
  });

  it("deletes by business id and throws on error", async () => {
    const c = chain({ error: null });
    await deleteWhatsAppConnection(BIZ, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);

    const c2 = chain({ error: { message: "del fail" } });
    await expect(deleteWhatsAppConnection(BIZ, makeDb(c2))).rejects.toThrow(/del fail/);
  });
});

describe("default service client", () => {
  it("falls back to createSupabaseServiceClient when no client is passed", async () => {
    const c = chain({ error: null });
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    c.eq.mockImplementation(() => c);
    defaultClientSpy.mockReturnValue(makeDb(c));

    expect(await getWhatsAppConnection(BIZ)).toBeNull();
    expect(await getPublicWhatsAppConnection(BIZ)).toBeNull();
    expect(await getActiveWhatsAppConnectionByPhoneNumberId("pn-9")).toBeNull();
    expect(await getWhatsAppPhoneNumberClaim("pn-9")).toBeNull();
    await saveWhatsAppConnection(
      {
        businessId: BIZ,
        wabaId: "w",
        phoneNumberId: "p",
        displayPhoneNumber: null,
        accessToken: "t",
        templates: {}
      }
    );
    await setWhatsAppConnectionActive(BIZ, true);
    await updateWhatsAppTemplates(BIZ, {});
    (c as unknown as { neq: unknown }).neq = vi.fn(() => c);
    expect(await isWabaClaimedByOtherBusiness("waba-9", BIZ)).toBe(false);
    await deleteWhatsAppConnection(BIZ);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});
