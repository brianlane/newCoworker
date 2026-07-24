/**
 * fix-kyp-kav-contact.ts — repair a lead's split contact identity: name and
 * email the REAL-number contact row, delete the junk-number orphan carrying
 * the name.
 *
 * Background (KYP Ads, Jul 24 2026): a Facebook lead typed a junk phone into
 * the form, so the intake flow filed the contact NAME on an undialable
 * number. The lead then booked through Calendly with their real number and
 * email; the calendar pre-call reminder flow texted the real number, and the
 * send-side contact filing created that row NAMELESS because the flow's
 * `invitee_first_name` var was not in the engine's conventional name keys
 * (fixed in the same PR as this script). The dashboard Texts thread showed
 * "Set contact" for a lead the AI was addressing by name.
 *
 * What --apply does (idempotent, fill-only):
 *   1. On the REAL-number contact row: set display_name/email only where
 *      they are currently empty — an owner edit is never clobbered.
 *   2. Delete the junk-number row, but ONLY while it still looks exactly
 *      like the known orphan (the given name, no aliases, no tags) — if it
 *      has since been edited or merged, it is left alone with a note.
 *
 * Per scripts/oneshot/README.md, every tenant-specific value rides argv/env
 * (never hard-coded PII).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/fix-kyp-kav-contact.ts --business <uuid> \
 *     --real +1XXXXXXXXXX --junk +XXXXXXXXX --name <name> [--email <email>]          # dry-run
 *   npx tsx scripts/oneshot/fix-kyp-kav-contact.ts --business <uuid> \
 *     --real +1XXXXXXXXXX --junk +XXXXXXXXX --name <name> [--email <email>] --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business") ?? process.env.KYP_BUSINESS_ID ?? "";
const REAL_E164 = argValue("--real") ?? "";
const JUNK_E164 = argValue("--junk") ?? "";
const NAME = (argValue("--name") ?? "").trim();
const EMAIL = (argValue("--email") ?? "").trim().toLowerCase();

if (!/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid> (or set KYP_BUSINESS_ID)");
  process.exit(1);
}
if (!/^\+\d{8,15}$/.test(REAL_E164)) {
  console.error("[oneshot] pass --real <E.164> (the lead's dialable number)");
  process.exit(1);
}
if (!/^\+\d{8,15}$/.test(JUNK_E164) || JUNK_E164 === REAL_E164) {
  console.error("[oneshot] pass --junk <E.164> (the orphan row's number, distinct from --real)");
  process.exit(1);
}
if (NAME.length === 0) {
  console.error("[oneshot] pass --name <display name>");
  process.exit(1);
}
if (EMAIL.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(EMAIL)) {
  console.error("[oneshot] --email does not look like an email address");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

type ContactRow = {
  id: string;
  customer_e164: string;
  display_name: string | null;
  email: string | null;
  tags: string[] | null;
  alias_e164s: string[] | null;
};

async function readContact(e164: string): Promise<ContactRow | null> {
  const { data, error } = await db
    .from("contacts")
    .select("id, customer_e164, display_name, email, tags, alias_e164s")
    .eq("business_id", BUSINESS_ID)
    .eq("customer_e164", e164)
    .maybeSingle();
  if (error) {
    console.error(`[oneshot] contact read failed for ${e164}:`, error.message);
    process.exit(1);
  }
  return (data as ContactRow | null) ?? null;
}

const real = await readContact(REAL_E164);
const junk = await readContact(JUNK_E164);

console.log(
  `[oneshot] real-number row (${REAL_E164}): ${
    real
      ? `${real.id} name=${JSON.stringify(real.display_name)} email=${JSON.stringify(real.email)}`
      : "MISSING"
  }`
);
console.log(
  `[oneshot] junk-number row (${JUNK_E164}): ${
    junk ? `${junk.id} name=${JSON.stringify(junk.display_name)}` : "none (already removed)"
  }`
);

if (!real) {
  console.error(
    `[oneshot] no contact row for ${REAL_E164} — nothing to name. If the Texts thread exists, ` +
      "the row should too (interaction rollup); investigate before re-running."
  );
  process.exit(1);
}

// Fill-only: never clobber an owner edit.
const updates: Record<string, unknown> = {};
if (!real.display_name || real.display_name.trim() === "") updates.display_name = NAME;
if (EMAIL && (!real.email || real.email.trim() === "")) updates.email = EMAIL;

// The junk row is only deletable while it still looks exactly like the known
// orphan: the given name, no merged aliases, no tags. Anything else means a
// human (or a merge) touched it since — leave it for manual review.
const junkDeletable =
  junk != null &&
  junk.display_name === NAME &&
  (junk.alias_e164s ?? []).length === 0 &&
  (junk.tags ?? []).length === 0;

console.log(
  `[oneshot] planned: ${
    Object.keys(updates).length > 0
      ? `set ${Object.keys(updates).join(" + ")} on ${real.id}`
      : "real-number row already filled, no update"
  }; ` +
    (junk
      ? junkDeletable
        ? `delete orphan ${junk.id}`
        : `orphan ${junk.id} no longer matches the known shape — SKIP delete`
      : "no orphan to delete")
);

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

if (Object.keys(updates).length > 0) {
  updates.updated_at = new Date().toISOString();
  const { error: updErr } = await db.from("contacts").update(updates).eq("id", real.id);
  if (updErr) {
    console.error("[oneshot] real-number contact update failed:", updErr.message);
    process.exit(1);
  }
  console.log(`[oneshot] updated ${real.id}: ${Object.keys(updates).join(", ")}`);
}

let deletedJunkId: string | null = null;
if (junk && junkDeletable) {
  const { error: delErr } = await db
    .from("contacts")
    .delete()
    .eq("id", junk.id)
    .eq("customer_e164", JUNK_E164);
  if (delErr) {
    console.error("[oneshot] orphan delete failed:", delErr.message);
    process.exit(1);
  }
  deletedJunkId = junk.id;
  console.log(`[oneshot] deleted orphan ${junk.id} (${JUNK_E164})`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    named_contact_id: real.id,
    fields_set: Object.keys(updates).filter((k) => k !== "updated_at"),
    deleted_junk_contact_id: deletedJunkId
  }
});
console.log("[oneshot] applied.");
