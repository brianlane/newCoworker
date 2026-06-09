import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcilePendingEmailChange } from "@/lib/account/email-change";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type PendingRow = { user_id: string; business_id: string; new_email: string };

function makeDb(opts: {
  pending?: PendingRow | null;
  selectError?: { message: string } | null;
  updateError?: { message: string } | null;
}) {
  const maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: opts.pending ?? null, error: opts.selectError ?? null });
  const selectEq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq: selectEq });

  const deleteEq = vi.fn().mockResolvedValue({ error: null });
  const del = vi.fn().mockReturnValue({ eq: deleteEq });

  const updateEq = vi.fn().mockResolvedValue({ error: opts.updateError ?? null });
  const update = vi.fn().mockReturnValue({ eq: updateEq });

  const from = vi.fn((table: string) => {
    if (table === "pending_email_changes") return { select, delete: del };
    return { update };
  });

  return { db: { from }, from, update, updateEq, deleteEq };
}

const PENDING: PendingRow = {
  user_id: "user-1",
  business_id: "biz-1",
  new_email: "new@test.com"
};

describe("reconcilePendingEmailChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns early without a db call when userId is missing", async () => {
    await reconcilePendingEmailChange("", "new@test.com");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("returns early without a db call when email is missing", async () => {
    await reconcilePendingEmailChange("user-1", null);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("does nothing when there is no pending row", async () => {
    const { db, update } = makeDb({ pending: null });
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never);
    expect(update).not.toHaveBeenCalled();
  });

  it("does nothing when the pending select errors", async () => {
    const { db, update } = makeDb({ pending: PENDING, selectError: { message: "boom" } });
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not update or delete when the live email does not match new_email yet", async () => {
    const { db, update, deleteEq } = makeDb({ pending: PENDING });
    await reconcilePendingEmailChange("user-1", "old@test.com", db as never);
    expect(update).not.toHaveBeenCalled();
    expect(deleteEq).not.toHaveBeenCalled();
  });

  it("keeps the pending row when the owner_email update fails", async () => {
    const { db, update, deleteEq } = makeDb({ pending: PENDING, updateError: { message: "db down" } });
    await reconcilePendingEmailChange("user-1", "NEW@test.com", db as never);
    expect(update).toHaveBeenCalledWith({ owner_email: "NEW@test.com" });
    expect(deleteEq).not.toHaveBeenCalled();
  });

  it("updates owner_email and deletes the pending row on success", async () => {
    const { db, update, deleteEq } = makeDb({ pending: PENDING });
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never);
    expect(update).toHaveBeenCalledWith({ owner_email: "new@test.com" });
    expect(deleteEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("falls back to the service client when none is provided", async () => {
    const { db, update, deleteEq } = makeDb({ pending: PENDING });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await reconcilePendingEmailChange("user-1", "new@test.com");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ owner_email: "new@test.com" });
    expect(deleteEq).toHaveBeenCalledWith("user_id", "user-1");
  });
});
