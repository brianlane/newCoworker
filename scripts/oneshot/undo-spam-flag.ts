/**
 * undo-spam-flag.ts — reverse a WRONGFUL owner spam flag on a real contact.
 *
 * Background (Jul 24 2026, KYP Ads / Chris Gregoris): James texted "stop
 * texting chris please" about a hot lead who was waiting on a personal call,
 * and the owner-operator turn mapped it onto flag_contact_spam — an
 * irreversible STOP-list block plus a spam tag and a "declared this contact
 * SPAM" pinned note. The right primitive for that intent is
 * contacts.sms_reply_mode='suppress' (no default Coworker reply; manual
 * sends and inbound processing unaffected). This script undoes the flag and
 * applies the intended state.
 *
 * SAFETY GATE: the script scans the contact's ENTIRE inbound history with
 * the same isStopKeyword matcher the compliance handler uses and ABORTS if
 * the person ever texted STOP themselves — a genuine customer opt-out is
 * sacred (CTIA / A2P 10DLC) and only the contact texting START may lift it.
 * Only tool-/owner-written suppression is reversible here.
 *
 * What --apply does:
 *   1. sms_clear_opt_out RPC — removes the suppression row.
 *   2. Contact: remove the "spam" tag, delete pinned-note lines carrying the
 *      spam-declaration marker, and set sms_reply_mode (default: suppress,
 *      honoring the owner's actual "stop texting them" request; pass
 *      --reply-mode auto to fully restore the coworker).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/undo-spam-flag.ts --business <uuid> --phone +1XXXXXXXXXX            # dry-run
 *   npx tsx scripts/oneshot/undo-spam-flag.ts --business <uuid> --phone +1XXXXXXXXXX --apply    # write
 *   (optional) --reply-mode suppress|auto   (default suppress)
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business") ?? "";
const PHONE = argValue("--phone") ?? "";
const REPLY_MODE = argValue("--reply-mode") ?? "suppress";

if (!/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid>");
  process.exit(1);
}
if (!/^\+\d{8,15}$/.test(PHONE)) {
  console.error("[oneshot] pass --phone <E.164, e.g. +18579289096>");
  process.exit(1);
}
if (!["suppress", "auto"].includes(REPLY_MODE)) {
  console.error("[oneshot] --reply-mode must be suppress or auto");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");
const { isStopKeyword } = await import("../../supabase/functions/_shared/telnyx_sms_compliance.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const SPAM_TAG = "spam";
/** The exact marker every tool-written spam note carries (flag-spam.ts). */
const SPAM_NOTE_MARKER = "declared this contact SPAM";

// ---------------------------------------------------------------------------
// Current state.
// ---------------------------------------------------------------------------
const { data: optRow, error: optErr } = await db
  .from("sms_opt_outs")
  .select("sender_e164, kind, set_at")
  .eq("business_id", BUSINESS_ID)
  .eq("sender_e164", PHONE)
  .maybeSingle();
if (optErr) {
  console.error("[oneshot] opt-out read failed:", optErr.message);
  process.exit(1);
}

const { data: contact, error: contactErr } = await db
  .from("contacts")
  .select("id, display_name, tags, pinned_md, sms_reply_mode")
  .eq("business_id", BUSINESS_ID)
  .eq("customer_e164", PHONE)
  .maybeSingle();
if (contactErr) {
  console.error("[oneshot] contact read failed:", contactErr.message);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// SAFETY GATE: did this person ever text a STOP keyword themselves? Scan the
// full inbound history with the SAME matcher the compliance handler uses.
// A genuine customer STOP must never be cleared by platform tooling.
// ---------------------------------------------------------------------------
const { data: inboundRows, error: inErr } = await db
  .from("sms_inbound_jobs")
  .select("created_at, payload")
  .eq("business_id", BUSINESS_ID)
  .eq("customer_e164", PHONE)
  .order("created_at", { ascending: true })
  .limit(1000);
if (inErr) {
  console.error("[oneshot] inbound history read failed:", inErr.message);
  process.exit(1);
}
const stopTexts: string[] = [];
for (const row of (inboundRows ?? []) as Array<{ created_at: string; payload: unknown }>) {
  const text =
    ((row.payload as { data?: { payload?: { text?: unknown } } })?.data?.payload?.text as
      | string
      | undefined) ?? "";
  if (typeof text === "string" && isStopKeyword(text.trim().toUpperCase())) {
    stopTexts.push(`${row.created_at}: ${text.trim()}`);
  }
}
if (stopTexts.length > 0) {
  console.error(
    "[oneshot] ABORT: this contact texted a STOP keyword themselves — a genuine customer " +
      "opt-out can only be lifted by the contact texting START:"
  );
  for (const line of stopTexts) console.error(`[oneshot]   ${line}`);
  process.exit(1);
}

const label = contact?.display_name ? `${contact.display_name} (${PHONE})` : PHONE;
console.log(`[oneshot] contact: ${label} (row ${contact?.id ?? "none"})`);
console.log(`[oneshot] opt-out row: ${optRow ? `kind=${optRow.kind} set_at=${optRow.set_at}` : "none"}`);
console.log(`[oneshot] inbound texts scanned: ${(inboundRows ?? []).length} — no STOP keyword found`);
console.log(`[oneshot] tags: ${JSON.stringify(contact?.tags ?? [])}`);
console.log(`[oneshot] sms_reply_mode: ${contact?.sms_reply_mode ?? "(no contact)"} → ${REPLY_MODE}`);

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Clear the suppression row.
// ---------------------------------------------------------------------------
if (optRow) {
  const { data: cleared, error: clearErr } = await db.rpc("sms_clear_opt_out", {
    p_business_id: BUSINESS_ID,
    p_sender_e164: PHONE
  });
  if (clearErr) {
    console.error("[oneshot] sms_clear_opt_out failed:", clearErr.message);
    process.exit(1);
  }
  console.log(`[oneshot] opt-out cleared: ${JSON.stringify(cleared)}`);
} else {
  console.log("[oneshot] no opt-out row — nothing to clear");
}

// ---------------------------------------------------------------------------
// 2. Contact: drop the spam tag + spam-declaration note lines; set reply mode.
// ---------------------------------------------------------------------------
if (contact) {
  const tags: string[] = Array.isArray(contact.tags) ? (contact.tags as string[]) : [];
  const pinned = typeof contact.pinned_md === "string" ? contact.pinned_md : "";
  const keptPinned = pinned
    .split("\n")
    .filter((line) => !line.includes(SPAM_NOTE_MARKER))
    .join("\n")
    .trim();
  const updates: Record<string, unknown> = {
    tags: tags.filter((t) => t !== SPAM_TAG),
    pinned_md: keptPinned.length > 0 ? keptPinned : null,
    sms_reply_mode: REPLY_MODE,
    updated_at: new Date().toISOString()
  };
  const { error: updErr } = await db.from("contacts").update(updates).eq("id", contact.id);
  if (updErr) {
    console.error("[oneshot] contact update failed:", updErr.message);
    process.exit(1);
  }
  console.log(
    `[oneshot] contact updated: spam tag removed, spam note lines removed, sms_reply_mode=${REPLY_MODE}`
  );
} else {
  console.log("[oneshot] no contact row — tag/note/reply-mode skipped");
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    phone: PHONE,
    cleared_opt_out: Boolean(optRow),
    reply_mode: REPLY_MODE
  }
});
console.log("[oneshot] applied.");
