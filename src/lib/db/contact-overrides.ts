/**
 * Owner-set manual contact labels, now stored on the unified `contacts` table.
 *
 * A manual label is the escape hatch when a derived name is wrong or missing:
 * the Safe Mode forward cell that belongs to someone other than
 * `businesses.owner_name`, or a lead-source short code like ReferralExchange's
 * 73339 that has no roster/customer identity. It is the same record the AI's
 * customer memory uses — these helpers just set the owner-facing name/email/type
 * without touching the memory fields.
 *
 * A row's `type` distinguishes a manual label (owner/tester/service/other) from
 * an auto customer profile (`customer`); see src/lib/db/contact-names.ts, where a
 * non-customer type wins over a derived owner/employee name.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { PG_UNIQUE_VIOLATION } from "@/lib/customer-memory/db";
import type { ContactType } from "@/lib/customer-memory/types";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** E.164, or a bare 3-8 digit short code (lead sources text from these). */
export const CONTACT_NUMBER_RE = /^(\+[1-9]\d{6,15}|\d{3,8})$/;

export type ContactOverrideRow = {
  e164: string;
  name: string;
  email: string | null;
  type: ContactType;
  updated_at: string;
};

export type SetContactOverrideInput = {
  /** Owner-set email linking this contact's number to their address (optional). */
  email?: string | null;
  /** Classification for a NEWLY-created manual contact; defaults to 'other'. */
  type?: ContactType;
};

/**
 * Set the owner-facing label for a number on the unified contacts table.
 *
 * Update-then-insert (not a blind upsert) so labeling an existing CUSTOMER from
 * a call/text thread only renames them — it never demotes their `type` away from
 * 'customer'. A number with no contact row yet becomes a manual contact (default
 * type 'other'); the memory fields stay at their defaults until the person
 * actually texts/calls.
 */
export async function setContactOverride(
  businessId: string,
  e164: string,
  name: string,
  options: SetContactOverrideInput = {},
  client?: SupabaseClient
): Promise<void> {
  const trimmed = name.trim();
  if (!CONTACT_NUMBER_RE.test(e164)) {
    throw new Error(`setContactOverride: invalid number ${e164}`);
  }
  if (trimmed.length === 0 || trimmed.length > 120) {
    throw new Error("setContactOverride: name must be 1-120 characters");
  }
  const db = client ?? (await createSupabaseServiceClient());
  const emailPatch = "email" in options ? { email: options.email?.trim() || null } : {};

  // 1) Try to relabel an existing row first — preserves its type (a customer
  //    stays a customer) and never disturbs the memory fields.
  const { data: updated, error: updErr } = await db
    .from("contacts")
    .update({ display_name: trimmed, ...emailPatch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("customer_e164", e164)
    .select("id");
  if (updErr) throw new Error(`setContactOverride: ${updErr.message}`);
  if (updated && updated.length > 0) return;

  // 2) No row yet → create a manual contact.
  const { error: insErr } = await db.from("contacts").insert({
    business_id: businessId,
    customer_e164: e164,
    display_name: trimmed,
    type: options.type ?? "other",
    ...emailPatch
  });
  if (!insErr) return;
  if (insErr.code !== PG_UNIQUE_VIOLATION) {
    throw new Error(`setContactOverride: ${insErr.message}`);
  }
  // Race: a concurrent writer (record_customer_interaction) created the row
  // between our update and insert. Relabel it now; keep its type.
  const { error: raceErr } = await db
    .from("contacts")
    .update({ display_name: trimmed, ...emailPatch, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("customer_e164", e164);
  if (raceErr) throw new Error(`setContactOverride: ${raceErr.message}`);
}

/** Manual (non-customer) contacts for a business, newest-edited first. */
export async function listContactOverrides(
  businessId: string,
  client?: SupabaseClient
): Promise<ContactOverrideRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("contacts")
    .select("e164:customer_e164, name:display_name, email, type, updated_at")
    .eq("business_id", businessId)
    .neq("type", "customer")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`listContactOverrides: ${error.message}`);
  return (data ?? []) as unknown as ContactOverrideRow[];
}

/**
 * Remove a manual contact label. Only deletes rows that are NOT customer
 * profiles, so deleting a label can never wipe the AI's customer memory — a
 * customer is removed from the Customers page flow instead (deleteCustomerMemory).
 */
export async function deleteContactOverride(
  businessId: string,
  e164: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("contacts")
    .delete()
    .eq("business_id", businessId)
    .eq("customer_e164", e164)
    .neq("type", "customer");
  if (error) throw new Error(`deleteContactOverride: ${error.message}`);
}
