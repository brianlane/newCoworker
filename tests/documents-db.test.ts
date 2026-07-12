/**
 * DB access for business_documents / business_document_shares
 * (src/lib/documents/db.ts): success + error paths for every helper, on
 * both the injected-client and default-client code paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  completeSignatureRequest,
  countBusinessDocuments,
  deleteBusinessDocument,
  getBusinessDocument,
  getDocumentShareByTokenSha,
  getDocumentSignatureRequestByTokenSha,
  insertBusinessDocument,
  insertDocumentShare,
  insertDocumentSignatureRequest,
  listBusinessDocuments,
  listDocumentShares,
  listDocumentSignatureRequests,
  markSignatureRequestViewed,
  patchBusinessDocument,
  revokeDocumentShare,
  touchDocumentShareAccess,
  voidSignatureRequest
} from "@/lib/documents/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";

type Chain = Record<string, ReturnType<typeof vi.fn>> & PromiseLike<unknown>;

function chain(terminal?: unknown): Chain {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "eq", "in", "not", "order"]) {
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

describe("listBusinessDocuments", () => {
  it("returns rows (explicit client)", async () => {
    const c = chain({ data: [{ id: DOC }], error: null });
    expect(await listBusinessDocuments(BIZ, makeDb(c))).toEqual([{ id: DOC }]);
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
  });

  it("returns [] for a null data payload and uses the default client", async () => {
    const c = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await listBusinessDocuments(BIZ)).toEqual([]);
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "boom" } });
    await expect(listBusinessDocuments(BIZ, makeDb(c))).rejects.toThrow(/boom/);
  });
});

describe("getBusinessDocument", () => {
  it("returns the row (explicit client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: DOC }, error: null });
    expect(await getBusinessDocument(BIZ, DOC, makeDb(c))).toEqual({ id: DOC });
  });

  it("returns null on no row (default client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await getBusinessDocument(BIZ, DOC)).toBeNull();
  });

  it("throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(getBusinessDocument(BIZ, DOC, makeDb(c))).rejects.toThrow(/nope/);
  });
});

describe("countBusinessDocuments", () => {
  it("returns the exact count (explicit client)", async () => {
    const c = chain({ count: 4, error: null });
    expect(await countBusinessDocuments(BIZ, makeDb(c))).toBe(4);
  });

  it("returns 0 for a null count (default client)", async () => {
    const c = chain({ count: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await countBusinessDocuments(BIZ)).toBe(0);
  });

  it("throws on error", async () => {
    const c = chain({ count: null, error: { message: "cnt" } });
    await expect(countBusinessDocuments(BIZ, makeDb(c))).rejects.toThrow(/cnt/);
  });
});

describe("insertBusinessDocument", () => {
  const row = {
    id: DOC,
    business_id: BIZ,
    title: "Price sheet",
    category: "pricing",
    audience: "both" as const,
    storage_path: "p",
    mime_type: "application/pdf",
    byte_size: 10
  };

  it("inserts and returns the row (explicit client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { ...row, status: "processing" }, error: null });
    const out = await insertBusinessDocument(row, makeDb(c));
    expect(out.status).toBe("processing");
    expect(c.insert).toHaveBeenCalledWith(expect.objectContaining({ id: DOC }));
  });

  it("throws on error (default client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "ins" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(insertBusinessDocument(row)).rejects.toThrow(/ins/);
  });
});

describe("patchBusinessDocument", () => {
  it("scopes the update to business + id (explicit client)", async () => {
    const c = chain({ error: null });
    await patchBusinessDocument(BIZ, DOC, { title: "New" }, makeDb(c));
    expect(c.update).toHaveBeenCalledWith(
      expect.objectContaining({ title: "New", updated_at: expect.any(String) })
    );
    expect(c.eq).toHaveBeenCalledWith("business_id", BIZ);
    expect(c.eq).toHaveBeenCalledWith("id", DOC);
  });

  it("throws on error (default client)", async () => {
    const c = chain({ error: { message: "upd" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(patchBusinessDocument(BIZ, DOC, { title: "x" })).rejects.toThrow(/upd/);
  });
});

describe("deleteBusinessDocument", () => {
  it("deletes scoped rows (explicit client)", async () => {
    const c = chain({ error: null });
    await deleteBusinessDocument(BIZ, DOC, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
  });

  it("throws on error (default client)", async () => {
    const c = chain({ error: { message: "del" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(deleteBusinessDocument(BIZ, DOC)).rejects.toThrow(/del/);
  });
});

describe("insertDocumentShare", () => {
  const share = {
    id: "33333333-3333-4333-8333-333333333333",
    business_id: BIZ,
    document_id: DOC,
    token_sha256: "deadbeef",
    shared_with: "+15551230000",
    channel: "sms",
    expires_at: "2026-08-01T00:00:00Z"
  };

  it("inserts and returns the row (explicit client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: share, error: null });
    expect(await insertDocumentShare(share, makeDb(c))).toEqual(share);
  });

  it("throws on error (default client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "shr" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(insertDocumentShare(share)).rejects.toThrow(/shr/);
  });
});

describe("getDocumentShareByTokenSha", () => {
  it("looks up by sha (explicit client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "s1" }, error: null });
    expect(await getDocumentShareByTokenSha("abc", makeDb(c))).toEqual({ id: "s1" });
    expect(c.eq).toHaveBeenCalledWith("token_sha256", "abc");
  });

  it("returns null on no row (default client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await getDocumentShareByTokenSha("abc")).toBeNull();
  });

  it("throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "tok" } });
    await expect(getDocumentShareByTokenSha("abc", makeDb(c))).rejects.toThrow(/tok/);
  });
});

describe("listDocumentShares", () => {
  it("lists for the business, optionally filtered by document (explicit client)", async () => {
    const c = chain({ data: [{ id: "s1" }], error: null });
    expect(await listDocumentShares(BIZ, DOC, makeDb(c))).toEqual([{ id: "s1" }]);
    expect(c.eq).toHaveBeenCalledWith("document_id", DOC);
  });

  it("returns [] for null data without a document filter (default client)", async () => {
    const c = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await listDocumentShares(BIZ)).toEqual([]);
    expect(c.eq).not.toHaveBeenCalledWith("document_id", expect.anything());
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "lst" } });
    await expect(listDocumentShares(BIZ, undefined, makeDb(c))).rejects.toThrow(/lst/);
  });
});

describe("revokeDocumentShare", () => {
  it("stamps revoked_at and reports the matched count (explicit client)", async () => {
    const c = chain({ data: [{ id: "s1" }], error: null });
    expect(await revokeDocumentShare(BIZ, "s1", undefined, makeDb(c))).toBe(1);
    expect(c.update).toHaveBeenCalledWith({ revoked_at: expect.any(String) });
    expect(c.eq).not.toHaveBeenCalledWith("document_id", expect.anything());
  });

  it("scopes to the document when given and reports 0 on a cross-document id", async () => {
    const c = chain({ data: [], error: null });
    expect(await revokeDocumentShare(BIZ, "s1", DOC, makeDb(c))).toBe(0);
    expect(c.eq).toHaveBeenCalledWith("document_id", DOC);
    const cNull = chain({ data: null, error: null });
    expect(await revokeDocumentShare(BIZ, "s1", DOC, makeDb(cNull))).toBe(0);
  });

  it("throws on error (default client)", async () => {
    const c = chain({ data: null, error: { message: "rvk" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(revokeDocumentShare(BIZ, "s1")).rejects.toThrow(/rvk/);
  });
});

describe("insertDocumentSignatureRequest", () => {
  const row = {
    id: "44444444-4444-4444-8444-444444444444",
    business_id: BIZ,
    document_id: DOC,
    token_sha256: "cafebabe",
    signer_name: "Jane",
    expires_at: "2026-08-01T00:00:00Z"
  };

  it("inserts and returns the row (explicit client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: { ...row, status: "sent" }, error: null });
    const out = await insertDocumentSignatureRequest(row, makeDb(c));
    expect(out.status).toBe("sent");
  });

  it("throws on error (default client)", async () => {
    const c = chain();
    c.single.mockResolvedValue({ data: null, error: { message: "sig-ins" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(insertDocumentSignatureRequest(row)).rejects.toThrow(/sig-ins/);
  });
});

describe("getDocumentSignatureRequestByTokenSha", () => {
  it("looks up by sha (explicit client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: { id: "r1" }, error: null });
    expect(await getDocumentSignatureRequestByTokenSha("abc", makeDb(c))).toEqual({ id: "r1" });
    expect(c.eq).toHaveBeenCalledWith("token_sha256", "abc");
  });

  it("returns null on no row (default client)", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await getDocumentSignatureRequestByTokenSha("abc")).toBeNull();
  });

  it("throws on error", async () => {
    const c = chain();
    c.maybeSingle.mockResolvedValue({ data: null, error: { message: "sig-tok" } });
    await expect(getDocumentSignatureRequestByTokenSha("abc", makeDb(c))).rejects.toThrow(
      /sig-tok/
    );
  });
});

describe("listDocumentSignatureRequests", () => {
  it("lists for the business, optionally filtered by document (explicit client)", async () => {
    const c = chain({ data: [{ id: "r1" }], error: null });
    expect(await listDocumentSignatureRequests(BIZ, DOC, makeDb(c))).toEqual([{ id: "r1" }]);
    expect(c.eq).toHaveBeenCalledWith("document_id", DOC);
  });

  it("returns [] for null data without a document filter (default client)", async () => {
    const c = chain({ data: null, error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    expect(await listDocumentSignatureRequests(BIZ)).toEqual([]);
    expect(c.eq).not.toHaveBeenCalledWith("document_id", expect.anything());
  });

  it("throws on error", async () => {
    const c = chain({ data: null, error: { message: "sig-lst" } });
    await expect(listDocumentSignatureRequests(BIZ, undefined, makeDb(c))).rejects.toThrow(
      /sig-lst/
    );
  });
});

describe("markSignatureRequestViewed", () => {
  it("flips sent → viewed conditionally (explicit client)", async () => {
    const c = chain({ error: null });
    await markSignatureRequestViewed("r1", makeDb(c));
    expect(c.update).toHaveBeenCalledWith({ status: "viewed" });
    expect(c.eq).toHaveBeenCalledWith("status", "sent");
  });

  it("throws on error (default client)", async () => {
    const c = chain({ error: { message: "sig-view" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(markSignatureRequestViewed("r1")).rejects.toThrow(/sig-view/);
  });
});

describe("completeSignatureRequest", () => {
  const fields = {
    signature_name: "Jane Customer",
    signed_at: "2026-07-11T12:00:00Z",
    signer_ip: "203.0.113.9",
    signer_user_agent: "UA",
    content_sha256: "deadbeef"
  };

  it("signs conditionally on a signable status and reports the count (explicit client)", async () => {
    const c = chain({ data: [{ id: "r1" }], error: null });
    expect(await completeSignatureRequest("r1", fields, makeDb(c))).toBe(1);
    expect(c.update).toHaveBeenCalledWith({ ...fields, status: "signed" });
    expect(c.in).toHaveBeenCalledWith("status", ["sent", "viewed"]);
  });

  it("reports 0 when the race was lost", async () => {
    const c = chain({ data: [], error: null });
    expect(await completeSignatureRequest("r1", fields, makeDb(c))).toBe(0);
    const cNull = chain({ data: null, error: null });
    expect(await completeSignatureRequest("r1", fields, makeDb(cNull))).toBe(0);
  });

  it("throws on error (default client)", async () => {
    const c = chain({ data: null, error: { message: "sig-cmp" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(completeSignatureRequest("r1", fields)).rejects.toThrow(/sig-cmp/);
  });
});

describe("voidSignatureRequest", () => {
  it("voids signable rows and reports the count (explicit client, no document filter)", async () => {
    const c = chain({ data: [{ id: "r1" }], error: null });
    expect(await voidSignatureRequest(BIZ, "r1", undefined, makeDb(c))).toBe(1);
    expect(c.update).toHaveBeenCalledWith({ status: "void" });
    expect(c.in).toHaveBeenCalledWith("status", ["sent", "viewed"]);
    expect(c.eq).not.toHaveBeenCalledWith("document_id", expect.anything());
  });

  it("scopes to the document when given and reports 0 on a signed/foreign row", async () => {
    const c = chain({ data: [], error: null });
    expect(await voidSignatureRequest(BIZ, "r1", DOC, makeDb(c))).toBe(0);
    expect(c.eq).toHaveBeenCalledWith("document_id", DOC);
    const cNull = chain({ data: null, error: null });
    expect(await voidSignatureRequest(BIZ, "r1", DOC, makeDb(cNull))).toBe(0);
  });

  it("throws on error (default client)", async () => {
    const c = chain({ data: null, error: { message: "sig-void" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(voidSignatureRequest(BIZ, "r1")).rejects.toThrow(/sig-void/);
  });
});

describe("touchDocumentShareAccess", () => {
  it("bumps the counter and stamps last_accessed_at (explicit client)", async () => {
    const c = chain({ error: null });
    await touchDocumentShareAccess("s1", 2, makeDb(c));
    expect(c.update).toHaveBeenCalledWith({
      access_count: 3,
      last_accessed_at: expect.any(String)
    });
  });

  it("throws on error (default client)", async () => {
    const c = chain({ error: { message: "tch" } });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await expect(touchDocumentShareAccess("s1", 0)).rejects.toThrow(/tch/);
  });
});
