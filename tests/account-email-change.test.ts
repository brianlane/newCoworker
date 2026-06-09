import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcilePendingEmailChange } from "@/lib/account/email-change";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type PendingRow = { user_id: string; old_email: string; new_email: string };

function makeDb(opts: {
  pending?: PendingRow | null;
  selectError?: { message: string } | null;
  updateError?: { message: string } | null;
  updatedRows?: Array<{ id: string }> | null;
  alreadySynced?: { id: string } | null;
}) {
  // pending_email_changes.select().eq().maybeSingle()
  const pendingMaybeSingle = vi
    .fn()
    .mockResolvedValue({ data: opts.pending ?? null, error: opts.selectError ?? null });
  const pendingSelectEq = vi.fn().mockReturnValue({ maybeSingle: pendingMaybeSingle });
  const pendingSelect = vi.fn().mockReturnValue({ eq: pendingSelectEq });

  // pending_email_changes.delete().eq()
  const deleteEq = vi.fn().mockResolvedValue({ error: null });
  const del = vi.fn().mockReturnValue({ eq: deleteEq });

  // businesses.update().eq().select()
  const updateSelect = vi
    .fn()
    .mockResolvedValue({ data: opts.updatedRows ?? [], error: opts.updateError ?? null });
  const updateEq = vi.fn().mockReturnValue({ select: updateSelect });
  const update = vi.fn().mockReturnValue({ eq: updateEq });

  // businesses.select().eq().limit().maybeSingle()  (already-synced probe)
  const alreadyMaybeSingle = vi.fn().mockResolvedValue({ data: opts.alreadySynced ?? null, error: null });
  const alreadyLimit = vi.fn().mockReturnValue({ maybeSingle: alreadyMaybeSingle });
  const alreadyEq = vi.fn().mockReturnValue({ limit: alreadyLimit });
  const bizSelect = vi.fn().mockReturnValue({ eq: alreadyEq });

  const from = vi.fn((table: string) => {
    if (table === "pending_email_changes") return { select: pendingSelect, delete: del };
    return { update, select: bizSelect };
  });

  return { db: { from }, from, update, updateEq, bizSelect, deleteEq };
}

const PENDING: PendingRow = {
  user_id: "user-1",
  old_email: "old@test.com",
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

  it("updates every business under the old email and deletes the pending row on success", async () => {
    const { db, update, updateEq, deleteEq } = makeDb({
      pending: PENDING,
      updatedRows: [{ id: "biz-1" }, { id: "biz-2" }]
    });
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never);
    expect(update).toHaveBeenCalledWith({ owner_email: "new@test.com" });
    expect(updateEq).toHaveBeenCalledWith("owner_email", "old@test.com");
    expect(deleteEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("keeps the pending row when zero businesses matched and none are on the new email yet", async () => {
    const { db, deleteEq, bizSelect } = makeDb({ pending: PENDING, updatedRows: [], alreadySynced: null });
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never);
    expect(bizSelect).toHaveBeenCalled();
    expect(deleteEq).not.toHaveBeenCalled();
  });

  it("clears the pending row when a prior run already synced businesses to the new email", async () => {
    const { db, deleteEq } = makeDb({ pending: PENDING, updatedRows: [], alreadySynced: { id: "biz-1" } });
    await reconcilePendingEmailChange("user-1", "new@test.com", db as never);
    expect(deleteEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("falls back to the service client when none is provided", async () => {
    const { db, update, deleteEq } = makeDb({ pending: PENDING, updatedRows: [{ id: "biz-1" }] });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await reconcilePendingEmailChange("user-1", "new@test.com");
    expect(createSupabaseServiceClient).toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({ owner_email: "new@test.com" });
    expect(deleteEq).toHaveBeenCalledWith("user_id", "user-1");
  });
});
