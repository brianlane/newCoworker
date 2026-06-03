import { describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  insertVpsSshKey,
  getActiveVpsSshKey,
  getActiveVpsSshKeyForBusiness,
  listActiveVpsSshKeys
} from "@/lib/db/vps-ssh-keys";
import { generateKeyPair as nodeGenKeyPair } from "node:crypto";
import { promisify } from "node:util";
import { utils as ssh2Utils } from "ssh2";

const generateKeyPair = promisify(nodeGenKeyPair);

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

  describe("listActiveVpsSshKeys", () => {
    it("returns all active rows, filtering rotated_at IS NULL and ordering newest-first", async () => {
      const second = { ...sample, id: "row-2", business_id: "biz-2", hostinger_vps_id: "43" };
      const chain = makeChain();
      chain.order.mockResolvedValue({ data: [sample, second], error: null });
      const db = makeDb(chain);
      const rows = await listActiveVpsSshKeys(db as never);
      expect(rows).toEqual([sample, second]);
      expect(db.from).toHaveBeenCalledWith("vps_ssh_keys");
      expect(chain.is).toHaveBeenCalledWith("rotated_at", null);
      expect(chain.order).toHaveBeenCalledWith("created_at", { ascending: false });
    });

    it("returns an empty array when no VPS has been provisioned", async () => {
      const chain = makeChain();
      chain.order.mockResolvedValue({ data: null, error: null });
      const db = makeDb(chain);
      await expect(listActiveVpsSshKeys(db as never)).resolves.toEqual([]);
    });

    it("throws on Supabase error", async () => {
      const chain = makeChain();
      chain.order.mockResolvedValue({ data: null, error: { message: "list boom" } });
      const db = makeDb(chain);
      await expect(listActiveVpsSshKeys(db as never)).rejects.toThrow(/list boom/);
    });

    it("re-encodes legacy PKCS#8 PEMs across every returned row", async () => {
      const { privateKey } = await generateKeyPair("ed25519");
      const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      const legacy = { ...sample, private_key_pem: pkcs8 };
      const chain = makeChain();
      chain.order.mockResolvedValue({ data: [legacy], error: null });
      const db = makeDb(chain);
      const rows = await listActiveVpsSshKeys(db as never);
      expect(rows[0].private_key_pem).toContain("BEGIN OPENSSH PRIVATE KEY");
    });

    it("uses the default service client when none is provided", async () => {
      const chain = makeChain();
      chain.order.mockResolvedValue({ data: [sample], error: null });
      defaultClientSpy.mockReturnValueOnce(makeDb(chain));
      await expect(listActiveVpsSshKeys()).resolves.toEqual([sample]);
      expect(defaultClientSpy).toHaveBeenCalled();
    });
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

  describe("PKCS#8 → OpenSSH migration on read", () => {
    /**
     * Pin the contract that closes the bug surfaced by Cursor Bugbot
     * (PKCS#8 key migration not wired into production read paths):
     * legacy `vps_ssh_keys` rows persisted before generateSshKeypair()
     * switched its private-key export to OpenSSH-format ("openssh-key-v1")
     * remain on disk in PKCS#8 form. ssh2 1.17 — backing every
     * production sshExec — rejects PKCS#8 ed25519 PEMs with
     * "Cannot parse privateKey: Unsupported key format". Without
     * read-path migration, every legacy business would fail SSH
     * (backup/restore, change-plan, admin re-bootstrap).
     *
     * The fix: getActiveVpsSshKey* re-encodes PKCS#8 → openssh-key-v1
     * on the way out via convertPkcs8Ed25519PemToOpenssh. The
     * conversion is identity-preserving (same ed25519 keypair, just
     * re-framed) so the matching authorized_keys on the VPS keeps
     * authenticating without any VPS-side change.
     */
    async function makeLegacyPkcs8Row() {
      const { privateKey } = await generateKeyPair("ed25519");
      const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      return {
        ...sample,
        private_key_pem: pkcs8
      };
    }

    it("getActiveVpsSshKey re-encodes a legacy PKCS#8 PEM into ssh2-loadable OpenSSH format", async () => {
      const legacy = await makeLegacyPkcs8Row();
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValue({ data: legacy, error: null });
      const db = makeDb(chain);
      const row = await getActiveVpsSshKey("42", db as never);
      expect(row).not.toBeNull();
      expect(row!.private_key_pem).toContain("BEGIN OPENSSH PRIVATE KEY");
      expect(row!.private_key_pem).not.toContain("BEGIN PRIVATE KEY\n");
      // The migrated PEM must be parseable by ssh2 — the whole point of
      // wiring the migration into the read path.
      const parsed = ssh2Utils.parseKey(row!.private_key_pem);
      expect(parsed instanceof Error ? parsed.message : (parsed as { type: string }).type).toBe(
        "ssh-ed25519"
      );
    });

    it("getActiveVpsSshKeyForBusiness re-encodes a legacy PKCS#8 PEM into OpenSSH format", async () => {
      const legacy = await makeLegacyPkcs8Row();
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValue({ data: legacy, error: null });
      const db = makeDb(chain);
      const row = await getActiveVpsSshKeyForBusiness("biz-1", db as never);
      expect(row).not.toBeNull();
      expect(row!.private_key_pem).toContain("BEGIN OPENSSH PRIVATE KEY");
    });

    it("read path is idempotent on already-OpenSSH PEMs (no double-wrap)", async () => {
      // Generate an OpenSSH-format key and confirm a second pass through
      // the read migration leaves it byte-identical. This guards against
      // a regression where someone accidentally drops the
      // `if (includes("BEGIN OPENSSH"))` short-circuit in
      // convertPkcs8Ed25519PemToOpenssh — turning every read into a
      // re-encode that randomises the openssh `checkint` and quietly
      // breaks deterministic comparisons elsewhere.
      const { generateSshKeypair } = await import("@/lib/hostinger/keypair");
      const fresh = await generateSshKeypair("read-idempotent");
      const row = { ...sample, private_key_pem: fresh.privateKeyPem };
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValue({ data: row, error: null });
      const db = makeDb(chain);
      const out = await getActiveVpsSshKey("42", db as never);
      expect(out!.private_key_pem).toBe(fresh.privateKeyPem);
    });

    it("read path tolerates a malformed PEM by returning the row as-is", async () => {
      // Defence-in-depth: a row whose private_key_pem can't be parsed
      // by node:crypto is broken beyond what this migration can fix.
      // We surface the row unchanged so the downstream sshExec fails
      // with the specific "Cannot parse privateKey" error rather than
      // the read itself bombing — an operator debugging a malformed
      // row needs visibility into what's actually wrong, not a
      // generic "convertPkcs8Ed25519PemToOpenssh failed" wrapper.
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValue({ data: { ...sample, private_key_pem: "garbage" }, error: null });
      const db = makeDb(chain);
      const row = await getActiveVpsSshKey("42", db as never);
      expect(row!.private_key_pem).toBe("garbage");
    });

    it("read path is a no-op when private_key_pem is empty", async () => {
      // Treat empty string as "nothing to migrate" — same shape the
      // existing default-client tests already pass through.
      const chain = makeChain();
      chain.maybeSingle.mockResolvedValue({ data: { ...sample, private_key_pem: "" }, error: null });
      const db = makeDb(chain);
      const row = await getActiveVpsSshKey("42", db as never);
      expect(row!.private_key_pem).toBe("");
    });
  });
});
