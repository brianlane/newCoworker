/**
 * The database side of implicit contact ownership: read the roster and the
 * business's own owner numbers, then apply the rule.
 *
 * The rule itself, and why it exists, lives in
 * `src/lib/contacts/owner-attribution.ts` (import-free so pure consumers can
 * share it).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { businessOwnerNumbers } from "@/lib/db/contact-names";
import { listTeamMembers } from "@/lib/db/employees";
import {
  pickImplicitContactOwner,
  type ImplicitContactOwner,
  type ImplicitOwnerCandidate
} from "@/lib/contacts/owner-attribution";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * The implicit owner for a business, or null when the rule does not apply.
 *
 * Never throws: an unreadable roster means the surface shows "unowned", which
 * is exactly today's behavior, and no page should 500 over a cosmetic
 * attribution. Pass `members` when the caller already loaded the roster.
 *
 * Cost: one query for a business with a real team (the roster read, or none
 * at all when `members` is passed), four for a one-person one (the roster
 * plus the three owner-number sources), because the owner-number reads only
 * happen after the count check.
 */
export async function resolveImplicitContactOwner(
  businessId: string,
  client?: SupabaseClient,
  members?: readonly ImplicitOwnerCandidate[]
): Promise<ImplicitContactOwner | null> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const roster = members ?? (await listTeamMembers(businessId, db));
    if (roster.filter((m) => m.active).length !== 1) return null;
    const ownerNumbers = await businessOwnerNumbers(businessId, db);
    return pickImplicitContactOwner(roster, ownerNumbers);
  } catch (err) {
    logger.warn("implicit contact owner: unreadable, treating contacts as unowned", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
