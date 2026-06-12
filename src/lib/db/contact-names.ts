/**
 * Resolve phone numbers to known contact names for dashboard display.
 *
 * A number can belong to a team member (AiFlow routing roster) or to a
 * customer profile (`customer_memories.display_name`). Team members win:
 * an employee who once texted the business number may also have an
 * auto-created customer profile, and labeling them "customer" is exactly
 * the confusion this helper exists to remove.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ContactName = {
  name: string;
  kind: "employee" | "customer";
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
  const [teamRes, custRes] = await Promise.all([
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
      .or(`customer_e164.in.(${inList}),alias_e164s.ov.{${inList}}`)
  ]);
  if (teamRes.error) {
    throw new Error(`resolveContactNames: ${teamRes.error.message}`);
  }
  if (custRes.error) {
    throw new Error(`resolveContactNames: ${custRes.error.message}`);
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
  return out;
}
