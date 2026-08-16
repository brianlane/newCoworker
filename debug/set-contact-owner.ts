/**
 * Assign a contact to a roster member (owner_employee_id -> that member).
 *
 * The mirror of `clear-contact-owner.ts`, and the manual counterpart to a
 * `route_to_team` claim. Needed whenever a lead is picked up outside the
 * claim machinery and the row never got stamped: an unowned contact sends
 * every later alert about it to the business owner instead of the person
 * actually working it (`contact_owner_target.ts`).
 *
 * The case that prompted it (Amy Laidlaw, 2026-08-15): a stranded lead was
 * alerted to the seller-tagged team by hand. A teammate replied "1", but the
 * alert was not a claim OFFER, so the bare "1" resolved against her most
 * recently updated live offer and the lead stayed unowned.
 *
 * Refuses to guess: the member must match by name on the ACTIVE roster, and
 * exactly one contact must match the phone.
 *
 * Usage:
 *   tsx debug/set-contact-owner.ts --business <uuid> --phone +1XXXXXXXXXX --member "Full Name"
 *   tsx debug/set-contact-owner.ts --business <uuid> --phone +1XXXXXXXXXX --member "Full Name" --apply
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
const memberName = arg("member");
const apply = process.argv.includes("--apply");
if (!businessId || !phone || !memberName) {
  console.error(
    'Usage: tsx debug/set-contact-owner.ts --business <uuid> --phone +1XXXXXXXXXX --member "Full Name" [--apply]'
  );
  process.exit(2);
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!url || !key) {
  console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
  process.exit(2);
}
const { createClient } = await import("@supabase/supabase-js");
const db = createClient(url, key, { auth: { persistSession: false } });

const { data: members, error: mErr } = await db
  .from("ai_flow_team_members")
  .select("id, name, phone_e164, active")
  .eq("business_id", businessId)
  .eq("active", true);
if (mErr) {
  console.error(`roster lookup FAILED: ${mErr.message}`);
  process.exit(1);
}
// Full-name match, case-insensitive. Broadcast name matching on this repo is
// full-name too ("Gabby" reaches nobody), so a partial match here would be a
// second, softer convention that quietly disagrees with the flows.
const want = memberName.trim().toLowerCase();
const matches = (members ?? []).filter((m) => (m.name ?? "").trim().toLowerCase() === want);
if (matches.length !== 1) {
  console.error(
    `expected exactly one ACTIVE roster member named "${memberName}", found ${matches.length}.` +
      ` Roster: ${(members ?? []).map((m) => m.name).join(", ")}`
  );
  process.exit(1);
}
const member = matches[0]!;

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
console.log(`new owner: ${member.name} (${member.id})`);
if (c.owner_employee_id === member.id) {
  console.log("already owned by that member, nothing to do.");
  process.exit(0);
}
if (c.owner_employee_id) {
  console.log(`NOTE: reassigning from an existing owner (${c.owner_employee_id}).`);
}
if (!apply) {
  console.log("[dry-run] Not writing. Re-run with --apply to set the owner.");
  process.exit(0);
}
const { data: updated, error: upErr } = await db
  .from("contacts")
  .update({ owner_employee_id: member.id })
  .eq("id", c.id)
  .eq("business_id", businessId)
  .select("id, owner_employee_id");
if (upErr) {
  console.error(`update FAILED: ${upErr.message}`);
  process.exit(1);
}
// A PostgREST update matching zero rows is NOT an error, so confirm the write
// actually landed rather than trusting the absence of one.
if ((updated ?? []).length !== 1) {
  console.error(`update matched ${(updated ?? []).length} rows; owner NOT set.`);
  process.exit(1);
}
console.log(`ASSIGNED. Alerts about this contact now go to ${member.name}, not the business owner.`);
