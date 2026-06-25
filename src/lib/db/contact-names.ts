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
import { coerceOwnerPhoneToE164 } from "@/lib/telnyx/assign-did";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ContactName = {
  name: string;
  /** `contact` = owner-set override on a number with no derived identity. */
  kind: "owner" | "employee" | "customer" | "contact";
  /** Present (true) when the NAME came from a manual contact_overrides row. */
  override?: true;
};

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
  const [teamRes, contactRes, bizRes, telnyxRes, prefsRes] = await Promise.all([
    // active-only: matches the inbound webhook's employee gate, so a
    // deactivated employee whose texts take the normal customer path is
    // not labeled "employee" in the UI either.
    db
      .from("ai_flow_team_members")
      .select("phone_e164, name")
      .eq("business_id", businessId)
      .eq("active", true)
      .in("phone_e164", unique),
    // Unified contacts (customers + folded manual overrides). Filter in SQL
    // (primary number IN list, or alias array overlaps it) so the query scales
    // with the numbers shown, not the tenant's total contact count. `type`
    // tells customer (auto profile name) from a manual label (owner/tester/
    // service/other) — the latter wins over a derived owner/employee name.
    db
      .from("contacts")
      .select("customer_e164, alias_e164s, display_name, type")
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
  for (const res of [teamRes, contactRes, bizRes, telnyxRes, prefsRes]) {
    if (res.error) {
      throw new Error(`resolveContactNames: ${res.error.message}`);
    }
  }

  const out = new Map<string, ContactName>();
  const wanted = new Set(unique);
  // A contacts row whose type is NOT 'customer' is a manual label (the old
  // contact_overrides), so its name wins even over a derived owner/employee
  // name. Keyed by number (primary + aliases) for the owner/employee overlay.
  const manualLabel = new Map<string, string>();
  for (const row of (contactRes.data as Array<{
    customer_e164: string;
    alias_e164s: string[] | null;
    display_name: string | null;
    type: string;
  }> | null) ?? []) {
    const name = row.display_name?.trim();
    if (!name || name.toLowerCase() === "unknown caller") continue;
    const isManual = row.type !== "customer";
    // `contact` = a manual label with no derived identity; `customer` = an
    // auto/owner-edited profile name.
    const kind = isManual ? "contact" : "customer";
    for (const num of [row.customer_e164, ...(row.alias_e164s ?? [])]) {
      if (!wanted.has(num)) continue;
      out.set(num, isManual ? { name, kind, override: true } : { name, kind });
      if (isManual) manualLabel.set(num, name);
    }
  }
  // Employees overwrite a stale auto-created customer profile for the same
  // number; a manual label still wins over the roster name (kind kept).
  for (const row of (teamRes.data as Array<{
    phone_e164: string;
    name: string | null;
  }> | null) ?? []) {
    const rosterName = row.name?.trim();
    const labeled = manualLabel.get(row.phone_e164);
    const name = labeled ?? rosterName;
    if (name) {
      out.set(row.phone_e164, labeled ? { name, kind: "employee", override: true } : { name, kind: "employee" });
    }
  }
  // Owner last — wins over a roster entry or stale customer profile for the
  // same number; a manual label still wins over the derived owner name.
  const biz = bizRes.data as { owner_name?: string | null; phone?: string | null } | null;
  const telnyx = telnyxRes.data as { forward_to_e164?: string | null } | null;
  const prefs = prefsRes.data as { phone_number?: string | null } | null;
  const ownerName = biz?.owner_name?.trim() || "Owner";
  // coerceOwnerPhoneToE164: these are owner-typed free-text fields
  // ("6026951142", "(602) 805-3377") — same coercion the DID-assign path
  // uses for the onboarding phone.
  const ownerNumbers = [
    coerceOwnerPhoneToE164(telnyx?.forward_to_e164),
    coerceOwnerPhoneToE164(prefs?.phone_number),
    coerceOwnerPhoneToE164(biz?.phone)
  ];
  for (const num of ownerNumbers) {
    if (!num || !wanted.has(num)) continue;
    const labeled = manualLabel.get(num);
    out.set(num, labeled ? { name: labeled, kind: "owner", override: true } : { name: ownerName, kind: "owner" });
  }
  return out;
}
