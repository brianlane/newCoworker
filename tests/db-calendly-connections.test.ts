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
  getCalendlyConnectionById,
  getCalendlyConnectionUserUriById,
  listActiveCalendlyConnections,
  listCalendlyConnections,
  listPublicCalendlyConnections,
  saveCalendlyConnection,
  setCalendlyConnectionActive,
  setCalendlyConnectionUserUri,
  toPublicCalendlyConnection
} from "@/lib/db/calendly-connections";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
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
    order: vi.fn(() => c),
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
const CONN_A = "aaaaaaaa-1111-4111-8111-111111111111";
const CONN_B = "bbbbbbbb-1111-4111-8111-111111111111";
const URI_A = "https://api.calendly.com/users/AAA";
const URI_B = "https://api.calendly.com/users/BBB";

const storedRow = (over: Record<string, unknown> = {}) => ({
  id: CONN_A,
  business_id: BIZ,
  access_token_encrypted: "enc(tok-a)",
  account_name: "James",
  account_email: "james@kyp.test",
  user_uri: URI_A,
  is_active: true,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  ...over
});

describe("listCalendlyConnections / listActiveCalendlyConnections", () => {
  it("lists oldest-first with tokens decrypted", async () => {
    const rows = [storedRow(), storedRow({ id: CONN_B, user_uri: URI_B, is_active: false })];
    const c = chain({ data: rows, error: null });
    const list = await listCalendlyConnections(BIZ, makeDb(c));
    expect(list).toHaveLength(2);
    expect(list[0].accessToken).toBe("tok-a");
    expect(c.order).toHaveBeenCalledWith("created_at", { ascending: true });
    // Bounded read: multi-connection is a handful of accounts, never a scan.
    expect(c.limit).toHaveBeenCalledWith(50);
  });

  it("throws on a read error", async () => {
    const c = chain({ data: null, error: { message: "boom" } });
    await expect(listCalendlyConnections(BIZ, makeDb(c))).rejects.toThrow(
      "listCalendlyConnections: boom"
    );
  });

  it("active list filters out disabled rows", async () => {
    const rows = [storedRow(), storedRow({ id: CONN_B, user_uri: URI_B, is_active: false })];
    const c = chain({ data: rows, error: null });
    const list = await listActiveCalendlyConnections(BIZ, makeDb(c));
    expect(list.map((r) => r.id)).toEqual([CONN_A]);
  });

  it("empty data resolves to an empty list (null-coalesce branch)", async () => {
    const c = chain({ data: null, error: null });
    expect(await listCalendlyConnections(BIZ, makeDb(c))).toEqual([]);
  });

  it("throws when a stored token decrypts to nothing (fail closed)", async () => {
    const c = chain({ data: [storedRow({ access_token_encrypted: "" })], error: null });
    await expect(listCalendlyConnections(BIZ, makeDb(c))).rejects.toThrow(
      "calendly connection has no stored access token"
    );
  });
});

describe("getCalendlyConnectionById", () => {
  it("returns the decrypted row scoped to the business", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: storedRow(), error: null });
    const row = await getCalendlyConnectionById(BIZ, CONN_A, makeDb(c));
    expect(row?.accessToken).toBe("tok-a");
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("id", CONN_A);
  });

  it("null when absent; throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getCalendlyConnectionById(BIZ, CONN_A, makeDb(c))).toBeNull();
    const cErr = chain();
    cErr.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getCalendlyConnectionById(BIZ, CONN_A, makeDb(cErr))).rejects.toThrow(
      "getCalendlyConnectionById: boom"
    );
  });
});

describe("getActiveCalendlyConnection (primary = oldest active)", () => {
  it("returns the first active row", async () => {
    const rows = [
      storedRow({ is_active: false }),
      storedRow({ id: CONN_B, user_uri: URI_B, access_token_encrypted: "enc(tok-b)" })
    ];
    const c = chain({ data: rows, error: null });
    const row = await getActiveCalendlyConnection(BIZ, makeDb(c));
    expect(row?.id).toBe(CONN_B);
    expect(row?.accessToken).toBe("tok-b");
  });

  it("null when nothing is active", async () => {
    const c = chain({ data: [storedRow({ is_active: false })], error: null });
    expect(await getActiveCalendlyConnection(BIZ, makeDb(c))).toBeNull();
  });
});

