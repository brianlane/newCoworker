/**
 * Resolve email addresses to contact profiles for dashboard linking.
 *
 * The Emails view shows raw addresses (`email_log.from_email` / `to_email` /
 * `cc_email`); when an address belongs to a known contact
 * (`contacts.email`), the UI links it to that contact's profile page. One
 * business-scoped query resolves the whole page's addresses; matching is
 * case-insensitive in JS (addresses arrive in whatever casing the provider
 * used, and `contacts.email` is owner-typed).
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { extractEmailAddresses } from "@/lib/email/address";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type EmailContactLink = {
  customerE164: string;
  displayName: string | null;
};

/** Contacts-with-email fetch cap; a tenant's contact list is far below this. */
const CONTACT_EMAIL_SCAN_LIMIT = 2000;

/**
 * Map lowercase email address → contact link for every address that matches a
 * contact's stored email. Unmatched addresses are simply absent. Values in
 * `addresses` may be raw header strings — `Name <addr>` and comma-separated
 * recipient lists (Cc) are both handled.
 */
export async function findContactsByEmails(
  businessId: string,
  addresses: Array<string | null | undefined>,
  client?: SupabaseClient
): Promise<Map<string, EmailContactLink>> {
  const wanted = new Set<string>();
  for (const a of addresses) {
    for (const addr of extractEmailAddresses(a)) wanted.add(addr);
  }
  const out = new Map<string, EmailContactLink>();
  if (wanted.size === 0) return out;

  const db = client ?? (await createSupabaseServiceClient());
  // One scan of the business's emailed contacts, matched in JS — exact
  // case-insensitive equality, so an ILIKE wildcard false-positive is
  // impossible and no LIKE-escaping is needed.
  const { data, error } = await db
    .from("contacts")
    .select("customer_e164, display_name, email")
    .eq("business_id", businessId)
    .not("email", "is", null)
    .limit(CONTACT_EMAIL_SCAN_LIMIT);
  if (error) throw new Error(`findContactsByEmails: ${error.message}`);

  for (const row of (data ?? []) as Array<{
    customer_e164: string;
    display_name: string | null;
    email: string | null;
  }>) {
    const key = (row.email ?? "").trim().toLowerCase();
    // First match wins on duplicate emails (deterministic enough for a link).
    if (key && wanted.has(key) && !out.has(key)) {
      out.set(key, {
        customerE164: row.customer_e164,
        displayName: row.display_name?.trim() || null
      });
    }
  }
  return out;
}
