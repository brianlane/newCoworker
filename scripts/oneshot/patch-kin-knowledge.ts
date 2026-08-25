/**
 * patch-kin-knowledge.ts: write KIN's booking links into the coworker's
 * business knowledge, and repair the white-glove greeting block.
 *
 * The flow routes the FIRST text. This routes every text after it: the SMS
 * coworker only knows what identity.md and soul.md tell it, and before this
 * they carried no booking links at all.
 *
 * Idempotent: the Booking Links section is replaced, not appended, and the
 * first-message block is rewritten in place.
 *
 * Usage:
 *   npx tsx scripts/oneshot/patch-kin-knowledge.ts --business <uuid>          # dry-run
 *   npx tsx scripts/oneshot/patch-kin-knowledge.ts --business <uuid> --apply
 */
import { loadEnv } from "../../debug/_shared.ts";
import { buildKinIdentityMd, buildKinSoulMd } from "./kin-knowledge-content.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const businessArgIdx = process.argv.indexOf("--business");
const BUSINESS_ID =
  (businessArgIdx !== -1 ? process.argv[businessArgIdx + 1] : undefined) ??
  process.env.KIN_BUSINESS_ID;
if (!BUSINESS_ID || !/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set KIN_BUSINESS_ID)");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: row, error } = await db
  .from("business_configs")
  .select("identity_md, soul_md")
  .eq("business_id", BUSINESS_ID)
  .maybeSingle();
if (error || !row) {
  console.error(`[oneshot] config fetch failed: ${error?.message ?? "no row"}`);
  process.exit(1);
}

const currentIdentity = String(row.identity_md ?? "");
const currentSoul = String(row.soul_md ?? "");
const nextIdentity = buildKinIdentityMd(currentIdentity);
const nextSoul = buildKinSoulMd(currentSoul);

const identityChanged = nextIdentity !== currentIdentity;
const soulChanged = nextSoul !== currentSoul;
console.log(`[oneshot] identity.md ${identityChanged ? "CHANGES" : "unchanged"} (${currentIdentity.length} -> ${nextIdentity.length} chars)`);
console.log(`[oneshot] soul.md ${soulChanged ? "CHANGES" : "unchanged"} (${currentSoul.length} -> ${nextSoul.length} chars)`);
if (identityChanged) {
  console.log("\n--- identity.md AFTER ---\n" + nextIdentity);
}
if (soulChanged) {
  const start = nextSoul.indexOf("### First message & qualification");
  console.log("\n--- soul.md first-message block AFTER ---\n" + nextSoul.slice(start, start + 1200));
}
if (!identityChanged && !soulChanged) {
  console.log("[oneshot] already current; nothing to do.");
  process.exit(0);
}
if (!APPLY) {
  console.log("\n[oneshot] dry-run only. Re-run with --apply to write.");
  process.exit(0);
}

const { error: updErr } = await db
  .from("business_configs")
  .update({ identity_md: nextIdentity, soul_md: nextSoul, updated_at: new Date().toISOString() })
  .eq("business_id", BUSINESS_ID);
if (updErr) {
  console.error(`[oneshot] update failed: ${updErr.message}`);
  process.exit(1);
}
await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: { identityChanged, soulChanged }
});
console.log("[oneshot] applied.");