describe("getActiveCalendlyConnectionId", () => {
  it("id-only probe orders oldest-first and takes one", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: CONN_A }, error: null });
    expect(await getActiveCalendlyConnectionId(BIZ, makeDb(c))).toBe(CONN_A);
    expect(c.order).toHaveBeenCalledWith("created_at", { ascending: true });
    expect(c.limit).toHaveBeenCalledWith(1);
  });

  it("null when none; throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getActiveCalendlyConnectionId(BIZ, makeDb(c))).toBeNull();
    const cErr = chain();
    cErr.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getActiveCalendlyConnectionId(BIZ, makeDb(cErr))).rejects.toThrow(
      "getActiveCalendlyConnectionId: boom"
    );
  });
});

describe("getCalendlyConnectionUserUriById / setCalendlyConnectionUserUri", () => {
  it("reads the cached URI of one ACTIVE row by id", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { user_uri: URI_A }, error: null });
    expect(await getCalendlyConnectionUserUriById(CONN_A, makeDb(c))).toBe(URI_A);
    expect(c.eq).toHaveBeenCalledWith("id", CONN_A);
    expect(c.eq).toHaveBeenCalledWith("is_active", true);
  });

  it("null when unresolved/absent; throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { user_uri: null }, error: null });
    expect(await getCalendlyConnectionUserUriById(CONN_A, makeDb(c))).toBeNull();
    const cErr = chain();
    cErr.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getCalendlyConnectionUserUriById(CONN_A, makeDb(cErr))).rejects.toThrow(
      "getCalendlyConnectionUserUriById: boom"
    );
  });

  it("persists a resolved URI onto ONE row by id", async () => {
    const c = chain({ error: null });
    await setCalendlyConnectionUserUri(CONN_A, URI_A, makeDb(c));
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ user_uri: URI_A })
    );
    expect(c.eq).toHaveBeenCalledWith("id", CONN_A);
  });

  it("set throws on error", async () => {
    const c = chain({ error: { message: "boom" } });
    await expect(setCalendlyConnectionUserUri(CONN_A, URI_A, makeDb(c))).rejects.toThrow(
      "setCalendlyConnectionUserUri: boom"
    );
  });
});

describe("listPublicCalendlyConnections", () => {
  it("masks token material into has_token", async () => {
    const c = chain({ data: [storedRow()], error: null });
    const list = await listPublicCalendlyConnections(BIZ, makeDb(c));
    expect(list[0]).not.toHaveProperty("access_token_encrypted");
    expect(list[0]).not.toHaveProperty("accessToken");
    expect(list[0].has_token).toBe(true);
  });

  it("throws on error; empty data resolves empty", async () => {
    const cErr = chain({ data: null, error: { message: "boom" } });
    await expect(listPublicCalendlyConnections(BIZ, makeDb(cErr))).rejects.toThrow(
      "listPublicCalendlyConnections: boom"
    );
    const cEmpty = chain({ data: null, error: null });
    expect(await listPublicCalendlyConnections(BIZ, makeDb(cEmpty))).toEqual([]);
  });
});

describe("toPublicCalendlyConnection", () => {
  it("flags an empty stored token as has_token false", () => {
    const pub = toPublicCalendlyConnection(storedRow({ access_token_encrypted: "" }) as never);
    expect(pub.has_token).toBe(false);
  });
});

