import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  insertVpsSshKey,
  getActiveVpsSshKey,
  getActiveVpsSshKeyForBusiness
} from "@/lib/db/vps-ssh-keys";

type MockQB = {
  insert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  is: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
};

function makeChain() {
  const qb: MockQB = {
    insert: vi.fn(() => qb),
    select: vi.fn(() => qb),
    eq: vi.fn(() => qb),
    is: vi.fn(() => qb),
    order: vi.fn(() => qb),
    limit: vi.fn(() => qb),
    single: vi.fn(),
    maybeSingle: vi.fn()
  };
  return qb;
}

type MockDb = {
  from: ReturnType<typeof vi.fn>;
};

function makeDb(chain: MockQB): MockDb {
  return { from: vi.fn(() => chain) };
}

describe("vps_ssh_keys DB layer", () => {
  const sample = {
    id: "row-uuid",
    business_id: "biz-1",
    hostinger_vps_id: "42",
    hostinger_public_key_id: 9,
    public_key: "ssh-ed25519 AAA",
    private_key_pem: "PEM",
    fingerprint_sha256: "SHA256:abc",
    ssh_username: "root",
    created_at: "2026-01-01T00:00:00Z",
    rotated_at: null
  };

  it("insertVpsSshKey writes all fields (including nullable hostinger_public_key_id) and returns the row", async () => {
    const chain = makeChain();
    chain.single.mockResolvedValue({ data: sample, error: null });
    const db = makeDb(chain);
    const res = await insertVpsSshKey(
      {
        business_id: "biz-1",
        hostinger_vps_id: "42",
        hostinger_public_key_id: 9,
        public_key: "ssh-ed25519 AAA",
        private_key_pem: "PEM",
        fingerprint_sha256: "SHA256:abc"
      },
      db as never
    );
    expect(res).toEqual(sample);
    expect(db.from).toHaveBeenCalledWith("vps_ssh_keys");
    const insertArg = chain.insert.mock.calls[0][0];
    expect(insertArg.ssh_username).toBe("root");
    expect(insertArg.hostinger_public_key_id).toBe(9);
  });

  it("insertVpsSshKey defaults hostinger_public_key_id to null when omitted", async () => {
    const chain = makeChain();
    chain.single.mockResolvedValue({ data: sample, error: null });
    const db = makeDb(chain);
    await insertVpsSshKey(
      {
        business_id: "b",
        hostinger_vps_id: "1",
        public_key: "ssh-ed25519 a",
        private_key_pem: "PEM",
        fingerprint_sha256: "fp"
      },
      db as never
    );
    const insertArg = chain.insert.mock.calls[0][0];
    expect(insertArg.hostinger_public_key_id).toBeNull();
    expect(insertArg.ssh_username).toBe("root");
  });

  it("insertVpsSshKey throws when Supabase returns an error", async () => {
    const chain = makeChain();
    chain.single.mockResolvedValue({ data: null, error: { message: "unique violation" } });
    const db = makeDb(chain);
    await expect(
      insertVpsSshKey(
        {
          business_id: "b",
          hostinger_vps_id: "1",
          public_key: "",
          private_key_pem: "",
          fingerprint_sha256: ""
        },
        db as never
      )
    ).rejects.toThrow(/unique violation/);
  });

  it("getActiveVpsSshKey filters by hostinger_vps_id and rotated_at IS NULL", async () => {
    const chain = makeChain();
    chain.maybeSingle.mockResolvedValue({ data: sample, error: null });
    const db = makeDb(chain);
    const row = await getActiveVpsSshKey("42", db as never);
    expect(row).toEqual(sample);
    expect(chain.eq).toHaveBeenCalledWith("hostinger_vps_id", "42");
    expect(chain.is).toHaveBeenCalledWith("rotated_at", null);
  });

  it("getActiveVpsSshKey returns null when no row found", async () => {
    const chain = makeChain();
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    const db = makeDb(chain);
    await expect(getActiveVpsSshKey("99", db as never)).resolves.toBeNull();
  });

  it("getActiveVpsSshKey throws on Supabase error", async () => {
    const chain = makeChain();
    chain.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    const db = makeDb(chain);
    await expect(getActiveVpsSshKey("42", db as never)).rejects.toThrow(/boom/);
  });

  it("getActiveVpsSshKeyForBusiness orders by created_at desc and limits to 1", async () => {
    const chain = makeChain();
    chain.maybeSingle.mockResolvedValue({ data: sample, error: null });
    const db = makeDb(chain);
    await getActiveVpsSshKeyForBusiness("biz-1", db as never);
    expect(chain.eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(chain.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(chain.limit).toHaveBeenCalledWith(1);
  });

  it("getActiveVpsSshKeyForBusiness returns null on no match", async () => {
    const chain = makeChain();
    chain.maybeSingle.mockResolvedValue({ data: null, error: null });
    const db = makeDb(chain);
    await expect(getActiveVpsSshKeyForBusiness("x", db as never)).resolves.toBeNull();
  });

  it("getActiveVpsSshKeyForBusiness throws on Supabase error", async () => {
    const chain = makeChain();
    chain.maybeSingle.mockResolvedValue({ data: null, error: { message: "db error" } });
    const db = makeDb(chain);
    await expect(getActiveVpsSshKeyForBusiness("x", db as never)).rejects.toThrow(/db error/);
  });

  describe("fallback to createSupabaseServiceClient when no client is provided", () => {
    it("insertVpsSshKey uses the default service client", async () => {
      const chain = makeChain();
      chain.single.mockResolvedValue({ data: sample, error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      const res = await insertVpsSshKey({
        business_id: "b",
        hostinger_vps_id: "1",
        public_key: "pk",
        private_key_pem: "pem",
        fingerprint_sha256: "fp"
      });
      expect(res).toEqual(sample);
      expect(defaultClientSpy).toHaveBeenCalled();
    });

    it("getActiveVpsSshKey uses the default service client", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValue({ data: sample, error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await expect(getActiveVpsSshKey("42")).resolves.toEqual(sample);
    });

    it("getActiveVpsSshKeyForBusiness uses the default service client", async () => {
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValue({ data: sample, error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await expect(getActiveVpsSshKeyForBusiness("biz-1")).resolves.toEqual(sample);
    });
  });
});
