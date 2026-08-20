/**
 * The dashboard Claim action: a signed-in teammate takes an unowned lead as
 * their own from the Tasks board or the customers list, with the combined
 * effects of the two claim surfaces that already exist: the ownership stamp
 * an admin assign writes, and the analytics clock a texted "1" starts.
 *
 * One-contact-one-owner is the product rule this enforces, and the write is
 * where it holds or breaks: a plain update would let two teammates claim the
 * same lead milliseconds apart, both seeing "unowned" on read. So the update
 * is a compare-and-swap on `owner_employee_id IS NULL`, verified through
 * `.select()`, because PostgREST reports a zero-row update as success with
 * no error; a zero-row result is re-read and reported as "somebody else got
 * there first" instead of claimed.
 *
 * On a successful claim this also:
 *  - stamps claimed_by / claimed_name / claimed_at_ms on the lead's routed
 *    run (stampLeadClaimOnRun), so employee-performance analytics see a
 *    dashboard claim exactly like a texted "1",
 *  - fires the same `owner_assigned` contact event the quick editor's owner
 *    dropdown fires, so notification and automation flows behave
 *    identically for a claim and an assign.
 * Both are best-effort by their own modules' construction (neither throws);
 * only the ownership write itself may fail the claim.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getCustomerMemory } from "@/lib/customer-memory/db";
import { getTeamMember } from "@/lib/db/employees";
import { resolveCallerEmployeeId } from "@/lib/db/caller-employee";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { stampLeadClaimOnRun } from "@/lib/leads/claim-stamp";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type ClaimLeadResult =
  /** The caller now owns the contact (this request made it so). */
  | { outcome: "claimed"; ownerEmployeeId: string; ownerName: string }
  /** The caller already owned it; idempotent double-clicks land here. */
  | { outcome: "already_mine"; ownerEmployeeId: string; ownerName: string }
  /** Somebody else owns it. Name is null when their roster row is gone. */
  | { outcome: "already_owned"; ownerName: string | null }
  /** The caller's login maps to no roster member, so nobody to assign. */
  | { outcome: "not_linked" }
  /** No contact row behind the key (deleted, or never filed). */
  | { outcome: "not_found" };

/**
 * Claim `contactKey` (an E.164, short code, or `email:` key, the same keys
 * every contact route accepts) for the roster member the caller's login IS:
 * their explicit Settings -> Team access link, or the owner's own roster row
 * (resolveCallerEmployeeId, the exact mapping the Tasks board's "My leads"
 * scope uses, so whoever sees a lead under "mine" after claiming is the
 * person the claim assigned).
 */
export async function claimLeadForCaller(args: {
  businessId: string;
  contactKey: string;
  callerEmail: string | null | undefined;
  db?: SupabaseClient;
  nowMs?: number;
}): Promise<ClaimLeadResult> {
  const db = args.db ?? (await createSupabaseServiceClient());

  const employeeId = await resolveCallerEmployeeId(args.businessId, args.callerEmail, db);
  if (!employeeId) return { outcome: "not_linked" };
  // The member row itself: its name labels the claim everywhere (the
  // owner_assigned event, the run stamp) and its phone is the claimed_by
  // identity the SMS claim path records.
  const member = await getTeamMember(args.businessId, employeeId, db);
  if (!member) return { outcome: "not_linked" };

  // Alias-aware read: the key may be a merged-away number whose surviving
  // row is primary-keyed differently; every later write targets the primary.
  const contact = await getCustomerMemory(args.businessId, args.contactKey, db);
  if (!contact) return { outcome: "not_found" };
  const canonicalKey = contact.customer_e164;

  if (contact.owner_employee_id) {
    if (contact.owner_employee_id === member.id) {
      // Idempotent: re-claiming your own lead re-asserts the analytics stamp
      // (backfilling a legacy self-claim that predates stamping) and changes
      // nothing else, no event fires because no ownership changed.
      await stampLeadClaimOnRun(db, {
        businessId: args.businessId,
        leadE164: canonicalKey,
        claimedByE164: member.phone_e164,
        claimedByName: member.name,
        nowMs: args.nowMs
      });
      return { outcome: "already_mine", ownerEmployeeId: member.id, ownerName: member.name };
    }
    return {
      outcome: "already_owned",
      ownerName: await ownerNameOf(args.businessId, contact.owner_employee_id, db)
    };
  }

  // The compare-and-swap: first writer wins, and the `.select()` is the
  // proof of winning, a PostgREST update matching zero rows returns success
  // with no error, so without it a lost race would read as a claim.
  const { data: written, error } = await db
    .from("contacts")
    .update({ owner_employee_id: member.id, updated_at: new Date().toISOString() })
    .eq("business_id", args.businessId)
    .eq("customer_e164", canonicalKey)
    .is("owner_employee_id", null)
    .select("customer_e164");
  if (error) throw new Error(`claimLeadForCaller: ${error.message}`);

  if ((written ?? []).length === 0) {
    // Lost the race (or the row vanished). Read back the truth so the
    // refusal can name today's owner, not the null this request saw.
    const fresh = await getCustomerMemory(args.businessId, canonicalKey, db);
    if (!fresh) return { outcome: "not_found" };
    if (fresh.owner_employee_id === member.id) {
      // A parallel request of OURS won (double-click); same happy answer.
      return { outcome: "already_mine", ownerEmployeeId: member.id, ownerName: member.name };
    }
    return {
      outcome: "already_owned",
      ownerName: await ownerNameOf(args.businessId, fresh.owner_employee_id, db)
    };
  }

  // Bookkeeping, both best-effort by construction: the ownership row is
  // already written, so neither a missed stamp nor a failed event may
  // un-claim the lead.
  await stampLeadClaimOnRun(db, {
    businessId: args.businessId,
    leadE164: canonicalKey,
    claimedByE164: member.phone_e164,
    claimedByName: member.name,
    nowMs: args.nowMs
  });
  await fireContactEvent(args.businessId, {
    kind: "owner_assigned",
    contact: { e164: canonicalKey },
    ownerName: member.name,
    // Same shape the quick editor's assign uses, so downstream dedupe and
    // templates cannot tell a claim from an assign.
    dedupeKey: `ce:owner:${canonicalKey}:${member.id}:${args.nowMs ?? Date.now()}`
  });

  return { outcome: "claimed", ownerEmployeeId: member.id, ownerName: member.name };
}

/**
 * The display name behind an owner id, null when the roster row is gone or
 * unreadable; the refusal still stands either way, it just loses the name.
 */
async function ownerNameOf(
  businessId: string,
  ownerEmployeeId: string | null,
  db: SupabaseClient
): Promise<string | null> {
  if (!ownerEmployeeId) return null;
  const owner = await getTeamMember(businessId, ownerEmployeeId, db).catch(() => null);
  return owner?.name ?? null;
}
