/**
 * Resolve phone numbers to known contact names for dashboard display.
 *
 * A number can belong to the business owner (Safe Mode forward cell, alert
 * phone, or onboarding phone), a team member (AiFlow routing roster), or a
 * customer profile (`customer_memories.display_name`). Precedence is
 * owner > employee > customer: the owner's cell receives AiFlow/owner-notify
 * texts and may also have a stale auto-created customer profile, and
 * labeling them "customer" is exactly the confusion this helper removes.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ContactName = {
  name: string;
  kind: "owner" | "employee" | "customer";
};

/**
 * Lenient E.164 normalization for owner-entered phone fields
 * (`notification_preferences.phone_number`, `businesses.phone`) which are
 * free text — owners type "6026951142". Bare 10-digit numbers are assumed
 * NANP (+1), matching how Telnyx provisions every tenant DID today. Returns
 * null when the input can't be made into a plausible E.164.
 */
function looseE164(input: string | null | undefined): string | null {
  const digits = (input ?? "").replace(/[^\d]/g, "");
  if (!digits) return null;
  const candidate =
    digits.length === 10 ? `+1${digits}` : `+${digits}`;
  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
}

/**
 * Map E.164 → display name for every number we can identify. Numbers with
 * no roster entry and no named customer profile are simply absent from the
 * result — callers fall back to showing the raw number.
 */
export async function resolveContactNames(
  businessId: string,
  e164s: string[],
  client?: SupabaseClient
): Promise<Map<string, ContactName>> {
  const unique = [...new Set(e164s)].filter(Boolean);
  if (unique.length === 0) return new Map();
  const db = client ?? (await createSupabaseServiceClient());

  // E.164 strings are "+digits" only, so embedding them in a PostgREST
  // .or() filter needs no escaping (no commas/parens/braces possible).
  const inList = unique.join(",");
  const [teamRes, custRes, bizRes, telnyxRes, prefsRes] = await Promise.all([
    // active-only: matches the inbound webhook's employee gate, so a
    // deactivated employee whose texts take the normal customer path is
    // not labeled "employee" in the UI either.
    db
      .from("ai_flow_team_members")
      .select("phone_e164, name")
      .eq("business_id", businessId)
      .eq("active", true)
      .in("phone_e164", unique),
    // Filter in SQL (primary number IN list, or alias array overlaps it)
    // so the query scales with the numbers shown, not the tenant's total
    // customer count.
    db
      .from("customer_memories")
      .select("customer_e164, alias_e164s, display_name")
      .eq("business_id", businessId)
      .or(`customer_e164.in.(${inList}),alias_e164s.ov.{${inList}}`),
    // Owner numbers come from three places: the onboarding phone, the Safe
    // Mode forward cell, and the notification alert phone. Any of them
    // appearing in a thread list is the owner, not a customer.
    db
      .from("businesses")
      .select("owner_name, phone")
      .eq("id", businessId)
      .maybeSingle(),
    db
      .from("business_telnyx_settings")
      .select("forward_to_e164")
      .eq("business_id", businessId)
      .maybeSingle(),
    db
      .from("notification_preferences")
      .select("phone_number")
      .eq("business_id", businessId)
      .maybeSingle()
  ]);
  for (const res of [teamRes, custRes, bizRes, telnyxRes, prefsRes]) {
    if (res.error) {
      throw new Error(`resolveContactNames: ${res.error.message}`);
    }
  }

  const out = new Map<string, ContactName>();
  // Customers first, employees second, so an employee entry overwrites a
  // stale auto-created customer profile for the same number.
  const wanted = new Set(unique);
  for (const row of (custRes.data as Array<{
    customer_e164: string;
    alias_e164s: string[] | null;
    display_name: string | null;
  }> | null) ?? []) {
    const name = row.display_name?.trim();
    if (!name || name.toLowerCase() === "unknown caller") continue;
    for (const num of [row.customer_e164, ...(row.alias_e164s ?? [])]) {
      if (wanted.has(num)) out.set(num, { name, kind: "customer" });
    }
  }
  for (const row of (teamRes.data as Array<{
    phone_e164: string;
    name: string | null;
  }> | null) ?? []) {
    const name = row.name?.trim();
    if (name) out.set(row.phone_e164, { name, kind: "employee" });
  }
  // Owner last — wins over a roster entry or stale customer profile for
  // the same number.
  const biz = bizRes.data as { owner_name?: string | null; phone?: string | null } | null;
  const telnyx = telnyxRes.data as { forward_to_e164?: string | null } | null;
  const prefs = prefsRes.data as { phone_number?: string | null } | null;
  const ownerName = biz?.owner_name?.trim() || "Owner";
  const ownerNumbers = [
    looseE164(telnyx?.forward_to_e164),
    looseE164(prefs?.phone_number),
    looseE164(biz?.phone)
  ];
  for (const num of ownerNumbers) {
    if (num && wanted.has(num)) out.set(num, { name: ownerName, kind: "owner" });
  }
  return out;
}
