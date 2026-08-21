/**
 * Prospecting, recording that a prospect answered.
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
  /**
   * Addresses this reply could belong to, best first: who actually sent it,
   * then the address we originally mailed (which the thread records).
   *
   * Both are needed. People answer from a different mailbox than the one on
   * their website all the time, or hand the mail to a colleague, and matching
   * only the sender would leave the ledger thinking they never replied and let
   * the silence-based follow-up chase them anyway. The thread is already proof
   * this conversation is ours, so trusting its correspondent is safe.
   */
  candidateEmails: Array<string | null | undefined>,
  bodyText: string,
  client?: SupabaseClient
): Promise<ProspectReplyOutcome> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const tried = new Set<string>();
    let prospect = null as Awaited<ReturnType<typeof findProspectByEmail>>;
    for (const candidate of candidateEmails) {
      const email = candidate?.trim().toLowerCase();
      if (!email || tried.has(email)) continue;
      tried.add(email);
      prospect = await findProspectByEmail(businessId, email, db);
      if (prospect) break;
    }
    if (!prospect) return "not_a_prospect";

    // AN OPT-OUT IS HONORED WHATEVER STATE THE ROW IS IN, and is therefore
    // checked before the status gate below.
    //
    // "Take me off your list" is a request about the FUTURE, so what the
    // ledger already thinks of this row is beside the point. Behind the gate
    // it was reachable only from `sent`, which meant a person who had already
    // answered us once could ask to stop and be ignored: their second mail
    // returned "already" and never reached suppressProspect, leaving them
    // stamped on neither axis and still inside every future campaign
    // audience. Retiring engaged prospects as `replied` (this PR) would have
    // widened that from "people who wrote back twice" to "everyone who booked
    // a call", which is how it was found (Bugbot, PR #1571).
    //
    // suppressProspect is idempotent on both writes, so the only state worth
    // short-circuiting is one that is already suppressed.
    if (looksLikeOptOut(bodyText)) {
      if (prospect.status === "unsubscribed") return "already";
      await suppressProspect(businessId, prospect.id, db, "asked to stop by reply");
      return "unsubscribed";
    }

    // Only a contacted prospect can newly REPLY. Anything else (a draft, a
    // skip, a row that already answered) is left exactly as it is.
    if (prospect.status !== "sent") return "already";
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
