/**
 * fix-staff-contact-rows.ts: delete contact rows that an AiFlow send filed for
 * a roster member, before the engine learned that a teammate is never a lead.
 *
 * Background (the Dave Lane defect, Amy Laidlaw Real Estate, Jul 25 2026): a
 * post-claim hand-off step addressed the claiming teammate through a templated
 * phone var (`to: "{{vars.claimed_agent_phone}}"`). The worker did not recognize
 * that as an internal teammate send, so it filed a lead customer profile for the
 * number, and the only guard checked for an EXISTING non-customer contacts row,
 * which a teammate who had never been a contact did not have. Worse, when the
 * run had captured no lead phone the engine treated the recipient AS the lead,
 * so the row was stamped with the LEAD's name: the dashboard read
 * "New customer: Dave Lane" on a row whose display_name was another person's.
 *
 * The engine now refuses this two ways (roster-aware internal-send detection in
 * the send step, plus a roster/self-aware guard in enrichCustomerProfile), so
 * no new rows appear. This cleans up the ones already filed.
 *
 * Deleting is the right repair, not renaming: the roster is the authoritative
 * record for these people and the dashboard already overlays their roster name
 * onto any row for their number (src/lib/db/contact-names.ts). The stored row
 * carries nothing worth keeping (an auto-captured name that belongs to someone
 * else), and its `type: 'customer'` is what puts the teammate on the Customers
 * page and in the "New customer" activity feed.
 *
 * SAFETY: a row is deleted only while it still looks exactly like the
 * auto-created artifact: the number is on the business's roster, type is
 * 'customer', name_source is 'auto', and it carries no merged aliases, tags,
 * owner assignment, email, or AI memory (summary/pinned notes). Anything else
 * means a human or a real interaction touched it since, so it is reported and
 * LEFT ALONE for manual review.
 *
 * Per scripts/oneshot/README.md, every tenant-specific value rides argv/env
 * (never hard-coded PII).
 *
 * Usage:
 *   set -a && source .env && set +a
 *   # audit every roster number for the business:
 *   npx tsx scripts/oneshot/fix-staff-contact-rows.ts --business <uuid>
 *   # or scope to specific numbers (repeatable):
 *   npx tsx scripts/oneshot/fix-staff-contact-rows.ts --business <uuid> \
 *     --phone +1XXXXXXXXXX --phone +1YYYYYYYYYY
 *   # land it:
 *   npx tsx scripts/oneshot/fix-staff-contact-rows.ts --business <uuid> --apply
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Every `--phone <e164>` occurrence, in order. */
function argValues(flag: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === flag && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

const BUSINESS_ID = argValue("--business") ?? "";
const PHONES = argValues("--phone").map((p) => p.trim());

if (!/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid>");
  process.exit(1);
}
for (const phone of PHONES) {
  if (!/^\+\d{8,15}$/.test(phone)) {
    console.error(`[oneshot] --phone ${phone} is not E.164 (e.g. +16025551234)`);
    process.exit(1);
  }
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

type RosterRow = { name: string | null; phone_e164: string };
type ContactRow = {
  id: string;
  customer_e164: string;
  display_name: string | null;
  type: string;
  name_source: string;
  email: string | null;
  tags: string[] | null;
  alias_e164s: string[] | null;
  owner_employee_id: string | null;
  summary_md: string | null;
  pinned_md: string | null;
  /** Concurrency token: a before-update trigger stamps this on EVERY write. */
  updated_at: string;
};

const { data: rosterData, error: rosterErr } = await db
  .from("ai_flow_team_members")
  .select("name, phone_e164")
  .eq("business_id", BUSINESS_ID);
if (rosterErr) {
  console.error(`[oneshot] roster read failed: ${rosterErr.message}`);
  process.exit(1);
}
const roster = (rosterData as RosterRow[] | null) ?? [];
if (roster.length === 0) {
  console.error("[oneshot] this business has no roster members, nothing to audit.");
  process.exit(1);
}
const rosterByPhone = new Map(roster.map((r) => [r.phone_e164, r.name?.trim() || "(unnamed)"]));

// Scope: the given numbers, or every roster number when none were given. A
// --phone that is NOT on the roster is a mistake worth stopping for, since the
// whole premise of the repair is "this number belongs to a teammate".
const targets = PHONES.length > 0 ? PHONES : [...rosterByPhone.keys()];
const offRoster = targets.filter((p) => !rosterByPhone.has(p));
if (offRoster.length > 0) {
  console.error(
    `[oneshot] not on this business's roster: ${offRoster.join(", ")}. ` +
      "This script only repairs rows for roster members; check the business id."
  );
  process.exit(1);
}

const { data: contactData, error: contactErr } = await db
  .from("contacts")
  .select(
    "id, customer_e164, display_name, type, name_source, email, tags, alias_e164s, owner_employee_id, summary_md, pinned_md, updated_at"
  )
  .eq("business_id", BUSINESS_ID)
  .in("customer_e164", targets);
if (contactErr) {
  console.error(`[oneshot] contacts read failed: ${contactErr.message}`);
  process.exit(1);
}
const contacts = (contactData as ContactRow[] | null) ?? [];

/**
 * Why this row is NOT the untouched auto-created artifact, or null when it is.
 * Every check is a reason a human (or a real interaction) has invested something
 * in the row that a blind delete would throw away.
 */
function keepReason(c: ContactRow): string | null {
  if (c.type !== "customer") return `type is '${c.type}', not the mis-filed 'customer'`;
  if (c.name_source !== "auto") return `display_name was set by hand (name_source: ${c.name_source})`;
  if ((c.alias_e164s ?? []).length > 0) return "another number was merged into it";
  if ((c.tags ?? []).length > 0) return `it carries tags (${(c.tags ?? []).join(", ")})`;
  if (c.owner_employee_id) return "it is assigned to a teammate as its owner";
  if (c.email) return "it carries an email address";
  if (c.summary_md || c.pinned_md) return "it carries AI memory (summary or pinned notes)";
  return null;
}

console.log(
  `[oneshot] business ${BUSINESS_ID}: auditing ${targets.length} roster number(s), ` +
    `${contacts.length} have a contact row`
);

const deletable: ContactRow[] = [];
for (const phone of targets) {
  const rosterName = rosterByPhone.get(phone)!;
  const row = contacts.find((c) => c.customer_e164 === phone);
  if (!row) {
    console.log(`[oneshot]   ${phone} (roster: ${rosterName}): no contact row, clean`);
    continue;
  }
  const keep = keepReason(row);
  const named = JSON.stringify(row.display_name);
  if (keep) {
    console.log(
      `[oneshot]   ${phone} (roster: ${rosterName}): SKIP ${row.id}, name=${named}, ${keep}`
    );
    continue;
  }
  console.log(
    `[oneshot]   ${phone} (roster: ${rosterName}): DELETE ${row.id}, ` +
      `mis-filed as a customer named ${named}`
  );
  deletable.push(row);
}

if (deletable.length === 0) {
  console.log("[oneshot] nothing to delete.");
  process.exit(0);
}

if (!APPLY) {
  console.log(
    `[oneshot] dry run complete: ${deletable.length} row(s) would be deleted. ` +
      "Re-run with --apply to write."
  );
  process.exit(0);
}

const deletedIds: string[] = [];
for (const row of deletable) {
  // Optimistic concurrency: `updated_at` is stamped by a BEFORE UPDATE trigger
  // on contacts, so matching it covers EVERY keepReason condition at once (and
  // any field a future column adds). A real interaction landing between the
  // audit read and this write, an inbound text bumping the counters, a tag,
  // a summarizer pass, moves it and the delete becomes a no-op. The shape
  // columns are re-asserted alongside it so the guarantee is readable in the
  // query itself rather than resting on one timestamp.
  const { data, error } = await db
    .from("contacts")
    .delete()
    .eq("id", row.id)
    .eq("business_id", BUSINESS_ID)
    .eq("customer_e164", row.customer_e164)
    .eq("updated_at", row.updated_at)
    .eq("type", "customer")
    .eq("name_source", "auto")
    .is("email", null)
    .is("owner_employee_id", null)
    .is("summary_md", null)
    .is("pinned_md", null)
    .select("id");
  if (error) {
    console.error(`[oneshot] delete ${row.id} failed: ${error.message}`);
    process.exit(1);
  }
  if (((data as { id: string }[] | null) ?? []).length === 0) {
    console.log(`[oneshot] ${row.id} changed since the read, left alone`);
    continue;
  }
  deletedIds.push(row.id);
  console.log(`[oneshot] deleted ${row.id} (${row.customer_e164})`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    audited_phones: targets.length,
    deleted_contact_ids: deletedIds,
    skipped: deletable.length - deletedIds.length
  }
});
console.log(`[oneshot] applied: ${deletedIds.length} row(s) deleted.`);
