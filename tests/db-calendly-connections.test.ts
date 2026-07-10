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
  CalendlyConnectionValidationError,
  deleteCalendlyConnection,
  getActiveCalendlyConnection,
  getActiveCalendlyConnectionId,
  getCalendlyConnection,
  getPublicCalendlyConnection,
  toPublicCalendlyConnection,
  upsertCalendlyConnection
} from "@/lib/db/calendly-connections";

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
  id: "cl-1",
  business_id: BIZ,
  access_token_encrypted: "enc(pat-secret)",
  account_name: "Acme Spa",
  account_email: "owner@acme.com",
  is_active: true,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z"
};

describe("toPublicCalendlyConnection", () => {
  it("drops the ciphertext and reports has_token", () => {
    const pub = toPublicCalendlyConnection(STORED as never);
    expect(pub).not.toHaveProperty("access_token_encrypted");
    expect(pub.has_token).toBe(true);
  });
});

describe("getCalendlyConnection", () => {
  it("returns null when no row exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getCalendlyConnection(BIZ, makeDb(c))).toBeNull();
  });

  it("decrypts the stored token", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const row = await getCalendlyConnection(BIZ, makeDb(c));
    expect(row?.accessToken).toBe("pat-secret");
    expect(row).not.toHaveProperty("access_token_encrypted");
  });

  it("throws on a query error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getCalendlyConnection(BIZ, makeDb(c))).rejects.toThrow(/boom/);
  });

  it("fails closed when the stored token decrypts to nothing", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({
      data: { ...STORED, access_token_encrypted: "" },
      error: null
    });
    await expect(getCalendlyConnection(BIZ, makeDb(c))).rejects.toThrow(
      /no stored access token/
    );
  });
});

describe("getActiveCalendlyConnection", () => {
  it("returns null for an inactive row and the row when active", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { ...STORED, is_active: false }, error: null });
    expect(await getActiveCalendlyConnection(BIZ, makeDb(c))).toBeNull();

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    expect((await getActiveCalendlyConnection(BIZ, makeDb(c2)))?.id).toBe("cl-1");
  });
});

describe("getActiveCalendlyConnectionId", () => {
  it("returns the id for an active connection and null when absent", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "cl-1" }, error: null });
    expect(await getActiveCalendlyConnectionId(BIZ, makeDb(c))).toBe("cl-1");
    expect(c.eq).toHaveBeenCalledWith("is_active", true);

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getActiveCalendlyConnectionId(BIZ, makeDb(c2))).toBeNull();
  });

  it("throws on a query error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(getActiveCalendlyConnectionId(BIZ, makeDb(c))).rejects.toThrow(/down/);
  });
});

describe("getPublicCalendlyConnection", () => {
  it("returns the masked row / null / throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const pub = await getPublicCalendlyConnection(BIZ, makeDb(c));
    expect(pub?.has_token).toBe(true);

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getPublicCalendlyConnection(BIZ, makeDb(c2))).toBeNull();

    const c3 = chain();
    c3.maybeSingle.mockResolvedValue({ data: null, error: { message: "err" } });
    await expect(getPublicCalendlyConnection(BIZ, makeDb(c3))).rejects.toThrow(/err/);
  });
});

