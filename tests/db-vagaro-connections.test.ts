import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
// Deterministic envelope so assertions don't depend on env keys.
vi.mock("@/lib/integrations/secrets", () => ({
  encryptIntegrationSecret: vi.fn((v: string | null | undefined) =>
    v ? `enc(${v})` : null
  ),
  decryptIntegrationSecret: vi.fn((v: string | null | undefined) => {
    if (!v) return null;
    const m = /^enc\((.*)\)$/.exec(v);
    return m ? m[1] : v;
  })
}));

import {
  deleteVagaroConnection,
  getActiveVagaroConnection,
  getActiveVagaroConnectionId,
  getPublicVagaroConnection,
  getVagaroConnection,
  setVagaroBookingDefaults,
  toPublicVagaroConnection,
  upsertVagaroConnection,
  VagaroConnectionValidationError,
  validateVagaroApiBaseUrl
} from "@/lib/db/vagaro-connections";

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
  id: "vg-1",
  business_id: BIZ,
  client_id: "client-abc",
  client_secret_encrypted: "enc(shhh)",
  api_base_url: "https://api.vagaro.com",
  webhook_verification_token: "tok123",
  default_service_id: null,
  default_employee_id: null,
  is_active: true,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z"
};

describe("validateVagaroApiBaseUrl", () => {
  it("accepts a bare https origin and strips trailing slashes", () => {
    expect(validateVagaroApiBaseUrl("https://api.vagaro.com/")).toBe("https://api.vagaro.com");
    expect(validateVagaroApiBaseUrl(" https://usa03.vagaro.com:8443 ")).toBe(
      "https://usa03.vagaro.com:8443"
    );
  });

  it("rejects http, paths, and junk", () => {
    for (const bad of ["http://api.vagaro.com", "https://api.vagaro.com/v3", "not a url"]) {
      expect(() => validateVagaroApiBaseUrl(bad)).toThrow(VagaroConnectionValidationError);
    }
  });
});

describe("toPublicVagaroConnection", () => {
  it("drops the ciphertext and reports has_secret", () => {
    const pub = toPublicVagaroConnection(STORED as never);
    expect(pub).not.toHaveProperty("client_secret_encrypted");
    expect(pub.has_secret).toBe(true);
  });
});

describe("getVagaroConnection", () => {
  it("returns null when no row exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getVagaroConnection(BIZ, makeDb(c))).toBeNull();
  });

  it("decrypts the stored secret", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const row = await getVagaroConnection(BIZ, makeDb(c));
    expect(row?.clientSecret).toBe("shhh");
    expect(row).not.toHaveProperty("client_secret_encrypted");
  });

  it("throws on a query error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getVagaroConnection(BIZ, makeDb(c))).rejects.toThrow(/boom/);
  });

  it("fails closed when the stored secret decrypts to nothing", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({
      data: { ...STORED, client_secret_encrypted: "" },
      error: null
    });
    await expect(getVagaroConnection(BIZ, makeDb(c))).rejects.toThrow(/no stored client secret/);
  });
});

describe("getActiveVagaroConnection", () => {
  it("returns null for an inactive row", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { ...STORED, is_active: false }, error: null });
    expect(await getActiveVagaroConnection(BIZ, makeDb(c))).toBeNull();
  });

  it("returns the active row", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    expect((await getActiveVagaroConnection(BIZ, makeDb(c)))?.id).toBe("vg-1");
  });
});

describe("getActiveVagaroConnectionId", () => {
  it("returns the id for an active connection and null when absent", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "vg-1" }, error: null });
    expect(await getActiveVagaroConnectionId(BIZ, makeDb(c))).toBe("vg-1");

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getActiveVagaroConnectionId(BIZ, makeDb(c2))).toBeNull();
    expect(c2.eq).toHaveBeenCalledWith("is_active", true);
  });

  it("throws on a query error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(getActiveVagaroConnectionId(BIZ, makeDb(c))).rejects.toThrow(/down/);
  });
});

describe("getPublicVagaroConnection", () => {
  it("returns the masked row / null / throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const pub = await getPublicVagaroConnection(BIZ, makeDb(c));
    expect(pub?.has_secret).toBe(true);

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getPublicVagaroConnection(BIZ, makeDb(c2))).toBeNull();

    const c3 = chain();
    c3.maybeSingle.mockResolvedValue({ data: null, error: { message: "err" } });
    await expect(getPublicVagaroConnection(BIZ, makeDb(c3))).rejects.toThrow(/err/);
  });
});

