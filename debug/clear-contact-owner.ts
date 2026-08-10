/**
 * Clear a wrongly-assigned contact owner (owner_employee_id -> null).
 *
 * Built for the Danfar incident (2026-08-10): claims on flows whose lead
 * phone was withheld bound ownership to the PARTNER's alert line, so the
 * partner contact itself ("HomeLight Referral", "Clever Referrals") ended
 * up owned by a teammate, and every later referral from that line was
 * owner-assigned to them without the team race. The code fix stops new
 * poisoning; this clears the existing rows.
 *
 * Usage:
 *   tsx debug/clear-contact-owner.ts --business <uuid> --phone +1XXXXXXXXXX          # dry-run
 *   tsx debug/clear-contact-owner.ts --business <uuid> --phone +1XXXXXXXXXX --apply
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith("--")
    ? process.argv[i + 1]!
    : null;
}
const businessId = arg("business");
const phone = arg("phone");
const apply = process.argv.includes("--apply");
if (!businessId || !phone) {
  console.error("Usage: tsx debug/clear-contact-owner.ts --business <uuid> --phone +1XXXXXXXXXX [--apply]");
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

const { data, error } = await db
  .from("contacts")
  .select("id, display_name, customer_e164, owner_employee_id")
  .eq("business_id", businessId)
  .eq("customer_e164", phone);
if (error) {
  console.error(`lookup FAILED: ${error.message}`);
  process.exit(1);
}
const rows = data ?? [];
if (rows.length !== 1) {
  console.error(`expected exactly one contact for ${phone}, found ${rows.length}`);
  process.exit(1);
}
const c = rows[0]!;
console.log(`contact: ${c.display_name} (${c.customer_e164}) owner=${c.owner_employee_id ?? "(none)"}`);
if (!c.owner_employee_id) {
  console.log("already unowned, nothing to do.");
  process.exit(0);
}
if (!apply) {
  console.log("[dry-run] Not writing. Re-run with --apply to clear the owner.");
  process.exit(0);
}
const { error: upErr } = await db
  .from("contacts")
  .update({ owner_employee_id: null })
  .eq("id", c.id)
  .eq("business_id", businessId);
if (upErr) {
  console.error(`update FAILED: ${upErr.message}`);
  process.exit(1);
}
console.log("CLEARED. The next lead from this line races the team normally.");
