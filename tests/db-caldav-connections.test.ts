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
  CaldavConnectionValidationError,
  deleteCaldavConnection,
  getActiveCaldavConnection,
  getActiveCaldavConnectionId,
  getCaldavConnection,
  getPublicCaldavConnection,
  normalizeCaldavServerUrl,
  toPublicCaldavConnection,
  upsertCaldavConnection
} from "@/lib/db/caldav-connections";

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
  id: "cd-1",
  business_id: BIZ,
  server_url: "https://caldav.icloud.com/",
  username: "owner@icloud.com",
  password_encrypted: "enc(app-pass)",
  calendar_url: "https://p42-caldav.icloud.com/123/calendars/work/",
  calendar_name: "Work",
  is_active: true,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z"
};

describe("normalizeCaldavServerUrl", () => {
  it("accepts and normalizes a public https URL", () => {
    expect(normalizeCaldavServerUrl(" https://caldav.icloud.com ")).toBe(
      "https://caldav.icloud.com/"
    );
  });

  it("rejects malformed URLs", () => {
    expect(() => normalizeCaldavServerUrl("not a url")).toThrow(
      CaldavConnectionValidationError
    );
  });

  it("rejects non-https schemes", () => {
    expect(() => normalizeCaldavServerUrl("http://caldav.example.com")).toThrow(/https/);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() => normalizeCaldavServerUrl("https://user:pass@caldav.example.com")).toThrow(
      /username\/password fields/
    );
  });

  it("rejects private/loopback hosts", () => {
    expect(() => normalizeCaldavServerUrl("https://localhost/dav")).toThrow(/private/);
    expect(() => normalizeCaldavServerUrl("https://192.168.1.10/dav")).toThrow(/private/);
  });
});

describe("toPublicCaldavConnection", () => {
  it("drops the ciphertext and reports has_password", () => {
    const pub = toPublicCaldavConnection(STORED as never);
    expect(pub).not.toHaveProperty("password_encrypted");
    expect(pub.has_password).toBe(true);
  });
});

describe("getCaldavConnection", () => {
  it("returns null when no row exists", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getCaldavConnection(BIZ, makeDb(c))).toBeNull();
  });

  it("decrypts the stored password", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const row = await getCaldavConnection(BIZ, makeDb(c));
    expect(row?.password).toBe("app-pass");
    expect(row).not.toHaveProperty("password_encrypted");
  });

  it("throws on a query error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getCaldavConnection(BIZ, makeDb(c))).rejects.toThrow(/boom/);
  });

  it("fails closed when the stored password decrypts to nothing", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({
      data: { ...STORED, password_encrypted: "" },
      error: null
    });
    await expect(getCaldavConnection(BIZ, makeDb(c))).rejects.toThrow(/no stored password/);
  });
});

describe("getActiveCaldavConnection", () => {
  it("returns null for an inactive row and the row when active", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { ...STORED, is_active: false }, error: null });
    expect(await getActiveCaldavConnection(BIZ, makeDb(c))).toBeNull();

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    expect((await getActiveCaldavConnection(BIZ, makeDb(c2)))?.id).toBe("cd-1");
  });
});

describe("getActiveCaldavConnectionId", () => {
  it("returns the id for an active connection and null when absent", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "cd-1" }, error: null });
    expect(await getActiveCaldavConnectionId(BIZ, makeDb(c))).toBe("cd-1");
    expect(c.eq).toHaveBeenCalledWith("is_active", true);

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getActiveCaldavConnectionId(BIZ, makeDb(c2))).toBeNull();
  });

  it("throws on a query error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "down" } });
    await expect(getActiveCaldavConnectionId(BIZ, makeDb(c))).rejects.toThrow(/down/);
  });
});

describe("getPublicCaldavConnection", () => {
  it("returns the masked row / null / throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: STORED, error: null });
    const pub = await getPublicCaldavConnection(BIZ, makeDb(c));
    expect(pub?.has_password).toBe(true);

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getPublicCaldavConnection(BIZ, makeDb(c2))).toBeNull();

    const c3 = chain();
    c3.maybeSingle.mockResolvedValue({ data: null, error: { message: "err" } });
    await expect(getPublicCaldavConnection(BIZ, makeDb(c3))).rejects.toThrow(/err/);
  });
});

