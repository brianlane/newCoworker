/**
 * Read back the WebVTT a Zoom import stored.
 *
 * The import writes the original transcript into the private documents
 * bucket and then condenses it; the condensation is what everything
 * downstream reads. Correcting a meeting needs the ORIGINAL, because the
 * speaker labels are the evidence of which name is wrong, and they only
 * survive in the raw file.
 *
 * Never throws: a missing or unreadable object answers with an empty
 * transcript, and the correction falls back to the document title.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { BUSINESS_DOCS_BUCKET } from "@/lib/documents/core";
import { logger } from "@/lib/logger";

export async function fetchStoredTranscript(
  businessId: string,
  storagePath: string
): Promise<string> {
  if (!storagePath.trim()) return "";
  try {
    const db = await createSupabaseServiceClient();
    const { data, error } = await db.storage.from(BUSINESS_DOCS_BUCKET).download(storagePath);
    if (error || !data) {
      logger.warn("zoom transcript: stored file unreadable", {
        businessId,
        error: error?.message ?? "no data"
      });
      return "";
    }
    return await data.text();
  } catch (err) {
    logger.warn("zoom transcript: stored file read threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return "";
  }
}
