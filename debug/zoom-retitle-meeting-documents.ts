/**
 * Backfill guest + heading titles onto already-imported Zoom meeting docs.
 *
 * New imports get this title from importZoomTranscriptDocument. Documents
 * imported before that shipped still carry Zoom's generic topic, so several
 * rows read "New Coworker's Zoom Meeting" or the bare "Zoom meeting recording
 * (transcript)" and cannot be told apart in the Documents grid.
 *
 * Reads each document's stored VTT plus its saved content_md/summary and
 * re-derives the title with exactly the same helpers the import path uses.
 * Documents whose title is NOT generic are left alone: a host who named their
 * meeting said something we should not overwrite.
 *
 * Dry-run by default. Pass --apply to write.
 *
 * Usage:
 *   tsx debug/zoom-retitle-meeting-documents.ts [--business <uuid>] [--apply]
 *
 * Defaults to New Coworker HQ.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const HQ_BIZ = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const apply = process.argv.includes("--apply");
const businessId = argValue("--business") ?? HQ_BIZ;

const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const { patchBusinessDocument } = await import("../src/lib/documents/db.ts");
const { BUSINESS_DOCS_BUCKET } = await import("../src/lib/documents/core.ts");
const { getBusiness } = await import("../src/lib/db/businesses.ts");
const { getActiveZoomConnection } = await import("../src/lib/db/zoom-connections.ts");
const { vttToPlainText } = await import("../src/lib/transcripts/vtt.ts");
const {
  buildZoomGuestHeadingTitle,
  extractFirstMinutesHeading,
  extractVttSpeakers,
  isGenericZoomTopic,
  pickZoomGuestName,
  zoomTopicFromTitle
} = await import("../src/lib/zoom/document-title.ts");

const db = await createSupabaseServiceClient();

const business = await getBusiness(businessId);
if (!business) {
  console.error(`business ${businessId} not found`);
  process.exit(1);
}
const conn = await getActiveZoomConnection(businessId);
const hostNames = [business.name, conn?.account_name ?? ""].filter((n) => n.trim() !== "");
console.log(`[retitle] business=${business.name} hostNames=${JSON.stringify(hostNames)}`);
console.log(`[retitle] mode=${apply ? "APPLY" : "dry-run"}\n`);

const { data: docs, error } = await db
  .from("business_documents")
  .select("id, title, storage_path, content_md, summary")
  .eq("business_id", businessId)
  .eq("category", "meeting")
  .order("created_at", { ascending: true });
if (error) {
  console.error("document read failed:", error.message);
  process.exit(1);
}

let considered = 0;
let changed = 0;

for (const doc of (docs ?? []) as Array<{
  id: string;
  title: string;
  storage_path: string | null;
  content_md: string | null;
  summary: string | null;
}>) {
  considered += 1;
  // Same normalization the import path uses before judging the topic.
  if (!isGenericZoomTopic(zoomTopicFromTitle(doc.title))) {
    console.log(`  skip ${doc.id}: host-chosen title ${JSON.stringify(doc.title)}`);
    continue;
  }
  if (!doc.storage_path) {
    console.log(`  skip ${doc.id}: no stored object`);
    continue;
  }

  const { data: blob, error: dlError } = await db.storage
    .from(BUSINESS_DOCS_BUCKET)
    .download(doc.storage_path);
  if (dlError || !blob) {
    console.log(`  skip ${doc.id}: download failed (${dlError?.message ?? "no body"})`);
    continue;
  }
  const vtt = await blob.text();

  const guest = pickZoomGuestName({
    speakers: extractVttSpeakers(vttToPlainText(vtt)),
    hostNames,
    summary: doc.summary
  });
  const heading = extractFirstMinutesHeading(doc.content_md ?? "");
  const derived = buildZoomGuestHeadingTitle({ guest, heading });

  if (!derived || derived === doc.title) {
    console.log(`  skip ${doc.id}: nothing better to derive (guest=${guest}, heading=${heading})`);
    continue;
  }

  changed += 1;
  console.log(`  ${apply ? "WRITE" : "would write"} ${doc.id}`);
  console.log(`      from: ${doc.title}`);
  console.log(`        to: ${derived}`);
  if (apply) {
    await patchBusinessDocument(businessId, doc.id, { title: derived });
  }
}

console.log(
  `\n[retitle] ${considered} meeting document(s) considered, ${changed} ${apply ? "retitled" : "would be retitled"}`
);
if (!apply && changed > 0) console.log("[retitle] re-run with --apply to write");
