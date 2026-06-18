/**
 * Owner-set contact name overrides (see contact_overrides migration).
 *
 * An override is the manual escape hatch when derived contact names are
 * wrong or missing: the Safe Mode forward cell that belongs to someone
 * other than `businesses.owner_name`, or a lead-source short code like
 * ReferralExchange's 73339 that has no roster/customer identity at all.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** E.164, or a bare 3-8 digit short code (lead sources text from these). */
export const CONTACT_NUMBER_RE = /^(\+[1-9]\d{6,15}|\d{3,8})$/;

export type ContactOverrideRow = {
  e164: string;
  name: string;
  email: string | null;
  updated_at: string;
};

export type SetContactOverrideInput = {
  /** Owner-set email linking this contact's number to their address (optional). */
  email?: string | null;
};

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
  const { error } = await db.from("contact_overrides").upsert(
    {
      business_id: businessId,
      e164,
      name: trimmed,
      // Only overwrite email when the caller passed the key; leave an existing
      // value untouched on a name-only re-save.
      ...("email" in options ? { email: options.email?.trim() || null } : {}),
      updated_at: new Date().toISOString()
    },
    { onConflict: "business_id,e164" }
  );
  if (error) throw new Error(`setContactOverride: ${error.message}`);
}

/** Owner-set contacts for a business, newest-edited first. */
export async function listContactOverrides(
  businessId: string,
  client?: SupabaseClient
): Promise<ContactOverrideRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("contact_overrides")
    .select("e164, name, email, updated_at")
    .eq("business_id", businessId)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`listContactOverrides: ${error.message}`);
  return (data ?? []) as ContactOverrideRow[];
}

export async function deleteContactOverride(
  businessId: string,
  e164: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("contact_overrides")
    .delete()
    .eq("business_id", businessId)
    .eq("e164", e164);
  if (error) throw new Error(`deleteContactOverride: ${error.message}`);
}