describe("upsertCaldavConnection", () => {
  it("rejects an empty or oversized username", async () => {
    await expect(
      upsertCaldavConnection({ businessId: BIZ, username: "  " }, makeDb(chain()))
    ).rejects.toThrow(/1-512/);
    await expect(
      upsertCaldavConnection({ businessId: BIZ, username: "x".repeat(513) }, makeDb(chain()))
    ).rejects.toThrow(/1-512/);
  });

  it("rejects an empty or oversized password", async () => {
    await expect(
      upsertCaldavConnection({ businessId: BIZ, password: "  " }, makeDb(chain()))
    ).rejects.toThrow(/1-1024/);
    await expect(
      upsertCaldavConnection({ businessId: BIZ, password: "x".repeat(1025) }, makeDb(chain()))
    ).rejects.toThrow(/1-1024/);
  });

  it("rejects a bad server URL before touching the database", async () => {
    const c = chain();
    await expect(
      upsertCaldavConnection({ businessId: BIZ, serverUrl: "http://x.com" }, makeDb(c))
    ).rejects.toThrow(CaldavConnectionValidationError);
    expect(c.maybeSingle).not.toHaveBeenCalled();
  });

  it("throws on an existence-check error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "read fail" } });
    await expect(
      upsertCaldavConnection(
        { businessId: BIZ, serverUrl: "https://caldav.icloud.com", username: "u", password: "p" },
        makeDb(c)
      )
    ).rejects.toThrow(/read fail/);
  });

  it("requires server URL, username, and password on first connect", async () => {
    for (const partial of [
      {},
      { serverUrl: "https://caldav.icloud.com" },
      { serverUrl: "https://caldav.icloud.com", username: "u" },
      { username: "u", password: "p" }
    ]) {
      const c = chain();
      c.maybeSingle.mockResolvedValue({ data: null, error: null });
      await expect(
        upsertCaldavConnection({ businessId: BIZ, ...partial }, makeDb(c))
      ).rejects.toThrow(/required to connect/);
    }
  });

  it("creates a row with an encrypted password and optional calendar fields", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    const pub = await upsertCaldavConnection(
      {
        businessId: BIZ,
        serverUrl: "https://caldav.icloud.com",
        username: " owner@icloud.com ",
        password: " app-pass ",
        calendarUrl: "https://p42-caldav.icloud.com/123/calendars/work/",
        calendarName: "Work",
        isActive: true
      },
      makeDb(c)
    );
    expect(pub.has_password).toBe(true);
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.server_url).toBe("https://caldav.icloud.com/");
    expect(inserted.username).toBe("owner@icloud.com");
    expect(inserted.password_encrypted).toBe("enc(app-pass)");
    expect(inserted.calendar_url).toBe("https://p42-caldav.icloud.com/123/calendars/work/");
    expect(inserted.calendar_name).toBe("Work");
    expect(inserted.is_active).toBe(true);
  });

  it("creates without calendar fields when they are omitted", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertCaldavConnection(
      {
        businessId: BIZ,
        serverUrl: "https://caldav.icloud.com",
        username: "u",
        password: "p"
      },
      makeDb(c)
    );
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted).not.toHaveProperty("calendar_url");
    expect(inserted).not.toHaveProperty("calendar_name");
    expect(inserted).not.toHaveProperty("is_active");
  });

  it("creates with explicit null calendar fields", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertCaldavConnection(
      {
        businessId: BIZ,
        serverUrl: "https://caldav.icloud.com",
        username: "u",
        password: "p",
        calendarUrl: null,
        calendarName: null
      },
      makeDb(c)
    );
    const inserted = c.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.calendar_url).toBeNull();
    expect(inserted.calendar_name).toBeNull();
  });

  it("surfaces an insert error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: null, error: { message: "insert fail" } });
    await expect(
      upsertCaldavConnection(
        { businessId: BIZ, serverUrl: "https://caldav.icloud.com", username: "u", password: "p" },
        makeDb(c)
      )
    ).rejects.toThrow(/insert fail/);
  });

  it("updates in place, keeping stored credentials when none are supplied", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "cd-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertCaldavConnection(
      { businessId: BIZ, calendarUrl: "https://x.example.com/cal/", calendarName: null, isActive: false },
      makeDb(c)
    );
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("server_url");
    expect(patch).not.toHaveProperty("username");
    expect(patch).not.toHaveProperty("password_encrypted");
    expect(patch.calendar_url).toBe("https://x.example.com/cal/");
    expect(patch.calendar_name).toBeNull();
    expect(patch.is_active).toBe(false);
  });

  it("clears the cached calendar on update when explicitly nulled", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "cd-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertCaldavConnection(
      { businessId: BIZ, calendarUrl: null, calendarName: "Kept" },
      makeDb(c)
    );
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.calendar_url).toBeNull();
    expect(patch.calendar_name).toBe("Kept");
  });

  it("rotates credentials when supplied and surfaces update errors", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "cd-1" }, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    await upsertCaldavConnection(
      {
        businessId: BIZ,
        serverUrl: "https://dav.example.com",
        username: "new-user",
        password: "rotated-test-fixture"
      },
      makeDb(c)
    );
    const patch = c.update.mock.calls[0][0] as Record<string, unknown>;
    expect(patch.server_url).toBe("https://dav.example.com/");
    expect(patch.username).toBe("new-user");
    expect(patch.password_encrypted).toBe("enc(rotated-test-fixture)");
    expect(patch).not.toHaveProperty("calendar_url");
    expect(patch).not.toHaveProperty("calendar_name");

    const c2 = chain();
    c2.maybeSingle.mockResolvedValue({ data: { id: "cd-1" }, error: null });
    c2.single.mockResolvedValue({ data: null, error: { message: "update fail" } });
    await expect(upsertCaldavConnection({ businessId: BIZ }, makeDb(c2))).rejects.toThrow(
      /update fail/
    );
  });
});

describe("deleteCaldavConnection", () => {
  it("deletes by business id and throws on error", async () => {
    const c = chain({ error: null });
    await deleteCaldavConnection(BIZ, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);

    const c2 = chain({ error: { message: "del fail" } });
    await expect(deleteCaldavConnection(BIZ, makeDb(c2))).rejects.toThrow(/del fail/);
  });
});

describe("default service client", () => {
  it("falls back to createSupabaseServiceClient when no client is passed", async () => {
    const c = chain({ error: null });
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: STORED, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));

    expect(await getCaldavConnection(BIZ)).toBeNull();
    expect(await getActiveCaldavConnectionId(BIZ)).toBeNull();
    expect(await getPublicCaldavConnection(BIZ)).toBeNull();
    await upsertCaldavConnection({
      businessId: BIZ,
      serverUrl: "https://caldav.icloud.com",
      username: "u",
      password: "p"
    });
    await deleteCaldavConnection(BIZ);
    expect(defaultClientSpy).toHaveBeenCalledTimes(5);
  });
});
