/**
 * DB access for the structured services catalog (src/lib/services/db.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  deleteBusinessService,
  insertBusinessService,
  listBusinessServices,
  patchBusinessService
} from "@/lib/services/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SVC = "22222222-2222-4222-8222-222222222222";

type Chain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;

function chain(terminal?: unknown): Chain {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "order"]) {
    c[m] = vi.fn(() => c);
  }
  c.single = vi.fn();
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve);
  return c as Chain;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listBusinessServices", () => {
  it("returns ordered rows (explicit client)", async () => {
    const c = chain({ data: [{ id: SVC }], error: null });
    expect(await listBusinessServices(BIZ, makeDb(c))).toEqual([{ id: SVC }]);
    expect(c.order).toHaveBeenCalledWith("position", { ascending: true });
  });

  it("returns [] on null data (default client)", async () => {
    const c = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await listBusinessServices(BIZ)).toEqual([]);
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "boom" } });
    await expect(listBusinessServices(BIZ, makeDb(c))).rejects.toThrow(/boom/);
  });
});

describe("insertBusinessService", () => {
  const row = { id: SVC, business_id: BIZ, name: "Massage" };

  it("inserts and returns the row (explicit client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { ...row, active: true }, error: null });
    const out = await insertBusinessService(row, makeDb(c));
    expect(out.name).toBe("Massage");
  });

  it("throws on error (default client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "ins" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(insertBusinessService(row)).rejects.toThrow(/ins/);
  });
});

describe("patchBusinessService", () => {
  it("scopes the update (explicit client)", async () => {
    const c = chain({ error: null });
    await patchBusinessService(BIZ, SVC, { price_text: "$99" }, makeDb(c));
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ price_text: "$99", updated_at: expect.any(String) })
    );
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("id", SVC);
  });

  it("throws on error (default client)", async () => {
    const c = chain({ error: { message: "upd" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(patchBusinessService(BIZ, SVC, { active: false })).rejects.toThrow(/upd/);
  });
});

describe("deleteBusinessService", () => {
  it("deletes scoped rows (explicit client)", async () => {
    const c = chain({ error: null });
    await deleteBusinessService(BIZ, SVC, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
  });

  it("throws on error (default client)", async () => {
    const c = chain({ error: { message: "del" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(deleteBusinessService(BIZ, SVC)).rejects.toThrow(/del/);
  });
});
