/**
 * Prospecting, suppression, the one path that must never half-succeed.
 *
 * A person who asks to stop hearing from us has to be stopped on BOTH axes,
 * because outreach and campaigns read different tables: the ledger row is what
 * stops any further outreach mail (and keeps the domain out of discovery), and
 * the contact row's marketing stamp is what keeps them out of every future
 * campaign audience. Stamping only the first would let a later campaign reach
 * someone who already opted out.
 *
 * Both writes are idempotent, and the contact stamp is best-effort: a prospect
 * is often not a contact at all (the outreach flow files them only when a phone
 * number is known), so a missing contact is the normal case rather than a
 * failure.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { getProspect, patchProspect } from "./db";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Retire a prospect at their own request. `reason` distinguishes a clicked
 * unsubscribe link from a reply that asked us to stop, because both arrive and
 * the owner should be able to tell them apart.
 */
export async function suppressProspect(
  businessId: string,
  prospectId: string,
  client?: SupabaseClient,
  reason = "unsubscribed via link"
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const prospect = await getProspect(businessId, prospectId, db);
  // Nothing to stamp, and deliberately no error: the response to an
  // unsubscribe must not reveal whether the row exists.
  if (!prospect) return;
  await patchProspect(
    businessId,
    prospectId,
    { status: "unsubscribed", status_detail: reason },
    db
  );
  if (prospect.email) await suppressContactByEmail(businessId, prospect.email, db);
}

/**
 * Stamp the marketing opt-out on any contact of this business holding the
 * address, so campaign audiences exclude them too. Best-effort by contract.
 *
 * Equality on a lowercased address, the same convention the rest of the
 * codebase uses for contact lookups. ILIKE would read an underscore in the
 * local part as a wildcard and could suppress somebody else entirely.
 */
export async function suppressContactByEmail(
  businessId: string,
  email: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("contacts")
    .update({ marketing_unsubscribed_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("email", email.trim().toLowerCase())
    .is("marketing_unsubscribed_at", null);
  if (error) {
    logger.warn("outreach: contact marketing stamp failed", {
      businessId,
      error: error.message
    });
  }
}
