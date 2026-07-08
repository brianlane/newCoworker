import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createHash } from "node:crypto";
import {
  CustomerHeldBackupKeyError,
  generateBackupPassphrase,
  getOrCreateResidencyBackupKey,
  resolveResidencyBackupPassphraseForDeploy,
  setResidencyBackupCustody
} from "@/lib/residency/backup-keys";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

function makeDb(opts: {
  reads: Array<{ data: unknown; error: { message: string } | null }>;
  insertError?: { message: string } | null;
  upsertError?: { message: string } | null;
}) {
  let readIdx = 0;
  const maybeSingle = vi.fn(async () => opts.reads[Math.min(readIdx++, opts.reads.length - 1)]);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const insert = vi.fn(async () => ({ error: opts.insertError ?? null }));
  const upsert = vi.fn(async () => ({ error: opts.upsertError ?? null }));
  const from = vi.fn(() => ({ select, insert, upsert }));
  return { db: { from } as never, insert, upsert };
}

describe("generateBackupPassphrase", () => {
  it("mints distinct, env-safe 256-bit values", () => {
    const a = generateBackupPassphrase();
    const b = generateBackupPassphrase();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("getOrCreateResidencyBackupKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the existing escrowed key without minting", async () => {
    const { db, insert } = makeDb({
      reads: [{ data: { passphrase: "existing" }, error: null }]
    });
    expect(await getOrCreateResidencyBackupKey(BIZ, db as never)).toBe("existing");
    expect(insert).not.toHaveBeenCalled();
  });

  it("mints + stores a key on first use", async () => {
    const { db, insert } = makeDb({ reads: [{ data: null, error: null }] });
    const key = await getOrCreateResidencyBackupKey(BIZ, db as never);
    expect(key).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(insert).toHaveBeenCalledWith({ business_id: BIZ, passphrase: key });
  });

  it("converges to the winner's key when losing a concurrent mint race", async () => {
    const { db } = makeDb({
      reads: [
        { data: null, error: null },
        { data: { passphrase: "winner" }, error: null }
      ],
      insertError: { message: "duplicate key value" }
    });
    expect(await getOrCreateResidencyBackupKey(BIZ, db as never)).toBe("winner");
  });

  it("throws when the race reread also fails or is empty", async () => {
    const rereadFail = makeDb({
      reads: [
        { data: null, error: null },
        { data: null, error: { message: "reread down" } }
      ],
      insertError: { message: "dup" }
    });
    await expect(getOrCreateResidencyBackupKey(BIZ, rereadFail.db as never)).rejects.toThrow(
      /reread down/
    );

    const rereadEmpty = makeDb({
      reads: [
        { data: null, error: null },
        { data: null, error: null }
      ],
      insertError: { message: "dup" }
    });
    await expect(getOrCreateResidencyBackupKey(BIZ, rereadEmpty.db as never)).rejects.toThrow(
      /no row/
    );
  });

  it("throws on a read error and uses the default client when none is passed", async () => {
    const readFail = makeDb({ reads: [{ data: null, error: { message: "read down" } }] });
    await expect(getOrCreateResidencyBackupKey(BIZ, readFail.db as never)).rejects.toThrow(
      /read down/
    );

    const ok = makeDb({ reads: [{ data: { passphrase: "svc" }, error: null }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(ok.db as never);
    expect(await getOrCreateResidencyBackupKey(BIZ)).toBe("svc");
  });

  it("throws the typed error for customer_held rows (custody flag or dropped plaintext)", async () => {
    const byCustody = makeDb({
      reads: [{ data: { passphrase: null, custody: "customer_held" }, error: null }]
    });
    await expect(getOrCreateResidencyBackupKey(BIZ, byCustody.db as never)).rejects.toThrow(
      CustomerHeldBackupKeyError
    );

    // Defensive: a null passphrase must never mint over a customer's flip
    // even if the custody column were somehow stale.
    const byNull = makeDb({
      reads: [{ data: { passphrase: null, custody: "escrowed" }, error: null }]
    });
    await expect(getOrCreateResidencyBackupKey(BIZ, byNull.db as never)).rejects.toThrow(
      /customer_held/
    );
  });
});

describe("resolveResidencyBackupPassphraseForDeploy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the escrowed key, and empty string for customer_held custody", async () => {
    const escrowed = makeDb({
      reads: [{ data: { passphrase: "escrowed-key", custody: "escrowed" }, error: null }]
    });
    expect(await resolveResidencyBackupPassphraseForDeploy(BIZ, escrowed.db as never)).toBe(
      "escrowed-key"
    );

    const customer = makeDb({
      reads: [{ data: { passphrase: null, custody: "customer_held" }, error: null }]
    });
    expect(await resolveResidencyBackupPassphraseForDeploy(BIZ, customer.db as never)).toBe("");
  });

  it("rethrows non-custody errors", async () => {
    const readFail = makeDb({ reads: [{ data: null, error: { message: "db down" } }] });
    await expect(
      resolveResidencyBackupPassphraseForDeploy(BIZ, readFail.db as never)
    ).rejects.toThrow(/db down/);
  });
});

describe("setResidencyBackupCustody", () => {
  beforeEach(() => vi.clearAllMocks());

  it("customer_held drops the plaintext and keeps the SHA-256 fingerprint", async () => {
    const { db, upsert } = makeDb({
      reads: [{ data: { passphrase: "the-escrowed-key" }, error: null }]
    });
    await setResidencyBackupCustody(BIZ, "customer_held", db as never);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        passphrase: null,
        custody: "customer_held",
        passphrase_sha256: createHash("sha256").update("the-escrowed-key").digest("hex")
      })
    );
  });

  it("customer_held with no existing key stores a null fingerprint", async () => {
    const { db, upsert } = makeDb({ reads: [{ data: null, error: null }] });
    await setResidencyBackupCustody(BIZ, "customer_held", db as never);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ passphrase: null, passphrase_sha256: null })
    );
  });

  it("escrowed mints a FRESH key (the dropped one is unrecoverable by design)", async () => {
    const { db, upsert } = makeDb({ reads: [{ data: null, error: null }] });
    await setResidencyBackupCustody(BIZ, "escrowed", db as never);
    const arg = (upsert.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(arg.custody).toBe("escrowed");
    expect(arg.passphrase_sha256).toBeNull();
    expect(String(arg.passphrase)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("surfaces read/write errors and uses the default client when none is passed", async () => {
    const readFail = makeDb({ reads: [{ data: null, error: { message: "read boom" } }] });
    await expect(
      setResidencyBackupCustody(BIZ, "customer_held", readFail.db as never)
    ).rejects.toThrow(/read boom/);

    const writeFail = makeDb({
      reads: [{ data: null, error: null }],
      upsertError: { message: "write boom" }
    });
    await expect(
      setResidencyBackupCustody(BIZ, "customer_held", writeFail.db as never)
    ).rejects.toThrow(/write boom/);
    await expect(
      setResidencyBackupCustody(BIZ, "escrowed", writeFail.db as never)
    ).rejects.toThrow(/write boom/);

    const ok = makeDb({ reads: [{ data: null, error: null }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(ok.db as never);
    await setResidencyBackupCustody(BIZ, "escrowed");
    expect(ok.upsert).toHaveBeenCalled();

    const okCustomer = makeDb({ reads: [{ data: null, error: null }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(okCustomer.db as never);
    await setResidencyBackupCustody(BIZ, "customer_held");
    expect(okCustomer.upsert).toHaveBeenCalled();
  });
});
