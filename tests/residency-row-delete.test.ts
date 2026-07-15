import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  softDeleteContentRows,
  restoreContentRows,
  ContentRowMutationError
} from "@/lib/residency/row-delete";
import { __clearResidencyModeCache } from "@/lib/residency/read";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

type ChainResult = { data: unknown; error: { message: string } | null };

/** Update chain: from(table).update(set).eq(...).in?(...).select(pk) → result. */
function makeContentChain(result: ChainResult) {
  const chain = {
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    select: vi.fn().mockResolvedValue(result)
  };
  return chain;
}

function makeBizChain(mode: string | null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({
      data: mode === null ? null : { data_residency_mode: mode },
      error: null
    })
  };
}

function makeDb(mode: string | null, contentResult: ChainResult) {
  const contentChain = makeContentChain(contentResult);
  const bizChain = makeBizChain(mode);
  const db = {
    from: vi.fn((table: string) => (table === "businesses" ? bizChain : contentChain))
  };
  return { db, contentChain, bizChain };
}

describe("residency/row-delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearResidencyModeCache();
  });

  it("refuses to stamp with no row filters (business_id alone is too broad)", async () => {
    const { db } = makeDb("supabase", { data: [], error: null });
    await expect(
      softDeleteContentRows(BIZ, "email_log", [], USER, { client: db as never })
    ).rejects.toThrow(ContentRowMutationError);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("supabase mode: stamps centrally only, box is null", async () => {
    const { db, contentChain } = makeDb("supabase", { data: [{ id: "e1" }], error: null });
    const result = await softDeleteContentRows(
      BIZ,
      "email_log",
      [{ column: "id", op: "eq", value: "e1" }],
      USER,
      { client: db as never }
    );
    expect(result).toEqual({ central: 1, box: null });
    expect(contentChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_by: USER, deleted_at: expect.any(String) })
    );
    expect(contentChain.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(contentChain.eq).toHaveBeenCalledWith("id", "e1");
  });

  it("applies `in` filters via .in()", async () => {
    const { db, contentChain } = makeDb("supabase", {
      data: [{ id: "a" }, { id: "b" }],
      error: null
    });
    const result = await softDeleteContentRows(
      BIZ,
      "sms_outbound_log",
      [{ column: "id", op: "in", value: ["a", "b"] }],
      null,
      { client: db as never }
    );
    expect(result.central).toBe(2);
    expect(contentChain.in).toHaveBeenCalledWith("id", ["a", "b"]);
    expect(contentChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ deleted_by: null })
    );
  });

  it("throws on central update error", async () => {
    const { db } = makeDb("supabase", { data: null, error: { message: "boom" } });
    await expect(
      softDeleteContentRows(BIZ, "email_log", [{ column: "id", op: "eq", value: "x" }], USER, {
        client: db as never
      })
    ).rejects.toThrow("central update on email_log failed: boom");
  });

  it("central returns 0 when data is null with no error", async () => {
    const { db } = makeDb("supabase", { data: null, error: null });
    const result = await softDeleteContentRows(
      BIZ,
      "email_log",
      [{ column: "id", op: "eq", value: "x" }],
      USER,
      { client: db as never }
    );
    expect(result).toEqual({ central: 0, box: null });
  });

  it("dual mode: also stamps on the box with business_id-scoped filters", async () => {
    const { db } = makeDb("dual", { data: [{ id: "t1" }], error: null });
    const update = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: "t1" }] });
    const result = await softDeleteContentRows(
      BIZ,
      "voice_call_transcripts",
      [{ column: "call_control_id", op: "eq", value: "v3:abc" }],
      USER,
      { client: db as never, dataApiFor: () => ({ update }) }
    );
    expect(result).toEqual({ central: 1, box: 1 });
    expect(update).toHaveBeenCalledWith({
      table: "voice_call_transcripts",
      set: expect.objectContaining({ deleted_by: USER }),
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "call_control_id", op: "eq", value: "v3:abc" }
      ],
      returning: true
    });
  });

  it("vps mode: box update failure fails LOUDLY before anything is stamped", async () => {
    const { db, contentChain } = makeDb("vps", { data: [{ id: "n1" }], error: null });
    const update = vi.fn().mockResolvedValue({ ok: false, error: "internal", message: "down" });
    await expect(
      softDeleteContentRows(
        BIZ,
        "notifications",
        [{ column: "id", op: "eq", value: "n1" }],
        USER,
        { client: db as never, dataApiFor: () => ({ update }) }
      )
    ).rejects.toThrow("box update on notifications failed: down");
    // Box-first ordering: the failed box call must abort BEFORE the central
    // stamp, so no read path (central or box) hides a half-deleted item.
    expect(contentChain.update).not.toHaveBeenCalled();
  });

  it("restoreContentRows clears the stamp centrally and on the box", async () => {
    const { db, contentChain } = makeDb("vps", { data: [{ id: "n1" }], error: null });
    const update = vi.fn().mockResolvedValue({ ok: true, rows: [{ id: "n1" }] });
    const result = await restoreContentRows(
      BIZ,
      "notifications",
      [{ column: "id", op: "eq", value: "n1" }],
      { client: db as never, dataApiFor: () => ({ update }) }
    );
    expect(result).toEqual({ central: 1, box: 1 });
    expect(contentChain.update).toHaveBeenCalledWith({ deleted_at: null, deleted_by: null });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ set: { deleted_at: null, deleted_by: null } })
    );
  });

  it("uses the default service client when none is injected", async () => {
    const { db } = makeDb("supabase", { data: [], error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const result = await softDeleteContentRows(
      BIZ,
      "email_log",
      [{ column: "id", op: "eq", value: "x" }],
      USER
    );
    expect(result.central).toBe(0);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});
