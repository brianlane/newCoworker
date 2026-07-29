/**
 * Re-title and re-ingest an existing Zoom transcript document from its
 * stored VTT (fixes mid-word content_md truncation and generic titles).
 *
 * Dry-run by default. Pass --apply to write.
 *
 * Usage:
 *   tsx debug/zoom-refix-transcript-document.ts --document <uuid> [--meeting <id|uuid|link>] [--apply]
 *
 * Defaults to New Coworker HQ. When --meeting is set, past-meeting topic +
 * start_time drive the new title; otherwise the title is rebuilt from
 * whatever meta we can fetch for the document's existing storage label, or
 * left unchanged if Zoom is unreachable.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const HQ_BIZ = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const apply = process.argv.includes("--apply");
const documentId = argValue("--document");
const meetingRef = argValue("--meeting");
const businessId = argValue("--business") ?? HQ_BIZ;

if (!documentId) {
  console.error(
    "Usage: tsx debug/zoom-refix-transcript-document.ts --document <uuid> [--meeting <id|uuid|link>] [--business <uuid>] [--apply]"
  );
  process.exit(1);
}

const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const { getBusinessDocument, patchBusinessDocument } = await import("../src/lib/documents/db.ts");
const { BUSINESS_DOCS_BUCKET } = await import("../src/lib/documents/core.ts");
const { ingestDocument } = await import("../src/lib/documents/ingest.ts");
const { getBusiness } = await import("../src/lib/db/businesses.ts");
const {
  buildZoomTranscriptTitle,
  fetchPastMeetingMeta
} = await import("../src/lib/zoom/transcript.ts");
const { syncVaultToVpsAndLog } = await import("../src/lib/vps/sync-vault.ts");

const doc = await getBusinessDocument(businessId, documentId);
if (!doc) throw new Error(`Document ${documentId} not found for business ${businessId}`);
if (!doc.storage_path) throw new Error(`Document ${documentId} has no storage_path`);

const business = await getBusiness(businessId);
if (!business) throw new Error(`Business ${businessId} not found`);

const db = await createSupabaseServiceClient();
const { data: blob, error: dlError } = await db.storage
  .from(BUSINESS_DOCS_BUCKET)
  .download(doc.storage_path);
if (dlError || !blob) {
  throw new Error(`Storage download failed: ${dlError?.message ?? "empty"}`);
}
const bytes = Buffer.from(await blob.arrayBuffer());

let title = doc.title;
if (meetingRef) {
  const meta = await fetchPastMeetingMeta(businessId, meetingRef);
  title = buildZoomTranscriptTitle({
    topic: meta?.topic ?? null,
    startTime: meta?.startTime ?? null,
    meetingId: meta?.meetingId ?? null
  });
}

const ingested = await ingestDocument({
  businessId,
  title,
  mimeType: doc.mime_type,
  data: bytes,
  businessName: business.name
});
if (!ingested.ok) {
  throw new Error(`Ingest failed: ${ingested.error}${ingested.detail ? ` (${ingested.detail})` : ""}`);
}

console.log(
  JSON.stringify(
    {
      apply,
      documentId,
      oldTitle: doc.title,
      newTitle: title,
      oldContentLen: doc.content_md.length,
      newContentLen: ingested.contentMd.length,
      oldTail: doc.content_md.slice(-60),
      newTail: ingested.contentMd.slice(-80),
      hasTruncationMarker: ingested.contentMd.includes("… (transcript truncated)")
    },
    null,
    2
  )
);

if (!apply) {
  console.log("Dry-run only. Re-run with --apply to write.");
  process.exit(0);
}

await patchBusinessDocument(businessId, documentId, {
  title,
  content_md: ingested.contentMd,
  summary: ingested.summary,
  status: "ready",
  error_detail: null
});
void syncVaultToVpsAndLog(businessId);
console.log("Applied.");
