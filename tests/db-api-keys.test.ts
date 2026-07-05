import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => {
    throw new Error("tests must inject a client");
  })
}));

import {
  countActiveApiKeys,
  findActiveApiKeyByHash,
  insertApiKey,
  listApiKeys,
  revokeApiKey,
  touchApiKeyLastUsed
} from "@/lib/db/api-keys";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function chain(terminal?: unknown): Chain & PromiseLike<unknown> {
  const c = {
    select: vi.fn(() => c),
    insert: vi.fn(() => c),
    update: vi.fn(() => c),
    eq: vi.fn(() => c),
    is: vi.fn(() => c),
    order: vi.fn(() => c),
    single: vi.fn(),
    maybeSingle: vi.fn(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve)
  };
  return c as never;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) };
}

const ROW = {
  id: "key-1",
  business_id: "biz-1",
  name: "Zapier",
  key_prefix: "nck_aaaaaaaa",
  key_hash: "h".repeat(64),
  created_at: "2026-07-01T00:00:00Z",
  last_used_at: null,
  revoked_at: null
};

describe("api_keys DB layer", () => {
  it("insertApiKey inserts hash + prefix and returns the row", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: ROW, error: null });
    const db = makeDb(c);
    const row = await insertApiKey(
      { businessId: "biz-1", name: "Zapier", keyPrefix: "nck_aaaaaaaa", keyHash: "h".repeat(64) },
      db as never
    );
    expect(row).toEqual(ROW);
    expect(db.from).toHaveBeenCalledWith("api_keys");
    expect(c.insert).toHaveBeenCalledWith({
      business_id: "biz-1",
      name: "Zapier",
      key_prefix: "nck_aaaaaaaa",
      key_hash: "h".repeat(64)
    });
  });

  it("insertApiKey throws on error", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "dup" } });
    await expect(
      insertApiKey(
        { businessId: "b", name: "n", keyPrefix: "p", keyHash: "h" },
        makeDb(c) as never
      )
    ).rejects.toThrow(/dup/);
  });

  it("listApiKeys selects non-revoked keys without the hash", async () => {
    const { key_hash: _hash, ...publicRow } = ROW;
    const c = chain({ data: [publicRow], error: null });
    const db = makeDb(c);
    const rows = await listApiKeys("biz-1", db as never);
    expect(rows).toEqual([publicRow]);
    expect(c.select).toHaveBeenCalledWith(
      "id, business_id, name, key_prefix, created_at, last_used_at, revoked_at"
    );
    expect(c.is).toHaveBeenCalledWith("revoked_at", null);
  });

  it("listApiKeys throws on error and returns [] on null data", async () => {
    await expect(
      listApiKeys("b", makeDb(chain({ data: null, error: { message: "db" } })) as never)
    ).rejects.toThrow(/db/);
    await expect(
      listApiKeys("b", makeDb(chain({ data: null, error: null })) as never)
    ).resolves.toEqual([]);
  });

  it("countActiveApiKeys returns the exact count (0 on null)", async () => {
    const c = chain({ count: 3, error: null });
    await expect(countActiveApiKeys("biz-1", makeDb(c) as never)).resolves.toBe(3);
    await expect(
      countActiveApiKeys("b", makeDb(chain({ count: null, error: null })) as never)
    ).resolves.toBe(0);
    await expect(
      countActiveApiKeys("b", makeDb(chain({ count: null, error: { message: "db" } })) as never)
    ).rejects.toThrow(/db/);
  });

  it("revokeApiKey scopes by business and reports whether a row matched", async () => {
    const c = chain({ data: [{ id: "key-1" }], error: null });
    const db = makeDb(c);
    await expect(revokeApiKey("biz-1", "key-1", db as never)).resolves.toBe(true);
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ revoked_at: expect.any(String) })
    );
    expect(c.eq).toHaveBeenCalledWith("id", "key-1");
    expect(c.eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(c.is).toHaveBeenCalledWith("revoked_at", null);

    await expect(
      revokeApiKey("biz-1", "nope", makeDb(chain({ data: [], error: null })) as never)
    ).resolves.toBe(false);
    await expect(
      revokeApiKey("b", "k", makeDb(chain({ data: null, error: { message: "db" } })) as never)
    ).rejects.toThrow(/db/);
  });

  it("findActiveApiKeyByHash filters revoked keys and returns null on miss", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    const db = makeDb(c);
    await expect(findActiveApiKeyByHash("h".repeat(64), db as never)).resolves.toEqual(ROW);
    expect(c.eq).toHaveBeenCalledWith("key_hash", "h".repeat(64));
    expect(c.is).toHaveBeenCalledWith("revoked_at", null);

    const miss = chain();
    miss.maybeSingle.mockResolvedValue({ data: null, error: null });
    await expect(findActiveApiKeyByHash("x", makeDb(miss) as never)).resolves.toBeNull();

    const err = chain();
    err.maybeSingle.mockResolvedValue({ data: null, error: { message: "db" } });
    await expect(findActiveApiKeyByHash("x", makeDb(err) as never)).rejects.toThrow(/db/);
  });

  it("touchApiKeyLastUsed stamps last_used_at by key id", async () => {
    const c = chain({ error: null });
    const db = makeDb(c);
    await touchApiKeyLastUsed("key-1", db as never);
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ last_used_at: expect.any(String) })
    );
    expect(c.eq).toHaveBeenCalledWith("id", "key-1");
  });
});