describe("upsertCalendlyConnection", () => {
  it("rejects an empty or oversized token", async () => {
    await expect(
      upsertCalendlyConnection({ businessId: BIZ, accessToken: "  " }, makeDb(chain()))
    ).rejects.toThrow(CalendlyConnectionValidationError);
    await expect(
      upsertCalendlyConnection(
        { businessId: BIZ, accessToken: "x".repeat(4097) },
        makeDb(chain())
      )
    ).rejects.toThrow(/1-4096/);
  });

  it("throws on an existence-check error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "read fail" } });
    await expect(
      upsertCalendlyConnection({ businessId: BIZ, accessToken: "pat" }, makeDb(c))
    ).rejects.toThrow(/read fail/);
  });

  it("requires a token on first connect", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(upsertCalendlyConnection({ businessId: BIZ }, makeDb(c))).rejects.toThrow(
      /required to connect/
    );
  });

  it("creates a row with an encrypted token and optional identity", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    const pub = await upsertCalendlyConnection(
      {
        businessId: BIZ,
        accessToken: " pat-secret ",
        accountName: "Acme Spa",
        accountEmail: "owner@acme.com",
        isActive: true
      },
      makeDb(c)
    );
    expect(pub.has_token).toBe(true);
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.access_token_encrypted).toBe("enc(pat-secret)");
    expect(inserted.account_name).toBe("Acme Spa");
    expect(inserted.account_email).toBe("owner@acme.com");
    expect(inserted.is_active).toBe(true);
  });

  it("creates with explicit null identity fields", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertCalendlyConnection(
      { businessId: BIZ, accessToken: "pat", accountName: null, accountEmail: null },
      makeDb(c)
    );
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.account_name).toBeNull();
    expect(inserted.account_email).toBeNull();
  });

  it("clears the stored account name on update when explicitly nulled", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "cl-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertCalendlyConnection({ businessId: BIZ, accountName: null }, makeDb(c));
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.account_name).toBeNull();
    expect(patch).not.toHaveProperty("account_email");
  });

  it("creates without identity fields when they are omitted", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertCalendlyConnection({ businessId: BIZ, accessToken: "pat" }, makeDb(c));
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted).not.toHaveProperty("account_name");
    expect(inserted).not.toHaveProperty("account_email");
    expect(inserted).not.toHaveProperty("is_active");
  });

  it("surfaces an insert error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: null, error: { message: "insert fail" } });
    await expect(
      upsertCalendlyConnection({ businessId: BIZ, accessToken: "pat" }, makeDb(c))
    ).rejects.toThrow(/insert fail/);
  });

  it("updates in place, keeping the stored token when none is supplied", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "cl-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertCalendlyConnection(
      { businessId: BIZ, accountName: "New Name", accountEmail: null, isActive: false },
      makeDb(c)
    );
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("access_token_encrypted");
    expect(patch.account_name).toBe("New Name");
    expect(patch.account_email).toBeNull();
    expect(patch.is_active).toBe(false);
  });

  it("rotates the token when supplied and surfaces update errors", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "cl-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertCalendlyConnection({ businessId: BIZ, accessToken: "new-pat" }, makeDb(c));
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.access_token_encrypted).toBe("enc(new-pat)");
    // Identity untouched when the keys are absent from the input.
    expect(patch).not.toHaveProperty("account_name");
    expect(patch).not.toHaveProperty("account_email");

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: { id: "cl-1" }, error: null });
    c2.single.mockResolvedValue({ data: null, error: { message: "update fail" } });
    await expect(upsertCalendlyConnection({ businessId: BIZ }, makeDb(c2))).rejects.toThrow(
      /update fail/
    );
  });
});

describe("deleteCalendlyConnection", () => {
  it("deletes by business id and throws on error", async () => {
    const c = chain({ error: null });
    await deleteCalendlyConnection(BIZ, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);

    const c2 = chain({ error: { message: "del fail" } });
    await expect(deleteCalendlyConnection(BIZ, makeDb(c2))).rejects.toThrow(/del fail/);
  });
});

describe("default service client", () => {
  it("falls back to createSupabaseServiceClient when no client is passed", async () => {
    const c = chain({ error: null });
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));

    expect(await getCalendlyConnection(BIZ)).toBeNull();
    expect(await getActiveCalendlyConnectionId(BIZ)).toBeNull();
    expect(await getPublicCalendlyConnection(BIZ)).toBeNull();
    await upsertCalendlyConnection({ businessId: BIZ, accessToken: "pat" });
    await deleteCalendlyConnection(BIZ);
    expect(defaultClientSpy).toHaveBeenCalledTimes(5);
  });
});
