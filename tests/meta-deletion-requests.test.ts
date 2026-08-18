/**
 * The deletion-request ledger (src/lib/meta/deletion-requests.ts).
 *
 * Meta requires the Data Deletion Request callback to hand back a
 * confirmation code and a URL where the person can read what happened, so
 * the request has to outlive the HTTP call. These are the reads and writes
 * behind that.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  getMetaDeletionRequestByCode,
  insertMetaDeletionRequest
} from "@/lib/meta/deletion-requests";

type Chain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;

function chain(terminal?: unknown): Chain {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "eq"]) c[m] = vi.fn(() => c);
  c.single = vi.fn();
  c.maybeSingle = vi.fn();
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve);
  return c as Chain;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

const ROW = {
  id: "r-1",
  confirmation_code: "ABCDEFGH2345",
  meta_user_id: "122098495527401398",
  connections_cleared: 1,
  status: "completed" as const,
  detail: null,
  requested_at: "2026-08-18T00:00:00Z",
  completed_at: "2026-08-18T00:00:00Z"
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("insertMetaDeletionRequest", () => {
  it("records the request, stamping when it completed", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: ROW, error: null });
    const row = await insertMetaDeletionRequest(
      {
        confirmationCode: "ABCDEFGH2345",
        metaUserId: "122098495527401398",
        connectionsCleared: 1,
        status: "completed"
      },
      makeDb(c)
    );
    expect(row).toEqual(ROW);
    expect(c.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmation_code: "ABCDEFGH2345",
        meta_user_id: "122098495527401398",
        connections_cleared: 1,
        status: "completed",
        detail: null,
        completed_at: expect.any(String)
      })
    );
  });

  it("carries a failure detail through", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: ROW, error: null });
    await insertMetaDeletionRequest(
      {
        confirmationCode: "X",
        metaUserId: "1",
        connectionsCleared: 0,
        status: "failed",
        detail: "db down"
      },
      makeDb(c)
    );
    expect(c.insert).toHaveBeenCalledWith(expect.objectContaining({ detail: "db down" }));
  });

  it("throws on error", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "dup" } });
    await expect(
      insertMetaDeletionRequest(
        { confirmationCode: "X", metaUserId: "1", connectionsCleared: 0, status: "no_data" },
        makeDb(c)
      )
    ).rejects.toThrow(/dup/);
  });
});

describe("getMetaDeletionRequestByCode", () => {
  it("looks a code up case-insensitively, since people retype it", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    expect(await getMetaDeletionRequestByCode("  abcdefgh2345 ", makeDb(c))).toEqual(ROW);
    expect(c.eq).toHaveBeenCalledWith("confirmation_code", "ABCDEFGH2345");
  });

  it("REFUSES a blank code instead of querying", async () => {
    // A blank code must never return "some row": the status page would then
    // show one person's outcome to another.
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: ROW, error: null });
    expect(await getMetaDeletionRequestByCode("", makeDb(c))).toBeNull();
    expect(await getMetaDeletionRequestByCode("   ", makeDb(c))).toBeNull();
    expect(c.eq).not.toHaveBeenCalled();
  });

  it("returns null for an unknown code and throws on error", async () => {
    const miss = chain();
    miss.maybeSingle.mockResolvedValue({ data: null, error: null });
    expect(await getMetaDeletionRequestByCode("NOPE", makeDb(miss))).toBeNull();

    const err = chain();
    err.maybeSingle.mockResolvedValue({ data: null, error: { message: "boom" } });
    await expect(getMetaDeletionRequestByCode("X", makeDb(err))).rejects.toThrow(/boom/);
  });
});

describe("default-client paths", () => {
  it("resolves the service client when none is injected", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: ROW, error: null });
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));

    await insertMetaDeletionRequest({
      confirmationCode: "X",
      metaUserId: "1",
      connectionsCleared: 0,
      status: "no_data"
    });
    await getMetaDeletionRequestByCode("X");
    expect(defaultClientSpy).toHaveBeenCalledTimes(2);
  });
});