describe("upsertVagaroConnection", () => {
  it("rejects an invalid client id", async () => {
    await expect(
      upsertVagaroConnection({ businessId: BIZ, clientId: "  " }, makeDb(chain()))
    ).rejects.toThrow(VagaroConnectionValidationError);
    await expect(
      upsertVagaroConnection({ businessId: BIZ, clientId: "x".repeat(201) }, makeDb(chain()))
    ).rejects.toThrow(/1-200/);
  });

  it("throws on an existence-check error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "read fail" } });
    await expect(
      upsertVagaroConnection(
        { businessId: BIZ, clientId: "client-abc", clientSecret: "s" },
        makeDb(c)
      )
    ).rejects.toThrow(/read fail/);
  });

  it("requires a secret on first connect", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(
      upsertVagaroConnection({ businessId: BIZ, clientId: "client-abc" }, makeDb(c))
    ).rejects.toThrow(/Client Secret is required/);
  });

  it("creates a row with an encrypted secret and a fresh webhook token", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    const pub = await upsertVagaroConnection(
      {
        businessId: BIZ,
        clientId: " client-abc ",
        clientSecret: "shhh",
        apiBaseUrl: "https://api.vagaro.com/",
        isActive: true
      },
      makeDb(c)
    );
    expect(pub.has_secret).toBe(true);
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.client_id).toBe("client-abc");
    expect(inserted.client_secret_encrypted).toBe("enc(shhh)");
    expect(inserted.api_base_url).toBe("https://api.vagaro.com");
    expect(inserted.is_active).toBe(true);
    expect(String(inserted.webhook_verification_token)).toMatch(/^[0-9a-f]{48}$/);
  });

  it("surfaces an insert error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: null, error: { message: "insert fail" } });
    await expect(
      upsertVagaroConnection(
        { businessId: BIZ, clientId: "client-abc", clientSecret: "s" },
        makeDb(c)
      )
    ).rejects.toThrow(/insert fail/);
  });

  it("defaults the API host on create when none is supplied", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertVagaroConnection(
      { businessId: BIZ, clientId: "client-abc", clientSecret: "s" },
      makeDb(c)
    );
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.api_base_url).toBe("https://api.vagaro.com");
  });

  it("updates in place, keeping the stored secret AND regional URL when omitted", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "vg-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertVagaroConnection(
      { businessId: BIZ, clientId: "client-new", isActive: false },
      makeDb(c)
    );
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.client_id).toBe("client-new");
    expect(patch).not.toHaveProperty("client_secret_encrypted");
    // A credentials-only save must never reset a merchant's regional host.
    expect(patch).not.toHaveProperty("api_base_url");
    expect(patch.is_active).toBe(false);
  });

  it("writes an explicitly-supplied API host on update", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "vg-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertVagaroConnection(
      { businessId: BIZ, clientId: "client-new", apiBaseUrl: "https://usa03.vagaro.com" },
      makeDb(c)
    );
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.api_base_url).toBe("https://usa03.vagaro.com");
  });

  it("rotates the secret when a new one is supplied and surfaces update errors", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "vg-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertVagaroConnection(
      { businessId: BIZ, clientId: "client-abc", clientSecret: "new-secret" },
      makeDb(c)
    );
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.client_secret_encrypted).toBe("enc(new-secret)");

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: { id: "vg-1" }, error: null });
    c2.single.mockResolvedValue({ data: null, error: { message: "update fail" } });
    await expect(
      upsertVagaroConnection({ businessId: BIZ, clientId: "client-abc" }, makeDb(c2))
    ).rejects.toThrow(/update fail/);
  });
});

describe("setVagaroBookingDefaults", () => {
  it("patches only the provided defaults", async () => {
    const c = chain({ error: null });
    await setVagaroBookingDefaults(BIZ, { defaultServiceId: "svc-1" }, makeDb(c));
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.default_service_id).toBe("svc-1");
    expect(patch).not.toHaveProperty("default_employee_id");

    const c2 = chain({ error: null });
    await setVagaroBookingDefaults(
      BIZ,
      { defaultServiceId: null, defaultEmployeeId: "emp-2" },
      makeDb(c2)
    );
    const patch2 = c2.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch2.default_service_id).toBeNull();
    expect(patch2.default_employee_id).toBe("emp-2");

    // Employee-only patch: the service key must stay untouched entirely.
    const c3 = chain({ error: null });
    await setVagaroBookingDefaults(BIZ, { defaultEmployeeId: "emp-3" }, makeDb(c3));
    const patch3 = c3.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch3).not.toHaveProperty("default_service_id");
    expect(patch3.default_employee_id).toBe("emp-3");
  });

  it("coerces explicitly-undefined defaults to null clears", async () => {
    const c = chain({ error: null });
    await setVagaroBookingDefaults(
      BIZ,
      { defaultServiceId: undefined, defaultEmployeeId: undefined },
      makeDb(c)
    );
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.default_service_id).toBeNull();
    expect(patch.default_employee_id).toBeNull();
  });

  it("throws on error", async () => {
    const c = chain({ error: { message: "patch fail" } });
    await expect(
      setVagaroBookingDefaults(BIZ, { defaultServiceId: "svc-1" }, makeDb(c))
    ).rejects.toThrow(/patch fail/);
  });
});

describe("default service client", () => {
  it("falls back to createSupabaseServiceClient when no client is passed", async () => {
    // One call per helper that owns a `client ?? createSupabaseServiceClient()`
    // fallback, so the default-client arm is exercised everywhere.
    const c = chain({ error: null });
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));

    expect(await getVagaroConnection(BIZ)).toBeNull();
    expect(await getActiveVagaroConnectionId(BIZ)).toBeNull();
    expect(await getPublicVagaroConnection(BIZ)).toBeNull();
    await upsertVagaroConnection({ businessId: BIZ, clientId: "cid", clientSecret: "s" });
    await setVagaroBookingDefaults(BIZ, { defaultServiceId: "svc-1" });
    await deleteVagaroConnection(BIZ);
    expect(defaultClientSpy).toHaveBeenCalledTimes(6);
  });
});

describe("deleteVagaroConnection", () => {
  it("deletes by business id and throws on error", async () => {
    const c = chain({ error: null });
    const db = makeDb(c);
    await deleteVagaroConnection(BIZ, db);
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);

    const c2 = chain({ error: { message: "del fail" } });
    await expect(deleteVagaroConnection(BIZ, makeDb(c2))).rejects.toThrow(/del fail/);
  });
});
