/**
 * DB access for contact_notes (src/lib/notes/db.ts): success + error paths
 * for every helper, on both the injected-client and default-client code
 * paths (the documents-db harness pattern).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  CONTACT_NOTES_LIST_LIMIT,
  createContactNote,
  deleteNotesForContact,
  getContactNote,
  listContactNotes,
  repointContactNoteIds,
  repointContactNotes,
  softDeleteContactNote,
  updateOwnContactNote
} from "@/lib/notes/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONTACT = "22222222-2222-4222-8222-222222222222";
const NOTE = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";

type Chain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;

function chain(terminal?: unknown): Chain {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "in", "is", "order", "limit"]) {
    c[m] = vi.fn(() => c);
  }
  c.single = vi.fn();
  c.maybeSingle = vi.fn();
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve);
  return c as Chain;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listContactNotes", () => {
  it("lists the contact's live notes newest-first under the explicit cap (explicit client)", async () => {
    const c = chain({ data: [{ id: NOTE }], error: null });
    expect(await listContactNotes(BIZ, CONTACT, makeDb(c))).toEqual([{ id: NOTE }]);
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("contact_id", CONTACT);
    expect(c.is).toHaveBeenCalledWith("deleted_at", null);
    expect(c.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(c.limit).toHaveBeenCalledWith(CONTACT_NOTES_LIST_LIMIT);
  });

  it("returns [] for a null data payload and uses the default client", async () => {
    const c = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await listContactNotes(BIZ, CONTACT)).toEqual([]);
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "boom" } });
    await expect(listContactNotes(BIZ, CONTACT, makeDb(c))).rejects.toThrow(/listContactNotes: boom/);
  });
});

describe("getContactNote", () => {
  it("returns the row scoped to business + contact + id (explicit client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: NOTE }, error: null });
    expect(await getContactNote(BIZ, CONTACT, NOTE, makeDb(c))).toEqual({ id: NOTE });
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("contact_id", CONTACT);
    expect(c.eq).toHaveBeenCalledWith("id", NOTE);
  });

  it("returns null on no row (default client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await getContactNote(BIZ, CONTACT, NOTE)).toBeNull();
  });

  it("throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(getContactNote(BIZ, CONTACT, NOTE, makeDb(c))).rejects.toThrow(
      /getContactNote: nope/
    );
  });
});

describe("createContactNote", () => {
  const row = {
    business_id: BIZ,
    contact_id: CONTACT,
    author_user_id: USER,
    author_label: "Sarah",
    body: "Warm lead"
  };

  it("inserts and returns the created row (explicit client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { id: NOTE, ...row }, error: null });
    expect(await createContactNote(row, makeDb(c))).toEqual({ id: NOTE, ...row });
    expect(c.insert).toHaveBeenCalledWith(row);
  });

  it("uses the default client", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { id: NOTE }, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await createContactNote(row)).toEqual({ id: NOTE });
  });

  it("throws on error", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "ins" } });
    await expect(createContactNote(row, makeDb(c))).rejects.toThrow(/createContactNote: ins/);
  });
});

describe("updateOwnContactNote", () => {
  it("updates through the author filter and reports the matched count (explicit client)", async () => {
    const c = chain({ data: [{ id: NOTE }], error: null });
    expect(await updateOwnContactNote(BIZ, CONTACT, NOTE, USER, "Edited", makeDb(c))).toBe(1);
    expect(c.update).toHaveBeenCalledWith({ body: "Edited", updated_at: expect.any(String) });
    expect(c.eq).toHaveBeenCalledWith("author_user_id", USER);
    expect(c.is).toHaveBeenCalledWith("deleted_at", null);
    expect(c.select).toHaveBeenCalledWith("id");
  });

  it("reports 0 for a non-array payload (default client)", async () => {
    const c = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await updateOwnContactNote(BIZ, CONTACT, NOTE, USER, "Edited")).toBe(0);
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "upd" } });
    await expect(updateOwnContactNote(BIZ, CONTACT, NOTE, USER, "Edited", makeDb(c))).rejects.toThrow(
      /updateOwnContactNote: upd/
    );
  });
});

describe("softDeleteContactNote", () => {
  it("stamps deleted_at with the author filter when given (explicit client)", async () => {
    const c = chain({ data: [{ id: NOTE }], error: null });
    expect(await softDeleteContactNote(BIZ, CONTACT, NOTE, { authorUserId: USER }, makeDb(c))).toBe(1);
    expect(c.update).toHaveBeenCalledWith({ deleted_at: expect.any(String) });
    expect(c.eq).toHaveBeenCalledWith("author_user_id", USER);
    expect(c.is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("deletes by id alone on the owner path and defaults opts (default client)", async () => {
    const c = chain({ data: [{ id: NOTE }], error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await softDeleteContactNote(BIZ, CONTACT, NOTE)).toBe(1);
    expect(c.eq).not.toHaveBeenCalledWith("author_user_id", expect.anything());
  });

  it("reports 0 for a non-array payload", async () => {
    const c = chain({ data: null, error: null });
    expect(await softDeleteContactNote(BIZ, CONTACT, NOTE, {}, makeDb(c))).toBe(0);
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "del" } });
    await expect(softDeleteContactNote(BIZ, CONTACT, NOTE, {}, makeDb(c))).rejects.toThrow(
      /softDeleteContactNote: del/
    );
  });
});

describe("repointContactNotes", () => {
  it("moves every note (soft-deleted included) and returns the moved ids (explicit client)", async () => {
    const c = chain({ data: [{ id: "n1" }, { id: "n2" }], error: null });
    expect(await repointContactNotes(BIZ, CONTACT, "target-contact", makeDb(c))).toEqual([
      "n1",
      "n2"
    ]);
    expect(c.update).toHaveBeenCalledWith({
      contact_id: "target-contact",
      updated_at: expect.any(String)
    });
    expect(c.eq).toHaveBeenCalledWith("contact_id", CONTACT);
    // No deleted_at filter: soft-deleted notes move with the person.
    expect(c.is).not.toHaveBeenCalled();
  });

  it("returns [] for a non-array payload (default client)", async () => {
    const c = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await repointContactNotes(BIZ, CONTACT, "target-contact")).toEqual([]);
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "rp" } });
    await expect(repointContactNotes(BIZ, CONTACT, "target-contact", makeDb(c))).rejects.toThrow(
      /repointContactNotes: rp/
    );
  });
});

describe("repointContactNoteIds", () => {
  it("no-ops on an empty id list without touching any client", async () => {
    await repointContactNoteIds(BIZ, [], CONTACT);
    expect(defaultClientSpy).not.toHaveBeenCalled();
  });

  it("moves exactly the given ids (explicit client)", async () => {
    const c = chain({ data: null, error: null });
    await repointContactNoteIds(BIZ, ["n1", "n2"], CONTACT, makeDb(c));
    expect(c.update).toHaveBeenCalledWith({
      contact_id: CONTACT,
      updated_at: expect.any(String)
    });
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.in).toHaveBeenCalledWith("id", ["n1", "n2"]);
  });

  it("uses the default client and throws on error", async () => {
    const c = chain({ data: null, error: { message: "rpids" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(repointContactNoteIds(BIZ, ["n1"], CONTACT)).rejects.toThrow(
      /repointContactNoteIds: rpids/
    );
  });
});

describe("deleteNotesForContact", () => {
  it("hard-deletes every row for the contact and counts them (explicit client)", async () => {
    const c = chain({ data: [{ id: "n1" }, { id: "n2" }], error: null });
    expect(await deleteNotesForContact(BIZ, CONTACT, makeDb(c))).toBe(2);
    expect(c.delete).toHaveBeenCalled();
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("contact_id", CONTACT);
  });

  it("reports 0 for a non-array payload (default client)", async () => {
    const c = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await deleteNotesForContact(BIZ, CONTACT)).toBe(0);
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "dnc" } });
    await expect(deleteNotesForContact(BIZ, CONTACT, makeDb(c))).rejects.toThrow(
      /deleteNotesForContact: dnc/
    );
  });
});
