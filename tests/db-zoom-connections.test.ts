/**
 * Tests for the direct Zoom connection store (src/lib/db/zoom-connections.ts):
 * encrypted token-pair persistence, fail-closed decryption, the public
 * (no-ciphertext) projection, and the token-rotation update path.
 */
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
  deleteZoomConnection,
  getActiveZoomConnection,
  getActiveZoomConnectionId,
  getPublicZoomConnection,
  getZoomConnection,
  setZoomConnectionActive,
  toPublicZoomConnection,
  updateZoomTokens,
  upsertZoomConnection
} from "@/lib/db/zoom-connections";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  match: ReturnType<typeof vi.fn>;
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
    match: vi.fn(() => c),
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
  id: "zc-1",
  business_id: BIZ,
  access_token_encrypted: "enc(access-secret)",
  refresh_token_encrypted: "enc(refresh-secret)",
  token_expires_at: "2026-07-15T00:00:00Z",
  zoom_user_id: "zu-1",
  account_email: "owner@acme.com",
  account_name: "Acme Spa",
  is_active: true,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z"
};

describe("toPublicZoomConnection", () => {
  it("drops both ciphertexts and reports has_tokens", () => {
    const pub = toPublicZoomConnection(STORED as never);
    expect(pub).not.toHaveProperty("access_token_encrypted");
    expect(pub).not.toHaveProperty("refresh_token_encrypted");
    expect(pub.has_tokens).toBe(true);
  });

  it("reports has_tokens false when either token is missing", () => {
    expect(
      toPublicZoomConnection({ ...STORED, access_token_encrypted: "" } as never).has_tokens
    ).toBe(false);
    expect(
      toPublicZoomConnection({ ...STORED, refresh_token_encrypted: "" } as never).has_tokens
    ).toBe(false);
  });
});

describe("getZoomConnection", () => {
  it("returns null when no row exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getZoomConnection(BIZ, makeDb(c))).toBeNull();
  });

  it("decrypts the stored token pair", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const row = await getZoomConnection(BIZ, makeDb(c));
    expect(row?.accessToken).toBe("access-secret");
    expect(row?.refreshToken).toBe("refresh-secret");
    expect(row).not.toHaveProperty("access_token_encrypted");
    expect(row).not.toHaveProperty("refresh_token_encrypted");
  });

  it("throws on a query error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getZoomConnection(BIZ, makeDb(c))).rejects.toThrow(/boom/);
  });

  it("fails closed when either stored token decrypts to nothing", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({
      data: { ...STORED, access_token_encrypted: "" },
      error: null
    });
    await expect(getZoomConnection(BIZ, makeDb(c))).rejects.toThrow(
      /no stored token pair/
    );

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({
      data: { ...STORED, refresh_token_encrypted: "" },
      error: null
    });
    await expect(getZoomConnection(BIZ, makeDb(c2))).rejects.toThrow(
      /no stored token pair/
    );
  });

  it("uses the default service client when none is provided", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await getZoomConnection(BIZ)).toBeNull();
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("getActiveZoomConnection", () => {
  it("returns null for an inactive row and the row when active", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { ...STORED, is_active: false }, error: null });
    expect(await getActiveZoomConnection(BIZ, makeDb(c))).toBeNull();

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    expect((await getActiveZoomConnection(BIZ, makeDb(c2)))?.id).toBe("zc-1");
  });

  it("returns null when no row exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getActiveZoomConnection(BIZ, makeDb(c))).toBeNull();
  });
});

describe("getActiveZoomConnectionId", () => {
  it("returns the id without decrypting", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "zc-1" }, error: null });
    expect(await getActiveZoomConnectionId(BIZ, makeDb(c))).toBe("zc-1");
  });

  it("returns null when nothing is active", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getActiveZoomConnectionId(BIZ, makeDb(c))).toBeNull();
  });

  it("throws on a query error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "probe boom" } });
    await expect(getActiveZoomConnectionId(BIZ, makeDb(c))).rejects.toThrow(/probe boom/);
  });

  it("uses the default service client when none is provided", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await getActiveZoomConnectionId(BIZ)).toBeNull();
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("getPublicZoomConnection", () => {
  it("returns the masked shape", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const pub = await getPublicZoomConnection(BIZ, makeDb(c));
    expect(pub?.has_tokens).toBe(true);
    expect(pub).not.toHaveProperty("access_token_encrypted");
  });

  it("returns null when no row exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getPublicZoomConnection(BIZ, makeDb(c))).toBeNull();
  });

  it("throws on a query error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "read boom" } });
    await expect(getPublicZoomConnection(BIZ, makeDb(c))).rejects.toThrow(/read boom/);
  });

  it("uses the default service client when none is provided", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await getPublicZoomConnection(BIZ)).toBeNull();
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

const UPSERT_INPUT = {
  businessId: BIZ,
  accessToken: "new-access",
  refreshToken: "new-refresh",
  expiresAt: new Date("2026-07-15T01:00:00Z"),
  zoomUserId: "zu-1",
  accountEmail: "owner@acme.com",
  accountName: "Acme Spa"
};

