/**
 * fix-hq-discovery-doc-pricing.ts: correct the garbled pricing bullet in the
 * Kingsley Moyo discovery-call transcript stored in HQ's documents.
 *
 * The Zoom import's AI summary mangled the numbers ("approximately
 * $999/month (or $99/month ... best price is $9.99/mo ...)"). HQ documents
 * are coworker-readable knowledge (business_knowledge_lookup answers from
 * them), and the person that summary is about texts the HQ line, so the
 * coworker could quote nonsense pricing at a real customer. The transcript
 * body is left byte-identical; only the summary bullet is replaced, with a
 * correction note so the edit is self-documenting.
 *
 * Actual prices (src/lib/plans/tier.ts): Standard $195/mo month-to-month,
 * $109/mo on a 12-month term, $99/mo on 24 months; intro discount on the
 * first period.
 *
 * Idempotent: exits cleanly when the corrected marker is already present.
 *
 * Usage:
 *   npx tsx scripts/oneshot/fix-hq-discovery-doc-pricing.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/fix-hq-discovery-doc-pricing.ts --business <uuid> --apply
 *   optional: --doc <uuid>   (defaults to the Aug 20 2026 discovery-call doc)
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.HQ_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set HQ_BUSINESS_ID)");
  process.exit(1);
}
const docArgIdx = process.argv.indexOf("--doc");
const DOC_ID =
  (docArgIdx !== -1 ? process.argv[docArgIdx + 1] : undefined) ??
  "00ad1b0d-680b-42f4-9488-07df6495575e";

const CORRECTED_MARKER = "Corrected 2026-08-24";
const CORRECTED_BULLET =
  "  * **Standard Tier (corrected):** Required for webhook support and Meta leads. " +
  "$195/month month-to-month with no contract, $109/month on a 12-month term, or $99/month on a " +
  "24-month term, with an intro discount on the first period. (" + CORRECTED_MARKER + ": the " +
  "original AI summary of this call garbled these numbers; the transcript below is unedited.)";

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: doc, error } = await db
  .from("business_documents")
  .select("id, title, content_md")
  .eq("business_id", BUSINESS_ID)
  .eq("id", DOC_ID)
  .maybeSingle();
if (error || !doc) {
  console.error(`[oneshot] doc fetch failed: ${error?.message ?? "no row"}`);
  process.exit(1);
}
const content: string = doc.content_md ?? "";
console.log(`[oneshot] doc "${doc.title}" (${content.length} chars)`);

if (content.includes(CORRECTED_MARKER)) {
  console.log("[oneshot] already corrected; nothing to do.");
  process.exit(0);
}

// Replace ONLY the garbled "Standard Tier" sub-bullet. Its siblings (tier
// overview, the two-accounts plan) are accurate and stay.
const startToken = "  * **Standard Tier:**";
const start = content.indexOf(startToken);
if (start === -1) {
  console.error("[oneshot] could not find the Standard Tier sub-bullet; doc changed shape. Refusing.");
  process.exit(1);
}
const nextBullet = content.indexOf("\n  * ", start + 1);
if (nextBullet === -1) {
  console.error("[oneshot] could not find the end of the Standard Tier bullet. Refusing.");
  process.exit(1);
}
const oldBlock = content.slice(start, nextBullet);
console.log("[oneshot] REPLACING (rollback copy):\n" + oldBlock);
console.log("[oneshot] WITH:\n" + CORRECTED_BULLET);
const next = content.slice(0, start) + CORRECTED_BULLET + content.slice(nextBullet);

if (!APPLY) {
  console.log("[oneshot] dry-run only. Re-run with --apply to write.");
  process.exit(0);
}

const { error: updErr } = await db
  .from("business_documents")
  .update({ content_md: next, updated_at: new Date().toISOString() })
  .eq("id", doc.id);
if (updErr) {
  console.error(`[oneshot] update failed: ${updErr.message}`);
  process.exit(1);
}
await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: { docId: doc.id, replacedChars: oldBlock.length }
});
console.log("[oneshot] applied.");
