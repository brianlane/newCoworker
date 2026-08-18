/**
 * Set a contact's per-contact reply mode (contacts.sms_reply_mode).
 *
 * Built during a LIVE bot-vs-bot loop on Amy Laidlaw's account (2026-08-07):
 * HomeLight's automated feedback number (+14155491442) was saved as a customer
 * contact ("Aaron"), so the coworker politely replied to every robot text,
 * each reply triggered HomeLight's "this number is not monitored"
 * auto-responder, and every lap fired an owner alert at Amy. Two robots
 * thanking each other every 30 seconds, forever.
 *
 * `suppress` is the built-in kill for exactly this: the worker logs the
 * inbound and bumps the contact's counters but sends NO default Coworker
 * reply, which starves the other robot of anything to answer. Fully
 * reversible: run again with --mode auto (that reversal path is what
 * scripts/oneshot/undo-spam-flag.ts exists for on spam-flagged contacts).
 *
 * Usage:
 *   tsx debug/set-sms-reply-mode.ts --business <uuid> --phone +1XXXXXXXXXX --mode suppress          # dry-run
 *   tsx debug/set-sms-reply-mode.ts --business <uuid> --phone +1XXXXXXXXXX --mode suppress --apply  # write
 *
 * Modes (see sms-inbound-worker's reply gate for the semantics):
 *   auto, normal Coworker auto-reply (the default for every contact)
 *   suppress, no auto-reply; inbound still logged and counted
 *   forward_owner, no auto-reply; text forwarded to the owner's cell with a
 *                   "what would you like me to say?" relay prompt
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const MODES = ["auto", "suppress", "forward_owner"] as const;
type Mode = (typeof MODES)[number];

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")
    ? process.argv[i + 1]!
    : null;
}

const businessId = arg("business");
const phone = arg("phone");
const mode = arg("mode") as Mode | null;
const apply = process.argv.includes("--apply");

if (!businessId || !phone || !mode || !MODES.includes(mode)) {
  console.error(
    "Usage: tsx debug/set-sms-reply-mode.ts --business <uuid> --phone +1XXXXXXXXXX --mode auto|suppress|forward_owner [--apply]"
  );
  process.exit(2);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(2);
}
const { createClient } = await import("@supabase/supabase-js");
const db = createClient(url, key, { auth: { persistSession: false } });

// Alias-aware, matching the worker's own lookup: the reply gate resolves the
// contact by customer_e164 OR alias_e164s, so the update must target the same
// row that gate will read, not just an exact-number match.
const { data, error } = await db
  .from("contacts")
  .select("id, display_name, customer_e164, alias_e164s, sms_reply_mode")
  .eq("business_id", businessId)
  .or(`customer_e164.eq.${phone},alias_e164s.cs.{${phone}}`);
if (error) {
  console.error(`contact lookup FAILED: ${error.message}`);
  process.exit(1);
}
const rows = data ?? [];
if (rows.length === 0) {
  console.error(`No contact on ${businessId} with number or alias ${phone}.`);
  process.exit(1);
}
if (rows.length > 1) {
  console.error(`${rows.length} contacts match ${phone}; refusing to update ambiguously:`);
  for (const r of rows) console.error(`  ${r.id}  ${r.display_name}  ${r.customer_e164}`);
  process.exit(1);
}

const c = rows[0]!;
console.log(`contact : ${c.display_name} (${c.customer_e164})  id=${c.id}`);
console.log(`mode    : ${c.sms_reply_mode ?? "auto"} -> ${mode}`);

if (!apply) {
  console.log("\n[dry-run] Not writing. Re-run with --apply to write.");
  process.exit(0);
}

const { error: upErr } = await db
  .from("contacts")
  .update({ sms_reply_mode: mode })
  .eq("id", c.id)
  .eq("business_id", businessId);
if (upErr) {
  console.error(`update FAILED: ${upErr.message}`);
  process.exit(1);
}
console.log(`\nAPPLIED. The worker's reply gate reads this row per inbound, so the next`);
console.log(`message from ${phone} gets ${mode === "auto" ? "a normal reply again" : "no auto-reply"}.`);