describe("upsertZoomConnection", () => {
  it("inserts an encrypted, active row when none exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    const pub = await upsertZoomConnection(UPSERT_INPUT, makeDb(c));
    expect(pub.has_tokens).toBe(true);
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.business_id).toBe(BIZ);
    expect(inserted.access_token_encrypted).toBe("enc(new-access)");
    expect(inserted.refresh_token_encrypted).toBe("enc(new-refresh)");
    expect(inserted.token_expires_at).toBe("2026-07-15T01:00:00.000Z");
    expect(inserted.is_active).toBe(true);
  });

  it("defaults identity fields to null when omitted", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertZoomConnection(
      {
        businessId: BIZ,
        accessToken: "a",
        refreshToken: "r",
        expiresAt: new Date("2026-07-15T01:00:00Z")
      },
      makeDb(c)
    );
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.zoom_user_id).toBeNull();
    expect(inserted.account_email).toBeNull();
    expect(inserted.account_name).toBeNull();
  });

  it("replaces tokens and re-activates on reconnect", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "zc-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertZoomConnection(UPSERT_INPUT, makeDb(c));
    const updated = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updated.access_token_encrypted).toBe("enc(new-access)");
    expect(updated.is_active).toBe(true);
    expect(updated.updated_at).toBeDefined();
  });

  it("throws on read, insert, and update errors", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "read fail" } });
    await expect(upsertZoomConnection(UPSERT_INPUT, makeDb(c))).rejects.toThrow(/read fail/);

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    c2.single.mockResolvedValue({ data: null, error: { message: "insert fail" } });
    await expect(upsertZoomConnection(UPSERT_INPUT, makeDb(c2))).rejects.toThrow(
      /insert fail/
    );

    const c3 = chain();
    c3.maybeSingle.mockResolvedValue({ data: { id: "zc-1" }, error: null });
    c3.single.mockResolvedValue({ data: null, error: { message: "update fail" } });
    await expect(upsertZoomConnection(UPSERT_INPUT, makeDb(c3))).rejects.toThrow(
      /update fail/
    );
  });

  it("uses the default service client when none is provided", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await upsertZoomConnection(UPSERT_INPUT);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("updateZoomTokens", () => {
  const TOKENS = {
    accessToken: "rotated-access",
    refreshToken: "rotated-refresh",
    expiresAt: new Date("2026-07-15T02:00:00Z")
  };

  it("persists the rotated pair in one update and reports success", async () => {
    const c = chain({ data: [{ id: "zc-1" }], error: null });
    expect(await updateZoomTokens(BIZ, TOKENS, undefined, makeDb(c))).toBe(true);
    const updated = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updated.access_token_encrypted).toBe("enc(rotated-access)");
    expect(updated.refresh_token_encrypted).toBe("enc(rotated-refresh)");
    expect(updated.token_expires_at).toBe("2026-07-15T02:00:00.000Z");
    expect(c.match).toHaveBeenCalledWith({ business_id: BIZ });
  });

  it("applies the optimistic-concurrency fence and reports a lost race", async () => {
    const c = chain({ data: [], error: null });
    expect(
      await updateZoomTokens(BIZ, TOKENS, "2026-07-01T00:00:00Z", makeDb(c))
    ).toBe(false);
    expect(c.match).toHaveBeenCalledWith({
      business_id: BIZ,
      updated_at: "2026-07-01T00:00:00Z"
    });
  });

  it("treats a null data payload as no rows updated", async () => {
    const c = chain({ data: null, error: null });
    expect(await updateZoomTokens(BIZ, TOKENS, undefined, makeDb(c))).toBe(false);
  });

  it("throws on an update error", async () => {
    const c = chain({ data: null, error: { message: "rotate fail" } });
    await expect(updateZoomTokens(BIZ, TOKENS, undefined, makeDb(c))).rejects.toThrow(
      /rotate fail/
    );
  });

  it("uses the default service client when none is provided", async () => {
    const c = chain({ data: [{ id: "zc-1" }], error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await updateZoomTokens(BIZ, TOKENS)).toBe(true);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("setZoomConnectionActive", () => {
  it("updates the flag", async () => {
    const c = chain({ error: null });
    await setZoomConnectionActive(BIZ, false, makeDb(c));
    const updated = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(updated.is_active).toBe(false);
  });

  it("throws on an update error", async () => {
    const c = chain({ error: { message: "flag fail" } });
    await expect(setZoomConnectionActive(BIZ, true, makeDb(c))).rejects.toThrow(/flag fail/);
  });

  it("uses the default service client when none is provided", async () => {
    const c = chain({ error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await setZoomConnectionActive(BIZ, true);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("deleteZoomConnection", () => {
  it("deletes by business id", async () => {
    const c = chain({ error: null });
    await deleteZoomConnection(BIZ, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
  });

  it("throws on a delete error", async () => {
    const c = chain({ error: { message: "delete fail" } });
    await expect(deleteZoomConnection(BIZ, makeDb(c))).rejects.toThrow(/delete fail/);
  });

  it("uses the default service client when none is provided", async () => {
    const c = chain({ error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await deleteZoomConnection(BIZ);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});
