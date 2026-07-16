/**
 * Contact-linked document cleanup (src/lib/documents/cleanup.ts): deleting
 * a contact deletes their record documents (rows + stored originals),
 * keeps signed evidence, and closes the void-then-recheck signing race.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));
vi.mock("@/lib/documents/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/documents/db")>()),
  listBusinessDocumentsForContact: vi.fn(),
  listDocumentSignatureRequests: vi.fn(),
  voidAllSignatureRequestsForDocument: vi.fn(),
  deleteBusinessDocument: vi.fn()
}));

import { deleteContactLinkedDocuments } from "@/lib/documents/cleanup";
import {
  deleteBusinessDocument,
  listBusinessDocumentsForContact,
  listDocumentSignatureRequests,
  voidAllSignatureRequestsForDocument,
  type BusinessDocumentRow,
  type DocumentSignatureRequestRow
} from "@/lib/documents/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONTACT = "33333333-3333-4333-8333-333333333333";

const listDocs = vi.mocked(listBusinessDocumentsForContact);
const listRequests = vi.mocked(listDocumentSignatureRequests);
const voidAll = vi.mocked(voidAllSignatureRequestsForDocument);
const deleteDoc = vi.mocked(deleteBusinessDocument);

function doc(id: string, overrides: Partial<BusinessDocumentRow> = {}): BusinessDocumentRow {
  return {
    id,
    business_id: BIZ,
    title: `Doc ${id}`,
    category: "policy",
    audience: "staff",
    storage_path: `${BIZ}/${id}/record.md`,
    mime_type: "text/markdown",
    byte_size: 10,
    content_md: "c",
    summary: "s",
    status: "ready",
    error_detail: null,
    expires_at: null,
    expiring_soon_notified_at: null,
    expired_notified_at: null,
    contact_id: CONTACT,
    renewal_date: null,
    assigned_employee_id: null,
    renewal_due_notified_at: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    ...overrides
  };
}

function signedRequest(status: DocumentSignatureRequestRow["status"]): DocumentSignatureRequestRow {
  return {
    id: "req-1",
    business_id: BIZ,
    document_id: "d",
    token_sha256: "t",
    signer_name: "Jane",
    signer_email: "",
    signer_phone: "",
    message: "",
    status,
    signature_name: status === "signed" ? "Jane" : null,
    signed_at: status === "signed" ? "2026-07-02T00:00:00Z" : null,
    signer_ip: null,
    signer_user_agent: null,
    content_sha256: null,
    signed_content_md: null,
    expires_at: "2026-08-01T00:00:00Z",
    created_at: "2026-07-01T00:00:00Z"
  };
}

function makeStorageDb(removeError: { message: string } | null = null) {
  const removed: unknown[] = [];
  const db = {
    storage: {
      from: vi.fn(() => ({
        remove: vi.fn(async (paths: string[]) => {
          removed.push(paths);
          return { error: removeError };
        })
      }))
    }
  };
  return { db: db as never, removed };
}

beforeEach(() => {
  vi.clearAllMocks();
  voidAll.mockResolvedValue(0);
  deleteDoc.mockResolvedValue(undefined);
});

describe("deleteContactLinkedDocuments", () => {
  it("deletes unsigned record documents (rows + stored originals)", async () => {
    const { db, removed } = makeStorageDb();
    listDocs.mockResolvedValue([doc("d1"), doc("d2")]);
    listRequests.mockResolvedValue([]);
    const result = await deleteContactLinkedDocuments(BIZ, CONTACT, db);
    expect(result).toEqual({ deleted: 2, keptSigned: 0 });
    expect(voidAll).toHaveBeenCalledTimes(2);
    expect(deleteDoc).toHaveBeenCalledWith(BIZ, "d1", db);
    expect(deleteDoc).toHaveBeenCalledWith(BIZ, "d2", db);
    expect(removed).toEqual([[`${BIZ}/d1/record.md`], [`${BIZ}/d2/record.md`]]);
  });

  it("keeps a signed document as evidence without voiding its requests", async () => {
    const { db } = makeStorageDb();
    listDocs.mockResolvedValue([doc("d1")]);
    listRequests.mockResolvedValue([signedRequest("signed")]);
    const result = await deleteContactLinkedDocuments(BIZ, CONTACT, db);
    expect(result).toEqual({ deleted: 0, keptSigned: 1 });
    expect(voidAll).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it("catches a signature landing between the void and the re-check", async () => {
    const { db } = makeStorageDb();
    listDocs.mockResolvedValue([doc("d1")]);
    listRequests
      .mockResolvedValueOnce([signedRequest("sent")])
      .mockResolvedValueOnce([signedRequest("signed")]);
    const result = await deleteContactLinkedDocuments(BIZ, CONTACT, db);
    expect(result).toEqual({ deleted: 0, keptSigned: 1 });
    expect(voidAll).toHaveBeenCalledTimes(1);
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it("continues past a storage-remove failure (row already gone)", async () => {
    const { db } = makeStorageDb({ message: "object missing" });
    listDocs.mockResolvedValue([doc("d1")]);
    listRequests.mockResolvedValue([]);
    const result = await deleteContactLinkedDocuments(BIZ, CONTACT, db);
    expect(result).toEqual({ deleted: 1, keptSigned: 0 });
  });

  it("returns zeros for a contact with no documents (default client)", async () => {
    const { db } = makeStorageDb();
    defaultClientSpy.mockReturnValue(db);
    listDocs.mockResolvedValue([]);
    const result = await deleteContactLinkedDocuments(BIZ, CONTACT);
    expect(result).toEqual({ deleted: 0, keptSigned: 0 });
  });

  it("propagates a row-delete failure so the caller aborts the contact delete", async () => {
    const { db } = makeStorageDb();
    listDocs.mockResolvedValue([doc("d1")]);
    listRequests.mockResolvedValue([]);
    deleteDoc.mockRejectedValueOnce(new Error("delete boom"));
    await expect(deleteContactLinkedDocuments(BIZ, CONTACT, db)).rejects.toThrow(/delete boom/);
  });
});
