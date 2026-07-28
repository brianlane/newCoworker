/**
 * Prospecting — recording that a prospect answered.
 *
 * WHY THIS EXISTS. The follow-up is scheduled off silence: sent five or more
 * days ago, never nudged. If nothing ever writes a reply to the ledger, then a
 * prospect who DID answer gets nudged anyway, which reads as a machine talking
 * over them, and it contradicts the whole promise that replies are handled in
 * the thread.
 *
 * So this is the one place a reply is recorded, called from the email coworker's
 * mailbox poll as each inbound message on an owned thread is claimed. It is
 * cheap (one indexed lookup by address) and a no-op for the overwhelming
 * majority of mail, which is not from a prospect at all.
 *
 * An opt-out request is recognized here too, and suppressed rather than merely
 * marked replied: somebody who says "take me off your list" must not go on to
 * receive a follow-up, and must not be reachable by a later campaign either.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { looksLikeOptOut } from "./compliance";
import { findProspectByEmail, patchProspect } from "./db";
import { suppressProspect } from "./suppress";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ProspectReplyOutcome = "not_a_prospect" | "replied" | "unsubscribed" | "already";

/**
 * Record an inbound email against the outreach ledger, if it is from a prospect
 * we contacted. Best-effort by contract: this is bookkeeping alongside the
 * coworker's own answer, and a failure here must never cost the reply itself.
 */
export async function noteProspectReply(
  businessId: string,
  fromEmail: string,
  bodyText: string,
  client?: SupabaseClient
): Promise<ProspectReplyOutcome> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const prospect = await findProspectByEmail(businessId, fromEmail, db);
    if (!prospect) return "not_a_prospect";
    // Only a contacted prospect can reply. Anything else (a draft, a skip, an
    // already-suppressed row) is left exactly as it is.
    if (prospect.status !== "sent") return "already";

    if (looksLikeOptOut(bodyText)) {
      await suppressProspect(businessId, prospect.id, db, "asked to stop by reply");
      return "unsubscribed";
    }
    await patchProspect(
      businessId,
      prospect.id,
      { status: "replied", replied_at: new Date().toISOString() },
      db
    );
    return "replied";
  } catch (err) {
    logger.warn("outreach: could not record a prospect reply", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return "not_a_prospect";
  }
}
