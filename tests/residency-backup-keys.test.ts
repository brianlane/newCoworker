import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import {
  generateBackupPassphrase,
  getOrCreateResidencyBackupKey
} from "@/lib/residency/backup-keys";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

function makeDb(opts: {
  reads: Array<{ data: unknown; error: { message: string } | null }>;
  insertError?: { message: string } | null;
}) {
  let readIdx = 0;
  const maybeSingle = vi.fn(async () => opts.reads[Math.min(readIdx++, opts.reads.length - 1)]);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const insert = vi.fn(async () => ({ error: opts.insertError ?? null }));
  const from = vi.fn(() => ({ select, insert }));
  return { db: { from } as never, insert };
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
});
