/**
 * Which roster member IS the signed-in caller?
 *
 * Two recognitions, tried in order:
 *
 * 1. The explicit link: their business_members row names an employee_id
 *    (Settings → Team access). Staff and manager logins are linked this way.
 * 2. The business owner's own roster row. Owners sign in through
 *    businesses.owner_email and never get a business_members row (ownership
 *    is implicit, see src/lib/authz/policy.ts), so the explicit link CANNOT
 *    exist for them; without this step, "My tasks" told the very person the
 *    account belongs to that their login isn't linked (HQ, Aug 19 2026).
 *    Their roster row is recognized the way the Employees page badges it
 *    and implicit contact ownership proves it: the member's phone matches
 *    one of the business's owner numbers, and the row is active.
 *
 * Best-effort: returns null on any read failure, so surfaces show the
 * unlinked notice (today's behavior) rather than 500 over attribution.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { businessOwnerNumbers } from "@/lib/db/contact-names";
import { listTeamMembers } from "@/lib/db/employees";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export async function resolveCallerEmployeeId(
  businessId: string,
  callerEmail: string | null | undefined,
  client?: SupabaseClient
): Promise<string | null> {
  if (!callerEmail) return null;
  try {
    const db = client ?? (await createSupabaseServiceClient());

    // 1) The explicit business_members link (same lookup every dashboard
    // surface uses; revoked rows never count).
    const { data: memberRow } = await db
      .from("business_members")
      .select("employee_id")
      .eq("business_id", businessId)
      .eq("email", callerEmail.trim().toLowerCase())
      .neq("status", "revoked")
      .maybeSingle();
    const linked =
      (memberRow as { employee_id?: string | null } | null)?.employee_id ?? null;
    if (linked) return linked;

    // 2) The owner's own roster row. Case-insensitive owner_email match,
    // mirroring getBusinessRoleForEmail, the check that admitted this
    // caller to the page; a strict DB equality would let a mixed-case
    // owner_email pass authorization yet miss here, leaving the owner
    // "unlinked" again.
    const { data: bizRow } = await db
      .from("businesses")
      .select("owner_email")
      .eq("id", businessId)
      .maybeSingle();
    const ownerEmail = (
      (bizRow as { owner_email?: string | null } | null)?.owner_email ?? ""
    )
      .trim()
      .toLowerCase();
    if (!ownerEmail || ownerEmail !== callerEmail.trim().toLowerCase()) {
      return null;
    }

    const [roster, ownerNumbers] = await Promise.all([
      listTeamMembers(businessId, db),
      businessOwnerNumbers(businessId, db)
    ]);
    const own = roster.find(
      (m) => m.active && ownerNumbers.includes(m.phone_e164)
    );
    return own?.id ?? null;
  } catch (err) {
    logger.warn("caller employee: unreadable, treating the login as unlinked", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