describe("saveCalendlyConnection", () => {
  const input = {
    businessId: BIZ,
    accessToken: "tok-new",
    userUri: URI_B,
    accountName: "Liz",
    accountEmail: "liz@lizdev.test"
  };

  it("rejects an empty or oversized token", async () => {
    await expect(
      saveCalendlyConnection({ ...input, accessToken: "   " }, makeDb(chain()))
    ).rejects.toThrow(CalendlyConnectionValidationError);
    await expect(
      saveCalendlyConnection({ ...input, accessToken: "x".repeat(4097) }, makeDb(chain()))
    ).rejects.toThrow("Personal Access Token must be 1-4096 characters");
  });

  it("throws when the dedupe read fails", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(saveCalendlyConnection(input, makeDb(c))).rejects.toThrow(
      "saveCalendlyConnection: boom"
    );
  });

  it("INSERTS a new row for a not-yet-linked account (identity from verify)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({
      data: storedRow({
        id: CONN_B,
        user_uri: URI_B,
        account_name: "Liz",
        account_email: "liz@lizdev.test",
        access_token_encrypted: "enc(tok-new)"
      }),
      error: null
    });
    const { connection, created } = await saveCalendlyConnection(input, makeDb(c));
    expect(created).toBe(true);
    expect(connection.user_uri).toBe(URI_B);
    expect(c.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        access_token_encrypted: "enc(tok-new)",
        user_uri: URI_B,
        account_name: "Liz",
        account_email: "liz@lizdev.test"
      })
    );
  });

  it("insert error surfaces", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    c.single.mockResolvedValue({ data: null, error: { message: "dup" } });
    await expect(saveCalendlyConnection(input, makeDb(c))).rejects.toThrow(
      "saveCalendlyConnection: dup"
    );
  });

  it("CONVERGES onto the existing row when the account is already linked (re-activates too)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: CONN_B }, error: null });
    c.single.mockResolvedValue({
      data: storedRow({ id: CONN_B, user_uri: URI_B, access_token_encrypted: "enc(tok-new)" }),
      error: null
    });
    const { connection, created } = await saveCalendlyConnection(input, makeDb(c));
    expect(created).toBe(false);
    expect(connection.id).toBe(CONN_B);
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token_encrypted: "enc(tok-new)",
        is_active: true,
        user_uri: URI_B
      })
    );
    expect(c.eq).toHaveBeenCalledWith("id", CONN_B);
  });

  it("converge update error surfaces", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: CONN_B }, error: null });
    c.single.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(saveCalendlyConnection(input, makeDb(c))).rejects.toThrow(
      "saveCalendlyConnection: boom"
    );
  });
});

describe("setCalendlyConnectionActive", () => {
  it("flips one row and returns it masked", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: storedRow({ is_active: false }), error: null });
    const row = await setCalendlyConnectionActive(BIZ, CONN_A, false, makeDb(c));
    expect(row?.is_active).toBe(false);
    expect(c.update).toHaveBeenCalledWith(expect.objectContaining({ is_active: false }));
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("id", CONN_A);
  });

  it("null when the row is missing; throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await setCalendlyConnectionActive(BIZ, CONN_A, true, makeDb(c))).toBeNull();
    const cErr = chain();
    cErr.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(setCalendlyConnectionActive(BIZ, CONN_A, true, makeDb(cErr))).rejects.toThrow(
      "setCalendlyConnectionActive: boom"
    );
  });
});

describe("deleteCalendlyConnection", () => {
  it("deletes ONE row scoped to the business", async () => {
    const c = chain({ error: null });
    await deleteCalendlyConnection(BIZ, CONN_A, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("id", CONN_A);
  });

  it("throws on error", async () => {
    const c = chain({ error: { message: "boom" } });
    await expect(deleteCalendlyConnection(BIZ, CONN_A, makeDb(c))).rejects.toThrow(
      "deleteCalendlyConnection: boom"
    );
  });
});

describe("default client resolution", () => {
  it("every entry point resolves the service client when none is injected", async () => {
    const listChain = chain({ data: [], error: null });
    defaultClientSpy.mockReturnValue(makeDb(listChain));
    expect(await listCalendlyConnections(BIZ)).toEqual([]);
    expect(await listPublicCalendlyConnections(BIZ)).toEqual([]);

    const single = chain();
    single.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(single));
    expect(await getCalendlyConnectionById(BIZ, CONN_A)).toBeNull();
    expect(await getActiveCalendlyConnectionId(BIZ)).toBeNull();
    expect(await getCalendlyConnectionUserUriById(CONN_A)).toBeNull();
    expect(await setCalendlyConnectionActive(BIZ, CONN_A, true)).toBeNull();

    const write = chain({ error: null });
    defaultClientSpy.mockReturnValue(makeDb(write));
    await setCalendlyConnectionUserUri(CONN_A, URI_A);
    await deleteCalendlyConnection(BIZ, CONN_A);

    const save = chain();
    save.maybeSingle.mockResolvedValue({ data: null, error: null });
    save.single.mockResolvedValue({ data: storedRow(), error: null });
    defaultClientSpy.mockReturnValue(makeDb(save));
    const { created } = await saveCalendlyConnection({
      businessId: BIZ,
      accessToken: "tok",
      userUri: URI_A,
      accountName: null,
      accountEmail: null
    });
    expect(created).toBe(true);
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});
