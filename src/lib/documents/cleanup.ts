/**
 * Contact-linked document cleanup — runs when a contact is deleted.
 *
 * The FK is ON DELETE SET NULL as a safety net, but silently converting a
 * deleted person's records into UNLINKED knowledge-library documents would
 * both leak their data into the general library and mint library docs past
 * the tier cap for free. So the app deletes the person's record documents
 * WITH them — except documents holding a completed signature, which are
 * retained legal evidence (they unlink via the FK and keep their audit
 * trail), mirroring the document DELETE route's refusal.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import {
  deleteBusinessDocument,
  listBusinessDocumentsForContact,
  listDocumentSignatureRequests,
  voidAllSignatureRequestsForDocument
} from "./db";
import { BUSINESS_DOCS_BUCKET } from "./core";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ContactDocumentCleanupResult = {
  /** Record documents deleted with the contact. */
  deleted: number;
  /** Documents kept (signed evidence) — the FK unlinks them instead. */
  keptSigned: number;
};

/**
 * Delete every document linked to a contact, keeping signed evidence.
 * Throws on failure — the caller must NOT delete the contact when cleanup
 * failed, or the FK would orphan the remaining records into the library.
 */
export async function deleteContactLinkedDocuments(
  businessId: string,
  contactId: string,
  client?: SupabaseClient
): Promise<ContactDocumentCleanupResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const docs = await listBusinessDocumentsForContact(businessId, contactId, db);
  const result: ContactDocumentCleanupResult = { deleted: 0, keptSigned: 0 };

  for (const doc of docs) {
    // Race-safe ordering copied from the document DELETE route: FIRST void
    // every still-signable request (the signing write is conditional on
    // status sent/viewed, so no concurrent signer can complete after this),
    // THEN re-check for signed rows.
    const signedBefore = (await listDocumentSignatureRequests(businessId, doc.id, db)).some(
      (r) => r.status === "signed"
    );
    if (!signedBefore) {
      await voidAllSignatureRequestsForDocument(businessId, doc.id, db);
    }
    const requests = await listDocumentSignatureRequests(businessId, doc.id, db);
    if (requests.some((r) => r.status === "signed")) {
      // Signed evidence survives; the contact-delete FK unlinks it.
      result.keptSigned += 1;
      continue;
    }

    // Row first (cascades shares), then the stored original — a leftover
    // object with no row is invisible garbage, the reverse would be a live
    // row pointing at nothing.
    await deleteBusinessDocument(businessId, doc.id, db);
    const { error: removeError } = await db.storage
      .from(BUSINESS_DOCS_BUCKET)
      .remove([doc.storage_path]);
    if (removeError) {
      logger.warn("deleteContactLinkedDocuments: storage remove failed", {
        businessId,
        documentId: doc.id,
        error: removeError.message
      });
    }
    result.deleted += 1;
  }

  return result;
}
